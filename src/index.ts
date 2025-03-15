import { isDocUrl } from './doc-check';

async function main() {
  const result1 = await isDocUrl("https://github.com/axios/axios");
  const result2 = await isDocUrl("https://github.com/axios/axios-docs");
  
  console.log(`Example 1: ${result1}`);
  console.log(`Example 2: ${result2}`);
}

main().catch(console.error);