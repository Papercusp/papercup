import { afterEach, describe, expect, it } from 'vitest';
import { contextGaugeAnnotator } from './context-gauge-annotator';
import {
  recordContextUsage,
  resetContextUsageCacheForTests,
  setContextGaugeEnabled,
} from '../system-health/context-usage-cache';
import {
  markContextEstimateFresh,
  resetContextVerifyForTests,
} from '../system-health/context-estimate-verify';

/** A superuser ctx resolves to ownerId === uiClientId (see coordination/identity.ts). */
const ctx = (ownerId: string) => ({ isSuperuser: true, uiClientId: ownerId }) as unknown;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const gaugeText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

afterEach(() => {
  resetContextUsageCacheForTests();
  resetContextVerifyForTests();
});

describe('contextGaugeAnnotator (P-013 wiring logic)', () => {
  it('appends a banded gauge when the owner is over the quiet band', () => {
    recordContextUsage('su-hot', 270_000, 300_000); // 90% → critical
    markContextEstimateFresh('su-hot'); // WI-4154: an alarm-band render requires a verified estimate
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-hot'));
    const texts = gaugeText(out);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('context: 270000/300000 (90%)');
    expect(texts[1]).toContain('CRITICAL');
    expect((out._meta as Record<string, unknown>)?._contextGauge).toContain('90%');
  });

  it('appends NOTHING below the quiet band (the common case)', () => {
    recordContextUsage('su-cool', 60_000, 300_000); // 20%
    const r = ok('body');
    const out = contextGaugeAnnotator(r, ctx('su-cool'));
    expect(out).toBe(r); // untouched reference
  });

  it('appends NOTHING for an owner the watchdog is not tracking (no cache entry)', () => {
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-unknown'))).toBe(r);
  });

  it('appends NOTHING for an unattributable ctx (resolveAgentIdentity throws)', () => {
    recordContextUsage('whatever', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, {})).toBe(r); // no identity fields → throws → swallowed
  });

  it('does NOT double-render when the result already carries a context line', () => {
    recordContextUsage('su-hot', 270_000, 300_000);
    markContextEstimateFresh('su-hot');
    // e.g. a coord:inbox result whose JSON already contains the usage line
    const r = ok('{"injection":"context: 270000/300000 (90%)\\n[coord+1]"}');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('suppresses an UNVERIFIED alarm-band reading (WI-4154 verify-before-alarm)', () => {
    // No markContextEstimateFresh: the cached 90% may be a pre-compaction leftover —
    // the annotator must not alarm on it; the kicked re-derive corrects the cache and
    // the next call renders the verified value.
    recordContextUsage('su-stale', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-stale'))).toBe(r);
  });

  it('is suppressed when the gauge flag mirror is disabled', () => {
    recordContextUsage('su-hot', 270_000, 300_000);
    setContextGaugeEnabled(false);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('renders the quiet bare fact in 65–79%', () => {
    recordContextUsage('su-mid', 210_000, 300_000); // 70%
    const out = contextGaugeAnnotator(ok('body'), ctx('su-mid'));
    const texts = gaugeText(out);
    expect(texts[1]).toBe('context: 210000/300000 (70%)');
    expect(texts[1]).not.toContain('⚠');
  });
});
