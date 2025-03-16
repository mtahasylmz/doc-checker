import axios from 'axios';
import * as cheerio from 'cheerio';
import { OpenAI } from 'openai';
import * as path from 'path';

// Configuration interface
interface Config {
  llmApiKey: string;
  llmModel: string;
  enableLLM: boolean;
  maxUrlContentLength: number;
  requestTimeout: number;
  cacheTTL: number;
  userAgent: string;
  debug: boolean;
}

// Default configuration
const DEFAULT_CONFIG: Config = {
  llmApiKey: process.env.OPENAI_API_KEY || '',
  llmModel: 'gpt-4o',
  enableLLM: true,
  maxUrlContentLength: 500000,
  requestTimeout: 10000,
  cacheTTL: 86400, // 24 hours in seconds
  userAgent: 'Documentation-Validator/1.0',
  debug: false
};

// Result interfaces
interface DocResult {
  isDocumentation: boolean;
  confidence: number;
  source: string;
  details: Record<string, any>;
}

interface DocEvidence {
  score: number;
  reason: string;
}

interface CacheEntry {
  result: DocResult;
  timestamp: number;
}

/**
 * DocumentationUrlValidator - A class to determine if a URL points to documentation
 */
class DocumentationUrlValidator {
  private config: Config;
  private openai: OpenAI | null = null;
  private cache: Map<string, CacheEntry> = new Map();
  private debugLog: string[] = [];

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize OpenAI client if enabled and API key provided
    if (this.config.enableLLM && this.config.llmApiKey) {
      this.openai = new OpenAI({
        apiKey: this.config.llmApiKey,
      });
    }
  }

  /**
   * Main method to check if a URL points to documentation
   */
  public async isDocUrl(url: string): Promise<boolean | DocResult> {
    this.log(`Analyzing URL: ${url}`);
    
    try {
      // Validate URL format
      if (!this.isValidUrlFormat(url)) {
        throw new Error(`Invalid URL format: ${url}`);
      }
      
      // Check cache
      const cached = this.checkCache(url);
      if (cached) {
        this.log(`Cache hit for ${url}`);
        return cached;
      }
      
      // Parse URL for analysis
      const urlObj = new URL(url);
      
      // Initial result object
      const result: DocResult = {
        isDocumentation: false,
        confidence: 0,
        source: 'initial',
        details: {}
      };
      
      // Step 1: URL pattern analysis
      const urlAnalysis = this.analyzeUrlPattern(urlObj);
      result.details.urlAnalysis = urlAnalysis;
      
      // If URL pattern is very strong indicator, we might not need further checks
      if (urlAnalysis.isStrongDocSignal) {
        result.isDocumentation = true;
        result.confidence = 0.85;
        result.source = 'url_pattern';
        this.saveToCache(url, result);
        return this.returnResult(result);
      }
      
      // If URL pattern is very strong negative indicator, we might not need further checks
      if (urlAnalysis.isStrongNonDocSignal) {
        result.isDocumentation = false;
        result.confidence = 0.85;
        result.source = 'url_pattern';
        this.saveToCache(url, result);
        return this.returnResult(result);
      }
      
      // Step 2: Content analysis based on URL type
      const contentResult = await this.analyzeContent(url, urlObj, urlAnalysis);
      
      // Merge content analysis with our result
      result.isDocumentation = contentResult.isDocumentation;
      result.confidence = contentResult.confidence;
      result.source = contentResult.source;
      result.details = { ...result.details, ...contentResult.details };
      
      // Save result to cache
      this.saveToCache(url, result);
      
      return this.returnResult(result);
      
    } catch (error) {
      this.log(`Error analyzing URL ${url}: ${error}`, true);
      return false;
    }
  }
  
  /**
   * Analyze URL pattern to detect documentation indicators
   */
  private analyzeUrlPattern(urlObj: URL): {
    isLikelyDoc: boolean,
    isStrongDocSignal: boolean,
    isStrongNonDocSignal: boolean,
    repoInfo?: {
      platform: string,
      owner: string,
      repo: string,
      isWiki: boolean,
      isPages: boolean,
      isReadme: boolean,
      path: string
    },
    evidence: DocEvidence[]
  } {
    const { hostname, pathname, searchParams } = urlObj;
    const evidence: DocEvidence[] = [];
    let isStrongDocSignal = false;
    let isStrongNonDocSignal = false;
    
    // Check for documentation keywords in hostname
    const docHostnamePatterns = [
      /^docs?\./, // docs.example.com
      /\.docs?\./, // api.docs.example.com
      /^developer\./, // developer.example.com
      /^dev\./, // dev.example.com
      /^reference\./, // reference.example.com
      /^api\./, // api.example.com
      /^learn\./, // learn.example.com
      /^help\./, // help.example.com
      /^support\./, // support.example.com
      /^wiki\./ // wiki.example.com
    ];
    
    for (const pattern of docHostnamePatterns) {
      if (pattern.test(hostname)) {
        evidence.push({
          score: 3,
          reason: `Hostname matches documentation pattern: ${pattern}`
        });
        isStrongDocSignal = true;
        break;
      }
    }
    
    // Check for documentation platforms
    const docPlatforms = [
      'readthedocs.io', 'readthedocs.org',
      'gitbook.io', 'gitbook.com',
      'docusaurus.io',
      'mkdocs.org',
      'docsify.js.org',
      'docz.site',
      'vuepress.vuejs.org',
      'storybook.js.org',
      'swagger.io'
    ];
    
    for (const platform of docPlatforms) {
      if (hostname.includes(platform)) {
        evidence.push({
          score: 4,
          reason: `Hosted on documentation platform: ${platform}`
        });
        isStrongDocSignal = true;
        break;
      }
    }
    
    // Check for documentation keywords in path
    const docPathPatterns = [
      /\/docs?\/?$/i, // /docs or /doc
      /\/docs?\//, // /docs/something
      /\/documentation\/?/i,
      /\/reference\/?/i,
      /\/guides?\/?/i,
      /\/tutorials?\/?/i,
      /\/learn\/?/i,
      /\/manual\/?/i,
      /\/help\/?/i,
      /\/api-?docs?\/?/i, // /api-docs or /apidocs
      /\/api\/docs?\/?/i, // /api/docs
      /\/developer\/?/i
    ];
    
    for (const pattern of docPathPatterns) {
      if (pattern.test(pathname)) {
        evidence.push({
          score: 2,
          reason: `Path matches documentation pattern: ${pattern}`
        });
        break;
      }
    }
    
    // Check for documentation file extensions
    const docFileExtensions = /\.(md|html?|txt|pdf|rst|adoc|asciidoc|dita|wiki)$/i;
    if (docFileExtensions.test(pathname)) {
      evidence.push({
        score: 1,
        reason: `Path ends with documentation file extension`
      });
    }
    
    // Check for non-documentation patterns
    const nonDocPathPatterns = [
      /\/shop\/?/i,
      /\/store\/?/i,
      /\/cart\/?/i,
      /\/checkout\/?/i,
      /\/buy\/?/i,
      /\/pricing\/?/i,
      /\/login\/?/i,
      /\/signup\/?/i,
      /\/register\/?/i,
      /\/account\/?/i,
      /\/blog\/[^\/]+\/?$/i, // Single blog post
      /\/news\/[^\/]+\/?$/i, // Single news item
      /\/about\/?$/i,
      /\/contact\/?$/i
    ];
    
    for (const pattern of nonDocPathPatterns) {
      if (pattern.test(pathname)) {
        evidence.push({
          score: -3,
          reason: `Path matches non-documentation pattern: ${pattern}`
        });
        isStrongNonDocSignal = true;
        break;
      }
    }
    
    // Specific checking for code repository platforms
    const repoInfo = this.checkRepositoryPlatform(urlObj);
    if (repoInfo) {
      if (repoInfo.isWiki || repoInfo.isPages) {
        evidence.push({
          score: 3,
          reason: `${repoInfo.platform} ${repoInfo.isWiki ? 'wiki' : 'pages'} (likely documentation)`
        });
        isStrongDocSignal = true;
      } else if (repoInfo.isReadme) {
        evidence.push({
          score: 1,
          reason: `${repoInfo.platform} README file (possible documentation)`
        });
      } else if (pathname.match(/\/blob\/.*\.(md|rst|adoc|asciidoc)$/i)) {
        evidence.push({
          score: 1,
          reason: `${repoInfo.platform} documentation file`
        });
      } else if (!pathname.includes('/blob/') && !pathname.includes('/tree/')) {
        // Repository root
        evidence.push({
          score: -1,
          reason: `${repoInfo.platform} repository root (less likely to be dedicated documentation)`
        });
      }
    }
    
    // Calculate if URL is likely documentation based on evidence
    const totalScore = evidence.reduce((sum, item) => sum + item.score, 0);
    const isLikelyDoc = totalScore > 0;
    
    return {
      isLikelyDoc,
      isStrongDocSignal,
      isStrongNonDocSignal,
      repoInfo,
      evidence
    };
  }
  
  /**
   * Check if URL is from a code repository platform like GitHub
   */
  private checkRepositoryPlatform(urlObj: URL): {
    platform: string,
    owner: string,
    repo: string,
    isWiki: boolean,
    isPages: boolean,
    isReadme: boolean,
    path: string
  } | null {
    const { hostname, pathname } = urlObj;
    
    // GitHub
    if (hostname === 'github.com' || hostname.endsWith('.github.io')) {
      const githubPathMatch = pathname.match(/^\/([^\/]+)\/([^\/]+)(\/.*)?$/);
      
      if (githubPathMatch || hostname.endsWith('.github.io')) {
        let owner = '';
        let repo = '';
        let path = '';
        
        if (hostname.endsWith('.github.io')) {
          owner = hostname.replace('.github.io', '');
          repo = pathname.split('/')[1] || '';
          path = '/' + pathname.split('/').slice(2).join('/');
        } else {
          owner = githubPathMatch![1];
          repo = githubPathMatch![2];
          path = githubPathMatch![3] || '';
        }
        
        return {
          platform: 'GitHub',
          owner,
          repo,
          isWiki: pathname.includes('/wiki/'),
          isPages: hostname.endsWith('.github.io') || path.startsWith('/docs/') || path.startsWith('/doc/'),
          isReadme: pathname.endsWith('README.md'),
          path
        };
      }
    }
    
    // GitLab
    if (hostname === 'gitlab.com' || hostname.includes('.gitlab.io')) {
      const gitlabPathMatch = pathname.match(/^\/([^\/]+)\/([^\/]+)(\/.*)?$/);
      
      if (gitlabPathMatch || hostname.includes('.gitlab.io')) {
        let owner = '';
        let repo = '';
        let path = '';
        
        if (hostname.includes('.gitlab.io')) {
          const hostnameParts = hostname.split('.');
          owner = hostnameParts[0];
          repo = hostnameParts.length > 2 ? hostnameParts[1] : pathname.split('/')[1] || '';
          path = hostnameParts.length > 2 
            ? pathname 
            : '/' + pathname.split('/').slice(2).join('/');
        } else {
          owner = gitlabPathMatch![1];
          repo = gitlabPathMatch![2];
          path = gitlabPathMatch![3] || '';
        }
        
        return {
          platform: 'GitLab',
          owner,
          repo,
          isWiki: pathname.includes('/wikis/'),
          isPages: hostname.includes('.gitlab.io') || path.startsWith('/docs/') || path.startsWith('/doc/'),
          isReadme: pathname.endsWith('README.md'),
          path
        };
      }
    }
    
    // Bitbucket
    if (hostname === 'bitbucket.org') {
      const bitbucketPathMatch = pathname.match(/^\/([^\/]+)\/([^\/]+)(\/.*)?$/);
      
      if (bitbucketPathMatch) {
        const owner = bitbucketPathMatch[1];
        const repo = bitbucketPathMatch[2];
        const path = bitbucketPathMatch[3] || '';
        
        return {
          platform: 'Bitbucket',
          owner,
          repo,
          isWiki: pathname.includes('/wiki/'),
          isPages: false,
          isReadme: pathname.endsWith('README.md'),
          path
        };
      }
    }
    
    return null;
  }
  
  /**
   * Analyze content based on URL type (repository or dedicated docs)
   */
  private async analyzeContent(
    url: string, 
    urlObj: URL, 
    urlAnalysis: ReturnType<typeof this.analyzeUrlPattern>
  ): Promise<DocResult> {
    // Initialize result with URL analysis data
    const result: DocResult = {
      isDocumentation: urlAnalysis.isLikelyDoc,
      confidence: 0.5,
      source: 'url_pattern',
      details: {
        urlEvidence: urlAnalysis.evidence
      }
    };
    
    try {
      // Fetch page content
      const { data, status } = await axios.get(url, {
        timeout: this.config.requestTimeout,
        maxContentLength: this.config.maxUrlContentLength,
        headers: {
          'User-Agent': this.config.userAgent
        }
      });
      
      if (status !== 200 || typeof data !== 'string') {
        throw new Error(`Failed to fetch content: ${status}`);
      }
      
      // Different analysis based on whether it's a repository or dedicated docs site
      if (urlAnalysis.repoInfo) {
        return await this.analyzeRepositoryContent(url, urlObj, urlAnalysis, data);
      } else {
        return await this.analyzeDedicatedDocsContent(url, urlObj, urlAnalysis, data);
      }
    } catch (error) {
        this.log(`Failed to fetch or analyze page content: ${error}`, true);
        
        // If we can't analyze the content, but URL analysis was promising, we'll trust that
        if (urlAnalysis.isLikelyDoc) {
          result.confidence = 0.6;
          result.isDocumentation = true;
          result.source = 'url_pattern_fallback';
        } else {
          result.confidence = 0.6;
          result.isDocumentation = false;
          result.source = 'url_pattern_fallback';
        }
        
        return result;
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
        let fileRows: Cheerio;
        
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
          llmAnalysis: llmResult?.details ||