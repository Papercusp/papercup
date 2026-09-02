/**
 * EI-22164571843016048 — a fact's source-provenance quote must not broadcast a
 * credential into every agent's orient.
 *
 * ⚠ NO LITERAL CREDENTIAL SHAPES IN THIS FILE. Every fixture is assembled at
 * runtime from fragments. A literal `ghp_…`/`AKIA…` written into a tracked file
 * trips the tree secrets-guard AND the pot-git publish guard, and a refused
 * publish range never advances its baseline — which wedges the hive publish
 * plane until someone edits history. Keep the concatenations.
 */
import { describe, expect, it } from 'vitest';
import { scanTextForSecrets } from '../../sync/pot-git/secrets-guard';
import {
  REDACTED_QUOTE,
  looksLikeCredentialValue,
  redactProvenanceQuote,
  scanProseCredential,
} from './quote-secret-redaction';

/** High-entropy fake — not a real credential. */
const FAKE = 'Qv7bTm2xLp9RdKw4Nz8Hs3Yc';
/** Structural tokens the SHARED detector is supposed to catch, built at runtime. */
const GH_TOKEN = ['gh', 'p', '_', 'a'.repeat(36)].join('');
const AWS_KEY = ['AK', 'IA', 'QV7BTM2XLP9RDKW4'].join('');

/** The quote that actually leaked, in the shape it actually had. */
const INCIDENT_QUOTE =
  'can you mark this as something that agents can auth themselves next time? ' +
  `my super@example.com password is ${FAKE}`;

describe('provenance-quote credential redaction', () => {
  it('redacts the incident shape — prose "password is <value>"', () => {
    const out = redactProvenanceQuote(INCIDENT_QUOTE);
    expect(out.redacted).toBe(true);
    expect(out.quote).toBe(REDACTED_QUOTE);
    expect(out.quote).not.toContain(FAKE);
    expect(out.detector).toBe('prose-credential');
  });

  // ── The control that keeps this module honest ──────────────────────────────
  // This is the deliberately-WEAK implementation, kept permanently: the fix
  // originally proposed for this bug was "just reuse the secrets guard". If
  // this expectation ever flips to CAUGHT, the shared detector grew a prose
  // rule and the layer above may be redundant — that is a deliberate decision
  // to re-make, not a silent one. If instead someone deletes scanProseCredential
  // and leaves only the shared scan, the test above goes red immediately.
  it('CONTROL: the shared secrets-guard alone MISSES the incident shape', () => {
    expect(scanTextForSecrets('<control>', INCIDENT_QUOTE)).toHaveLength(0);
  });

  // ── Calibration: the control above must not be passing because the shared
  // detector is simply broken. It has to catch what it does claim to catch. ──
  it('CALIBRATION: the shared secrets-guard catches structural tokens', () => {
    expect(scanTextForSecrets('<cal>', GH_TOKEN).length).toBeGreaterThan(0);
    expect(scanTextForSecrets('<cal>', AWS_KEY).length).toBeGreaterThan(0);
  });

  it('still redacts what the shared detector catches, and says which layer fired', () => {
    const gh = redactProvenanceQuote(`deploy with ${GH_TOKEN} please`);
    expect(gh.redacted).toBe(true);
    expect(gh.detector).toBe('secrets-guard');
    expect(gh.quote).not.toContain(GH_TOKEN);
  });

  it.each([
    ['separator form "password: X"', `password: ${FAKE}`],
    ['assignment form "password=X"', `password=${FAKE}`],
    ['prose "the api key for prod is X"', `the api key for prod is ${FAKE}`],
    ['prose "my access token was X"', `my access token was ${FAKE}`],
    ['prose with punctuation', `passphrase is "${FAKE}".`],
  ])('redacts %s', (_label, quote) => {
    expect(redactProvenanceQuote(quote).redacted).toBe(true);
  });

  // ── False positives are CHEAP here but not free: a quote is audit evidence,
  // so ordinary prose that merely mentions credentials must survive intact. ──
  it.each([
    ['policy prose', 'rotate the password every ninety days, per the security policy'],
    ['a reference, no value', 'the api key lives in the injected config, never in the repo'],
    ['placeholder', 'set password to <YOUR_PASSWORD_HERE> before running it'],
    ['redaction marker itself', REDACTED_QUOTE],
    ['a long ordinary word after the keyword', 'the password requirements are documented elsewhere'],
    ['unrelated technical prose', 'the token bucket refills at ten per second under load'],
  ])('does NOT redact %s', (_label, quote) => {
    const out = redactProvenanceQuote(quote);
    expect(out.redacted).toBe(false);
    expect(out.quote).toBe(quote);
  });

  it('leaves an absent quote alone rather than inventing one', () => {
    expect(redactProvenanceQuote(undefined)).toEqual({ quote: '', redacted: false });
    expect(redactProvenanceQuote('')).toEqual({ quote: '', redacted: false });
  });

  describe('value gates (each pinned separately so a widened gate is visible)', () => {
    it('rejects short values', () => expect(looksLikeCredentialValue('Ab3$x')).toBe(false));
    it('rejects single-character-class words', () =>
      expect(looksLikeCredentialValue('definitely')).toBe(false));
    it('rejects placeholders', () =>
      expect(looksLikeCredentialValue('CHANGEME_1234')).toBe(false));
    it('accepts a mixed high-entropy value', () =>
      expect(looksLikeCredentialValue(FAKE)).toBe(true));
  });

  it('does not run past a real word into an unrelated value', () => {
    // "password" then a non-filler word ends the window, so the unrelated build
    // id further along the sentence must not trigger a redaction.
    expect(scanProseCredential(`password requirements changed; build ${FAKE} shipped`)).toBe(false);
  });
});
