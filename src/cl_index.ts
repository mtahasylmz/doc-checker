import { analyzeDocUrl } from './doc-check-claude';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function runDetector() {
  const urlsToTest = [
    "https://docs.python.org/3/",
    "https://reactjs.org/docs/getting-started.html",
    "https://github.com/axios/axios",
    "https://github.com/axios/axios-docs",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    "https://en.wikipedia.org/wiki/JavaScript",
    "https://www.amazon.com/b?node=283155",
    "https://medium.com/javascript-in-plain-english/20-javascript-concepts-you-should-know-as-a-developer-3ae84b8b7b40",
    "https://github.com/facebook/react/wiki/Examples",
  ];

  console.log("Testing Documentation URL Detector\n");
  
  for (const url of urlsToTest) {
    try {
      console.log(`Analyzing: ${url}`);
      const result = await analyzeDocUrl(url, {
        enableLLM: process.env.OPENAI_API_KEY ? true : false,
        openaiApiKey: process.env.OPENAI_API_KEY,
        logDetails: false
      });
      
      console.log(`Result: ${result.isDocumentation ? "✅ IS DOCUMENTATION" : "❌ NOT DOCUMENTATION"}`);
      console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`Source: ${result.source}`);
      
      // Log top evidence if available
      if (result.details?.evidence || result.details?.urlEvidence) {
        console.log("Top evidence:");
        const allEvidence = [
          ...(result.details.urlEvidence || []), 
          ...(result.details.evidence || [])
        ].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);
        
        allEvidence.forEach(item => {
          console.log(`  ${item.score > 0 ? '+' : '-'}${Math.abs(item.score)} ${item.reason}`);
        });
      }
      
      // Show LLM reasoning if available
      if (result.details?.llmAnalysis?.reasoning) {
        console.log(`LLM reasoning: ${result.details.llmAnalysis.reasoning}`);
      }
      
      console.log("\n---\n");
    } catch (error) {
      console.error(`Error analyzing ${url}: ${error}`);
      console.log("\n---\n");
    }
  }
}

runDetector().catch(console.error);