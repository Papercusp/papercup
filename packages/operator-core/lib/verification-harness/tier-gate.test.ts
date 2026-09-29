/**
 * R-9 (expensive-verification-loops-2026-09-29, P-005): the expensive tier waits for the cheap
 * tier. The runner refuses the expensive tier for a phase whose code changed since that phase
 * last passed the cheap tier — before preflight or any phase is paid for.
 *
 * Drives the real `runHarness` against a temp code tree (a shell drill script whose phases are
 * functions), so the code identity, the receipt store and the refusal are all exercised as a
 * harness would hit them.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractShellFunction,
  formatSummaryLine,
  type HarnessContract,
  type PhaseOutcome,
  phaseCodeIdentity,
  runHarness,
  TIER_RECEIPT_HISTORY,
  validateContract,
} from '@papercusp/verification-harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = `#!/usr/bin/env bash
setup_rig() {
  echo "boot two instances"
}

phase_sync() {
  echo "push and observe v1"
}

phase_conflict() {
  echo "conflict v1"
}
`;

const contract: HarnessContract = {
  name: 'tier-drill',
  tiers: { cheap: 'same-box two-instance rig', expensive: 'physical rig' },
  phases: [
    { id: 'setup', reusable: true, code: ['drill.sh#setup_rig'] },
    { id: 'sync', dependsOn: ['setup'], code: ['drill.sh#phase_sync'] },
    { id: 'conflict', dependsOn: ['setup'], code: ['drill.sh#phase_conflict'] },
    { id: 'usb-unplug', dependsOn: ['setup'], tiers: ['expensive'] },
  ],
};

let root: string;
let codeRoot: string;
let evidenceRoot: string;
let ran: string[];
let preflights: number;
let failing: Set<string>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vh-tier-gate-'));
  codeRoot = path.join(root, 'code');
  evidenceRoot = path.join(root, 'evidence');
  await import('node:fs/promises').then((fs) => fs.mkdir(codeRoot, { recursive: true }));
  await writeFile(path.join(codeRoot, 'drill.sh'), SCRIPT);
  ran = [];
  preflights = 0;
  failing = new Set();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
async function run(tier: 'cheap' | 'expensive', extra: Partial<Parameters<typeof runHarness>[0]> = {}) {
  seq += 1;
  return runHarness({
    contract,
    evidenceRoot,
    codeRoot,
    tier,
    runId: `run-${seq}-${tier}`,
    preflight: async (): Promise<PhaseOutcome> => {
      preflights += 1;
      return { ok: true };
    },
    runPhase: async (ctx): Promise<PhaseOutcome> => {
      ran.push(`${tier}:${ctx.phase}`);
      return failing.has(ctx.phase) ? { ok: false, reasonCode: 'boom' } : { ok: true };
    },
    ...extra,
  });
}

async function editScript(from: string, to: string) {
  const file = path.join(codeRoot, 'drill.sh');
  const text = await readFile(file, 'utf8');
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

describe('tier gate — the expensive tier waits for the cheap tier (R-9)', () => {
  it('refuses an expensive run whose phases never passed the cheap tier, before preflight or any phase runs', async () => {
    const r = await run('expensive');
    expect(r.verdict).toBe('tier-refused');
    expect(ran).toEqual([]);
    expect(preflights).toBe(0);
    expect(r.preflight).toBeNull();
    expect(r.firstFailure).toEqual({ phase: 'setup', step: null, reasonCode: 'tier-gate:never-passed-cheap' });
    const byPhase = Object.fromEntries(r.phases.map((p) => [p.phase, [p.status, p.reasonCode]]));
    expect(byPhase).toEqual({
      setup: ['blocked', 'tier-gate:never-passed-cheap'],
      sync: ['blocked', 'tier-gate:never-passed-cheap'],
      conflict: ['blocked', 'tier-gate:never-passed-cheap'],
      'usb-unplug': ['blocked', 'tier-gate:run-refused'],
    });
    expect(r.tierGate?.phases.find((p) => p.phase === 'usb-unplug')?.status).toBe('exempt');
    expect(formatSummaryLine(r)).toContain('verdict=tier-refused');
    expect(formatSummaryLine(r)).toContain('tier=expensive tier_gate=refused:3');
    // The refusal is durable evidence, and a refused run does not become `latest`.
    const onDisk = JSON.parse(await readFile(path.join(r.evidenceDir, 'result.json'), 'utf8'));
    expect(onDisk.verdict).toBe('tier-refused');
    await expect(readFile(path.join(evidenceRoot, 'latest', 'result.json'), 'utf8')).rejects.toThrow();
  });

  it('admits the expensive tier once the same code passed the cheap tier; expensive-only phases are exempt', async () => {
    const cheap = await run('cheap');
    expect(cheap.verdict).toBe('pass');
    expect(ran).toEqual(['cheap:setup', 'cheap:sync', 'cheap:conflict']);
    expect(cheap.phases.find((p) => p.phase === 'usb-unplug')).toMatchObject({ status: 'skipped', reasonCode: 'tier:not-in-cheap' });
    expect(cheap.tierReceipts?.recorded.map((x) => x.phase)).toEqual(['setup', 'sync', 'conflict']);

    ran = [];
    const exp = await run('expensive');
    expect(exp.verdict).toBe('pass');
    expect(ran).toEqual(['expensive:setup', 'expensive:sync', 'expensive:conflict', 'expensive:usb-unplug']);
    expect(exp.tierGate?.refused).toBe(0);
    expect(exp.tierGate?.phases.map((p) => p.status)).toEqual(['admitted', 'admitted', 'admitted', 'exempt']);
    expect(exp.tierGate?.phases[1]?.cheapPass?.runId).toBe(cheap.runId);
  });

  it('refuses exactly the phase whose code changed since its cheap pass; re-passing the cheap tier re-admits it', async () => {
    await run('cheap');
    await editScript('push and observe v1', 'push and observe v2');

    ran = [];
    const refused = await run('expensive');
    expect(refused.verdict).toBe('tier-refused');
    expect(ran).toEqual([]);
    const gate = Object.fromEntries(refused.tierGate!.phases.map((p) => [p.phase, p.reasonCode ?? p.status]));
    // Editing phase_sync must not invalidate phase_conflict or setup_rig in the same script.
    expect(gate).toEqual({ setup: 'admitted', sync: 'tier-gate:code-changed', conflict: 'admitted', 'usb-unplug': 'tier-gate:expensive-only' });
    expect(refused.phases.find((p) => p.phase === 'sync')?.detail).toMatch(/code changed since its last cheap-tier pass/);

    await run('cheap');
    ran = [];
    const admitted = await run('expensive');
    expect(admitted.verdict).toBe('pass');
    expect(ran).toContain('expensive:sync');
  });

  it('keeps a history, so reverting to a version that passed the cheap tier is admitted without a re-run', async () => {
    await run('cheap');
    await editScript('conflict v1', 'conflict v2');
    await run('cheap');
    await editScript('conflict v2', 'conflict v1');
    ran = [];
    expect((await run('expensive')).verdict).toBe('pass');
    const store = JSON.parse(await readFile(path.join(evidenceRoot, 'tier-receipts.json'), 'utf8'));
    expect(store.receipts.conflict).toHaveLength(2);
    expect(store.receipts.conflict.length).toBeLessThanOrEqual(TIER_RECEIPT_HISTORY);
  });

  it('records no receipt for a phase that failed the cheap tier, so its expensive run stays refused', async () => {
    failing.add('conflict');
    const cheap = await run('cheap');
    expect(cheap.verdict).toBe('fail');
    expect(cheap.tierReceipts?.recorded.map((x) => x.phase)).toEqual(['setup', 'sync']);
    const exp = await run('expensive');
    expect(exp.verdict).toBe('tier-refused');
    expect(exp.firstFailure).toEqual({ phase: 'conflict', step: null, reasonCode: 'tier-gate:never-passed-cheap' });
  });

  it('does not record a cheap pass when the phase code moved while it ran', async () => {
    const cheap = await runHarness({
      contract,
      evidenceRoot,
      codeRoot,
      tier: 'cheap',
      runId: 'moving',
      runPhase: async (ctx) => {
        if (ctx.phase === 'sync') await editScript('push and observe v1', 'push and observe v3');
        return { ok: true };
      },
    });
    expect(cheap.tierReceipts?.unrecorded).toEqual([{ phase: 'sync', reasonCode: 'tier-gate:code-changed-during-run' }]);
    expect((await run('expensive')).tierGate?.phases.find((p) => p.phase === 'sync')?.reasonCode).toBe('tier-gate:never-passed-cheap');
  });

  it('an override runs the expensive tier anyway and keeps the reason on the result', async () => {
    const r = await run('expensive', { overrideTierGate: { reason: 'physical-only regression, cheap rig down (WI-1)' } });
    expect(r.verdict).toBe('pass');
    expect(r.tierGate?.override).toEqual({ reason: 'physical-only regression, cheap rig down (WI-1)' });
    expect(formatSummaryLine(r)).toContain('tier_gate=refused:3:overridden');
  });

  it('refuses to reuse a run from the other tier, and requires a tier on a tiered contract', async () => {
    const cheap = await run('cheap');
    await expect(run('expensive', { selection: { only: ['sync'], from: null }, reuseFrom: cheap.evidenceDir })).rejects.toThrow(
      /cannot reuse run .* \(cheap\) in a expensive run/,
    );
    await expect(runHarness({ contract, evidenceRoot, runPhase: async () => ({ ok: true }) })).rejects.toThrow(/pass the tier/);
    await expect(run('cheap', { selection: { only: ['usb-unplug'], from: null } })).rejects.toThrow(/does not run in the cheap tier/);
  });

  it('an untiered contract is unaffected: no tier, no gate, no receipts', async () => {
    const plain: HarnessContract = { name: 'plain', phases: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] };
    const r = await runHarness({ contract: plain, evidenceRoot, runPhase: async () => ({ ok: true }) });
    expect(r.verdict).toBe('pass');
    expect(r.tier).toBeUndefined();
    expect(r.tierGate).toBeUndefined();
    await expect(runHarness({ contract: plain, evidenceRoot, tier: 'cheap', runPhase: async () => ({ ok: true }) })).rejects.toThrow(
      /declares no tiers/,
    );
  });
});

describe('tier contract validation and code identity', () => {
  it('a phase running in both tiers must declare its code; tier dependencies must line up', () => {
    const base = { name: 'c', tiers: { cheap: 'local', expensive: 'rig' } };
    expect(() => validateContract({ ...base, phases: [{ id: 'a' }] })).toThrow(/must declare `code`/);
    expect(() =>
      validateContract({ ...base, phases: [{ id: 'x', tiers: ['expensive'] }, { id: 'y', dependsOn: ['x'], code: ['f'] }] }),
    ).toThrow(/runs in the cheap tier but its dependency x does not/);
    expect(() => validateContract({ name: 'n', phases: [{ id: 'a', tiers: ['cheap'] }] })).toThrow(/declares tiers but the contract declares none/);
    expect(() => validateContract({ ...base, phases: [{ id: 'a', code: ['/abs/path'] }] })).toThrow(/invalid code path/);
  });

  it('hashes one shell function, a whole file, or a directory; a missing function is unresolved, not silently empty', async () => {
    expect(extractShellFunction(SCRIPT, 'phase_sync')).toBe('phase_sync() {\n  echo "push and observe v1"\n}');
    expect(extractShellFunction(SCRIPT, 'phase_nope')).toBeNull();
    const fn = await phaseCodeIdentity({ code: ['drill.sh#phase_sync'] }, codeRoot);
    const file = await phaseCodeIdentity({ code: ['drill.sh'] }, codeRoot);
    const dir = await phaseCodeIdentity({ code: ['.'] }, codeRoot);
    expect(new Set([fn.hash, file.hash, dir.hash]).size).toBe(3);
    expect(await phaseCodeIdentity({ code: ['drill.sh#phase_nope'] }, codeRoot)).toEqual({ hash: null, unresolved: ['drill.sh#phase_nope'] });
    expect(await phaseCodeIdentity({ code: ['missing.sh'] }, codeRoot)).toEqual({ hash: null, unresolved: ['missing.sh'] });
    await writeFile(path.join(codeRoot, 'extra.txt'), 'x');
    expect((await phaseCodeIdentity({ code: ['.'] }, codeRoot)).hash).not.toBe(dir.hash);
  });
});
