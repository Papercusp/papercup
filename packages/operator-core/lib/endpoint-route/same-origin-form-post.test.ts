/**
 * same-origin-form-post.test.ts — the shared CSRF guard for a page's own form post, and a scan
 * for the pairing that broke it twice (WI-10003612 hosted CLI sign-in, WI-10004462 portal MCP
 * consent): a page served under a `no-referrer` policy in a module that checks the Origin header
 * with an exact comparison. Under `no-referrer` a real browser posts the form with `Origin: null`,
 * so an exact check refuses every browser while a test that sets the header by hand still passes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSameOriginFormPost } from './same-origin-form-post';

const ORIGIN = 'https://app.example.test';
const headers = (h: Record<string, string>) => new Headers(h);

describe('isSameOriginFormPost', () => {
  it('accepts the page’s own Origin', () => {
    expect(isSameOriginFormPost(headers({ origin: ORIGIN }), ORIGIN)).toBe(true);
  });

  it('accepts Origin null only when Fetch Metadata says the post is same-origin', () => {
    expect(isSameOriginFormPost(headers({ origin: 'null', 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(true);
    expect(isSameOriginFormPost(headers({ origin: 'null', 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(false);
    expect(isSameOriginFormPost(headers({ origin: 'null', 'sec-fetch-site': 'same-site' }), ORIGIN)).toBe(false);
    expect(isSameOriginFormPost(headers({ origin: 'null' }), ORIGIN)).toBe(false);
  });

  it('refuses another origin, and a post with no Origin at all', () => {
    expect(isSameOriginFormPost(headers({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(false);
    expect(isSameOriginFormPost(headers({}), ORIGIN)).toBe(false);
  });
});

/** A page that declares a no-referrer policy, as a meta tag or as a response header. */
const NO_REFERRER_PAGE = /content=["']no-referrer["']|['"]referrer-policy['"]\s*:\s*['"]no-referrer['"]/i;
/** An exact comparison of the request's Origin header. */
const EXACT_ORIGIN_CHECK = /headers\.get\(\s*['"]origin['"]\s*\)\s*[!=]==/;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('no page pairs a no-referrer policy with an exact Origin check', () => {
  it('the detectors recognize the broken pairing (control)', () => {
    const broken = `const html = '<meta name="referrer" content="no-referrer">';
      if (request.headers.get('origin') !== origin) return refuse();`;
    expect(NO_REFERRER_PAGE.test(broken)).toBe(true);
    expect(EXACT_ORIGIN_CHECK.test(broken)).toBe(true);
    expect(NO_REFERRER_PAGE.test(`headers: { 'referrer-policy': 'no-referrer' }`)).toBe(true);
    expect(NO_REFERRER_PAGE.test(`headers: { 'referrer-policy': 'same-origin' }`)).toBe(false);
  });

  it('holds for every source module under packages/operator-core/lib', () => {
    const files = sourceFiles(ROOT);
    // Positive control: the walk reached the modules that have to be clean.
    const seen = files.map((f) => relative(ROOT, f));
    expect(seen).toContain('connected-apps/portal-mcp-oauth.ts');
    expect(seen).toContain('endpoint-route/routes/hosted-cli/index.ts');

    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return NO_REFERRER_PAGE.test(text) && EXACT_ORIGIN_CHECK.test(text);
      })
      .map((file) => relative(ROOT, file));
    expect(offenders, 'use isSameOriginFormPost and referrer-policy same-origin (./same-origin-form-post.ts)').toEqual([]);
  });
});
