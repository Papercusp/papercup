/**
 * CI guard: client components must not VALUE-import server-only modules.
 *
 * operator-vite is a pure SPA — every `apps/operator/app/**` component runs in
 * the Tauri WebKit renderer, which has no Node built-ins and no Postgres. A
 * `'use client'` file that value-imports a server-only module (PG layer, fs/os
 * path helpers, the agent-config file reader) drags that whole subtree into the
 * renderer bundle, which crashes with "Can't find variable: Buffer" /
 * "homedir is not a function" — the exact regression class fixed in
 * `agent-config-constants.ts` (a single `SURFACE_KEYS` value-import pulled the
 * postgres driver into the SPA). See the insight at
 * `/internal/docs/agent-insights/operator-vite-node-globals`.
 *
 * This guard catches the common, depth-1 shape: a `'use client'` file directly
 * value-importing a denylisted module. `import type {...}` is erased by the
 * bundler and is allowed. Deeper transitive leaks are surfaced by the
 * production build's "externalized for browser compatibility" warnings
 * (`npm run build:operator`); this test is the cheap first line of defense.
 *
 * Escape hatch: append `// client-server-allow <reason>` to the import line.
 * Use only for a module you've confirmed is client-safe; prefer extracting the
 * client-safe symbols into a leaf `*-constants.ts` instead (see
 * `agent-config-constants.ts` / `workspace-id-constant.ts`).
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const APP_DIR = join(__dirname, '..', '..', 'app');
const REPO_APP = join(__dirname, '..', '..'); // apps/operator

/**
 * Server-only module specifiers that must never be value-imported by a client
 * component. Matched by EXACT `from '<spec>'` equality (so `@/lib/agent-config`
 * is caught but the client-safe `@/lib/agent-config-constants` is not).
 */
const DENY_EXACT = new Set<string>([
  '@papercusp/db-org',
  '../operator-state-pg',
  '../db-encryption',
  '../agent-config', // the server file — use @/lib/agent-config-constants in client code
  '../papercusp-root',
  '../workspace-registry', // the server file — use @/lib/workspace-id-constant in client code
  '../omp-sessions',
  '../delegates',
  '../harness-issues',
  '../harness-core',
]);
/** Node built-ins (any `node:*`) must never be value-imported by a client file. */
const DENY_NODE_PREFIX = 'node:';

const TS_EXT = /\.tsx?$/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDir) await walk(full, out);
    else if (TS_EXT.test(e.name)) out.push(full);
  }
  return out;
}

/** True if the file's first directive is `'use client'` (before any import/code). */
function isUseClient(src: string): boolean {
  // Strip a leading block comment + blank lines, then check the first directive.
  const head = src.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*/, '').trimStart();
  return /^['"]use client['"]\s*;?/.test(head);
}

interface ImportInfo {
  spec: string;
  line: number;
  raw: string;
  typeOnly: boolean;
}

/** Parse import statements, classifying each as type-only or value. */
function parseImports(src: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  // Matches: import ... from '<spec>';  and side-effect: import '<spec>';
  const re = /import\b([\s\S]*?)from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const raw = m[0];
    const line = src.slice(0, m.index).split('\n').length;
    if (m[3] !== undefined) {
      // Side-effect import `import 'x'` — runs the module body → value import.
      out.push({ spec: m[3], line, raw, typeOnly: false });
      continue;
    }
    const clause = m[1] ?? '';
    const spec = m[2];
    out.push({ spec, line, raw, typeOnly: isTypeOnlyClause(clause) });
  }
  return out;
}

/** A clause is type-only if it's `import type ...` or every named specifier is `type`-prefixed (and there's no default/namespace binding). */
function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true; // `import type { ... }` / `import type X`
  const named = c.match(/\{([\s\S]*)\}/);
  if (!named) return false; // default or namespace import → value
  // If there's a binding before the `{`, it's a default import → value.
  if (c.slice(0, c.indexOf('{')).replace(/[,\s]/g, '').length > 0) return false;
  const specifiers = named[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (specifiers.length === 0) return false;
  return specifiers.every((s) => /^type\s/.test(s));
}

function isDenied(spec: string): boolean {
  return DENY_EXACT.has(spec) || spec.startsWith(DENY_NODE_PREFIX);
}

describe('client components do not value-import server-only modules', () => {
  it('no `use client` file in app/ value-imports a denylisted server module', async () => {
    const files = await walk(APP_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const src = await fs.readFile(file, 'utf8');
      if (!isUseClient(src)) continue;
      const rel = relative(REPO_APP, file);
      for (const imp of parseImports(src)) {
        if (!isDenied(imp.spec)) continue;
        if (imp.typeOnly) continue; // erased by the bundler — safe
        // Per-line escape hatch.
        const lineText = src.split('\n')[imp.line - 1] ?? '';
        if (/client-server-allow/.test(lineText)) continue;
        violations.push(`${rel}:${imp.line}  value-imports server-only '${imp.spec}'`);
      }
    }

    if (violations.length) {
      throw new Error(
        `Client ('use client') components must not value-import server-only modules ` +
          `(they get bundled into the operator-vite renderer, which has no Node/PG and crashes).\n\n` +
          violations.map((v) => `  • ${v}`).join('\n') +
          `\n\nFix: import only types (\`import type\`), or extract the client-safe constants/types ` +
          `into a leaf \`*-constants.ts\` module (see agent-config-constants.ts / workspace-id-constant.ts), ` +
          `or fetch the data via \`/api/*\`. See /internal/docs/agent-insights/operator-vite-node-globals.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('client-safe constant modules stay leaf (no node/server imports)', async () => {
    const leaves = ['lib/agent-config-constants.ts', 'lib/workspace-id-constant.ts'];
    const bad: string[] = [];
    for (const rel of leaves) {
      const full = join(REPO_APP, rel);
      let src: string;
      try {
        src = await fs.readFile(full, 'utf8');
      } catch {
        continue; // module may have been renamed; not this test's concern
      }
      for (const imp of parseImports(src)) {
        if (imp.typeOnly) continue;
        if (isDenied(imp.spec) || imp.spec.startsWith('node:')) {
          bad.push(`${rel}:${imp.line} imports '${imp.spec}'`);
        }
      }
    }
    expect(bad, `client-safe leaf modules must have no server/node imports:\n${bad.join('\n')}`).toEqual([]);
  });
});
