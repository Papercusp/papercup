import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { prepareStudyRoutine, restoreStudyControls, studyRestorationPorts, type RestorationPorts } from './study/controls.mts';
import type { RoutineSnap } from '../agent-tools/routines/routine-snapshot';

vi.mock('../gateway-control/control-harness', async () => {
  const core = await import('@papercusp/control-mutation');
  return { ...core, runControlMutation: (spec: any, options: any) =>
    core.runControlMutation(spec, options, { writeAudit: async () => 'test-audit' }) };
});

const root = fileURLToPath(new URL('../../../../', import.meta.url));
describe('D017 standalone study environment admission', () => {
  it.each(['', 'https://external.example', 'http://127.0.0.1:3384/other'])('refuses sidecar setting %j before any study execution', (sidecar) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'packages/operator-core/lib/dream/study/run-one-cycle.mts', '--run'], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_EMBED_SIDECAR_URL: sidecar },
      encoding: 'utf8', timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('D017 study requires PAPERCUSP_EMBED_SIDECAR_URL');
    expect(result.stdout).not.toContain('prepared');
    expect(result.stdout).not.toContain('routines:set');
  });
});

describe('D017 study restoration', () => {
  const receipt = { ok: true, applied: true, verify: { ok: true }, auditId: 'restored' };
  function ports(): RestorationPorts {
    return { disableMaster: vi.fn().mockResolvedValue(receipt), masterDisabled: vi.fn().mockResolvedValue(true), revertRoutine: vi.fn().mockResolvedValue(receipt) };
  }

  it('restores master before routine after an uncertain enable', async () => {
    const p = ports();
    const order: string[] = [];
    p.disableMaster = async () => { order.push('master'); return receipt; };
    p.revertRoutine = async () => { order.push('routine'); return receipt; };
    await restoreStudyControls({ masterAttempted: true, routineAudit: 'source' }, p, async () => {});
    expect(order).toEqual(['master', 'routine']);
  });

  it('reconciles a lost disable response against the actual gate', async () => {
    const p = ports();
    p.disableMaster = vi.fn().mockRejectedValue(new Error('response lost'));
    const log = vi.fn();
    await restoreStudyControls({ masterAttempted: true, routineAudit: 'source' }, p, log);
    expect(p.masterDisabled).toHaveBeenCalledOnce();
    expect(p.revertRoutine).toHaveBeenCalledWith('source');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('still restores the routine when the master cannot be verified off', async () => {
    const p = ports();
    p.masterDisabled = vi.fn().mockResolvedValue(false);
    await expect(restoreStudyControls({ masterAttempted: true, routineAudit: 'source' }, p, async () => {}))
      .rejects.toThrow('needs immediate attention');
    expect(p.revertRoutine).toHaveBeenCalledWith('source');
  });

  it('does not call a routine for Blender and performs cleanup before logging', async () => {
    const p = ports();
    await expect(restoreStudyControls({ masterAttempted: true }, p, async () => { throw new Error('disk unavailable'); }))
      .rejects.toThrow('disk unavailable');
    expect(p.disableMaster).toHaveBeenCalledOnce();
    expect(p.masterDisabled).toHaveBeenCalledOnce();
    expect(p.revertRoutine).not.toHaveBeenCalled();
  });

  it('rejects a routine rollback or conflict instead of reporting restoration', async () => {
    const p = ports();
    p.revertRoutine = vi.fn().mockResolvedValue({ ...receipt, reverted: true });
    await expect(restoreStudyControls({ masterAttempted: true, routineAudit: 'source' }, p, async () => {}))
      .rejects.toThrow('needs immediate attention');
    expect(p.masterDisabled).toHaveBeenCalledOnce();
  });

  it('performs no writes when preflight never attempted controls', async () => {
    const p = ports();
    await restoreStudyControls({ masterAttempted: false }, p, async () => {});
    expect(p.disableMaster).not.toHaveBeenCalled();
    expect(p.revertRoutine).not.toHaveBeenCalled();
  });

  it('reads the production gate directly without invoking the unavailable HTTP hosts', async () => {
    const sql = vi.fn().mockResolvedValue([{ workspace_id: 'ws', pot_slug: 'pot', enabled: false, set_by: 'su', set_at: new Date() }]);
    const p = studyRestorationPorts(sql as never, 'ws', 'pot', 'su');
    await expect(p.masterDisabled()).resolves.toBe(true);
    expect(sql).toHaveBeenCalledOnce();
    expect(sql.mock.calls[0]?.slice(1)).toEqual(['ws', 'pot']);
  });
});

describe('D017 prepare-before-write routine setup', () => {
  const baseline = (): RoutineSnap => ({ active: false, triggerConfig: { cron: '0 */5 * * * *' },
    payloadTemplate: { mode: 'manual' }, nextFireAtIso: null, groupSlug: null, metadata: {} });

  it('restores a committed setup whose write response was lost, before any paid work', async () => {
    let current = baseline();
    let first = true;
    const log = vi.fn();
    const routine = await prepareStudyRoutine({
      read: async () => structuredClone(current),
      write: async snap => { current = structuredClone(snap); if (first) { first = false; throw new Error('response lost after commit'); } },
      actor: 'su-test', subject: 'pot/dream-cycle-manual',
    }, { mode: 'manual', pilot: { pin: 'frozen' } }, log);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'routine-restore-prepared', before: baseline() }));
    await expect(routine.apply()).rejects.toThrow('response lost after commit');
    expect(current.active).toBe(true);
    await expect(routine.restore()).resolves.toMatchObject({ ok: true, verify: { ok: true } });
    expect(current).toEqual(baseline());
  });

  it('restores after a failed receipt log and preserves new cycle metadata', async () => {
    let current = baseline();
    const routine = await prepareStudyRoutine({ read: async () => structuredClone(current), write: async snap => { current = structuredClone(snap); },
      actor: 'su-test', subject: 'pot/dream-cycle-manual' }, { mode: 'manual', pilot: { pin: 'frozen' } }, async () => {});
    await routine.apply();
    current.metadata = { dreamLastCycle: { cycleId: 'new' } };
    const ports: RestorationPorts = { disableMaster: vi.fn(), masterDisabled: vi.fn(), revertRoutine: vi.fn() };
    await restoreStudyControls({ masterAttempted: false, restoreRoutine: routine.restore }, ports, async () => {});
    expect(current).toEqual({ ...baseline(), metadata: { dreamLastCycle: { cycleId: 'new' } } });
    expect(ports.revertRoutine).not.toHaveBeenCalled();
  });

  it('does not write if the durable inverse cannot be recorded', async () => {
    const write = vi.fn();
    await expect(prepareStudyRoutine({ read: async () => baseline(), write, actor: 'su-test', subject: 'pot/manual' },
      { mode: 'manual' }, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a later conflicting configuration without overwriting it', async () => {
    let current = baseline();
    const routine = await prepareStudyRoutine({ read: async () => structuredClone(current), write: async snap => { current = structuredClone(snap); },
      actor: 'su-test', subject: 'pot/manual' }, { mode: 'manual', pilot: { pin: 'frozen' } }, async () => {});
    await routine.apply();
    current.payloadTemplate = { mode: 'manual', pilot: { pin: 'peer' } };
    await expect(routine.restore()).rejects.toThrow('refusing to overwrite');
    expect(current.payloadTemplate).toEqual({ mode: 'manual', pilot: { pin: 'peer' } });
  });
});
