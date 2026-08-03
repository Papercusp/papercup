/**
 * Recurrence guard for EI-19415249247575123.
 *
 * The class: a degraded process that has silently repointed at a DIFFERENT Postgres cluster
 * answers `not_found` for an object that exists, and the caller reads that as a clean
 * absence. The guard below asserts the one property that kills the class — **while a store
 * identity violation is latched, a not_found-shaped tool result must not read as a clean
 * absence** — rather than asserting the current wording, so a future rewording of the banner
 * keeps passing and a future surface that regrows a bare `not_found` still fails.
 */

import { describe, expect, it } from 'vitest';

import type { ObservedStoreIdentity } from '@papercusp/db-org';
import { describeStoreIdentityMismatch } from '@papercusp/db-org';

import {
  annotateStoreIdentitySuspectResult,
  looksLikeNotFoundVerdict,
  type StoreIdentitySuspectDeps,
  type StoreIdentitySuspectResult,
} from './store-identity-suspect';

const PINNED: ObservedStoreIdentity = {
  systemIdentifier: '7100000000000000001',
  database: 'papercusp',
  url: 'postgres://127.0.0.1:5432/papercusp',
  observedAt: 1_785_000_000_000,
};

const IMPOSTOR: ObservedStoreIdentity = {
  systemIdentifier: '7299999999999999999',
  database: 'papercusp',
  url: 'postgres://127.0.0.1:16012/papercusp',
  observedAt: 1_785_000_060_000,
};

/** Deps with the latch ENGAGED — the degraded state the whole guard is about. */
const latched: StoreIdentitySuspectDeps = {
  violation: () => ({ pinned: PINNED, observed: IMPOSTOR }),
  describe: describeStoreIdentityMismatch,
};

/** Deps with NO violation — the overwhelmingly common healthy process. */
const healthy: StoreIdentitySuspectDeps = {
  violation: () => null,
  describe: describeStoreIdentityMismatch,
};

function textResult(text: string): StoreIdentitySuspectResult {
  return { content: [{ type: 'text', text }] };
}

const NOT_FOUND_BODY = JSON.stringify({ ok: false, slug: 'no-http-anywhere-2026-07-28', error: 'not_found' });

/**
 * Models what a misled agent actually does: read the first text block and decide whether
 * anything in it warns that the absence might be false.
 *
 * This is the property under guard — deliberately NOT a string match on the current banner.
 */
function readsAsCleanAbsence(result: StoreIdentitySuspectResult): boolean {
  const text = (result.content[0] as { text?: string }).text ?? '';
  if (!looksLikeNotFoundVerdict(text)) return false; // not an absence answer at all
  const warned = /NOT EVIDENCE OF ABSENCE|wrong database|WRONG DATABASE|UNKNOWN/i.test(text);
  return !warned;
}

describe('store-identity suspect annotation (EI-19415249247575123)', () => {
  describe('the recurrence guard', () => {
    it('a not_found-shaped result NO LONGER reads as a clean absence while a violation is latched', () => {
      const raw = textResult(NOT_FOUND_BODY);

      // Precondition: without the guard this is exactly the dangerous shape.
      expect(readsAsCleanAbsence(raw)).toBe(true);

      const annotated = annotateStoreIdentitySuspectResult(raw, true, latched);

      expect(readsAsCleanAbsence(annotated)).toBe(false);
    });

    it('names the condition machine-readably, so a programmatic caller can branch on it', () => {
      const annotated = annotateStoreIdentitySuspectResult(textResult(NOT_FOUND_BODY), true, latched);

      expect(annotated._meta?.storeIdentitySuspect).toMatchObject({
        verdict: 'not-found-is-unreliable',
        pinned: { systemIdentifier: PINNED.systemIdentifier },
        observed: { systemIdentifier: IMPOSTOR.systemIdentifier },
        issue: 'EI-19415249247575123',
      });
    });

    it('preserves the original body verbatim beneath the warning (nothing is destroyed)', () => {
      const annotated = annotateStoreIdentitySuspectResult(textResult(NOT_FOUND_BODY), true, latched);
      const text = (annotated.content[0] as { text: string }).text;

      expect(text).toContain(NOT_FOUND_BODY);
      // The warning must come FIRST — an answer must not be readable before its retraction.
      expect(text.indexOf(NOT_FOUND_BODY)).toBeGreaterThan(0);
    });

    it.each([
      ['error', JSON.stringify({ ok: false, error: 'not_found' })],
      ['code', JSON.stringify({ ok: false, code: 'not_found' })],
      ['item_not_found', JSON.stringify({ ok: false, code: 'item_not_found' })],
      ['plan_not_found', JSON.stringify({ ok: false, error: 'plan_not_found' })],
    ])('covers the %s verdict shape emitted across agent-tools', (_label, body) => {
      const annotated = annotateStoreIdentitySuspectResult(textResult(body), true, latched);
      expect(readsAsCleanAbsence(annotated)).toBe(false);
    });
  });

  describe('the healthy hot path is untouched', () => {
    it('returns the SAME object when no violation is latched', () => {
      const raw = textResult(NOT_FOUND_BODY);
      // Identity, not equality: the healthy path must not even rebuild the result.
      expect(annotateStoreIdentitySuspectResult(raw, true, healthy)).toBe(raw);
    });

    it('leaves an ordinary successful result alone even while latched', () => {
      const ok = textResult(JSON.stringify({ ok: true, results: [{ id: 'WI-1' }] }));
      expect(annotateStoreIdentitySuspectResult(ok, true, latched)).toBe(ok);
    });

    it('leaves an EMPTY collection alone — deliberately out of scope, see the module doc', () => {
      const empty = textResult(JSON.stringify({ ok: true, results: [] }));
      expect(annotateStoreIdentitySuspectResult(empty, true, latched)).toBe(empty);
    });

    it('does not fire on prose that merely MENTIONS not_found (a tool description)', () => {
      const prose = textResult(
        'This tool returns not_found when the plan is missing. See the not_found handling notes.',
      );
      expect(annotateStoreIdentitySuspectResult(prose, true, latched)).toBe(prose);
    });
  });

  describe('programmatic callers keep a parseable body (EI-19386201256023240)', () => {
    it('stamps _meta but leaves the text byte-identical when annotateText is false', () => {
      const annotated = annotateStoreIdentitySuspectResult(textResult(NOT_FOUND_BODY), false, latched);
      const text = (annotated.content[0] as { text: string }).text;

      expect(text).toBe(NOT_FOUND_BODY);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(annotated._meta?.storeIdentitySuspect).toBeDefined();
    });
  });

  describe('fail-soft — a diagnostic must never break the call it diagnoses', () => {
    it('returns the original result if the describer throws', () => {
      const raw = textResult(NOT_FOUND_BODY);
      const exploding: StoreIdentitySuspectDeps = {
        violation: () => ({ pinned: PINNED, observed: IMPOSTOR }),
        describe: () => {
          throw new Error('boom');
        },
      };
      expect(annotateStoreIdentitySuspectResult(raw, true, exploding)).toBe(raw);
    });

    it('returns the original result if the latch itself throws', () => {
      const raw = textResult(NOT_FOUND_BODY);
      const exploding: StoreIdentitySuspectDeps = {
        violation: () => {
          throw new Error('boom');
        },
        describe: describeStoreIdentityMismatch,
      };
      expect(annotateStoreIdentitySuspectResult(raw, true, exploding)).toBe(raw);
    });

    it('tolerates a result with no text content', () => {
      const imageOnly: StoreIdentitySuspectResult = { content: [{ type: 'image', data: 'x' }] };
      expect(annotateStoreIdentitySuspectResult(imageOnly, true, latched)).toBe(imageOnly);
    });

    it('tolerates an empty content array', () => {
      const none: StoreIdentitySuspectResult = { content: [] };
      expect(annotateStoreIdentitySuspectResult(none, true, latched)).toBe(none);
    });
  });
});
