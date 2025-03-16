import axios from 'axios';
import * as cheerio from 'cheerio';
import 'dotenv/config';
import { OpenAI } from 'openai';

/**
 * Configuration for DocumentationUrlValidator
 */
interface Config {
  // LLM settings
  llmApiKey: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;

  // Rate limiting
  maxRequestsPerMinute: number;

  // Cache settings
  cacheTtl: number; // seconds

  // Page content length limit
  maxUrlContentLength: number;

  // For final verdict, how confident must LLM be
  minLlmConfidence: number;
}

const DEFAULT_CONFIG: Config = {
  llmApiKey: process.env.OPENAI_API_KEY || '',
  llmModel: 'gpt-4',
  llmMaxTokens: 200,
  llmTemperature: 0.0,

  maxRequestsPerMinute: 10,
  cacheTtl: 86400, // 24 hours
  maxUrlContentLength: 500_000_000,
  minLlmConfidence: 0.7,
};

/**
 * Simple cache entry
 */
interface CacheEntry {
  result: boolean;       // is it doc or not
  timestamp: number;     // record insertion time
}

export class DocumentationUrlValidator {
  private cache: Map<string, CacheEntry> = new Map();
  private requestCount = 0;
  private resetTime = Date.now() + 60_000;
  private openai: OpenAI;
  private config: Config; // Change from Partial<Config> to Config

  constructor(configOptions: Partial<Config> = {}) {
    // Merge with defaults
    this.config = { ...DEFAULT_CONFIG, ...configOptions } as Config;

    if (!this.config.llmApiKey) {
      throw new Error('LLM API key is required.');
    }

    // Setup OpenAI client
    this.openai = new OpenAI({ apiKey: this.config.llmApiKey });
  }

  // -----------------------
  // Public entry point
  // -----------------------
  public async isDocUrl(url: string): Promise<boolean> {
    // 1. Basic checks
    if (!this.isValidUrlFormat(url)) return false;

    // 2. Check cache
    const cached = this.getCachedResult(url);
    if (cached !== null) return cached;

    // 3. Rate limit
    await this.applyRateLimit();

    // 4. Evaluate type (Git-based vs. potential standalone doc site)
    let isDocSite = false;
    try {
      if (this.isGitHost(url)) {
        // Git-based approach
        isDocSite = await this.evaluateGitBasedDoc(url);
      } else {
        // Dedicated doc site approach
        isDocSite = await this.evaluateDedicatedDocSite(url);
      }
    } catch (error) {
      console.error(`[ERROR] Evaluating URL: ${url}`, error);
      isDocSite = false;
    }

    // 5. Cache & return
    this.cacheResult(url, isDocSite);
    return isDocSite;
  }

  // ----------------------------------------------------
  // [ A ] Basic Helpers
  // ----------------------------------------------------

  private isValidUrlFormat(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private getCachedResult(url: string): boolean | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    const isExpired = (Date.now() - entry.timestamp) > (this.config.cacheTtl * 1000);
    return isExpired ? null : entry.result;
  }

  private cacheResult(url: string, result: boolean): void {
    this.cache.set(url, { result, timestamp: Date.now() });
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    if (now > this.resetTime) {
      this.requestCount = 0;
      this.resetTime = now + 60_000;
    }
    if (this.requestCount >= this.config.maxRequestsPerMinute) {
      const waitTime = this.resetTime - now;
      await new Promise((res) => setTimeout(res, waitTime));
      this.requestCount = 0;
      this.resetTime = Date.now() + 60_000;
    }
    this.requestCount++;
  }

  // ----------------------------------------------------
  // [ B ] Identify Git-based vs. dedicated doc site
  // ----------------------------------------------------

  private isGitHost(url: string): boolean {
    const { hostname } = new URL(url);
    // You can add more known git hosts here
    return (
      hostname.includes('github.com') ||
      hostname.includes('gitlab.com') ||
      hostname.includes('bitbucket.org')
    );
  }

  // ----------------------------------------------------
  // [ C ] Evaluate Git-based documentation
  // ----------------------------------------------------
  private async evaluateGitBasedDoc(url: string): Promise<boolean> {
    // Step 1: Check if the URL has doc-like subpaths or readme
    // (We’re using naive checks; in real code, you might use provider APIs to fetch file structure.)
    const lowerUrl = url.toLowerCase();
    const docIndicators = ['docs', 'readme', 'wiki', 'documentation', 'manual'];

    // Quick heuristic: if docIndicators appear in the path
    let foundIndicator = docIndicators.some((kw) => lowerUrl.includes(kw));
    let readmeContent = '';

    // Step 2: Attempt to fetch the raw HTML to see if we can gather file structure
    // or content from README directly
    let html = '';
    try {
      const resp = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'DocCheck/1.0' },
        maxContentLength: this.config.maxUrlContentLength,
      });
      html = typeof resp.data === 'string' ? resp.data : '';
    } catch (error) {
      // If we can’t fetch it at all, fallback to an LLM call with minimal context
      console.warn(`[WARN] Could not fetch Git-based repo page: ${url}`, error);
    }

    // Step 3: If we have HTML, look for file listings or .md references
    if (html) {
      // Attempt to parse using cheerio
      const $ = cheerio.load(html);

      // Gather all file/folder names
      const fileLinks: string[] = [];
      $('a').each((_i, el) => {
        const text = $(el).text().trim().toLowerCase();
        // If the link text or href ends with .md, record it
        if (text.endsWith('.md') || text.includes('.md')) {
          fileLinks.push(text);
        }
      });

      // If multiple .md files found, that’s a strong sign
      if (fileLinks.length > 2) {
        foundIndicator = true;
      }

      // Potentially retrieve README content from the page (GitHub style)
      // On GitHub, the README is often rendered in a <article> or <div id="readme"> block.
      // This is simplistic and may not always work:
      const readmeSelectors = ['article.markdown-body', '#readme', '.Box-body', '.repository-content'];
      for (const selector of readmeSelectors) {
        const readmeEl = $(selector).first();
        if (readmeEl.length) {
          // Gather text from that element
          readmeContent = readmeEl.text().substring(0, 2000); // limit to 2k chars
          if (readmeContent.toLowerCase().includes('documentation')) {
            foundIndicator = true;
          }
          break;
        }
      }
    }

    // Step 4: If still uncertain, ask the LLM with the partial file structure or README snippet
    // We combine the snippet into a single prompt
    if (!foundIndicator) {
      // The LLM approach
      return await this.runLlmCheck({
        url,
        approach: 'gitRepoDocs',
        additionalContext: readmeContent || 'No README content found.',
      });
    }

    // If we found enough indicators, let’s confirm with LLM anyway
    // (You could skip the LLM if docIndicators are obviously strong, but let’s do it for completeness.)
    return this.runLlmCheck({
      url,
      approach: 'gitRepoDocs',
      additionalContext: readmeContent || 'No README content found.',
    });
  }

  // ----------------------------------------------------
  // [ D ] Evaluate Dedicated Documentation Site
  // ----------------------------------------------------
  private async evaluateDedicatedDocSite(url: string): Promise<boolean> {
    // Step 1: Basic doc-like subdomain / path checks
    const docKeywords = ['doc', 'docs', 'documentation', 'manual', 'learn', 'book', 'guide', 'tutorial', 'reference', 'api'];
    const { hostname, pathname } = new URL(url);
    const combinedPath = `${hostname}${pathname}`.toLowerCase();

    let hasDocIndicators = docKeywords.some((kw) => combinedPath.includes(kw));

    // Step 2: Attempt to fetch the page, check for sidebars, code snippets, etc.
    let html = '';
    try {
      const resp = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'DocCheck/1.0' },
        maxContentLength: this.config.maxUrlContentLength,
      });
      html = typeof resp.data === 'string' ? resp.data : '';
    } catch (error) {
      console.warn(`[WARN] Could not fetch potential doc site: ${url}`, error);
      // If we can’t fetch, fallback to LLM with minimal context.
      return await this.runLlmCheck({ url, approach: 'dedicatedDocs', additionalContext: '' });
    }

    // Step 3: Parse HTML
    const $ = cheerio.load(html);

    // 3a. Check for sidebars
    const hasSidebar = $('.sidebar, .toc, .nav-sidebar, nav.menu, nav.sidebar').length > 0;

    // 3b. Check for code blocks/snippets
    const codeBlocks = $('pre code, .highlight, .code-block, code[class^="language-"]').length;
    const hasCodeSnippets = codeBlocks > 0;

    // 3c. Look at <title> or <meta name="description">
    const title = $('title').text().toLowerCase();
    const description = $('meta[name="description"]').attr('content')?.toLowerCase() || '';

    if (docKeywords.some((kw) => title.includes(kw)) || docKeywords.some((kw) => description.includes(kw))) {
      hasDocIndicators = true;
    }

    // 3d. Gather a brief page structure from sidebar or headings
    let sidebarStructure = '';
    if (hasSidebar) {
      // Grab top-level list items or headings in the sidebar
      const sideLinks: string[] = [];
      $('.sidebar li a, .toc li a, nav.menu a, nav.sidebar a').each((_i, el) => {
        const linkText = $(el).text().trim();
        if (linkText) sideLinks.push(linkText);
      });

      sidebarStructure = `Sidebar Items:\n${sideLinks.slice(0, 10).join('\n')}`; // limit to 10 for brevity
    }

    // 3e. Grab some paragraphs from the main content (for LLM)
    let contentSnippet = '';
    const paragraphs: string[] = [];
    $('p').slice(0, 3).each(function(_i, el) {
      paragraphs.push($(el).text());
      return true; // Explicitly return a boolean
    });
    contentSnippet = paragraphs.join('\n\n').substring(0, 1000);

    // Step 4: Combine all into an LLM check
    return this.runLlmCheck({
      url,
      approach: 'dedicatedDocs',
      additionalContext: [
        hasDocIndicators ? 'URL or Title has doc-like indicators.' : '',
        hasSidebar ? 'Found a sidebar element.' : 'No sidebar present.',
        hasCodeSnippets ? 'Found code blocks/snippets.' : 'No code blocks found.',
        `TITLE: ${title}`,
        `DESCRIPTION: ${description}`,
        sidebarStructure ? sidebarStructure : '',
        'Content Snippet:\n' + contentSnippet,
      ].join('\n\n'),
    });
  }

  // ----------------------------------------------------
  // [ E ] LLM-based final check
  // ----------------------------------------------------
  private async runLlmCheck(params: {
    url: string;
    approach: 'gitRepoDocs' | 'dedicatedDocs';
    additionalContext: string;
  }): Promise<boolean> {
    const { url, approach, additionalContext } = params;

    // Build prompt context
    const systemPrompt = `
You are an AI that decides if a URL is a documentation page. 
Consider two main categories:
1) Git-based doc repos (like GitHub) that hold multiple .md files, readmes, or wikis.
2) Dedicated doc sites with code examples, sidebars, or doc-like subdomains.

If you have limited or contradictory data, you may respond with a lower confidence.
Return answers in JSON with keys: "isDocumentation" (true/false), "confidence" (number 0-1), and "reasoning" (brief).
`.trim();

    const userPrompt = `
URL: ${url}
Type: ${approach}
Context:
${additionalContext}

Decide if this is likely a documentation page or repo. Return only JSON with structure:
{
  "isDocumentation": boolean,
  "confidence": number,
  "reasoning": string
}
`.trim();

    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: this.config.llmTemperature,
        max_tokens: this.config.llmMaxTokens,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No content in LLM response.');
      }

      // Attempt to parse JSON
      const parsed = JSON.parse(content);
      if (
        typeof parsed.isDocumentation === 'boolean' &&
        typeof parsed.confidence === 'number'
      ) {
        // If LLM is confident enough
        if (parsed.confidence >= this.config.minLlmConfidence) {
          return parsed.isDocumentation;
        }
      }
      // If not sure or confidence too low, default false
      return false;
    } catch (error) {
      console.error('[ERROR] LLM invocation failed:', error);
      // If we can’t parse or LLM fails, fallback to false
      return false;
    }
  }
}

/**
 * Utility function to check if a URL points to documentation
 * @param url The URL to check
 * @returns Promise resolving to true if the URL is documentation, false otherwise
 */
export async function isDocUrl(url: string): Promise<boolean> {
  const validator = new DocumentationUrlValidator();
  return await validator.isDocUrl(url);
}

// ----------------------------------------------------
// USAGE EXAMPLE
// ----------------------------------------------------
(async function runExamples() {
  const validator = new DocumentationUrlValidator();

  const urls = [
    'https://github.com/axios/axios',          // Likely not dedicated docs, but might have some doc content
    'https://github.com/axios/axios-docs',     // Possibly doc repo
    'https://docs.github.com/en',              // Dedicated doc domain
    'https://reactjs.org/docs/getting-started.html',
    'https://www.npmjs.com/package/axios',
    'https://nodejs.org/api/documentation.html',
  ];

  for (const url of urls) {
    const isDoc = await validator.isDocUrl(url);
    console.log(`${url} -> ${isDoc ? '[DOC]' : '[NOT DOC]'}`);
  }
})();
