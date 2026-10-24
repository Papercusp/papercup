import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedgerRow, tagTurnForInjection, type LedgerRow } from '../../turn-provenance/turn-provenance';
import {
  indexedLoopLaunchBinding, indexedLoopTurnStartRecord,
  type IndexedLoopLaunchBinding, type IndexedNativeLoopTurn,
} from './loop-turn-start-stamp';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('indexed loop launch namespace', () => {
  const turn: IndexedNativeLoopTurn = {
    workspace_id: 'default', source_kind: 'codex', session_id: 'native-a', turn_idx: 7,
    ts: null, owner: 'su-a', speaker: 'user', text: '', turn_origin: 'loop-fire',
  };
  const launch: IndexedLoopLaunchBinding = {
    owner: 'su-a', workspace_id: 'workspace-a', spec_workspace: 'workspace-a',
    agent: 'codex', session_id: 'native-a', omp_thread_id: null,
    provenance_dir: '/scoped/workspace-a/turn-provenance',
  };

  it.each(['codex', 'claude', 'omp'])('binds the exact %s native session to its launch receipt', source => {
    const row = { ...launch, agent: source, ...(source === 'omp' ? { session_id: null, omp_thread_id: 'native-a' } : {}) };
    expect(indexedLoopLaunchBinding({ ...turn, source_kind: source }, [row], 'workspace-a'))
      .toEqual({ dir: launch.provenance_dir, workspaceId: 'workspace-a' });
  });

  it.each([
    ['owner', { owner: 'su-b' }], ['workspace', { workspace_id: 'workspace-b' }],
    ['spec workspace', { spec_workspace: 'workspace-b' }], ['source', { agent: 'claude' }],
    ['native session', { session_id: 'native-b' }], ['missing binding', { provenance_dir: null }],
    ['relative directory', { provenance_dir: 'turn-provenance' }],
  ])('rejects a wrong %s binding', (_name, change) => {
    expect(indexedLoopLaunchBinding(turn, [{ ...launch, ...change }], 'workspace-a')).toBeNull();
  });

  it('keeps absent and ambiguous launch receipts unknown', () => {
    expect(indexedLoopLaunchBinding(turn, [], 'workspace-a')).toBeNull();
    expect(indexedLoopLaunchBinding(turn, [launch, launch], 'workspace-a')).toBeNull();
    expect(indexedLoopLaunchBinding(turn, [launch], 'workspace-b')).toBeNull();
  });

  it('reads the target ledger under a host-global ingester and retains the exact indexed fire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-namespace-'));
    dirs.push(root);
    const targetDir = join(root, 'workspace-a', 'turn-provenance');
    const hostDir = join(root, 'host', 'turn-provenance');
    vi.stubEnv('PAPERCUSP_TURN_PROVENANCE_DIR', hostDir);
    const now = Date.now();
    const tagged = await tagTurnForInjection({ sid: 'su-a', origin: 'loop-fire', text: 'Continue.',
      dir: targetDir, nowMs: now, loopFire: { routineId: 'routine-a', wakeCount: 3 } });
    expect(tagged.ledgerWritten).toBe(true);
    const row = { ...turn, text: tagged.taggedText, ts: new Date(now).toISOString() };
    const target = indexedLoopLaunchBinding(row, [{ ...launch, provenance_dir: targetDir }], 'workspace-a')!;
    expect(indexedLoopTurnStartRecord(row)).toBeNull();
    expect(indexedLoopTurnStartRecord(row, undefined, target)).toMatchObject({
      workspaceId: 'default', owner: 'su-a', sessionId: 'native-a',
      detail: { source: 'session-ingest', provenanceWorkspaceId: 'workspace-a',
        loopFire: { routineId: 'routine-a', wakeCount: 3 },
        indexedTurn: { workspaceId: 'default', sourceKind: 'codex', sessionId: 'native-a', turnIdx: 7 } },
    });
    expect(indexedLoopTurnStartRecord(row, undefined, { ...target, dir: hostDir })).toBeNull();
    expect(indexedLoopTurnStartRecord({ ...row, workspace_id: 'workspace-b' }, undefined, target)).toBeNull();
    expect(indexedLoopTurnStartRecord({ ...row, owner: 'su-b' }, undefined, target)).toBeNull();
    expect(indexedLoopTurnStartRecord({ ...row, text: row.text.replace(tagged.nonce, 'aaaaaaaaaaaaaaaa') }, undefined, target)).toBeNull();
    // The live nonce remains primary when PTY transit changes the payload hash.
    expect(indexedLoopTurnStartRecord({ ...row, text: row.text + ' transit' }, undefined, target)).not.toBeNull();
  });

  it.each([
    ['future enrollment', { ts: 1 }], ['expired enrollment', { ts: -600001 }],
    ['wrong owner', { sid: 'su-b' }], ['wrong origin', { origin: 'wake-pump' }],
    ['missing routine', { loopFire: undefined }],
    ['empty routine', { loopFire: { routineId: '', wakeCount: 3 } }],
    ['invalid wake', { loopFire: { routineId: 'routine-a', wakeCount: 0 } }],
  ])('retains the %s rejection when the directory is scoped', async (_name, change) => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-namespace-negative-'));
    dirs.push(dir);
    const now = Date.now();
    const enrollment = { sid: 'su-a', nonce: '1234567890abcdef', origin: 'loop-fire', sha256: 'mangled',
      ts: now, loopFire: { routineId: 'routine-a', wakeCount: 3 }, ...change } as LedgerRow;
    if ('ts' in change && typeof change.ts === 'number') enrollment.ts = now + change.ts;
    expect(await appendLedgerRow(enrollment, { dir, nowMs: now, ttlMs: 3600000 })).toBe(true);
    expect(indexedLoopTurnStartRecord({ ...turn, ts: new Date(now).toISOString(),
      text: '⟦turn-origin:loop-fire nonce:1234567890abcdef⟧\nContinue.' }, undefined,
    { dir, workspaceId: 'workspace-a' })).toBeNull();
  });
});
