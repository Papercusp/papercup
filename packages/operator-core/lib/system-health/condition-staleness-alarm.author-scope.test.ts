/**
 * EI-19403159016550818 — the condition-staleness alarm's DEFAULT open-escalation
 * read must be author-scoped SERVER-SIDE.
 *
 * Why this lives in its own file: every test in condition-staleness-alarm.test.ts
 * injects `deps.listOpen`, so the DEFAULT implementation — the one that actually
 * shipped, and the one that was broken — had no coverage at all. Exercising it
 * requires mocking the escalations module, and a file-hoisted vi.mock would apply
 * to that whole suite. Kept separate so it cannot perturb it.
 *
 * THE DEFECT: the default read fetched a workspace-wide page of open escalations
 * (`maxRecords: OPEN_SCAN_WINDOW`, 500 — already the hard cap in
 * listEscalationsPaginated) and then filtered `e.from === <this alarm>` in JS.
 * The open-escalations projection is ordered OLDEST-first, and this alarm's own
 * rows are the NEWEST (it is the thing minting them), so once the workspace-wide
 * open set exceeds the window its rows sit entirely past it. Measured 2026-08-03
 * on a 607-row open set: this alarm's 60 rows occupied positions 501..607, the JS
 * filter returned exactly 0, and the auto-resolve leg became a permanent no-op —
 * 60 reminders for an already-recovered condition stayed open for hours with no
 * fault reported anywhere, because an empty page and "nothing of mine is open"
 * are the same value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

const listEscalationsPaginated = vi.fn();

// Spread the REAL module and override only the one read under test: a hand-written
// mock that enumerates exports silently red-pins every test in a file the moment
// the module under test adds an import from it (the checkpoint.test.ts class of
// failure) — importOriginal keeps that from being possible here.
vi.mock('../agent-tools/coordination/escalations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/escalations')>();
  return { ...actual, listEscalationsPaginated: (...args: unknown[]) => listEscalationsPaginated(...args) };
});

const { runConditionStalenessTick, CONDITION_STALENESS_IDENTITY } = await import('./condition-staleness-alarm');

const ALARM = CONDITION_STALENESS_IDENTITY.ownerId;

function reminderFor(conditionKey: string, msg_id: string): EscalationRecord {
  return {
    msg_id,
    from: ALARM,
    ts: new Date().toISOString(),
    severity: 'advisory',
    summary: `[condition-stale] condition '${conditionKey}' has been OPEN for 60m`,
    meta: { subjectSignature: `stale-condition:${conditionKey}` },
    resolved: null,
  } as unknown as EscalationRecord;
}

/** No conditions open at all → every open reminder should be auto-resolved. */
const NO_CONDITIONS_OPEN = async () => [];

describe('EI-19403159016550818: default open-escalation read is author-scoped', () => {
  beforeEach(() => {
    listEscalationsPaginated.mockReset();
  });

  it('pushes `from` into the query instead of filtering a workspace-wide page in JS', async () => {
    listEscalationsPaginated.mockResolvedValue({ escalations: [], truncated: false, total: 0 });

    await runConditionStalenessTick({
      readStates: NO_CONDITIONS_OPEN,
      escalate: async () => ({}),
      resolve: async () => true,
    });

    expect(listEscalationsPaginated).toHaveBeenCalledTimes(1);
    const args = listEscalationsPaginated.mock.calls[0][0];
    expect(args).toMatchObject({ status: 'open', from: ALARM });
  });

  it('REGRESSION: resolves its own reminders even when they sit past the workspace-wide window', async () => {
    // The store returns THIS ALARM'S rows because the query was author-scoped.
    // Under the old JS-filter read these rows were positions 501..607 of a 500-row
    // page, so this list arrived empty and `resolved` was [].
    const mine = [reminderFor('single-primary:no-primary', 'M-1'), reminderFor('single-primary:no-primary', 'M-2')];
    listEscalationsPaginated.mockResolvedValue({ escalations: mine, truncated: false, total: mine.length });

    const resolvedIds: string[] = [];
    const res = await runConditionStalenessTick({
      readStates: NO_CONDITIONS_OPEN, // the condition has RECOVERED
      escalate: async () => ({}),
      resolve: async (msg_id: string) => {
        resolvedIds.push(msg_id);
        return true;
      },
    });

    expect(resolvedIds).toEqual(['M-1', 'M-2']);
    expect(res.resolved).toEqual(['M-1', 'M-2']);
  });

  it('a TRUNCATED page is reported, never silently taken as "nothing of mine is open"', async () => {
    // The flag the original read destructured away. A resolve decision taken from a
    // page known to be partial re-creates the exact defect with a smaller window.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listEscalationsPaginated.mockResolvedValue({
      escalations: [reminderFor('single-primary:no-primary', 'M-1')],
      truncated: true,
      total: 1,
      trueOpenTotal: 607,
    });

    await runConditionStalenessTick({
      readStates: NO_CONDITIONS_OPEN,
      escalate: async () => ({}),
      resolve: async () => true,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/TRUNCATED/);
    warn.mockRestore();
  });

  it('a read failure still degrades to a no-op tick rather than throwing', async () => {
    listEscalationsPaginated.mockRejectedValue(new Error('projection unreachable'));

    const res = await runConditionStalenessTick({
      readStates: NO_CONDITIONS_OPEN,
      escalate: async () => ({}),
      resolve: async () => true,
    });

    expect(res.resolved).toEqual([]);
  });
});
