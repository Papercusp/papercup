/**
 * Vitest port of the former scripts/seed-dtcg-from-css.test.mjs ad-hoc smoke
 * (test-framework coverage audit, 2026-06-02). Drives the real seeder CLI
 * against a CSS fixture and asserts the DTCG output shape.
 *
 * It still shells out to `seed-dtcg-from-css.mjs` (the unit under test is the
 * seeder script, so an integration-style invocation is the honest test).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../seed-dtcg-from-css.mjs');

const FIXTURE = `
:root {
  --color-primary: #1d4ed8;
  --color-bg: #ffffff;
  --space-md: 12px;
  --transition-fast: 120ms;
  --random-thing: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #111827;
  }
}
`;

interface TokenEntry { $value?: unknown; $type?: string; [k: string]: unknown }
interface Collected { path: string; entry: TokenEntry }

function collectTokens(doc: Record<string, unknown>, path: string[] = []): Collected[] {
  const out: Collected[] = [];
  if (!doc || typeof doc !== 'object') return out;
  for (const k of Object.keys(doc)) {
    if (k.startsWith('$')) continue;
    const v = doc[k] as Record<string, unknown>;
    if (v && typeof v === 'object' && '$value' in v) {
      out.push({ path: [...path, k].join('.'), entry: v as TokenEntry });
      for (const k2 of Object.keys(v)) {
        if (k2.startsWith('$')) continue;
        const child = v[k2] as Record<string, unknown>;
        if (child && typeof child === 'object' && '$value' in child) {
          out.push({ path: [...path, k, k2].join('.'), entry: child as TokenEntry });
        }
      }
    } else if (v && typeof v === 'object') {
      out.push(...collectTokens(v, [...path, k]));
    }
  }
  return out;
}

function countHybridLeaves(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const obj = node as Record<string, unknown>;
  const hasValue = '$value' in obj;
  const childKeys = Object.keys(obj).filter(
    (k) => !k.startsWith('$') && obj[k] && typeof obj[k] === 'object',
  );
  let n = hasValue && childKeys.length > 0 ? 1 : 0;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$')) continue;
    n += countHybridLeaves(obj[k]);
  }
  return n;
}

describe('seed-dtcg-from-css', () => {
  function runSeeder(): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), 'dtcg-seed-test-'));
    const cssPath = join(dir, 'fixture.css');
    const outPath = join(dir, 'out.json');
    try {
      writeFileSync(cssPath, FIXTURE);
      execFileSync('node', [SCRIPT, cssPath, '--out=' + outPath, '--force'], { stdio: 'pipe' });
      return JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('emits a DTCG-v1 document', () => {
    expect(runSeeder().$schema).toBe('https://design-tokens.org/schemas/v1.json');
  });

  it('dedups a var declared in multiple :root blocks', () => {
    const tokens = collectTokens(runSeeder());
    expect(tokens.filter((t) => t.path === 'color.bg')).toHaveLength(1);
  });

  it('infers $type from the value (color / dimension / duration)', () => {
    const tokens = collectTokens(runSeeder());
    expect(tokens.find((t) => t.path === 'color.primary')?.entry.$type).toBe('color');
    expect(tokens.find((t) => t.path === 'space.md')?.entry.$type).toBe('dimension');
    expect(tokens.find((t) => t.path === 'transition.fast')?.entry.$type).toBe('duration');
  });

  it('keeps a raw fallback for unknown values', () => {
    const tokens = collectTokens(runSeeder());
    expect(tokens.find((t) => t.path === 'random.thing')).toBeTruthy();
  });

  it('produces no DTCG hybrid leaves ($value + non-$ children)', () => {
    expect(countHybridLeaves(runSeeder())).toBe(0);
  });
});
