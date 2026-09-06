/**
 * Delta-protocol override contract (agent-tool-delta-protocol-2026-06-22 P-007).
 *
 * The S23/S24/S25 scenarios all hinge on `makeDeltaSnapshotOverride`'s stateful
 * sequence: call 1 → full snapshot, call 2 → delta, call 3+ → re-fetched current
 * full list. This deterministically validates that contract (no model, no spend)
 * so a regression in the fixture is caught here, not as a confusing scenario
 * flake. Mirrors the merge truth the scenario asserts depend on.
 */

import { describe, expect, it } from 'vitest';

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import {
  makeDeltaSnapshotOverride,
  DELTA_BASE_ROWS,
  DELTA_CURRENT_ROWS,
} from '../scenarios/su/_overrides';
import { SU_S24_DELTA_FALLBACK_COMPACTED } from '../scenarios/su/S24-delta-fallback-compacted';

function callJson(ov: ReturnType<typeof makeDeltaSnapshotOverride>, name = 'work_items:list') {
  const res = ov.override(name, {});
  if (res === PASS_THROUGH) throw new Error('unexpected PASS_THROUGH');
  // Sync override returns a ToolResult; the su target joins content[].text.
  const text = (res as { content: Array<{ text?: string }> }).content.map((c) => c.text).join('\n');
  return JSON.parse(text) as { mode: string; items: Array<{ id: string; title: string }>; cursor: string };
}

describe('makeDeltaSnapshotOverride (delta-protocol fixture)', () => {
  it('returns full → delta → refetch-full across successive calls', () => {
    const ov = makeDeltaSnapshotOverride();

    // Call 1: the full base snapshot.
    const c1 = callJson(ov);
    expect(c1.mode).toBe('full');
    expect(c1.items).toEqual(DELTA_BASE_ROWS);
    expect((c1 as unknown as { note: string }).note).toMatch(/change-watermark, not a pagination cursor/i);

    // Call 2: the delta — one removed, one updated, one added.
    const c2 = callJson(ov) as unknown as {
      mode: string;
      items: Array<{ change: string; id: string }>;
      note: string;
    };
    expect(c2.mode).toBe('delta');
    const changes = Object.fromEntries(c2.items.map((i) => [i.id, i.change]));
    expect(changes).toEqual({ 'WI-7002': 'removed', 'WI-7004': 'updated', 'WI-7006': 'added' });
    // The legible inline contract tells a base-less model to re-fetch.
    expect(c2.note).toMatch(/re-?call|re-?fetch/i);

    // Call 3 (the fallback re-fetch): the current full list = base merged.
    const c3 = callJson(ov);
    expect(c3.mode).toBe('full');
    expect(c3.items).toEqual(DELTA_CURRENT_ROWS);

    // Call 4+: stays on the current full list.
    expect(callJson(ov).items).toEqual(DELTA_CURRENT_ROWS);
  });

  it('keeps secondary detail reads consistent with the current full snapshot', () => {
    const ov = makeDeltaSnapshotOverride();
    callJson(ov); // base
    callJson(ov); // apply delta; current view now contains WI-7006

    const result = ov.override('work_items:get', { id: 'WI-7006' });
    if (result === PASS_THROUGH) throw new Error('work_items:get unexpectedly passed through');
    const body = JSON.parse((result as { content: Array<{ text?: string }> }).content[0]!.text!);

    expect(body.results[0]).toMatchObject({
      ok: true,
      id: 'WI-7006',
      workItem: { title: 'Sandbox npm-install EROFS', state: 'open' },
    });
  });

  it('makes the compacted follow-up self-contained about which list to re-fetch', () => {
    expect(SU_S24_DELTA_FALLBACK_COMPACTED.version).toBe(2);
    const followUp = SU_S24_DELTA_FALLBACK_COMPACTED.triggers?.find(
      (trigger) => trigger.on === 'after_turn' && trigger.param === 1,
    );
    expect(followUp).toMatchObject({ fire: 'user_message' });
    expect((followUp as { text?: string }).text).toMatch(/open work-item list/i);
  });

  it('the current truth is the base correctly merged (removed gone, updated retitled, added present)', () => {
    const baseIds = new Set(DELTA_BASE_ROWS.map((r) => r.id));
    const curIds = new Set(DELTA_CURRENT_ROWS.map((r) => r.id));
    expect(curIds.has('WI-7002')).toBe(false); // removed
    expect(curIds.has('WI-7006')).toBe(true); // added (not in base)
    expect(baseIds.has('WI-7006')).toBe(false);
    // updated row keeps its id but changes title
    const baseUpd = DELTA_BASE_ROWS.find((r) => r.id === 'WI-7004')!;
    const curUpd = DELTA_CURRENT_ROWS.find((r) => r.id === 'WI-7004')!;
    expect(baseUpd.title).toMatch(/naive-retry/i);
    expect(curUpd.title).toMatch(/circuit-breaker/i);
    // The removed row's distinctive token must not appear in the current set.
    expect(DELTA_CURRENT_ROWS.some((r) => /debounce/i.test(r.title))).toBe(false);
  });

  it('passes through any non-snapshot tool', () => {
    const ov = makeDeltaSnapshotOverride();
    expect(ov.override('audit:list', {})).toBe(PASS_THROUGH);
    expect(ov.override('plans:get', {})).toBe(PASS_THROUGH);
  });

  it('matches the mcp-prefixed alias of the snapshot tool', () => {
    const ov = makeDeltaSnapshotOverride();
    expect(callJson(ov, 'mcp__agentmcp__work_items:list').mode).toBe('full');
  });

  it('gives each instance fresh call-count state (the getter-per-run contract)', () => {
    const a = makeDeltaSnapshotOverride();
    callJson(a); // advance a to delta-next
    const b = makeDeltaSnapshotOverride();
    // b is independent: its first call is still the full snapshot.
    expect(callJson(b).mode).toBe('full');
  });
});
