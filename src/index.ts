import { isDocUrl } from './doc-check.js';

async function main() : Promise<void>{
  const result1 = await isDocUrl("https://github.com/axios/axios");
  const result2 = await isDocUrl("https://github.com/axios/axios-docs");
  const result3 = await isDocUrl("https://github.com/reactjs/react.dev");
  
  
  console.log(`Example 1: ${result1} `);
  console.log(`Example 2: ${result2} `);
  console.log(`Example 2: ${result3} `);
}

main().catch(console.error);