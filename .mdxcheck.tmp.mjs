import { readFileSync } from 'node:fs';
import { findMdxCompileError, blankFrontmatter } from './packages/operator-core/lib/content-lint/mdx.ts';
const f = 'apps/operator-docs/src/content/docs/agent-insights/adding-a-derived-plan-frontmatter-scalar.mdx';
const src = blankFrontmatter(readFileSync(f, 'utf8'));
const err = await findMdxCompileError(src);
console.log(err ? ('COMPILE ERROR: ' + JSON.stringify(err)) : 'OK — compiles clean');
