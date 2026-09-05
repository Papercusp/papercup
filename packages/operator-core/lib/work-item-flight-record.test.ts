import { describe, expect, it } from 'vitest';
import { splitCarryNoteChecks, splitCarryNoteWalls } from './carry-note';
import { MECHANICAL_CHECKPOINT_MARKER } from './turn-end-tracking';
import {
  WORK_ITEM_FLIGHT_RECORD_BEGIN,
  digestTopLevelArgKeys,
  formatWorkItemFlightRecord,
  hasPriorAuthoredProse,
  mergeWorkItemFlightRecord,
} from './work-item-flight-record';

function record(n: number): string {
  return formatWorkItemFlightRecord({
    ownerId: 'su-target',
    cause: 'lease-release',
    capturedAt: `2026-08-23T00:00:0${n}.000Z`,
    intent: `intent ${n}`,
    currentFiles: [`file-${n}.ts`],
    tools: [],
  });
}

describe('work-item flight record', () => {
  it('formats bounded metadata and never persists argument values', () => {
    const out = formatWorkItemFlightRecord({
      ownerId: 'su-target',
      cause: 'forced-interrupt',
      capturedAt: '2026-08-23T00:00:00.000Z',
      intent: 'repair the release seam',
      currentFiles: ['a.ts'],
      tools: [
        {
          tool: 'setup:save_key',
          status: 'error',
          invokedAt: '2026-08-23T00:00:00.000Z',
          durationMs: 42,
          errorCode: 'invalid_input',
          argsJson: { provider: 'openai', apiKey: 'sk-super-secret' },
        },
      ],
    });
    expect(out).toContain('repair the release seam');
    expect(out).toContain('current_files: ["a.ts"]');
    expect(out).toContain('args_keys=["apiKey","provider"]');
    expect(out).not.toContain('sk-super-secret');
    expect(out).not.toContain('openai');
    expect(digestTopLevelArgKeys({ provider: 'one', apiKey: 'two' })).toEqual(
      digestTopLevelArgKeys({ apiKey: 'different', provider: 'different' }),
    );
  });

  it('keeps only the newest three records, preserves authored prose, and inserts before a legacy mechanical tail', () => {
    const authored = 'Authored checkpoint line 1.\nAuthored checkpoint line 2.';
    const mechanical = `${MECHANICAL_CHECKPOINT_MARKER} @old⟧ legacy mechanical tail`;
    let merged = `${authored}\n\n---\n${mechanical}`;
    for (let n = 1; n <= 4; n += 1) merged = mergeWorkItemFlightRecord(merged, record(n));

    expect(merged.startsWith(authored)).toBe(true);
    expect(merged.match(new RegExp(WORK_ITEM_FLIGHT_RECORD_BEGIN, 'g'))).toHaveLength(3);
    expect(merged).not.toContain('intent 1');
    expect(merged).toContain('intent 2');
    expect(merged).toContain('intent 4');
    expect(merged.indexOf('intent 4')).toBeLessThan(merged.indexOf(MECHANICAL_CHECKPOINT_MARKER));
    expect(merged.endsWith(mechanical)).toBe(true);
  });

  it('keeps automatic telemetry outside authored Checks and Walls sections', () => {
    const prior = [
      '## Did',
      'The agent-authored checkpoint.',
      '',
      '## Checks',
      '- ✓ existing claim — re-check: run the probe — evidence: still true',
      '',
      '## Walls',
      '- owner gate — re-check: ask the owner',
    ].join('\n');
    const automatic = formatWorkItemFlightRecord({
      ownerId: 'su-target',
      cause: 'lease-release',
      capturedAt: '2026-08-23T00:00:00.000Z',
      intent: 'recover the interrupted task',
      currentFiles: ['a.ts'],
      tools: [
        {
          tool: 'coord:glance',
          status: 'ok',
          invokedAt: '2026-08-23T00:00:00.000Z',
          durationMs: 10,
          errorCode: null,
          argsJson: { checks: ['not-a-carry-claim'] },
        },
      ],
    });

    const merged = mergeWorkItemFlightRecord(prior, automatic);
    const { body, checks } = splitCarryNoteChecks(merged);
    const { walls } = splitCarryNoteWalls(merged);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.claim).toBe('existing claim');
    expect(walls).toHaveLength(1);
    expect(walls[0]?.claim).toBe('owner gate');
    expect(body).toContain(WORK_ITEM_FLIGHT_RECORD_BEGIN);
    expect(body).toContain('args_key_digest=');
    expect(merged.indexOf(WORK_ITEM_FLIGHT_RECORD_BEGIN)).toBeLessThan(merged.indexOf('## Checks'));
  });

  // EI-21360972070006156 — the three regression guards below. Each asserts a line a
  // reader needs in order to DATE or SCOPE the prose beside a flight record; removing
  // the feature drops the line and fails the assertion.
  it('detects authored prose in both directions, so the record cannot claim what the merge contradicts', () => {
    // Control: a checkpoint holding ONLY a machine record has no authored prose. Without
    // this direction the detector could return a constant true and still look correct.
    const machineOnly = mergeWorkItemFlightRecord('', record(1));
    expect(machineOnly).toContain(WORK_ITEM_FLIGHT_RECORD_BEGIN);
    expect(hasPriorAuthoredProse(machineOnly)).toBe(false);
    expect(hasPriorAuthoredProse('')).toBe(false);
    expect(hasPriorAuthoredProse(null)).toBe(false);

    // A structured carry section alone is not authored PROSE either.
    expect(hasPriorAuthoredProse('## Checks\n- ✓ a claim — re-check: probe')).toBe(false);

    expect(hasPriorAuthoredProse('This item is one of the two initial claimed lanes.')).toBe(true);
    expect(hasPriorAuthoredProse(mergeWorkItemFlightRecord('Authored line.', record(2)))).toBe(true);
  });

  it('proves the clone guard discriminates: without per-item fields the output IS byte-identical', () => {
    // POSITIVE CONTROL for work-item-flight-record-capture.test.ts, which asserts that
    // two items no longer receive identical text. That assertion only means something if
    // the PRE-FIX shape — compose once, no per-item fields — really did produce identical
    // output. Kept here permanently rather than as a throwaway probe, so a successor can
    // re-run the proof instead of trusting a claim that the guard is falsifiable.
    const base = {
      ownerId: 'su-8973ac94',
      cause: 'lease-release' as const,
      capturedAt: '2026-08-24T18:20:00.505Z',
      intent: 'this item is one of the two initial claimed lanes; no source edits yet',
      currentFiles: [],
      tools: [],
    };
    expect(formatWorkItemFlightRecord(base)).toEqual(formatWorkItemFlightRecord(base));

    // ...and WITH them it does not. Both halves are needed: the first shows the old
    // behaviour was detectable, the second that the fix actually changes what is detected.
    expect(formatWorkItemFlightRecord({ ...base, alsoStampedOnItemIds: ['WI-41351'] })).not.toEqual(
      formatWorkItemFlightRecord({ ...base, alsoStampedOnItemIds: ['WI-41347'] }),
    );
  });

  it('marks a record cloned across several items as session-lane scoped, not a per-item reading', () => {
    const shared = {
      ownerId: 'su-target',
      cause: 'lease-release' as const,
      capturedAt: '2026-08-24T18:20:00.505Z',
      intent: 'this item is one of the two initial claimed lanes; no source edits yet',
      currentFiles: [],
      tools: [],
    };

    // The WI-41347 / WI-41351 shape: ONE lane note, two items.
    const cloned = formatWorkItemFlightRecord({ ...shared, alsoStampedOnItemIds: ['WI-41351'] });
    expect(cloned).toContain('intent_scope: session-lane');
    expect(cloned).toContain('stamped identically onto 2 items');
    expect(cloned).toContain('NOT a reading of this item');
    expect(cloned).toContain('also_stamped_on: ["WI-41351"]');

    // Control: a genuine single-item capture must NOT carry the warning, or the field
    // would be noise on every record and mean nothing on the ones that matter.
    const single = formatWorkItemFlightRecord({ ...shared, alsoStampedOnItemIds: [] });
    expect(single).not.toContain('intent_scope:');
    expect(single).not.toContain('also_stamped_on:');
  });

  it('states that authored prose above a record predates the capture', () => {
    // Reconstructs the confirmed failure: prose written at claim time asserting "no
    // source edits yet", still sitting above a release-time captured_at 17 minutes after
    // the edits landed. Nothing in the record used to date the prose.
    const staleProse = 'This item is one of the two initial claimed lanes; no source edits yet.';
    const withProse = formatWorkItemFlightRecord({
      ownerId: 'su-8973ac94',
      cause: 'lease-release',
      capturedAt: '2026-08-24T18:20:00.505Z',
      intent: 'initial claimed lanes',
      currentFiles: [],
      tools: [],
      priorAuthoredProse: hasPriorAuthoredProse(staleProse) ? 'present' : 'absent',
    });
    expect(withProse).toContain('authored_prose_above: PRESENT and PREDATES this capture');
    expect(withProse).toContain('date any absence claim in it against the file history');

    const merged = mergeWorkItemFlightRecord(staleProse, withProse);
    // The prose is still preserved verbatim — the fix adds provenance, it never edits
    // or drops what the agent wrote.
    expect(merged.startsWith(staleProse)).toBe(true);
    expect(merged.indexOf(staleProse)).toBeLessThan(merged.indexOf('authored_prose_above:'));

    const withoutProse = formatWorkItemFlightRecord({
      ownerId: 'su-8973ac94',
      cause: 'lease-release',
      capturedAt: '2026-08-24T18:20:00.505Z',
      intent: 'initial claimed lanes',
      currentFiles: [],
      tools: [],
      priorAuthoredProse: 'absent',
    });
    expect(withoutProse).toContain('authored_prose_above: none');
    expect(withoutProse).not.toContain('PREDATES this capture');
  });
});
