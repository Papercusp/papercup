import { describe, expect, it } from 'vitest';
import {
  finishRepairTickCommand, pendingRepairTickCommands, prepareRepairTickProgress,
  readRepairTickProgressHistory, repairTickProgressSummary, startRepairTickCommand, storeRepairTickProgress,
} from './repair-tick-progress';

const scope = { candidate: 'a'.repeat(40), head: 'b'.repeat(40), openedAtMs: 1 };
const commands = Array.from({ length: 4 }, (_, i) => ({ key: `key-${i}`, gateId: `gate-${i}`, script: `script-${i}`, workspace: null }));

describe('repair tick durable diagnostic continuation', () => {
  it('saves the next command before launch and resumes beyond a repeatedly killed command after restart', () => {
    let progress = prepareRepairTickProgress(scope, commands, undefined);
    progress = startRepairTickCommand(progress, commands[0].key);
    progress = finishRepairTickCommand(progress, commands[0].key, { status: 'fail', durationMs: 2, subjectPaths: ['decisive.ts'] });
    progress = startRepairTickCommand(progress, commands[1].key);
    // Process death: only the pre-launch checkpoint survived, with the command still running.
    const history = JSON.parse(JSON.stringify(storeRepairTickProgress(undefined, progress)));
    progress = prepareRepairTickProgress(scope, [...commands].reverse(), history);
    expect(pendingRepairTickCommands(progress).map((command) => command.key)).toEqual(['key-2', 'key-3', 'key-1']);
    expect(progress.states['key-0']?.result).toMatchObject({ status: 'fail', subjectPaths: ['decisive.ts'] });
    expect(repairTickProgressSummary(progress)).toMatchObject({ complete: false, completedCommandCount: 1,
      remainingCommands: [expect.objectContaining({ key: 'key-2', status: 'pending' }),
        expect.objectContaining({ key: 'key-3', status: 'pending' }), expect.objectContaining({ key: 'key-1', status: 'running' })] });
  });

  it.each([2, 3, 4, 13])('recovers the decisive receipt after %i distinct scope batches without losing earlier heads', (count) => {
    let history: unknown;
    for (let i = 0; i < count; i++) {
      let progress = prepareRepairTickProgress({ ...scope, openedAtMs: i }, commands, history);
      progress = finishRepairTickCommand(startRepairTickCommand(progress, commands[3].key), commands[3].key,
        { status: i === count - 1 ? 'fail' : 'pass', durationMs: 1 });
      history = JSON.parse(JSON.stringify(storeRepairTickProgress(history, progress)));
    }
    const recovered = prepareRepairTickProgress({ ...scope, openedAtMs: count - 1 }, commands, history);
    expect(recovered.states['key-3']?.result?.status).toBe('fail');
    expect(pendingRepairTickCommands(recovered).map((command) => command.key)).not.toContain('key-3');
    expect(readRepairTickProgressHistory(history)).toHaveLength(count);
    expect(prepareRepairTickProgress({ ...scope, openedAtMs: 0 }, commands, history).states['key-3']?.result).toBeDefined();
  });

  it('never reuses receipts at another head, frozen candidate, opening clock, or resolved command manifest', () => {
    let progress = prepareRepairTickProgress(scope, commands, undefined);
    progress = finishRepairTickCommand(startRepairTickCommand(progress, commands[0].key), commands[0].key, { status: 'pass', durationMs: 1 });
    const history = storeRepairTickProgress(undefined, progress);
    for (const changed of [{ head: 'c'.repeat(40) }, { candidate: 'c'.repeat(40) }, { openedAtMs: 2 }]) {
      expect(prepareRepairTickProgress({ ...scope, ...changed }, commands, history).states).toEqual({});
    }
    expect(prepareRepairTickProgress(scope, commands.map((command) => ({ ...command, script: 'changed' })), history).states).toEqual({});
  });

  it('refuses corrupt progress intact instead of treating lost receipts as an empty history', () => {
    const progress = prepareRepairTickProgress(scope, commands, undefined);
    expect(() => prepareRepairTickProgress(scope, commands, { unexpected: progress })).toThrow('unreadable history');
    expect(() => prepareRepairTickProgress(scope, commands, [{ ...progress, cursor: commands.length }])).toThrow('cursor');
    expect(() => prepareRepairTickProgress(scope, commands, [{ ...progress, states: { unknown: { status: 'complete' } } }])).toThrow('state');
  });
});
