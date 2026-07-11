import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextGaugeAnnotator } from './context-gauge-annotator';
import {
  recordContextUsage,
  resetContextUsageCacheForTests,
  setContextGaugeEnabled,
} from '../system-health/context-usage-cache';
import {
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
} from '../compaction-usage';

/** A superuser ctx resolves to ownerId === uiClientId (see coordination/identity.ts). */
const ctx = (ownerId: string) => ({ isSuperuser: true, uiClientId: ownerId }) as unknown;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const gaugeText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

/** WI-4154: the annotator's tokens now come from the transcript's current state
 *  (anchored sync read); the usage-cache entry supplies only the LIMIT. Give an
 *  owner a real temp transcript of `tokens*4` bytes + a cached limit. */
let dir: string;
let n = 0;
function trackOwner(ownerId: string, tokens: number, limit: number): void {
  const file = path.join(dir, `${++n}.jsonl`);
  const overhead = '{"t":""}\n'.length;
  fs.writeFileSync(file, `{"t":"${'x'.repeat(tokens * 4 - overhead)}"}\n`);
  if (!seedContextAnchorForTests(ownerId, file)) throw new Error('anchor seed failed');
  recordContextUsage(ownerId, tokens, limit);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-annotator-'));
});

afterEach(() => {
  resetContextUsageCacheForTests();
  resetContextAnchorsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('contextGaugeAnnotator (P-013 wiring logic)', () => {
  it('appends a banded gauge when the owner is over the quiet band', () => {
    trackOwner('su-hot', 270_000, 300_000); // 90% → critical
    const out = contextGaugeAnnotator(ok('result body'), ctx('su-hot'));
    const texts = gaugeText(out);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('context: 270000/300000 (90%)');
    expect(texts[1]).toContain('CRITICAL');
    expect((out._meta as Record<string, unknown>)?._contextGauge).toContain('90%');
  });

  it('appends NOTHING below the quiet band (the common case)', () => {
    trackOwner('su-cool', 60_000, 300_000); // 20%
    const r = ok('body');
    const out = contextGaugeAnnotator(r, ctx('su-cool'));
    expect(out).toBe(r); // untouched reference
  });

  it('appends NOTHING for an owner the watchdog is not tracking (no cache entry)', () => {
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-unknown'))).toBe(r);
  });

  it('appends NOTHING for an unattributable ctx (resolveAgentIdentity throws)', () => {
    trackOwner('whatever', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, {})).toBe(r); // no identity fields → throws → swallowed
  });

  it('does NOT double-render when the result already carries a context line', () => {
    trackOwner('su-hot', 270_000, 300_000);
    // e.g. a coord:inbox result whose JSON already contains the usage line
    const r = ok('{"injection":"context: 270000/300000 (90%)\\n[coord+1]"}');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('is suppressed when the gauge flag mirror is disabled', () => {
    trackOwner('su-hot', 270_000, 300_000);
    setContextGaugeEnabled(false);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-hot'))).toBe(r);
  });

  it('renders the quiet bare fact in 65–79%', () => {
    trackOwner('su-mid', 210_000, 300_000); // 70%
    const out = contextGaugeAnnotator(ok('body'), ctx('su-mid'));
    const texts = gaugeText(out);
    expect(texts[1]).toBe('context: 210000/300000 (70%)');
    expect(texts[1]).not.toContain('⚠');
  });

  it('renders the CURRENT transcript state, not the cached tokens (WI-4154)', () => {
    // Cache says 90% (pre-compaction), but the live transcript is small — the
    // render must follow the transcript. This is the false-alarm regression test.
    trackOwner('su-boundary', 270_000, 300_000);
    const small = path.join(dir, 'post-compaction.jsonl');
    fs.writeFileSync(small, `{"t":"${'x'.repeat(40_000)}"}\n`);
    seedContextAnchorForTests('su-boundary', small); // transcript now reads ~10k tokens (3%)
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-boundary'))).toBe(r); // 3% → silent, no false alarm
  });

  it('renders NOTHING when no live read is possible (never a stale cached number)', () => {
    // Tracked (limit known) but no anchor and no resolvable transcript in tests:
    // the annotator must stay silent rather than render the cached 90%.
    recordContextUsage('su-blind', 270_000, 300_000);
    const r = ok('body');
    expect(contextGaugeAnnotator(r, ctx('su-blind'))).toBe(r);
  });
});
