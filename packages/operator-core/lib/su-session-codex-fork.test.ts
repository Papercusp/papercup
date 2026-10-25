import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkCodexNativeHistory } from './su-session-codex-fork';
import type { RpcFrame } from './su-session-stdio-peer';

const dirs: string[] = [];
const PARENT = '11111111-1111-4111-8111-111111111111';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'su-fork-')); dirs.push(root);
  const sourceHome = join(root, 'parent'), childHome = join(root, 'child');
  const historyDir = join(sourceHome, 'sessions', '2026', '10', '25');
  mkdirSync(historyDir, { recursive: true }); mkdirSync(childHome);
  const sourcePath = join(historyDir, `rollout-2026-${PARENT}.jsonl`);
  const history = JSON.stringify({ type: 'session_meta', payload: { id: PARENT } }) + '\n';
  writeFileSync(sourcePath, history);
  writeFileSync(join(sourceHome, 'config.toml'), 'parent-only-config');
  const childPath = join(childHome, 'rollout-child.jsonl');
  const request = vi.fn(async (frame: RpcFrame): Promise<RpcFrame> => {
    if (frame.method === 'thread/read') return { thread: { id: PARENT, turns: [
      { id: 'done', status: 'completed' }, { id: 'pending-question', status: 'inProgress' },
    ] } };
    writeFileSync(childPath, history);
    return { thread: { id: 'child-thread', forkedFromId: PARENT, path: childPath } };
  });
  return { root, sourcePath, history, sourceHome, childPath, childHome, request,
    input: { source: { backend: 'codex' as const, source: 'adv_sessions' as const,
      ownerId: 'parent-owner', codexHome: sourceHome, rolloutId: PARENT, exactResumeSupported: true, missingReason: null },
      peer: { request }, childOwnerId: 'child-owner', childHome,
      params: { cwd: root, model: 'selected-model', approvalPolicy: 'on-request', sandbox: 'workspace-write' } } };
}
describe('tracked Codex history fork', () => {
  it('forks only through a completed turn in the fresh home and removes the temporary parent seed', async () => {
    const f = fixture(); await expect(forkCodexNativeHistory(f.input)).resolves.toMatchObject({ thread: { id: 'child-thread' } });
    expect(f.request.mock.calls[1][0]).toEqual({ method: 'thread/fork', params: {
      ...f.input.params, threadId: PARENT, ephemeral: false, lastTurnId: 'done',
    } });
    expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
    expect(readdirSync(f.childHome)).not.toContain('config.toml');
    expect(readdirSync(join(f.childHome, 'sessions', '2026', '10', '25'))).toEqual([]);
  });
  it.each(['owner', 'home', 'missing-id', 'unpersisted'] as const)('refuses invalid fork authority before RPC (%s)', async mode => {
    const f = fixture();
    if (mode === 'owner') f.input.childOwnerId = 'parent-owner';
    if (mode === 'home') f.input.childHome = f.sourceHome;
    if (mode === 'missing-id') f.input.source.rolloutId = '';
    if (mode === 'unpersisted') f.input.source.exactResumeSupported = false;
    await expect(forkCodexNativeHistory(f.input)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['same-id', 'wrong-parent', 'foreign-path', 'read-failure', 'pending-only', 'fork-failure'] as const)(
    'cleans the seed and preserves the parent on failure (%s)', async mode => {
      const f = fixture();
      if (mode === 'read-failure') f.request.mockRejectedValueOnce(new Error('read failed'));
      else if (mode === 'pending-only') f.request.mockResolvedValueOnce({ thread: { id: PARENT, turns: [{ id: 'pending', status: 'inProgress' }] } });
      else f.request.mockImplementationOnce(async () => ({ thread: { id: PARENT, turns: [{ id: 'done', status: 'completed' }] } }))
        .mockImplementationOnce(async () => {
          if (mode === 'fork-failure') throw new Error('fork failed');
          writeFileSync(f.childPath, f.history);
          return { thread: { id: mode === 'same-id' ? PARENT : 'child-thread',
            forkedFromId: mode === 'wrong-parent' ? 'foreign-parent' : PARENT,
            path: mode === 'foreign-path' ? f.sourcePath : f.childPath } };
        });
      await expect(forkCodexNativeHistory(f.input)).rejects.toThrow();
      expect(readFileSync(f.sourcePath, 'utf8')).toBe(f.history);
      expect(readdirSync(join(f.childHome, 'sessions', '2026', '10', '25'))).toEqual([]);
    });
});
