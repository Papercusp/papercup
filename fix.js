const fs = require('fs');
let content = fs.readFileSync('packages/operator-core/lib/search/refill-prose-vectors-727.test.ts', 'utf8');
content = content.replace(/\/\/ @ts-ignore — pure JS script, no \.d\.ts\nimport \{ classifyPass \} from '\.\.\/\.\.\/\.\.\/\.\.\/scripts\/refill-prose-vectors-727\.mjs';/s, `// eslint-disable-next-line @typescript-eslint/ban-ts-comment\nimport {\n  classifyPass,\n// @ts-expect-error — pure JS script\n} from '../../../../scripts/refill-prose-vectors-727.mjs';`);
fs.writeFileSync('packages/operator-core/lib/search/refill-prose-vectors-727.test.ts', content);
