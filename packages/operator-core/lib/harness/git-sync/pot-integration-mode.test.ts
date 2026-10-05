/**
 * pot-integration-mode (plan pot-review-integration-mode-2026-10-05, P-014 / P-015).
 *
 * Pins: the mode read distinguishes set/absent/malformed/error; the push resolver
 * NEVER resolves a working-copy pot (or an unreadable/malformed setting) to the
 * main repository; the pot-fork git remote is added / re-pointed / left alone;
 * and choosing working-copy mode is refused without a green-gate test command or
 * a fork (P-015).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  getHiveSetting: vi.fn(),
  setHiveSetting: vi.fn(),
  deleteHiveSetting: vi.fn(),
}));
vi.mock('../../hive-settings-store', () => store);

import {
  POT_INTEGRATION_SETTING_KEY,
  POT_FORK_REMOTE_NAME,
  coercePotIntegrationMode,
  readPotIntegrationMode,
  resolveIntegrationPushRemote,
  ensurePotForkGitRemote,
  applyIntegrationPushTarget,
  setPotIntegrationMode,
  type IntegrationPushConfig,
  type RunGit,
} from './pot-integration-mode';

const FORK = 'https://github.com/acme-bot/widget.git';

beforeEach(() => {
  store.getHiveSetting.mockReset();
  store.setHiveSetting.mockReset();
  store.deleteHiveSetting.mockReset();
});

describe('hiveGit.integration key', () => {
  it('is orthogonal to hiveGit.mode (D-005)', () => {
    expect(POT_INTEGRATION_SETTING_KEY).toBe('hiveGit.integration');
    expect(POT_INTEGRATION_SETTING_KEY).not.toBe('hiveGit.mode');
  });
  it('coerces only an exact review to review', () => {
    expect(coercePotIntegrationMode('review')).toBe('review');
    expect(coercePotIntegrationMode('direct')).toBe('direct');
    expect(coercePotIntegrationMode('REVIEW')).toBe('direct');
    expect(coercePotIntegrationMode(undefined)).toBe('direct');
  });
});

describe('readPotIntegrationMode', () => {
  it('reads an explicit review / direct as set', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'review' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'review', source: 'set' });
    store.getHiveSetting.mockResolvedValueOnce({ value: 'direct' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'set' });
    expect(store.getHiveSetting).toHaveBeenCalledWith('ws', 'pot', 'hiveGit.integration', undefined);
  });
  it('reads no row as absent (default direct)', async () => {
    store.getHiveSetting.mockResolvedValueOnce(null);
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'absent' });
  });
  it('reads junk as malformed and a throw as error — never throws', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'pr-please' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'malformed' });
    store.getHiveSetting.mockRejectedValueOnce(new Error('pg down'));
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'error' });
  });
});

describe('resolveIntegrationPushRemote', () => {
  it('direct (explicit or default) leaves the existing push logic unchanged', () => {
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'set' }, forkRemote: FORK }).kind).toBe(
      'unchanged',
    );
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'absent' } }).kind).toBe('unchanged');
  });
  it('review with a fork pushes the fork through the pot-fork remote', () => {
    const d = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' }, forkRemote: FORK });
    expect(d).toMatchObject({ kind: 'fork', remoteName: POT_FORK_REMOTE_NAME, url: FORK });
  });
  it('review with no fork is commit-only — never the main repository', () => {
    const d = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' } });
    expect(d).toMatchObject({ kind: 'commit-only', reason: 'working_copy_fork_missing' });
  });
  it('an unreadable or malformed setting is commit-only, even with a fork configured', () => {
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'error' }, forkRemote: FORK })).toMatchObject({
      kind: 'commit-only',
      reason: 'integration_mode_unknown',
    });
    expect(
      resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'malformed' }, forkRemote: FORK }),
    ).toMatchObject({ kind: 'commit-only', reason: 'integration_mode_malformed' });
  });
});

describe('ensurePotForkGitRemote', () => {
  function fakeGit(existing: string | null) {
    const calls: string[][] = [];
    const run: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (existing === null) throw new Error("error: No such remote 'pot-fork'");
        return { stdout: `${existing}\n` };
      }
      return { stdout: '' };
    };
    return { run, calls };
  }
  it('adds the remote when missing', async () => {
    const g = fakeGit(null);
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('added');
    expect(g.calls).toContainEqual(['remote', 'add', 'pot-fork', FORK]);
  });
  it('re-points a drifted remote', async () => {
    const g = fakeGit('https://github.com/someone-else/widget.git');
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('updated');
    expect(g.calls).toContainEqual(['remote', 'set-url', 'pot-fork', FORK]);
  });
  it('leaves a matching remote alone', async () => {
    const g = fakeGit(FORK);
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('unchanged');
    expect(g.calls).toHaveLength(1);
  });
});

describe('applyIntegrationPushTarget (the git-sync tick rewrite)', () => {
  const baseCfg = (): IntegrationPushConfig => ({ push: true, remote: 'origin', pushSubmoduleOrigins: true });
  const forkDecision = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' }, forkRemote: FORK });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('leaves the config untouched for a direct pot or no decision', async () => {
    const ensure = vi.fn();
    for (const decision of [
      undefined,
      resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'absent' } }),
    ]) {
      const cfg = baseCfg();
      expect(await applyIntegrationPushTarget('p', cfg, decision, '/repo', ensure)).toBeNull();
      expect(cfg).toEqual(baseCfg());
    }
    expect(ensure).not.toHaveBeenCalled();
  });

  it('a fork decision pushes the pot-fork remote and stops pushing submodule origins', async () => {
    const ensure = vi.fn().mockResolvedValue('added');
    const cfg = baseCfg();
    expect(await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', ensure)).toBeNull();
    expect(ensure).toHaveBeenCalledWith('/repo', FORK);
    expect(cfg).toEqual({ push: true, remote: POT_FORK_REMOTE_NAME, pushSubmoduleOrigins: false });
  });

  it('a commit-only decision pushes nowhere and never touches the remote', async () => {
    const ensure = vi.fn();
    const cfg = baseCfg();
    const decision = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' } });
    expect(await applyIntegrationPushTarget('p', cfg, decision, '/repo', ensure)).toBe('working_copy_fork_missing');
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('with no checkout path it pushes nowhere rather than the main repository', async () => {
    const ensure = vi.fn();
    const cfg = baseCfg();
    expect(await applyIntegrationPushTarget('p', cfg, forkDecision, null, ensure)).toBe('working_copy_no_repo_path');
    expect(cfg.push).toBe(false);
    expect(cfg.remote).toBe('origin');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('if the fork remote cannot be set up it pushes nowhere — never falls back to origin', async () => {
    const ensure = vi.fn().mockRejectedValue(new Error('git remote add failed'));
    const cfg = baseCfg();
    expect(await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', ensure)).toBe(
      'working_copy_fork_remote_setup_failed',
    );
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
  });
});

describe('setPotIntegrationMode (P-015 guard)', () => {
  const base = { workspaceId: 'ws', potHomeSlug: 'pot' };
  it('refuses working-copy mode without a green-gate test command', async () => {
    for (const greenCmd of [null, undefined, '', '   ']) {
      const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd, forkRemote: FORK });
      expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    }
    expect(store.setHiveSetting).not.toHaveBeenCalled();
  });
  it('refuses working-copy mode without a fork', async () => {
    const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd: 'npm test', forkRemote: null });
    expect(r).toMatchObject({ ok: false, error: 'fork_required' });
    expect(store.setHiveSetting).not.toHaveBeenCalled();
  });
  it('accepts working-copy mode with a test command and a fork', async () => {
    const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd: 'npm test', forkRemote: FORK });
    expect(r).toEqual({ ok: true, mode: 'review' });
    expect(store.setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', potHomeSlug: 'pot', settingKey: 'hiveGit.integration', value: 'review' },
      undefined,
    );
  });
  it('direct needs neither; null clears the row', async () => {
    expect(await setPotIntegrationMode({ ...base, mode: 'direct', greenCmd: null, forkRemote: null })).toEqual({
      ok: true,
      mode: 'direct',
    });
    expect(await setPotIntegrationMode({ ...base, mode: null, greenCmd: null, forkRemote: null })).toEqual({
      ok: true,
      mode: null,
    });
    expect(store.deleteHiveSetting).toHaveBeenCalledWith('ws', 'pot', 'hiveGit.integration', undefined);
  });
  it('throws on an unknown mode instead of coercing', async () => {
    await expect(
      setPotIntegrationMode({ ...base, mode: 'pr' as never, greenCmd: 'npm test', forkRemote: FORK }),
    ).rejects.toThrow(/unknown mode/);
  });
});
