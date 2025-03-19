import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { execSync } from 'child_process';
import { glob } from 'glob';

// Configuration for OpenAI API (or any other LLM API)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

interface RepoAnalysisResult {
  isValid: boolean;
  reason: string;
  details?: {
    isGithubUrl: boolean;
    containsDocsKeywords: boolean;
    mdFilesCount: number;
    llmEvaluation: string;
    confidenceScore: number;
  };
}

/**
 * Main function to validate if a URL is a documentation GitHub repository
 */
export async function isDocUrl(url: string): Promise<RepoAnalysisResult> {
  try {
    // Step 1: Check if it's a valid URL
    if (!isValidUrl(url)) {
      return { isValid: false, reason: 'Invalid URL format' };
    }

    // Step 2: Verify it's a GitHub repository URL
    if (!isGithubRepoUrl(url)) {
      return { isValid: false, reason: 'Not a GitHub repository URL' };
    }

    // Step 3: Check for documentation keywords in the URL
    const hasDocsKeywords = checkForDocsKeywords(url);

    // Step 4: Get repository information
    const repoInfo = extractRepoInfo(url);
    const tempDir = path.join(process.cwd(), 'temp', repoInfo.repoName);

    // Step 5: Clone the repository locally
    try {
      cloneRepository(repoInfo.owner, repoInfo.repoName, tempDir);
    } catch (error: any) {
      return { isValid: false, reason: `Failed to clone repository: ${error.message}` };
    }

    // Step 6: Count markdown files
    const mdFilesCount = countMarkdownFiles(tempDir);

    // Step 7: Read README.md for LLM evaluation
    let readmeContent = '';
    try {
      readmeContent = fs.readFileSync(path.join(tempDir, 'README.md'), 'utf8');
    } catch (error) {
      console.warn('README.md not found or cannot be read');
      readmeContent = 'No README.md found';
    }

    // Step 8: Ask LLM to evaluate if it's a documentation repository
    const llmEvaluation = await evaluateWithLLM(url, readmeContent, mdFilesCount, hasDocsKeywords);

    // Step 9: Clean up temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      console.warn(`Failed to remove temporary directory: ${error.message}`);
    }

    // Step 10: Make final decision
    const confidenceScore = calculateConfidenceScore(hasDocsKeywords, mdFilesCount, llmEvaluation);
    const isValid = confidenceScore >= 0.7;

    return {
      isValid,
      reason: isValid ? 'Repository appears to be documentation' : 'Repository does not appear to be documentation',
      details: {
        isGithubUrl: true,
        containsDocsKeywords: hasDocsKeywords,
        mdFilesCount,
        llmEvaluation,
        confidenceScore
      }
    };
  } catch (error: any) {
    return { isValid: false, reason: `Error during validation: ${error.message}` };
  }
}

/**
 * Check if the provided string is a valid URL
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the URL is a GitHub repository URL
 */
function isGithubRepoUrl(url: string): boolean {
  const githubPattern = /^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+\/?$/;
  return githubPattern.test(url);
}

/**
 * Check if the URL contains documentation-related keywords
 */
function checkForDocsKeywords(url: string): boolean {
  const docsKeywords = ['docs', 'documentation', 'learn', 'guide', 'tutorial', 'wiki'];
  const lowercaseUrl = url.toLowerCase();
  return docsKeywords.some(keyword => lowercaseUrl.includes(keyword));
}

/**
 * Extract repository owner and name from GitHub URL
 */
function extractRepoInfo(url: string): { owner: string; repoName: string } {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);

  if (pathParts.length < 2) {
    throw new Error('Invalid GitHub repository URL format');
  }


  return {
    owner: pathParts[0],
    repoName: pathParts[1]
  };
}

/**
 * Clone the repository to a local directory
 */
function cloneRepository(owner: string, repoName: string, directory: string): void {
  // Create directory if it doesn't exist
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const repoUrl = `https://github.com/${owner}/${repoName}.git`;
  execSync(`git clone --depth 1 ${repoUrl} ${directory}`, { stdio: 'pipe' });
}

/**
 * Count markdown files in the repository
 */
function countMarkdownFiles(directory: string): number {
  const mdFiles = glob.sync('**/*.md', { cwd: directory, ignore: ['node_modules/**', '.git/**'] });
  return mdFiles.length;
}

/**
 * Evaluate the repository using an LLM
 */
async function evaluateWithLLM(
    url: string,
    readmeContent: string,
    mdFilesCount: number,
    hasDocsKeywords: boolean
): Promise<string> {
  if (!OPENAI_API_KEY) {
    return "LLM evaluation skipped: API key not provided";
  }

  try {
    const prompt = `
      I need to determine if this GitHub repository is a documentation repository.
      
      URL: ${url}
      Contains documentation keywords in URL: ${hasDocsKeywords}
      Number of markdown files: ${mdFilesCount}
      README content: 
      ${readmeContent.substring(0, 2000)}${readmeContent.length > 2000 ? '...' : ''}
      
      Based on this information, is this likely to be a documentation repository? 
      Respond with either "Yes, this is likely a documentation repository because..." or
      "No, this is likely not a documentation repository because..." and provide your reasoning.
    `;

    const response = await axios.post(
        OPENAI_API_URL,
        {
          model: "gpt-4",
          messages: [
            { role: "system", content: "You are helping to identify documentation repositories on GitHub." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 500
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          }
        }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error: any) {
    console.error('Error with LLM API:', error.message);
    return `LLM evaluation failed: ${error.message}`;
  }
}

/**
 * Calculate confidence score based on various factors
 */
function calculateConfidenceScore(
    hasDocsKeywords: boolean,
    mdFilesCount: number,
    llmEvaluation: string
): number {
  let score = 0;

  // Score based on docs keywords in URL
  if (hasDocsKeywords) {
    score += 0.3;
  }

  // Score based on markdown files count
  if (mdFilesCount > 10) {
    score += 0.4;
  } else if (mdFilesCount > 5) {
    score += 0.3;
  } else if (mdFilesCount > 0) {
    score += 0.2;
  }

  // Score based on LLM evaluation
  if (llmEvaluation.toLowerCase().startsWith('yes')) {
    score += 0.3;
  } else if (!llmEvaluation.toLowerCase().startsWith('no')) {
    score += 0.1; // Neutral or error case
  }

  return score;
}

