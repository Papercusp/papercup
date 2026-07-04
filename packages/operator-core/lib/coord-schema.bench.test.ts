/**
 * Coord-injection token benchmark (token-efficient-coord-injection P-006).
 *
 * Sizes the before/after of the continuous `[coord]` injection drain with a real
 * BPE tokenizer (`o200k_base`, a frontier-tokenizer proxy — the RELATIVE ratio is
 * what matters), for a 1-message and an N-message inbox. The "before" reproduces
 * the legacy cc/omp hook output (full UUID twice on lifecycle lines, per-`(kind)`
 * tag, a per-injection footer); the "after" is `renderInjection` + the glyph-free
 * stored summaries. Asserts the cut as a regression guard so a future change that
 * erodes the savings fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { renderInjection, glyphFor, shortHandle, type CoordLineSource } from './coord-schema';

const enc = getEncoding('o200k_base');
const tok = (s: string): number => enc.encode(s).length;

const LEGACY_FOOTER =
  'Reply or hand off with coord:send; read the full thread with coord:inbox / coord:thread. Ignore if not relevant to your task.';

/**
 * Reproduce the LEGACY injection: `[coord] N new …:` header, `• {from} ({kind}):
 * {summary}` lines where the lifecycle summary itself re-embedded the glyph +
 * sender, and the ~40-token footer on EVERY injection.
 */
function legacyInjection(entries: Array<CoordLineSource & { legacySummary: string }>): string {
  const n = entries.length;
  const lines = [`[coord] ${n} new coordination message${n === 1 ? '' : 's'} since your last tool call:`];
  for (const e of entries) {
    const kind = e.kind && e.kind !== 'message' ? ` (${e.kind})` : '';
    lines.push(`  • ${e.from}${kind}: ${e.legacySummary}`);
  }
  lines.push(LEGACY_FOOTER);
  return lines.join('\n');
}

/** A realistic mixed inbox. `legacySummary` carries the OLD glyph + sender re-embed
 *  baked into the stored summary; `summary` is the NEW glyph-free/sender-free prose. */
function fixture(): Array<CoordLineSource & { legacySummary: string }> {
  const peerA = 'su-ab53332d-3ecb-4f37-b89e-fd57ac3c03df';
  const peerB = 'su-5580eba9-1c0a-4f63-bf71-b39d0afc3b8c';
  const peerC = 'su-9042e9c8-9a6a-45df-a415-075580fb175d';
  return [
    {
      from: peerA, kind: 'message', lifecycle: 'intent', ts: '2026-06-06T00:00:01.000Z',
      summary: 'now working on: the pre-prompt registry + Tier-3 read branch',
      legacySummary: `▶ ${peerA} now working on: the pre-prompt registry + Tier-3 read branch`,
    },
    {
      from: peerB, kind: 'message', lifecycle: 'completion', ts: '2026-06-06T00:00:02.000Z',
      summary: 'token-efficient-agent-io DONE: 17 items, 86 result-encoding tests — migs none',
      legacySummary: `token-efficient-agent-io DONE (${peerB}): 17 items, 86 result-encoding tests — migs none`,
    },
    {
      from: peerC, kind: 'handoff', ts: '2026-06-06T00:00:03.000Z',
      summary: 'handoff → su-2bf2: the P4 ?pot= slice on CupboardClient.tsx',
      legacySummary: `↪ handoff → su-2bf2: the P4 ?pot= slice on CupboardClient.tsx`,
    },
    {
      from: peerA, kind: 'escalation', severity: 'high', ts: '2026-06-06T00:00:04.000Z',
      summary: 'green-checkpoint red 15h — deploy held',
      legacySummary: 'green-checkpoint red 15h — deploy held',
    },
    {
      from: peerB, kind: 'message', lifecycle: 'window', ts: '2026-06-06T00:00:05.000Z',
      summary: 'holding dev-server — exclusive restart for the release-gate deploy',
      legacySummary: `🔒 holding dev-server (${peerB}) — exclusive restart for the release-gate deploy`,
    },
  ];
}

function report(label: string, before: number, after: number): void {
  const cut = (100 * (1 - after / before)).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`── ${label}: legacy ${before} tok → positional ${after} tok  (-${cut}%)`);
}

describe('coord injection token benchmark', () => {
  it('N-message inbox — the positional block is a large cut vs the legacy format', () => {
    const entries = fixture();
    const before = tok(legacyInjection(entries));
    const after = tok(renderInjection(entries));
    report(`${entries.length}-msg`, before, after);
    // The continuous drain (footer + double-UUID + glyph prose + per-(kind)) is
    // mostly eliminated. Guard a real, substantial cut.
    expect(after).toBeLessThan(before * 0.55);
  });

  it('1-message inbox — even a single line wins big (the footer dominates the legacy form)', () => {
    const one = [fixture()[0]];
    const before = tok(legacyInjection(one));
    const after = tok(renderInjection(one));
    report('1-msg', before, after);
    expect(after).toBeLessThan(before * 0.45);
  });

  it('the savings come from a short handle + 1-token glyph + no per-line UUID re-embed', () => {
    // A lifecycle intent line: legacy repeats the 36-char UUID TWICE; new shows a
    // 5-char handle once + a 1-token glyph.
    const e = fixture()[0];
    expect(shortHandle(e.from).length).toBeLessThanOrEqual(5);
    expect(tok(glyphFor(e))).toBe(1); // ASCII glyph is exactly one token
  });
});
