/**
 * project-naming.test.ts — §15.9 CF project-name + vanity-subdomain derivation
 * (publish worker, coverage campaign).
 *
 * Pure naming logic that names every published project's CF Pages project and
 * its vanity subdomain. The hash prefix is the tenant-correlation shield, the
 * slug sanitizer enforces CF's name charset/length, and the vanity subdomain
 * appends entropy. This pins: the deterministic hash prefix (8 bytes → 16 hex),
 * the 58-char CF cap, the sanitize rules (lowercasing, run-collapse,
 * edge-trim, empty → 'untitled'), and the vanity entropy shape. Real WebCrypto
 * + real randomBase32 run in-process (no mocks needed).
 */
import { describe, expect, it } from 'vitest';
import { cfProjectName, sanitizeSlug, vanitySubdomain } from './project-naming.ts';

describe('sanitizeSlug', () => {
  it('lowercases and keeps allowed [a-z0-9-]', () => {
    expect(sanitizeSlug('My-Cool-App2')).toBe('my-cool-app2');
  });

  it('replaces runs of disallowed chars with a single hyphen', () => {
    expect(sanitizeSlug('hello   world')).toBe('hello-world');
    expect(sanitizeSlug('a@@@b___c')).toBe('a-b-c');
  });

  it('collapses consecutive hyphens (incl. ones produced by replacement)', () => {
    expect(sanitizeSlug('a---b')).toBe('a-b');
    expect(sanitizeSlug('a- -b')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeSlug('---edge---')).toBe('edge');
    expect(sanitizeSlug('  spaced  ')).toBe('spaced');
  });

  it('falls back to "untitled" when nothing survives sanitization', () => {
    expect(sanitizeSlug('')).toBe('untitled');
    expect(sanitizeSlug('@@@')).toBe('untitled');
    expect(sanitizeSlug('---')).toBe('untitled');
  });

  it('passes through an already-clean slug unchanged', () => {
    expect(sanitizeSlug('already-clean-99')).toBe('already-clean-99');
  });
});

describe('cfProjectName', () => {
  it('prefixes a 16-hex (8-byte) hash then "-" then the sanitized slug', async () => {
    const name = await cfProjectName('secret', 'My App');
    expect(name).toMatch(/^[0-9a-f]{16}-my-app$/);
  });

  it('is deterministic for the same (secret, slug) pair', async () => {
    const a = await cfProjectName('s', 'harness-x');
    const b = await cfProjectName('s', 'harness-x');
    expect(a).toBe(b);
  });

  it('changes the hash prefix when the secret changes (tenant-correlation shield)', async () => {
    const a = await cfProjectName('secret-a', 'same-slug');
    const b = await cfProjectName('secret-b', 'same-slug');
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
    // slug suffix identical, only the hash differs
    expect(a.slice(16)).toBe(b.slice(16));
  });

  it('changes the hash prefix when the slug changes', async () => {
    const a = await cfProjectName('secret', 'slug-a');
    const b = await cfProjectName('secret', 'slug-b');
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
  });

  it('caps the slug suffix at 41 chars (16 hex + "-" + 41 ≤ 58 CF limit)', async () => {
    const longSlug = 'x'.repeat(120);
    const name = await cfProjectName('secret', longSlug);
    const suffix = name.slice(17); // after "<16hex>-"
    expect(suffix.length).toBe(41);
    expect(name.length).toBeLessThanOrEqual(58);
  });

  it('sanitizes the slug suffix (uppercase + disallowed chars)', async () => {
    const name = await cfProjectName('secret', 'Foo Bar!!!');
    expect(name).toMatch(/^[0-9a-f]{16}-foo-bar$/);
  });

  it('matches a known SHA-256 prefix for a fixed input (golden)', async () => {
    // sha256("secret/harness") first 8 bytes, hex:
    const data = new TextEncoder().encode('secret/harness');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let hex = '';
    for (let i = 0; i < 8; i++) hex += digest[i]!.toString(16).padStart(2, '0');
    const name = await cfProjectName('secret', 'harness');
    expect(name).toBe(`${hex}-harness`);
  });
});

describe('vanitySubdomain', () => {
  it('is the sanitized slug + "-" + 8 base32 chars', () => {
    const sub = vanitySubdomain('My App');
    // base32 alphabet is a-z + 2-7 (Crockford-ish: no 0/1/8/9)
    expect(sub).toMatch(/^my-app-[a-z2-7]{8}$/);
  });

  it('produces distinct entropy suffixes across calls for the same slug', () => {
    const a = vanitySubdomain('same');
    const b = vanitySubdomain('same');
    expect(a).not.toBe(b);
    expect(a.slice(0, 'same-'.length)).toBe('same-');
    expect(b.slice(0, 'same-'.length)).toBe('same-');
  });

  it('sanitizes the slug part before appending entropy', () => {
    const sub = vanitySubdomain('Weird @ Name');
    expect(sub).toMatch(/^weird-name-.{8}$/);
  });

  it('falls back to "untitled" as the slug part when slug is empty', () => {
    const sub = vanitySubdomain('@@@');
    expect(sub).toMatch(/^untitled-.{8}$/);
  });
});
