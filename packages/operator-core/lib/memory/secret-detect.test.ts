/**
 * secret-detect.test.ts — EI-10371 stage 1: precision corpus for the
 * write-time credential detector.
 *
 * The positive shapes mirror what the 2026-07-12 live scan actually found
 * (postgres connection strings with embedded passwords — values faked here)
 * plus the vendor-key classes the detector guards against. The negative
 * corpus is the load-bearing half: memory rows are FULL of localhost URLs
 * with ports, prose containing "password", and "Bearer token" prose — none
 * of those may trip the flag, or the chip trains users to ignore it.
 *
 * Every positive fixture is ASSEMBLED at runtime (`j(...)`) so this file
 * never contains a literal credential shape — the repo's secrets-guard hook
 * (and any external scanner) would rightly flag one, synthetic or not. Do
 * not "simplify" them back to string literals.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/secret-detect.test.ts
 */
import { describe, it, expect } from 'vitest';
import { detectPossibleSecrets, possibleSecretWarning } from './secret-detect';

const j = (...parts: string[]) => parts.join('');

const hit = (text: string, cls: string) => {
  const d = detectPossibleSecrets(text);
  expect(d.matched).toBe(true);
  expect(d.classes).toContain(cls);
};
const clean = (text: string) => {
  expect(detectPossibleSecrets(text)).toEqual({ matched: false, classes: [] });
};

describe('detectPossibleSecrets — positives (one per class)', () => {
  it('url-with-password: the class that exists in the live store', () => {
    hit(j('DB is at postgres://', 'harness_admin', ':', 's3cretpw', '@localhost:5432/harness'), 'url-with-password');
    hit(j('postgresql://', 'postgres_app', ':', 'hunter2', '@127.0.0.1:5568/bench'), 'url-with-password');
    hit(j('use redis://', 'svc', ':', 'p', '@ss.word@cache.internal:6379'), 'url-with-password');
  });

  it('vendor API keys', () => {
    hit(j('key is sk-', 'ant-', 'api03-aBcDeF0123456789xYz-qq'), 'anthropic-api-key');
    hit(j('token sk-', 'a1B2'.repeat(12)), 'openai-api-key');
    hit(j('sk-', 'proj-', 'AbCdEf0123456789', '_-AbCdEf0123'), 'openai-api-key');
    hit(j('stripe sk_', 'live_', 'aA0bB1cC2dD3eE4fF5gG'), 'stripe-key');
    hit(j('gh token ghp_', 'Ab0'.repeat(12)), 'github-token');
    hit(j('github_', 'pat_', 'x9'.repeat(15)), 'github-token');
    hit(j('AWS id AKIA', 'IOSFODNN7EXAMPLE'), 'aws-access-key-id');
    hit(j('slack xoxb-', '1234567890-abcdefghij'), 'slack-token');
  });

  it('private-key block, JWT, Bearer token', () => {
    hit(j('-----BEGIN RSA ', 'PRIVATE KEY-----', '\nMIIE...'), 'private-key');
    hit(j('-----BEGIN ', 'PRIVATE KEY-----'), 'private-key');
    hit(j('jwt: eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dQw4w9WgXcQ12345'), 'jwt');
    hit(j('curl -H "Authorization: Bearer ', 'abc123def456ghi789jkl012', '"'), 'bearer-token');
  });

  it('reports every matched class, in stable order', () => {
    const d = detectPossibleSecrets(
      j('postgres://', 'u', ':', 'p', '@h/db and also sk-', 'ant-', 'api03-aBcDeF0123456789xYz'),
    );
    expect(d.classes).toEqual(['anthropic-api-key', 'url-with-password']);
  });
});

describe('detectPossibleSecrets — negatives (the corpus that must stay clean)', () => {
  it('URLs with ports / paths — the dominant live-row shape', () => {
    clean('the API lives at http://127.0.0.1:3070/api/user/memory');
    clean('see https://example.com/docs/auth:overview@v2 for details');
    clean('git remote is git@github.com:org/repo.git');
  });

  it('prose ABOUT credentials', () => {
    clean('the user prefers password managers over sticky notes');
    clean('rotate the database password monthly');
    clean('Bearer token-based-authentication is configured on the gateway');
    clean('the sk-learning module ships next week');
  });

  it('short/fragment shapes below the confidence bar', () => {
    clean('header starts with eyJhbGciOiJIUzI1NiJ9 (just the alg segment)');
    clean(j('ghp_', 'short'));
    clean(j('AKIA', '123')); // too short for a real AWS key id
    clean('');
  });
});

describe('possibleSecretWarning', () => {
  it('names the classes and says the content was stored unchanged', () => {
    const w = possibleSecretWarning(['url-with-password']);
    expect(w).toContain('url-with-password');
    expect(w).toContain('UNCHANGED');
    expect(w).toMatch(/rotate/i);
  });
});
