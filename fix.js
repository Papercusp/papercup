const fs = require('fs');
let content = fs.readFileSync('packages/operator-core/lib/trace-vite-externalized.test.ts', 'utf8');
content = content.replace(/import \{.*?\} from '\.\.\/\.\.\/\.\.\/scripts\/trace-vite-externalized\.mjs';/s, `// eslint-disable-next-line import/no-relative-packages\nimport {\n  reachableStatic,\n  computeEagerExternalized,\n  shortestStaticChain,\n  decideEager,\n  ALLOWED_EAGER_BUILTINS,\n  parseJsonFileArg,\n// @ts-expect-error — the .mjs script has no declaration file\n} from '../../../scripts/trace-vite-externalized.mjs';`);
fs.writeFileSync('packages/operator-core/lib/trace-vite-externalized.test.ts', content);
