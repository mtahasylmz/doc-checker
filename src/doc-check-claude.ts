/**
 * Documentation URL Detector
 * 
 * A TypeScript implementation that uses multiple detection strategies
 * to determine if a URL points to documentation.
 */

import * as cheerio from 'cheerio';
import { OpenAI } from 'openai';
import axios from 'axios';
import { URL } from 'url';

// Type definitions
type DocEvidence = {
  score: number;
  reason: string;
};

type DocResult = {
  isDocumentation: boolean;
  confidence: number;
  source: string;
  details?: any;
};

interface DocDetectorConfig {
  enableLLM: boolean;
  openaiApiKey?: string;
  openaiModel?: string;
  logDetails?: boolean;
  userAgent?: string;
  timeout?: number;
}

class DocumentationDetector {
  private openai: OpenAI | null = null;
  private config: DocDetectorConfig;
  
  constructor(config: Partial<DocDetectorConfig> = {}) {
    this.config = {
      enableLLM: config.enableLLM ?? false,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel ?? 'gpt-4',
      logDetails: config.logDetails ?? false,
      userAgent: config.userAgent ?? 'Documentation-Detector/1.0',
      timeout: config.timeout ?? 10000
    };
    
    // Initialize OpenAI if API key is provided
    if (this.config.enableLLM && this.config.openaiApiKey) {
      this.openai = new OpenAI({
        apiKey: this.config.openaiApiKey
      });
    }
  }
  
  /**
   * Log messages with optional debug mode
   */
  private log(message: string, isError = false): void {
    if (this.config.logDetails || isError) {
      console[isError ? 'error' : 'log'](message);
    }
  }
  
  /**
   * Main function to check if a URL is documentation
   */
  public async isDocUrl(url: string): Promise<DocResult> {
    try {
      // Validate URL
      const urlObj = new URL(url);
      
      // First, analyze the URL pattern (quick and cheap)
      const urlAnalysis = this.analyzeUrlPattern(urlObj);
      
      // If URL analysis gives high confidence, we can short-circuit
      if (urlAnalysis.confidence > 0.9) {
        return {
          isDocumentation: urlAnalysis.isLikelyDoc,
          confidence: urlAnalysis.confidence,
          source: 'url_pattern',
          details: { urlEvidence: urlAnalysis.evidence }
        };
      }
      
      // Fetch page content
      const htmlContent = await this.fetchPageContent(url);
      
      // Choose analysis method based on URL type
      if (urlAnalysis.isRepo) {
        return await this.analyzeRepositoryContent(url, urlObj, urlAnalysis, htmlContent);
      } else {
        return await this.analyzeDedicatedDocsContent(url, urlObj, urlAnalysis, htmlContent);
      }
    } catch (error) {
      this.log(`Error in isDocUrl: ${error}`, true);
      return {
        isDocumentation: false,
        confidence: 0.3,
        source: 'error'
      };
    }
  }
  
  /**
   * Fetch HTML content from a URL
   */
  private async fetchPageContent(url: string): Promise<string> {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': this.config.userAgent
        },
        timeout: this.config.timeout
      });
      
      return response.data;
    } catch (error) {
      this.log(`Failed to fetch ${url}: ${error}`, true);
      throw new Error(`Failed to fetch URL content: ${error}`);
    }
  }
  
  /**
   * Analyze URL pattern for documentation indicators
   */
  private analyzeUrlPattern(urlObj: URL): {
    isLikelyDoc: boolean;
    isRepo: boolean;
    confidence: number;
    evidence: DocEvidence[];
    repoInfo?: {
      platform: string;
      owner: string;
      repo: string;
      isWiki: boolean;
      isPages: boolean;
    }
  } {
    const url = urlObj.href;
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;
    const evidence: DocEvidence[] = [];
    let isRepo = false;
    let repoInfo = null;
    
    // Check for common documentation subdomains
    const docSubdomains = [
      /^docs?\./, 
      /^developer\./, 
      /^dev\./, 
      /^documentation\./, 
      /^api\./, 
      /^support\./, 
      /^help\./, 
      /^learn\./,
      /^guide\./,
      /^manual\./,
      /^reference\./,
      /^wiki\./
    ];
    
    for (const pattern of docSubdomains) {
      if (pattern.test(hostname)) {
        evidence.push({
          score: 3,
          reason: `Hostname matches documentation subdomain pattern: ${pattern}`
        });
      }
    }
    
    // Check for documentation-specific TLDs or domains
    const docDomains = [
      'readthedocs.io',
      'readthedocs.org',
      'rtfd.io',
      'gitbook.io',
      'docusaurus.io',
      'netlify.app',
      'github.io'
    ];
    
    for (const domain of docDomains) {
      if (hostname.endsWith(domain)) {
        evidence.push({
          score: 2,
          reason: `Domain uses documentation hosting service: ${domain}`
        });
      }
    }
    
    // Check for documentation keywords in path
    const docPathPatterns = [
      /\/docs?\/?/, 
      /\/documentation\/?/, 
      /\/api\/?/,
      /\/reference\/?/,
      /\/guides?\/?/,
      /\/tutorials?\/?/,
      /\/manual\/?/,
      /\/handbook\/?/,
      /\/learn\/?/,
      /\/getting-started\/?/,
      /\/help\/?/,
      /\/support\/?/,
      /\/wiki\/?/,
      /\/manual\/?/,
      /\/cookbook\/?/,
      /\/howto\/?/
    ];
    
    for (const pattern of docPathPatterns) {
      if (pattern.test(pathname)) {
        evidence.push({
          score: 2,
          reason: `URL path contains documentation indicator: ${pattern}`
        });
      }
    }
    
    // Check for documentation file extensions
    if (pathname.endsWith('.md') || pathname.endsWith('.html') || pathname.endsWith('.htm') || 
        pathname.endsWith('.rst') || pathname.endsWith('.adoc')) {
      evidence.push({
        score: 1,
        reason: `URL ends with documentation file extension`
      });
    }
    
    // Check for repository platforms and extract repo information
    // GitHub
    const githubRepoMatch = /github\.com\/([^\/]+)\/([^\/]+)(\/.*)?/.exec(url);
    if (githubRepoMatch) {
      isRepo = true;
      
      const owner = githubRepoMatch[1];
      const repo = githubRepoMatch[2];
      const rest = githubRepoMatch[3] || '';
      
      repoInfo = {
        platform: 'GitHub',
        owner,
        repo,
        isWiki: rest.includes('/wiki'),
        isPages: hostname === `${owner}.github.io` && repo !== owner + '.github.io'
      };
      
      // Check for documentation-specific repositories
      if (/docs?|documentation|guide|tutorial|manual|reference/i.test(repo)) {
        evidence.push({
          score: 2,
          reason: `Repository name suggests documentation: ${repo}`
        });
      }
      
      // Check if it's a GitHub Wiki or GitHub Pages
      if (repoInfo.isWiki) {
        evidence.push({
          score: 3,
          reason: `GitHub Wiki (highly likely to be documentation)`
        });
      }
      
      if (repoInfo.isPages) {
        evidence.push({
          score: 2,
          reason: `GitHub Pages (commonly used for documentation)`
        });
      }
      
      // Check for common doc paths in repos
      if (rest.includes('/docs') || rest.includes('/doc') || 
          rest.includes('/documentation') || rest.includes('/wiki') ||
          rest.includes('/README') || rest.includes('/guide')) {
        evidence.push({
          score: 2,
          reason: `Repository path indicates documentation content`
        });
      }
    }
    
    // GitLab
    const gitlabRepoMatch = /gitlab\.com\/([^\/]+)\/([^\/]+)(\/.*)?/.exec(url);
    if (gitlabRepoMatch) {
      isRepo = true;
      
      const owner = gitlabRepoMatch[1];
      const repo = gitlabRepoMatch[2];
      const rest = gitlabRepoMatch[3] || '';
      
      repoInfo = {
        platform: 'GitLab',
        owner,
        repo,
        isWiki: rest.includes('/wikis'),
        isPages: hostname.endsWith('gitlab.io')
      };
      
      // Similar checks as GitHub
      if (/docs?|documentation|guide|tutorial|manual|reference/i.test(repo)) {
        evidence.push({
          score: 2,
          reason: `Repository name suggests documentation: ${repo}`
        });
      }
      
      if (repoInfo.isWiki) {
        evidence.push({
          score: 3,
          reason: `GitLab Wiki (highly likely to be documentation)`
        });
      }
    }
    
    // BitBucket
    const bitbucketRepoMatch = /bitbucket\.org\/([^\/]+)\/([^\/]+)(\/.*)?/.exec(url);
    if (bitbucketRepoMatch) {
      isRepo = true;
      
      const owner = bitbucketRepoMatch[1];
      const repo = bitbucketRepoMatch[2];
      const rest = bitbucketRepoMatch[3] || '';
      
      repoInfo = {
        platform: 'BitBucket',
        owner,
        repo,
        isWiki: rest.includes('/wiki'),
        isPages: false
      };
      
      // Similar checks as GitHub
      if (/docs?|documentation|guide|tutorial|manual|reference/i.test(repo)) {
        evidence.push({
          score: 2,
          reason: `Repository name suggests documentation: ${repo}`
        });
      }
      
      if (repoInfo.isWiki) {
        evidence.push({
          score: 3,
          reason: `BitBucket Wiki (highly likely to be documentation)`
        });
      }
    }
    
    // Calculate likelihood from evidence
    const totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
    
    // Calculate confidence (base 0.5 with modulation based on evidence)
    // More evidence gives higher confidence in either direction
    let confidence = 0.5;
    if (totalScore !== 0) {
      // Map total score to a confidence value
      // Higher absolute score = higher confidence
      confidence = 0.5 + Math.min(0.4, Math.abs(totalScore) * 0.05) * Math.sign(totalScore);
    }
    
    return {
      isLikelyDoc: totalScore > 0,
      isRepo,
      confidence,
      evidence,
      repoInfo: repoInfo || undefined
    };
  }
  
  /**
   * Use LLM to analyze repository content
   */
  private async analyzeLLM_RepoContent(url: string, repoData: Record<string, any>): Promise<DocResult> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }
    
    try {
      const prompt = `
      Analyze this GitHub/GitLab repository information and determine if it's likely to be a documentation repository.
      
      URL: ${url}
      
      Repository Information:
      - Platform: ${repoData.platform}
      - Owner: ${repoData.owner}
      - Repository Name: ${repoData.repo}
      - Is Wiki: ${repoData.isWiki}
      - Is GitHub/GitLab Pages: ${repoData.isPages}
      
      Directory Structure:
      ${repoData.directoryStructure.join('\n')}
      
      Statistics:
      - Markdown Files Count: ${repoData.mdFilesCount}
      - Documentation Directories: ${repoData.docDirsCount}
      - Language Folders: ${repoData.languageFolders.join(', ')}
      
      README Content Sample:
      ${repoData.readmeContent}
      
      Based ONLY on the information above, is this repository primarily meant to serve as documentation?
      Answer with a JSON object with the following structure:
      {
        "isDocumentation": boolean,
        "confidence": number (between 0 and 1),
        "reasoning": "explanation of your decision"
      }
      `;
      
      const response = await this.openai.chat.completions.create({
        model: this.config.openaiModel as string,
        messages: [
          { role: 'system', content: 'You are an expert at analyzing repository content to determine if it contains documentation.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{.*\}/s);
      
      if (!jsonMatch) {
        throw new Error('Failed to parse LLM response');
      }
      
      const result = JSON.parse(jsonMatch[0]);
      
      return {
        isDocumentation: result.isDocumentation,
        confidence: result.confidence,
        source: 'llm_repo_analysis',
        details: {
          reasoning: result.reasoning
        }
      };
      
    } catch (error) {
      this.log(`LLM repo analysis error: ${error}`, true);
      // Return a neutral result on failure
      return {
        isDocumentation: false,
        confidence: 0.5,
        source: 'llm_repo_analysis_error'
      };
    }
  }
  
/**
   * Use LLM to analyze page content
   */
private async analyzeLLM_PageContent(url: string, pageData: Record<string, any>): Promise<DocResult> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }
    
    try {
      const prompt = `
      Analyze this webpage information and determine if it's a documentation page.
      
      URL: ${url}
      
      Page Information:
      - Title: ${pageData.title}
      - Meta Description: ${pageData.metaDescription}
      - Main Heading: ${pageData.h1}
      - Headings: ${pageData.headings.join(', ')}
      
      Page Features:
      - Has Sidebar/Navigation: ${pageData.sidebarPresent}
      - Sidebar Items: ${pageData.sidebarItems.join(', ')}
      - Has Code Blocks: ${pageData.hasCodeBlocks}
      - Has Search Functionality: ${pageData.hasSearch}
      
      Content Sample:
      ${pageData.contentSample}
      
      Based ONLY on the information above, is this webpage primarily documentation?
      Answer with a JSON object with the following structure:
      {
        "isDocumentation": boolean,
        "confidence": number (between 0 and 1),
        "reasoning": "explanation of your decision"
      }
      `;
      
      const response = await this.openai.chat.completions.create({
        model: this.config.openaiModel as string,
        messages: [
          { role: 'system', content: 'You are an expert at analyzing webpages to determine if they are documentation.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{.*\}/s);
      
      if (!jsonMatch) {
        throw new Error('Failed to parse LLM response');
      }
      
      const result = JSON.parse(jsonMatch[0]);
      
      return {
        isDocumentation: result.isDocumentation,
        confidence: result.confidence,
        source: 'llm_page_analysis',
        details: {
          reasoning: result.reasoning
        }
      };
      
    } catch (error) {
      this.log(`LLM page analysis error: ${error}`, true);
      // Return a neutral result on failure
      return {
        isDocumentation: false,
        confidence: 0.5,
        source: 'llm_page_analysis_error'
      };
    }
  }
  
  /**
   * Analyze content from a repository platform (GitHub, GitLab, etc.)
   */
  private async analyzeRepositoryContent(
    url: string,
    urlObj: URL,
    urlAnalysis: ReturnType<typeof this.analyzeUrlPattern>,
    htmlContent: string
  ): Promise<DocResult> {
    const repoInfo = urlAnalysis.repoInfo!;
    const $ = cheerio.load(htmlContent);
    const evidence: DocEvidence[] = [];
    
    // Structure to collect information for LLM analysis
    const repoData: Record<string, any> = {
      platform: repoInfo.platform,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      isWiki: repoInfo.isWiki,
      isPages: repoInfo.isPages,
      readmeContent: '',
      directoryStructure: [],
      mdFilesCount: 0,
      docDirsCount: 0,
      languageFolders: [],
      pageTitle: $('title').text().trim(),
      mainContent: ''
    };
    
    // Check if it's a wiki page
    if (repoInfo.isWiki) {
      evidence.push({
        score: 3,
        reason: `${repoInfo.platform} wiki page (highly likely to be documentation)`
      });
    }
    
    // Count markdown files in the repository (if viewing a directory)
    if (repoInfo.platform === 'GitHub') {
      // Different selectors based on GitHub page type
      let fileRows: cheerio.Cheerio<any> = $();
      
      if (url.includes('/tree/')) {
        fileRows = $('.js-navigation-item');
      } else if (!url.includes('/blob/')) {
        fileRows = $('.js-navigation-item');
      }
      
      if (fileRows && fileRows.length) {
        const mdFiles: string[] = [];
        const docDirs: string[] = [];
        const langDirs: string[] = [];
        const structure: string[] = [];
        
        fileRows.each((_, el) => {
          const fileType = $(el).find('[role="rowheader"] svg').attr('aria-label') || '';
          const fileName = $(el).find('[role="rowheader"] a').text().trim();
          
          if (fileName) {
            structure.push(`${fileType === 'Directory' ? 'Dir: ' : 'File: '}${fileName}`);
            
            if (fileType === 'Directory') {
              // Check for potential documentation directories
              if (/^docs?$|^documentation$|^wiki$|^guide|^api|^reference/i.test(fileName)) {
                docDirs.push(fileName);
              }
              
              // Check for language directories
              if (/^(en|fr|es|de|it|pt|ru|zh|ja|ko|tr|ar)(-[a-z]{2})?$/i.test(fileName)) {
                langDirs.push(fileName);
              }
            } else if (fileName.toLowerCase().endsWith('.md')) {
              mdFiles.push(fileName);
            }
          }
        });
        
        repoData.directoryStructure = structure;
        repoData.mdFilesCount = mdFiles.length;
        repoData.docDirsCount = docDirs.length;
        repoData.languageFolders = langDirs;
        
        if (mdFiles.length > 3) {
          evidence.push({
            score: 2,
            reason: `Repository contains multiple markdown files (${mdFiles.length})`
          });
        }
        
        if (docDirs.length > 0) {
          evidence.push({
            score: 3,
            reason: `Repository contains documentation directories: ${docDirs.join(', ')}`
          });
        }
        
        if (langDirs.length > 0) {
          evidence.push({
            score: 2,
            reason: `Repository contains language folders: ${langDirs.join(', ')}`
          });
        }
      }
    }
    
    // Check for README content
    const readmeContent = $('.markdown-body').text() || $('.readme').text() || '';
    if (readmeContent) {
      repoData.readmeContent = readmeContent.substring(0, 2000); // Limit to 2000 chars
      
      // Check for documentation keywords in README
      const docKeywords = ['documentation', 'docs', 'guide', 'tutorial', 'reference', 'manual', 'api'];
      const docKeywordsPresent = docKeywords.filter(keyword => 
        readmeContent.toLowerCase().includes(keyword)
      );
      
      if (docKeywordsPresent.length > 0) {
        evidence.push({
          score: 1,
          reason: `README contains documentation keywords: ${docKeywordsPresent.join(', ')}`
        });
      }
      
      // Check for instructions in README
      if (/how to|installation|getting started|usage|example|setup|configuration/i.test(readmeContent)) {
        evidence.push({
          score: 1,
          reason: `README contains usage instructions`
        });
      }
    }
    
    // Use LLM to analyze repository if enabled
    let llmResult: DocResult | null = null;
    if (this.openai && this.config.enableLLM) {
      llmResult = await this.analyzeLLM_RepoContent(url, repoData);
    }
    
    // Calculate documentation likelihood from evidence
    let totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
    totalScore += urlAnalysis.evidence.reduce((sum, item) => sum + item.score, 0);
    
    let confidence = 0.5;
    let isDocumentation = totalScore > 0;
    
    // Adjust with LLM input if available
    if (llmResult) {
      // Weight LLM more heavily for repositories since pattern matching is less reliable
      confidence = 0.3 + (llmResult.confidence * 0.7);
      
      // If LLM strongly disagrees with heuristics, trust LLM
      if (Math.abs(llmResult.confidence - 0.5) > 0.3) {
        isDocumentation = llmResult.isDocumentation;
      } else {
        // Otherwise go with heuristic evidence
        isDocumentation = totalScore > 0;
      }
    } else {
      // Without LLM, confidence depends on strength of evidence
      confidence = 0.5 + Math.min(0.4, Math.abs(totalScore) * 0.05);
    }
    
    return {
      isDocumentation,
      confidence,
      source: llmResult ? 'repo_analysis_with_llm' : 'repo_analysis',
      details: {
        repoInfo,
        evidence,
        urlEvidence: urlAnalysis.evidence,
        llmAnalysis: llmResult?.details || null
      }
    };
  }
  
  /**
   * Analyze content from a dedicated documentation site
   */
  private async analyzeDedicatedDocsContent(
    url: string,
    urlObj: URL,
    urlAnalysis: ReturnType<typeof this.analyzeUrlPattern>,
    htmlContent: string
  ): Promise<DocResult> {
    const $ = cheerio.load(htmlContent);
    const evidence: DocEvidence[] = [];
    
    // Structure to collect information for LLM analysis
    const pageData: Record<string, any> = {
      title: $('title').text().trim(),
      metaDescription: $('meta[name="description"]').attr('content') || '',
      h1: $('h1').first().text().trim(),
      headings: $('h1, h2, h3').map((_, el) => $(el).text().trim()).get().slice(0, 10),
      sidebarPresent: false,
      sidebarItems: [],
      hasCodeBlocks: false,
      hasSearch: false,
      contentSample: ''
    };
    
    // Extract page features
    
    // Check title and meta for documentation keywords
    const docKeywords = ['documentation', 'docs', 'guide', 'tutorial', 'reference', 'manual', 'api', 'help', 'learn'];
    
    // Check title
    if (docKeywords.some(keyword => pageData.title.toLowerCase().includes(keyword))) {
      evidence.push({
        score: 2,
        reason: `Page title contains documentation keyword`
      });
    }
    
    // Check meta description
    if (docKeywords.some(keyword => pageData.metaDescription.toLowerCase().includes(keyword))) {
      evidence.push({
        score: 1,
        reason: `Meta description contains documentation keyword`
      });
    }
    
    // Check for sidebar (common in documentation sites)
    const potentialSidebars = $('.sidebar, .toc, .nav-sidebar, .navigation, nav.menu, .docs-menu, .doc-sidebar, aside');
    if (potentialSidebars.length > 0) {
      pageData.sidebarPresent = true;
      
      // Get menu items from sidebar
      const menuItems = potentialSidebars.find('a').map((_, el) => $(el).text().trim()).get().slice(0, 15);
      pageData.sidebarItems = menuItems;
      
      evidence.push({
        score: 2,
        reason: `Page has documentation-style sidebar/navigation`
      });
      
      // Check if sidebar items suggest documentation
      if (menuItems.some(item => 
        /getting started|introduction|overview|guide|api|reference|examples?|tutorial/i.test(item)
      )) {
        evidence.push({
          score: 2,
          reason: `Sidebar contains typical documentation sections`
        });
      }
    }
    
    // Check for code blocks (common in technical documentation)
    const codeBlocks = $('pre code, .highlight, .code-sample, .code-example, .hljs');
    if (codeBlocks.length > 0) {
      pageData.hasCodeBlocks = true;
      evidence.push({
        score: 2,
        reason: `Page contains code blocks/examples (${codeBlocks.length})`
      });
    }
    
    // Check for search functionality (common in docs)
    const searchElements = $('input[type="search"], .search-box, .search-input, .search-form, [placeholder*="search"]');
    if (searchElements.length > 0) {
      pageData.hasSearch = true;
      evidence.push({
        score: 1,
        reason: `Page has search functionality`
      });
    }
    
    // Check for documentation version selector (common in technical docs)
    const versionSelectors = $('select:contains("version"), .version-selector, [aria-label*="version"]');
    if (versionSelectors.length > 0) {
      evidence.push({
        score: 2,
        reason: `Page has version selector`
      });
    }
    
    // Check main content
    let mainContent = '';
    // Try to identify main content area using common selectors
    const contentSelectors = [
      'main', 'article', '.content', '.main-content', 
      '.documentation-content', '.docs-content', '.markdown-body'
    ];
    
    for (const selector of contentSelectors) {
      if ($(selector).length) {
        mainContent = $(selector).text().trim();
        break;
      }
    }
    
    // If no main content found, take a reasonable default
    if (!mainContent) {
      mainContent = $('body').text().trim();
    }
    
    // Prepare content sample (limit size)
    pageData.contentSample = mainContent.substring(0, 2000);
    
    // Look for "last updated" or publication dates (common in docs)
    const dateRegex = /last updated|updated on|published on|last modified/i;
    if (dateRegex.test(mainContent)) {
      evidence.push({
        score: 1,
        reason: `Page shows last updated/modified date (common in docs)`
      });
    }
    
    // Check for pagination or "next/previous" links (common in tutorials/guides)
    const paginationElements = $('a:contains("Next"), a:contains("Previous"), .pagination, .pager');
    if (paginationElements.length > 0) {
      evidence.push({
        score: 1,
        reason: `Page has pagination or next/previous navigation`
      });
    }
    
    // Check for non-documentation elements
    const nonDocElements = [
      // E-commerce elements
      'add to cart', 'buy now', 'add to basket', 'checkout', 'shopping cart',
      // Marketing elements
      'subscribe now', 'sign up today', 'limited time offer', 'discount',
      // Social/blog elements
      'comments', 'leave a comment', 'share this post'
    ];
    
    for (const element of nonDocElements) {
      if (mainContent.toLowerCase().includes(element)) {
        evidence.push({
          score: -2,
          reason: `Page contains non-documentation element: "${element}"`
        });
        break;
      }
    }
    
// Use LLM to analyze page content if enabled
let llmResult: DocResult | null = null;
if (this.openai && this.config.enableLLM) {
  llmResult = await this.analyzeLLM_PageContent(url, pageData);
}

// Calculate documentation likelihood from evidence
let totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
totalScore += urlAnalysis.evidence.reduce((sum, item) => sum + item.score, 0);

let confidence = 0.5;
let isDocumentation = totalScore > 0;

// Adjust with LLM input if available
if (llmResult) {
  // For dedicated pages, weigh heuristics and LLM equally
  confidence = (0.5 + (totalScore * 0.05) + llmResult.confidence) / 2;
  // If confidence from LLM is strong, trust it more
  if (Math.abs(llmResult.confidence - 0.5) > 0.3) {
    isDocumentation = llmResult.isDocumentation;
  } else {
    isDocumentation = totalScore > 0;
  }
} else {
  // Without LLM, confidence depends on strength of evidence
  confidence = 0.5 + Math.min(0.4, Math.abs(totalScore) * 0.05);
}

// Ensure confidence is within bounds
confidence = Math.max(0.1, Math.min(0.95, confidence));

return {
  isDocumentation,
  confidence,
  source: llmResult ? 'page_analysis_with_llm' : 'page_analysis',
  details: {
    evidence,
    urlEvidence: urlAnalysis.evidence,
    pageFeatures: {
      title: pageData.title,
      hasCodeBlocks: pageData.hasCodeBlocks,
      hasSidebar: pageData.sidebarPresent,
      hasSearch: pageData.hasSearch
    },
    llmAnalysis: llmResult?.details || null
  }
};
}
}

/**
* Utility function to check if a URL is a documentation page
*/
export async function isDocUrl(url: string, options: Partial<DocDetectorConfig> = {}): Promise<boolean> {
const detector = new DocumentationDetector(options);
const result = await detector.isDocUrl(url);
return result.isDocumentation;
}

/**
* More detailed analysis function that returns confidence scores and reasons
*/
export async function analyzeDocUrl(url: string, options: Partial<DocDetectorConfig> = {}): Promise<DocResult> {
const detector = new DocumentationDetector(options);
return await detector.isDocUrl(url);
}

// Example usage
async function exampleUsage() {
// Simple boolean check
const isDoc = await isDocUrl("https://docs.python.org/3/");
console.log(`Is documentation: ${isDoc}`);

// Detailed analysis
const analysis = await analyzeDocUrl("https://github.com/axios/axios-docs", {
enableLLM: true,
openaiApiKey: process.env.OPENAI_API_KEY,
logDetails: true
});

console.log(JSON.stringify(analysis, null, 2));
}

// Only run examples if this file is executed directly
if (require.main === module) {
exampleUsage().catch(console.error);
}