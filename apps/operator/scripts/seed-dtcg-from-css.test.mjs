#!/usr/bin/env node
/**
 * Smoke test for seed-dtcg-from-css.mjs.
 *
 * Writes a small CSS fixture, runs the seeder, asserts the output:
 *   - parses to valid JSON
 *   - contains at least one $type=color token
 *   - contains at least one $type=dimension token
 *   - has no DTCG hybrid leaves (a node with $value AND non-$ children)
 *   - dedups across multiple :root blocks
 *
 * Not a full vitest suite — runs as a plain Node script so it's
 * trivial to invoke in CI without depending on vitest config.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = resolve(__dirname, 'seed-dtcg-from-css.mjs');

const fixture = `
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

const dir = mkdtempSync(join(tmpdir(), 'dtcg-seed-test-'));
const cssPath = join(dir, 'fixture.css');
const outPath = join(dir, 'out.json');

try {
  writeFileSync(cssPath, fixture);
  execFileSync('node', [SCRIPT, cssPath, '--out=' + outPath, '--force'], {
    stdio: 'inherit',
  });
  const doc = JSON.parse(readFileSync(outPath, 'utf-8'));

  // structural assertions
  assert.equal(doc.$schema, 'https://design-tokens.org/schemas/v1.json');

  // dedup: one entry for color.bg even though :root declared twice
  const tokens = collectTokens(doc);
  const bg = tokens.filter((t) => t.path === 'color.bg');
  assert.equal(bg.length, 1, `expected 1 entry for color.bg, got ${bg.length}`);

  // type inference
  const primary = tokens.find((t) => t.path === 'color.primary');
  assert.ok(primary, 'color.primary missing');
  assert.equal(primary.entry.$type, 'color', 'color.primary should infer $type=color');

  const space = tokens.find((t) => t.path === 'space.md');
  assert.ok(space, 'space.md missing');
  assert.equal(space.entry.$type, 'dimension');

  const dur = tokens.find((t) => t.path === 'transition.fast');
  assert.ok(dur, 'transition.fast missing');
  assert.equal(dur.entry.$type, 'duration');

  // raw fallback for unknown
  const raw = tokens.find((t) => t.path === 'random.thing');
  assert.ok(raw, 'random.thing missing');

  // hybrid-leaf check
  let hybrids = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const hasValue = '$value' in node;
    const childKeys = Object.keys(node).filter(
      (k) => !k.startsWith('$') && node[k] && typeof node[k] === 'object',
    );
    if (hasValue && childKeys.length > 0) hybrids++;
    for (const k of Object.keys(node)) {
      if (k.startsWith('$')) continue;
      walk(node[k]);
    }
  }
  walk(doc);
  assert.equal(hybrids, 0, `${hybrids} hybrid leaves (DTCG-invalid)`);

  console.log('OK — 6 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function collectTokens(doc, path = []) {
  const out = [];
  if (!doc || typeof doc !== 'object') return out;
  for (const k of Object.keys(doc)) {
    if (k.startsWith('$')) continue;
    const v = doc[k];
    if (v && typeof v === 'object' && '$value' in v) {
      out.push({ path: [...path, k].join('.'), entry: v });
      // descend further in case of leaf+children promotion
      for (const k2 of Object.keys(v)) {
        if (k2.startsWith('$')) continue;
        const child = v[k2];
        if (child && typeof child === 'object' && '$value' in child) {
          out.push({ path: [...path, k, k2].join('.'), entry: child });
        }
      }
    } else if (v && typeof v === 'object') {
      out.push(...collectTokens(v, [...path, k]));
    }
  }
  return out;
}
