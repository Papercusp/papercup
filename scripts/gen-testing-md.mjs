#!/usr/bin/env node
// Bulk generate TESTING.md scaffolds for every Restart workspace
// missing one. Each scaffold reflects what already exists in the
// package: scripts, test file counts, etc. Humans fill in the
// "what they cover" sentence per file as those tests evolve.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function expandWorkspaces() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = [];
  for (const g of pkg.workspaces) {
    if (g.endsWith('/*')) {
      const dir = join(root, g.slice(0, -2));
      try {
        for (const e of readdirSync(dir)) {
          const f = join(dir, e);
          if (statSync(f).isDirectory() && existsSync(join(f, 'package.json'))) out.push(g.slice(0, -2) + '/' + e);
        }
      } catch { /* */ }
    } else if (existsSync(join(root, g, 'package.json'))) out.push(g);
  }
  return [...new Set(out)];
}

function listFiles(dir, pat, depth = 4, cur = 0) {
  if (cur >= depth) return [];
  let entries = []; try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (['node_modules', '.next', 'dist', 'build', '.git', 'storybook-static'].includes(e)) continue;
    const f = join(dir, e);
    let s; try { s = statSync(f); } catch { continue; }
    if (s.isDirectory()) out.push(...listFiles(f, pat, depth, cur + 1));
    else if (pat.test(e)) out.push(f);
  }
  return out;
}

function describe(ws) {
  const wsRoot = join(root, ws);
  const pkg = JSON.parse(readFileSync(join(wsRoot, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  const testFiles = listFiles(wsRoot, /\.test\.(ts|tsx)$/);
  const integFiles = testFiles.filter((f) => /\.integration\.test\./.test(f));
  const propFiles  = testFiles.filter((f) => /\.property\.test\./.test(f));
  const unitFiles  = testFiles.filter((f) => !integFiles.includes(f) && !propFiles.includes(f));
  const benchFiles = listFiles(wsRoot, /\.bench\.(ts|tsx)$/);
  const specFiles  = listFiles(wsRoot, /\.spec\.(ts|tsx)$/);
  const e2eDir     = existsSync(join(wsRoot, 'e2e'));
  const hasStory   = existsSync(join(wsRoot, '.storybook'));
  return { pkg, scripts, unitFiles, integFiles, propFiles, specFiles, benchFiles, e2eDir, hasStory };
}

function md(ws, info) {
  const { pkg, scripts, unitFiles, integFiles, propFiles, specFiles, benchFiles, e2eDir, hasStory } = info;
  const name = pkg.name || ws;
  const total = unitFiles.length + integFiles.length + propFiles.length + specFiles.length;

  const cover = total === 0 && benchFiles.length === 0 && !e2eDir
    ? `- (none yet) — drop \`*.test.ts\` files alongside source and they'll be picked up by \`npm test\`.`
    : [
        unitFiles.length    && `- **${unitFiles.length}** unit test file(s) (\`*.test.ts\`).`,
        integFiles.length   && `- **${integFiles.length}** integration test file(s) (\`*.integration.test.ts\`).`,
        propFiles.length    && `- **${propFiles.length}** property test file(s) (\`*.property.test.ts\`) — fast-check.`,
        specFiles.length    && `- **${specFiles.length}** spec file(s) (\`*.spec.ts\`).`,
        benchFiles.length   && `- **${benchFiles.length}** bench file(s) (\`*.bench.ts\`) — Vitest bench.`,
        e2eDir              && `- E2E specs under \`e2e/\` (Playwright).`,
        hasStory            && `- Storybook + visual baselines under \`lostpixel-baseline/\`.`,
      ].filter(Boolean).join('\n');

  const runRows = [
    `| Anything in this workspace          | \`npm test --workspace ${name}\``.padEnd(95) + '|',
    `| Code that other workspaces depend on| \`npm run test:affected\` from repo root             |`,
  ];
  if (integFiles.length) runRows.push(`| Files matching \`*.integration.test.*\`| \`npm run test:integration --workspace ${name}\``.padEnd(95) + '|');
  if (e2eDir) runRows.push(`| E2E spec changes                    | \`npm run test:e2e --workspace ${name}\``.padEnd(95) + '|');
  if (benchFiles.length) runRows.push(`| Code in a \`*.bench.ts\` hot path     | \`npm run bench --workspace ${name}\``.padEnd(95) + '|');

  return `# TESTING — ${name}

## What this project's tests cover

${cover}

## What they don't cover (yet)

- ${total === 0 && !e2eDir ? 'No tests exist yet — see "Run after editing" below for how to add them.' : 'Owner: edit this section to call out un-tested behavior worth knowing about.'}

## Run after editing

| Edit touches                        | Run                                                       |
| ----------------------------------- | --------------------------------------------------------- |
${runRows.join('\n')}

See repo-root \`CLAUDE.md\` (\`Tests after editing\` block) and the unified
testing spec at \`http://localhost:3055/docs/testing\` for the full
strategy.

---
*Scaffolded ${new Date().toISOString().slice(0, 10)} by \`scripts/gen-testing-md.mjs\`. Replace this footer when you've filled in real coverage notes.*
`;
}

const written = [];
for (const ws of expandWorkspaces()) {
  const dest = join(root, ws, 'TESTING.md');
  if (existsSync(dest)) continue;
  // Skip submodule packages — they need to be committed inside the submodule.
  // Detect by checking for .git as file (submodule pointer) one level up.
  // For simplicity: just generate; commit-time will route correctly.
  try {
    const info = describe(ws);
    writeFileSync(dest, md(ws, info));
    written.push(ws);
  } catch (e) { console.error(`! ${ws}:`, e.message); }
}
console.log(`Wrote ${written.length} TESTING.md scaffolds:`);
console.log(written.join('\n'));
