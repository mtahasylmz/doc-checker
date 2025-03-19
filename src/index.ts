import { isDocUrl } from './doc-check.js';

async function main() : Promise<void>{
  const result1 = await isDocUrl("https://github.com/axios/axios");
  const result2 = await isDocUrl("https://github.com/axios/axios-docs");
  
  console.log(`Example 1: ${result1.isValid} and the reason is ${result1.reason}`);
  console.log(`Example 2: ${result2.isValid} and the reason is ${result2.reason}`);
}

main().catch(console.error);