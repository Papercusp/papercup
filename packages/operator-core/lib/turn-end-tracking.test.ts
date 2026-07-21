/** P-015 (deterministic-context-carry) — turn-end sweeps: stale-held-WI
 *  auto-checkpoint composition/merge + unregistered-artifact detection. */
import { describe, expect, it } from 'vitest';
import {
  MECHANICAL_CHECKPOINT_MARKER,
  STALE_CHECKPOINT_MS,
  UNGUARDED_HALT_NOTE,
  composeMechanicalCheckpoint,
  detectUnguardedHalt,
  detectUnregisteredArtifacts,
  isDeliverableWrite,
  isRewakeGuaranteed,
  isStaleHeldCheckpoint,
  mergeMechanicalCheckpoint,
  unregisteredArtifactTripwire,
} from './turn-end-tracking';

const NOW = 1_784_000_000_000;

describe('isStaleHeldCheckpoint', () => {
  it('missing/blank checkpoint is stale', () => {
    expect(isStaleHeldCheckpoint({ checkpoint: null }, NOW)).toBe(true);
    expect(isStaleHeldCheckpoint({ checkpoint: '   ' }, NOW)).toBe(true);
  });

  it('old checkpoint is stale; fresh is not', () => {
    const old = { checkpoint: 'x', checkpointUpdatedAtMs: NOW - STALE_CHECKPOINT_MS - 1 };
    const fresh = { checkpoint: 'x', checkpointUpdatedAtMs: NOW - 60_000 };
    expect(isStaleHeldCheckpoint(old, NOW)).toBe(true);
    expect(isStaleHeldCheckpoint(fresh, NOW)).toBe(false);
  });

  it('an EXISTING checkpoint with unknown write time is NOT stale (cannot prove the gap)', () => {
    expect(isStaleHeldCheckpoint({ checkpoint: 'x', checkpointUpdatedAtMs: null }, NOW)).toBe(false);
    expect(isStaleHeldCheckpoint({ checkpoint: 'x' }, NOW)).toBe(false);
  });
});

describe('composeMechanicalCheckpoint / mergeMechanicalCheckpoint', () => {
  const block = composeMechanicalCheckpoint({
    atIso: '2026-07-14T18:30:00.000Z',
    journalNote: 'P-015 legs 1-2 landed; tests next.',
    toolLog: 'Edit assert.ts ✓\nBash vitest run ✓',
    sessionId: 'bf1881bc-9fd9',
  });

  it('block opens with the mechanical marker and carries note + log + session', () => {
    expect(block.startsWith(MECHANICAL_CHECKPOINT_MARKER)).toBe(true);
    expect(block).toContain('latest journal: P-015 legs 1-2 landed');
    expect(block).toContain('Bash vitest run ✓');
    expect(block).toContain('session: bf1881bc-9fd9');
  });

  it('merge onto an empty checkpoint is the block alone', () => {
    expect(mergeMechanicalCheckpoint(null, block)).toBe(block);
    expect(mergeMechanicalCheckpoint('', block)).toBe(block);
  });

  it('merge PRESERVES agent prose and appends the block', () => {
    const merged = mergeMechanicalCheckpoint('agent wrote this design note', block);
    expect(merged.startsWith('agent wrote this design note')).toBe(true);
    expect(merged).toContain(MECHANICAL_CHECKPOINT_MARKER);
  });

  it('a repeated sweep REPLACES the previous mechanical block, never stacks', () => {
    const first = mergeMechanicalCheckpoint('agent prose', block);
    const block2 = composeMechanicalCheckpoint({ atIso: '2026-07-14T19:30:00.000Z', journalNote: 'later turn' });
    const second = mergeMechanicalCheckpoint(first, block2);
    expect(second.startsWith('agent prose')).toBe(true);
    expect(second.match(new RegExp('⟦auto-checkpoint mechanical', 'g'))).toHaveLength(1);
    expect(second).toContain('later turn');
    expect(second).not.toContain('P-015 legs 1-2 landed');
  });
});

describe('deliverable detection', () => {
  it('scratch-path reports are deliverables; repo/code/plumbing writes are not', () => {
    expect(isDeliverableWrite('/tmp/claude-1000/scratchpad/audit-report.md')).toBe(true);
    expect(isDeliverableWrite('/home/x/.papercusp/scratch/ws/export.csv')).toBe(true);
    expect(isDeliverableWrite('/home/x/repo/lib/foo.ts')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/build.log')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/tasks/run.output.md')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/result-door-123.md')).toBe(false);
  });

  it('detectUnregisteredArtifacts matches registrations by basename and dedupes', () => {
    const writes = [
      '/tmp/s/scratchpad/report.md',
      '/tmp/s/scratchpad/report.md',
      '/tmp/s/scratchpad/summary.html',
      '/repo/lib/code.ts',
    ];
    const out = detectUnregisteredArtifacts(writes, ['reports/REPORT.md']);
    expect(out).toEqual(['/tmp/s/scratchpad/summary.html']);
  });

  it('tripwire is null when clean, populated + noted when not', () => {
    expect(unregisteredArtifactTripwire(['/repo/a.ts'], [])).toBeNull();
    const t = unregisteredArtifactTripwire(['/tmp/s/scratchpad/report.md'], []);
    expect(t?.kind).toBe('unregistered-artifact');
    expect(t?.files).toEqual(['/tmp/s/scratchpad/report.md']);
    expect(t?.note).toContain('artifacts:save');
  });
});

describe('isRewakeGuaranteed / detectUnguardedHalt (re-wake guarantee)', () => {
  const halt = { autonomousModeActive: true, loopActive: false, activeAwaitCount: 0 };

  it('an interactive (non-autonomous) session is ALWAYS guaranteed — never flagged', () => {
    expect(isRewakeGuaranteed({ ...halt, autonomousModeActive: false })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, autonomousModeActive: false })).toBeNull();
  });

  it('an autonomous session with an armed loop is guaranteed', () => {
    expect(isRewakeGuaranteed({ ...halt, loopActive: true })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, loopActive: true })).toBeNull();
  });

  it('an autonomous session with a real (non-inbox-wake) await is guaranteed', () => {
    expect(isRewakeGuaranteed({ ...halt, activeAwaitCount: 1 })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, activeAwaitCount: 2 })).toBeNull();
  });

  it('an owner-interactive turn suppresses the flag even under autonomous mode', () => {
    expect(isRewakeGuaranteed({ ...halt, ownerInteractiveTurn: true })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, ownerInteractiveTurn: true })).toBeNull();
  });

  it('autonomous + no loop + no await + no owner = UNGUARDED HALT', () => {
    expect(isRewakeGuaranteed(halt)).toBe(false);
    const t = detectUnguardedHalt(halt);
    expect(t?.kind).toBe('unguarded-halt');
    expect(t?.note).toBe(UNGUARDED_HALT_NOTE);
    expect(t?.note).toContain('session:request-compaction');
  });
});
