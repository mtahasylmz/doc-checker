import axios from 'axios';
import * as cheerio from 'cheerio';
import { OpenAI } from 'openai';
import 'dotenv/config';

// Configuration
interface Config {
  // LLM settings
  llmApiKey: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  
  // Rate limiting
  maxRequestsPerMinute: number;
  maxUrlContentLength: number; // Characters to analyze
  
  // Confidence thresholds
  minHeuristicConfidence: number;
  minLlmConfidence: number;
  
  // Cache settings
  cacheTtl: number; // seconds
}

const DEFAULT_CONFIG: Config = {
  llmApiKey: process.env.OPENAI_API_KEY || '',
  llmModel: 'gpt-4o',
  llmMaxTokens: 150,
  llmTemperature: 0.1,
  
  maxRequestsPerMinute: 10,
  maxUrlContentLength: 50000, // ~12.5k tokens max
  
  minHeuristicConfidence: 0.7,
  minLlmConfidence: 0.8,
  
  cacheTtl: 86400, // 24 hours
};

// Cache for URL results
interface CacheEntry {
  result: boolean;
  timestamp: number;
}

class DocumentationUrlValidator {
  private config: Config;
  private cache: Map<string, CacheEntry> = new Map();
  private requestCount: number = 0;
  private resetTime: number = Date.now() + 60000; // 1 minute from now
  private openai: OpenAI;
  
  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.llmApiKey) {
      throw new Error('LLM API key is required');
    }
    
    this.openai = new OpenAI({
      apiKey: this.config.llmApiKey,
    });
  }
  
  // Main function to check if a URL is a documentation URL

  public async isDocUrl(url: string): Promise<boolean> {
    try {
      // Validate URL format
      if (!this.isValidUrl(url)) {
        throw new Error('Invalid URL format');
      }
      
      // Check cache
      const cachedResult = this.checkCache(url);
      if (cachedResult !== null) {
        return cachedResult;
      }
      
      // Apply rate limiting
      await this.applyRateLimit();
      
      // First, use fast heuristics
      const { confidence, isDoc } = await this.applyHeuristics(url);
      
      // If confidence is high enough from heuristics, return result
      if (confidence >= this.config.minHeuristicConfidence) {
        this.cacheResult(url, isDoc);
        return isDoc;
      }
      
      // If heuristics weren't confident enough, use LLM
      const llmResult = await this.askLlm(url);
      this.cacheResult(url, llmResult);
      return llmResult;
      
    } catch (error) {
      console.error(`Error checking if ${url} is a doc URL:`, error);
      return false;
    }
  }
  
  /**
   * Validate URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  /**
   * Check if URL exists in cache and is still valid
   */
  private checkCache(url: string): boolean | null {
    const entry = this.cache.get(url);
    
    if (entry && (Date.now() - entry.timestamp) < this.config.cacheTtl * 1000) {
      return entry.result;
    }
    
    return null;
  }
  
  /**
   * Store result in cache
   */
  private cacheResult(url: string, isDoc: boolean): void {
    this.cache.set(url, {
      result: isDoc,
      timestamp: Date.now()
    });
  }
  
  /**
   * Apply rate limiting to API requests
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Reset counter if minute has passed
    if (now > this.resetTime) {
      this.requestCount = 0;
      this.resetTime = now + 60000;
    }
    
    // Check if we're over the limit
    if (this.requestCount >= this.config.maxRequestsPerMinute) {
      const waitTime = this.resetTime - now;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      // Reset after waiting
      this.requestCount = 0;
      this.resetTime = Date.now() + 60000;
    }
    
    this.requestCount++;
  }
  
  /**
   * Apply heuristic rules to determine if URL is documentation
   */
  private async applyHeuristics(url: string): Promise<{ confidence: number; isDoc: boolean }> {
    // Initialize confidence and result
    let confidenceScore = 0.5; // Start neutral
    let docEvidence = 0;
    let nonDocEvidence = 0;
    
    // Extract components from URL
    const urlObj = new URL(url);
    const { hostname, pathname, searchParams } = urlObj;
    
    // Check URL patterns
    // 1. Common documentation subdomains and paths
    const docSubdomains = ['docs', 'documentation', 'developer', 'dev', 'api', 'support', 'help', 'learn', 'wiki'];
    const docKeywords = ['doc', 'docs', 'documentation', 'manual', 'guide', 'tutorial', 'reference', 'api', 'sdk', 'howto', 'how-to', 'help'];
    
    // Check if hostname contains documentation-related terms
    if (docSubdomains.some(subDomain => hostname.includes(subDomain))) {
      docEvidence += 2;
    }
    
    // Check if pathname contains documentation-related terms
    if (docKeywords.some(keyword => pathname.toLowerCase().includes(keyword))) {
      docEvidence += 2;
    }
    
    // Check for common documentation file extensions
    if (pathname.match(/\.(md|html|htm|txt|pdf|rst|adoc|wiki|dita)$/i)) {
      docEvidence += 1;
    }
    
    // Check for GitHub, GitLab, or BitBucket specific patterns
    if (hostname.includes('github.com') || hostname.includes('gitlab.com') || hostname.includes('bitbucket.org')) {
      if (pathname.includes('wiki') || pathname.includes('pages') || pathname.includes('docs')) {
        docEvidence += 2;
      } else if (pathname.endsWith('README.md')) {
        docEvidence += 1;
      } else if (pathname.match(/\/blob\/.*\.(md|rst|adoc)$/)) {
        docEvidence += 1;
      } else if (!pathname.includes('/blob/') && !pathname.includes('/tree/')) {
        // Likely a repo root, less likely to be dedicated documentation
        nonDocEvidence += 1;
      }
    }
    
    // Check for popular documentation platforms
    const docPlatforms = ['readthedocs.io', 'readthedocs.org', 'gitbook.io', 'mkdocs.org', 'docsify.js.org', 'vuepress.vuejs.org', 'docusaurus.io'];
    if (docPlatforms.some(platform => hostname.includes(platform))) {
      docEvidence += 3;
    }
    
    // Try to fetch and analyze page content if URL doesn't already have strong indicators
    if (docEvidence - nonDocEvidence < 3) {
      try {
        const { data } = await axios.get(url, { 
          timeout: 5000,
          headers: { 'User-Agent': 'Documentation-Checker/1.0' },
          maxContentLength: this.config.maxUrlContentLength 
        });
        
        // Only process if it's an HTML page
        if (typeof data === 'string') {
          const $ = cheerio.load(data);
          
          // Check title for documentation keywords
          const title = $('title').text().toLowerCase();
          if (docKeywords.some(keyword => title.includes(keyword))) {
            docEvidence += 2;
          }
          
          // Check meta description for documentation keywords
          const metaDescription = $('meta[name="description"]').attr('content')?.toLowerCase() || '';
          if (docKeywords.some(keyword => metaDescription.includes(keyword))) {
            docEvidence += 1;
          }
          
          // Check for common documentation page structure
          const hasSidebar = $('.sidebar, .toc, .nav-sidebar, .navigation, nav.menu').length > 0;
          if (hasSidebar) {
            docEvidence += 1;
          }
          
          // Check for search functionality (common in docs)
          const hasSearch = $('input[type="search"], .search-box, .search-input, .search-form').length > 0;
          if (hasSearch) {
            docEvidence += 1;
          }
          
          // Check for code blocks/snippets (common in technical docs)
          const hasCodeBlocks = $('pre code, .highlight, .code-sample, .code-example').length > 0;
          if (hasCodeBlocks) {
            docEvidence += 1;
          }
          
          // Look for headings that suggest it's documentation
          const headingsText = $('h1, h2, h3').map((i, el) => $(el).text().toLowerCase()).get().join(' ');
          if (docKeywords.some(keyword => headingsText.includes(keyword))) {
            docEvidence += 1;
          }
          
          // Check for signs it's not documentation
          // E.g., shopping cart, pricing pages, etc.
          const nonDocKeywords = ['cart', 'checkout', 'buy now', 'pricing', 'subscribe', 'sign up', 'login'];
          if (nonDocKeywords.some(keyword => data.toLowerCase().includes(keyword))) {
            nonDocEvidence += 1;
          }
        }
      } catch (error) {
        // Failed to fetch or process page, slightly decrease confidence
        confidenceScore -= 0.1;
      }
    }
    
    // Calculate final confidence score
    // More evidence increases confidence
    const totalEvidence = docEvidence + nonDocEvidence;
    if (totalEvidence > 0) {
      confidenceScore = 0.5 + ((docEvidence - nonDocEvidence) / (totalEvidence * 2));
    }
    
    // Ensure confidence is between 0 and 1
    confidenceScore = Math.max(0, Math.min(1, confidenceScore));
    
    return {
      confidence: confidenceScore,
      isDoc: docEvidence > nonDocEvidence
    };
  }
  
  /**
   * Use LLM to determine if URL is documentation
   */
  private async askLlm(url: string): Promise<boolean> {
    try {
      // First try to get minimal content from the URL
      let pageContent = '';
      try {
        const { data } = await axios.get(url, { 
          timeout: 5000,
          headers: { 'User-Agent': 'Documentation-Checker/1.0' },
          maxContentLength: this.config.maxUrlContentLength 
        });
        
        if (typeof data === 'string') {
          const $ = cheerio.load(data);
          // Extract title, meta description, and first paragraphs
          const title = $('title').text();
          const description = $('meta[name="description"]').attr('content') || '';
          const h1 = $('h1').first().text();
          
          // Get first few paragraphs, truncated
          const paragraphs = $('p').slice(0, 3).map((i, el) => $(el).text()).get().join('\n\n');
          
          pageContent = `Title: ${title}\nDescription: ${description}\nH1: ${h1}\nContent preview:\n${paragraphs.substring(0, 500)}`;
        }
      } catch (error) {
        // If we can't fetch content, just use the URL itself
        pageContent = '';
      }
      const response = await this.openai.chat.completions.create({
        model: this.config.llmModel,
        messages: [
          {
            role: 'system',
            content: `You are an AI specialized in determining if a URL points to technical documentation.
            
Documentation websites typically:
1. Focus on explaining how to use software, APIs, libraries, frameworks, or hardware
2. Contain tutorials, guides, references, or API documentation
3. Are organized to help users learn or find specific information
4. May include code examples, diagrams, and technical explanations

Non-documentation websites are typically:
1. Marketing pages, homepages, blogs, stores, or social media
2. Focus on selling products/services rather than explaining how to use them
3. Are news articles, personal websites, or company information pages

You must respond with ONLY a JSON object containing:
1. "isDocumentation": true/false
2. "confidence": number between 0-1
3. "reasoning": brief explanation (max 2 sentences)

If you cannot tell from the information provided, lean toward false with lower confidence.`
          },
          {
            role: 'user',
            content: `URL: ${url}${pageContent ? `\n\nPage content preview:\n${pageContent}` : ''}\n\nIs this a documentation URL? Respond with the JSON format specified.`
          }
        ],
        temperature: this.config.llmTemperature,
        max_tokens: this.config.llmMaxTokens,
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }
      
      try {
        const result = JSON.parse(content);
        // Check if response meets confidence threshold
        if (typeof result.isDocumentation === 'boolean' && 
            typeof result.confidence === 'number' && 
            result.confidence >= this.config.minLlmConfidence) {
          return result.isDocumentation;
        } else {
          // If confidence is too low, default to false
          return false;
        }
      } catch (e) {
        console.error('Failed to parse LLM response:', e);
        return false;
      }
    } catch (error) {
      console.error('Error using LLM:', error);
      return false;
    }
  }
}

// Create a function that can be imported and used easily
export async function isDocUrl(url: string, config: Partial<Config> = {}): Promise<boolean> {
  const validator = new DocumentationUrlValidator(config);
  return await validator.isDocUrl(url);
}

// Example usage (can be removed or commented out)
async function runExamples() {
  const validator = new DocumentationUrlValidator();
  
  const examples = [
    "https://github.com/axios/axios",
    "https://github.com/axios/axios-docs",
    "https://docs.github.com/en",
    "https://reactjs.org/docs/getting-started.html",
    "https://www.amazon.com/products/item123",
    "https://nodejs.org/api/documentation.html"
  ];
  
  for (const url of examples) {
    const result = await validator.isDocUrl(url);
    console.log(`${url} -> ${result ? 'Documentation' : 'Not documentation'}`);
    }
}
runExamples().catch(console.error);