import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P-007 recurrence guard (cupboard-release-pipeline-content-trust-2026-09-16, plan Decision D-010).
 *
 * The Worker runs the TypeScript compiler (tooldef `checkScript`) to compute a recipe's authority
 * server-side. typescript.js reads the CJS globals `__filename` / `__dirname` at init; the Worker
 * bundle is ESM and has neither, so without wrangler `[define]` entries the compiler fails to
 * initialise. These assertions fail if the defines are dropped, renamed, or turned into something
 * that is not a JS string literal — the regression that would silently under-report recipe
 * authority (ensureParseCheckReady() also throws now, so the failure is loud at runtime too).
 */
const here = dirname(fileURLToPath(import.meta.url));
const wranglerToml = readFileSync(resolve(here, '../../wrangler.toml'), 'utf8');

/** Body of a top-level `[table]` (no nested/array tables), comments stripped. */
function tableBody(toml: string, table: string): string | null {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${table}]`);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('[')) break;
    if (l === '' || l.startsWith('#')) continue;
    body.push(l);
  }
  return body.join('\n');
}

/**
 * Evaluate `key = "<TOML basic string>"` the way wrangler does for [define]: the TOML string is a
 * JS EXPRESSION that must itself be a string literal. TOML basic-string escapes used here
 * (`\"`) are JSON-compatible, so JSON.parse decodes the TOML layer and a second JSON.parse
 * proves the result is a JS string literal.
 */
function defineValue(body: string, key: string): string | undefined {
  const m = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm').exec(body);
  if (!m) return undefined;
  try {
    const jsExpression = JSON.parse(m[1]) as string;
    const literal: unknown = JSON.parse(jsExpression);
    return typeof literal === 'string' ? literal : undefined;
  } catch {
    return undefined; // not a JS string literal (e.g. a bare identifier-ish value)
  }
}

describe('wrangler.toml — TypeScript-compiler Worker defines (P-007 / D-010)', () => {
  const defineBody = tableBody(wranglerToml, 'define');

  it('has a [define] table', () => {
    expect(defineBody).not.toBeNull();
  });

  it('defines __filename as a JS string literal (typescript.js getNodeSystem reads it at init)', () => {
    expect(defineValue(defineBody ?? '', '__filename')).toBe('/typescript.js');
  });

  it('defines __dirname as a JS string literal', () => {
    expect(defineValue(defineBody ?? '', '__dirname')).toBe('/');
  });

  it('keeps nodejs_compat (the compiler needs the Node builtin shims)', () => {
    expect(wranglerToml).toMatch(/^compatibility_flags\s*=\s*\[[^\]]*"nodejs_compat"[^\]]*\]/m);
  });

  it('CONTROL: the extractor rejects a bare (non-literal) define and a missing key', () => {
    // A define whose value is not a JS string literal must not read as valid — otherwise the
    // assertions above could pass vacuously on a malformed table.
    expect(defineValue('__filename = "typescript.js"', '__filename')).toBeUndefined();
    expect(defineValue('', '__filename')).toBeUndefined();
    expect(defineValue('__filename = "\\"/typescript.js\\""', '__dirname')).toBeUndefined();
    expect(defineValue('__filename = "\\"/typescript.js\\""', '__filename')).toBe('/typescript.js');
  });
});
