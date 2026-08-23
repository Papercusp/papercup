import { describe, expect, it } from 'vitest';
import { MECHANICAL_CHECKPOINT_MARKER } from './turn-end-tracking';
import {
  WORK_ITEM_FLIGHT_RECORD_BEGIN,
  digestTopLevelArgKeys,
  formatWorkItemFlightRecord,
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
});
