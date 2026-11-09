/**
 * WI-41774 — flight-record telemetry must never become a carry `checks` row.
 *
 * Measured before the fix: 41 notes had absorbed telemetry as checks, 1,237 junk
 * rows total, crowding 1,026 real claims past the 12-row cap (worst single item:
 * 252 junk vs 4 real). The rows are handed to cold successors as if they were
 * verified claims.
 *
 * Two independent failure modes are guarded here, because either one alone
 * re-opens the hole:
 *   1. PARSE  — `- at=… tool=… args_key_digest=…` satisfies CHECK_LINE_RE, so it
 *      parses as a claim, is re-rendered as a canonical check row (losing the
 *      ⟦…⟧ wrapper that let mergeWorkItemFlightRecord bound it), and then
 *      multiplies forever.
 *   2. RENDER — CARRY_NOTE_MAX_CHECKS was enforced only in normalizeCheckEntries
 *      (the supplied-write path). A cap enforced on write but not on render is
 *      not a cap, and it is what let one item reach 252 rows.
 *
 * The first test PINS the refusal to the REAL emitter rather than to a
 * hand-copied sample: it formats an actual flight record and asserts every line
 * of it is refused. If `formatWorkItemFlightRecord` changes shape, this fails
 * loudly instead of silently re-admitting telemetry.
 */
import { describe, expect, it } from 'vitest';
import {
  CARRY_NOTE_MAX_CHECKS,
  normalizeCheckEntries,
  parseCarryNote,
  parseCheckLine,
  splitCarryNoteChecks,
  withCarryNoteChecks,
  type CheckEntry,
} from './carry-note';
import { formatWorkItemFlightRecord } from './work-item-flight-record';
import { composeMechanicalCheckpoint } from './turn-end-tracking';

const REAL_CHECK_LINE =
  '- ✓ [#gate-green] the gate is green — re-check: node scripts/x.mjs — evidence: verified 07:00Z (since 2026-08-26T00:00:00.000Z)';

function realFlightRecord(): string {
  return formatWorkItemFlightRecord({
    capturedAt: '2026-08-26T07:30:00.000Z',
    cause: 'lease-release',
    ownerId: 'su-ea80a171-81a7-4423-88ab-587c92a340ca',
    intent: 'fixing the carry-note checks amplifier',
    currentFiles: ['packages/operator-core/lib/carry-note.ts'],
    tools: [
      {
        invokedAt: '2026-08-25 23:56:36.648-04',
        tool: 'coord:glance',
        status: 'ok',
        durationMs: 73,
        errorCode: null,
        argsJson: '{"audience":"*","activity_limit":5}',
      },
      {
        invokedAt: '2026-08-25 23:41:28.941-04',
        tool: 'loop:arm',
        status: 'ok',
        durationMs: 129,
        errorCode: null,
        argsJson: '{"goal":"x","intervalSec":60}',
      },
    ],
  });
}

describe('WI-41774: flight-record telemetry is not a check row', () => {
  it('keeps emitted system records out of the authored next action and retains real checks and walls', () => {
    const mechanical = composeMechanicalCheckpoint({
      atIso: '2026-11-09T00:08:39.545Z',
      sessionId: 'su-holder',
      boundary: 'respawn',
      toolLog: '## Next action\nThis is tool-log output, not an authored instruction.',
    });
    const note = [
      '## Next action', 'Verify the current discovery audit.',
      '', '---', '', realFlightRecord(),
      '', '---', '', mechanical,
      '', '## Checks', REAL_CHECK_LINE,
      '', '## Walls', '- Preserve the source bench.',
    ].join('\n');

    const parsed = parseCarryNote(note);
    expect(parsed.next).toBe('Verify the current discovery audit.');
    expect(parsed.checks?.map(check => check.claim)).toEqual(['the gate is green']);
    expect(parsed.walls?.map(wall => wall.claim)).toEqual(['Preserve the source bench.']);
  });

  it('reads an authored update after a mechanical record without adopting its tool-log headings', () => {
    const mechanical = composeMechanicalCheckpoint({
      atIso: '2026-11-09T00:08:39.545Z',
      toolLog: '## Next action\nHistorical tool-log text.',
    });
    const note = ['## Next action', 'Old authored action.', '', '---', '', mechanical,
      '', '---', '', '## Next action', 'Current authored action.'].join('\n');

    expect(parseCarryNote(note).next).toBe('Current authored action.');
  });

  it('preserves quoted and inline mentions of system markers in authored prose', () => {
    const body = 'Inspect the marker ⟦auto-checkpoint mechanical before acting.\n' +
      '> ⟦work-item-flight-record v1 begin⟧\nKeep this quoted example.';
    expect(parseCarryNote(`## Next action\n${body}`).next).toBe(body);
  });

  it('refuses EVERY line of a real formatted flight record (pinned to the emitter)', () => {
    const lines = realFlightRecord()
      .split('\n')
      .filter((l) => l.startsWith('- '));

    // Guard the guard: if the emitter stopped producing `- ` lines this test
    // would vacuously pass while measuring nothing.
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(parseCheckLine(line), `telemetry parsed as a check row: ${line}`).toBeNull();
    }
  });

  it('drops telemetry but keeps real claims when a record sits under ## Checks', () => {
    const telemetry = realFlightRecord()
      .split('\n')
      .filter((l) => l.startsWith('- '));
    const note = ['prose', '', '## Checks', '_legend_', REAL_CHECK_LINE, ...telemetry].join('\n');

    const { checks } = splitCarryNoteChecks(note);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.claim).toBe('the gate is green');
  });

  it('refuses telemetry supplied through structured checks while preserving real claims', () => {
    const emittedTelemetryClaim = realFlightRecord()
      .split('\n')
      .find((line) => line.startsWith('- at='))
      ?.slice(2);

    expect(emittedTelemetryClaim).toBeTruthy();

    const normalized = normalizeCheckEntries(
      [{ claim: emittedTelemetryClaim! }, { claim: 'the gate is green' }],
      [],
      Date.parse('2026-08-26T07:30:00.000Z'),
    );

    expect(normalized.map((entry) => entry.claim)).toEqual(['the gate is green']);
  });

  it('does NOT eat a legitimate claim that merely mentions tool= or at=', () => {
    // Anti-overreach: the refusal must be narrow. A real claim discussing tool
    // telemetry is still a claim.
    const line = '- ✓ every tool= line at= the top is filtered — re-check: rerun probe';
    const parsed = parseCheckLine(line);

    expect(parsed).not.toBeNull();
    expect(parsed?.claim).toContain('tool=');
  });

  it('drains already-absorbed telemetry on the next round-trip, and stays drained', () => {
    // This is the MIGRATION claim: the 41 polluted notes need no data backfill,
    // because refusing the shape at admission means the junk simply fails to
    // survive each note's next parse→render cycle. Repeat the cycle to prove it
    // is a fixed point and not a one-time drop.
    const telemetry = realFlightRecord()
      .split('\n')
      .filter((l) => l.startsWith('- '));
    let note = ['prose', '', '## Checks', '_legend_', REAL_CHECK_LINE, ...telemetry].join('\n');

    const counts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { body, checks } = splitCarryNoteChecks(note);
      counts.push(checks.length);
      note = withCarryNoteChecks(body, checks);
    }

    expect(counts).toEqual([1, 1, 1, 1]);
    expect(note).not.toContain('args_key_digest');
    expect(note).toContain('the gate is green');
  });

  it('leaves the RENDER path uncapped so an over-cap legacy note keeps its tail', () => {
    // Guards the fix AGAINST ITSELF. Capping withCarryNoteChecks looks like the
    // obvious containment for a 252-row runaway, but it silently evicts real
    // carried rows (P-013) and breaks keyed patching of an over-cap legacy note.
    // Containment belongs at admission, not here.
    const many: CheckEntry[] = Array.from({ length: 40 }, (_, i) => ({ claim: `legacy claim ${i + 1}` }));

    const rendered = withCarryNoteChecks('prose', many);
    const rows = rendered.split('\n').filter((l) => /^-\s+/.test(l));

    expect(rows).toHaveLength(40);
    expect(rows.length).toBeGreaterThan(CARRY_NOTE_MAX_CHECKS);
  });
});
