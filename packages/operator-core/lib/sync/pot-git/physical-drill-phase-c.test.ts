import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { verifySigrefs } from './sigrefs';
import { ensurePotGitRepo, readNamespaceRef } from './storage';
import { PHASE_A_POT_HOME, PHASE_A_REPO_KEY } from './physical-drill-phase-a';
import {
  PHASE_C_INPUT_SCHEMA,
  executePhysicalPhaseCHost,
  validatePhysicalPhaseC,
  type PhysicalPhaseCHost,
  type PhysicalPhaseCHostResult,
  type PhysicalPhaseCInput,
} from './physical-drill-phase-c';

const roots: string[] = [];
const tower = generateEd25519KeypairDer();
const vm = generateEd25519KeypairDer();

afterEach(() => {
  delete process.env.PAPERCUSP_POT_GIT_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(hostId: PhysicalPhaseCHost): string {
  const root = mkdtempSync(join(tmpdir(), `p505-phase-c-${hostId}-`));
  roots.push(root);
  return root;
}

async function runHost(
  hostId: PhysicalPhaseCHost,
  runId: string,
): Promise<{ root: string; result: PhysicalPhaseCHostResult }> {
  const root = newRoot(hostId);
  process.env.PAPERCUSP_POT_GIT_ROOT = root;
  const repoPath = await ensurePotGitRepo(PHASE_A_POT_HOME, PHASE_A_REPO_KEY);
  const physicalDeviceKey = hostId === 'tower' ? tower.pubkeyBase64 : vm.pubkeyBase64;
  const peerDeviceKey = hostId === 'tower' ? vm.pubkeyBase64 : tower.pubkeyBase64;
  const result = await executePhysicalPhaseCHost({
    hostId,
    runId,
    repoPath,
    physicalDeviceKey,
    peerDeviceKey,
  });
  return { root, result };
}

async function fixture(): Promise<PhysicalPhaseCInput> {
  const runId = 'p505-phase-c-unit-1';
  const towerResult = (await runHost('tower', runId)).result;
  const vmResult = (await runHost('vm', runId)).result;
  const timestamps = [
    Date.parse(towerResult.window.startedAt),
    Date.parse(towerResult.window.finishedAt),
    Date.parse(vmResult.window.startedAt),
    Date.parse(vmResult.window.finishedAt),
  ];
  return {
    schemaVersion: PHASE_C_INPUT_SCHEMA,
    runId,
    window: {
      startedAt: new Date(Math.min(...timestamps)).toISOString(),
      finishedAt: new Date(Math.max(...timestamps)).toISOString(),
    },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    hostResults: [towerResult, vmResult],
  };
}

function clone(input: PhysicalPhaseCInput): PhysicalPhaseCInput {
  return JSON.parse(JSON.stringify(input)) as PhysicalPhaseCInput;
}

describe('P-505 fixed physical Phase C trust negative-control executor', () => {
  it('accepts exact real-Git/Ed25519 relay, rollback, and roster refusals from both hosts', async () => {
    const verdict = validatePhysicalPhaseC(await fixture());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        phase: 'C',
        planItem: 'P-304',
        status: 'complete',
        complete: true,
        missingAssertions: [],
        assertions: {
          runBoundThirdDeviceNamespacesOnBothHosts: true,
          realGitAndEd25519ControlsOnBothHosts: true,
          relayLieRefusedBySignedHeadReconciliation: true,
          staleSigrefsRollbackRefused: true,
          nonMemberScopeServeRefused: true,
          honestHeadsRestoredAfterTamperControls: true,
        },
        hosts: [{ hostId: 'tower', sigrefsVersion: 1 }, { hostId: 'vm', sigrefsVersion: 1 }],
      },
    });
  });

  it('runs the relay control against a real namespaced ref and restores the signed honest head', async () => {
    const runId = 'p505-phase-c-restore-1';
    const { root, result } = await runHost('tower', runId);
    process.env.PAPERCUSP_POT_GIT_ROOT = root;
    expect(verifySigrefs(result.signedSigrefs, result.thirdDeviceKey)).toBe(true);
    expect(result.relayMismatches).toEqual([
      { ref: result.ref, expected: result.honestOid, actual: result.rogueOid },
    ]);
    expect(await readNamespaceRef(result.repoPath, result.thirdDeviceKey, result.ref)).toBe(result.honestOid);
    expect(result.restoredMismatches).toEqual([]);
    expect(result.nonMember.decision).toMatchObject({
      ok: false,
      refusal: { reason: 'not-a-member', scopeId: result.nonMember.scopeId },
    });
  });

  it('rejects forged cryptographic evidence and a mismatch that does not bind the rogue commit', async () => {
    const input = clone(await fixture());
    input.hostResults[0].signedSigrefs.sig = Buffer.alloc(64, 7).toString('base64');
    input.hostResults[1].relayMismatches[0]!.actual = input.hostResults[1].honestOid;
    const verdict = validatePhysicalPhaseC(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase C tower signed snapshot is not valid Ed25519 evidence',
        'Phase C vm relay lie is not the exact signed-head mismatch',
      ]),
    );
  });

  it('rejects a false rollback verdict or a non-member refusal for the wrong peer', async () => {
    const input = clone(await fixture());
    input.hostResults[0].rollback.decision = { ok: false, reason: 'bad-signature' } as never;
    input.hostResults[1].nonMember.decision.refusal.peerGithubUserId = 123;
    const verdict = validatePhysicalPhaseC(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase C tower stale signed snapshot was not refused by the rollback fence',
        'Phase C vm non-member scope serve was not refused by the fixed roster gate',
      ]),
    );
  });

  it('requires one independently generated third-device control from each physical host', async () => {
    const input = clone(await fixture());
    input.hostResults[1].thirdDeviceKey = input.hostResults[0].thirdDeviceKey;
    input.hostResults = [input.hostResults[0], input.hostResults[1]];
    const verdict = validatePhysicalPhaseC(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase C vm signed snapshot is not valid Ed25519 evidence',
        'Phase C hosts must generate distinct third-device identities',
      ]),
    );

    const oneHost = clone(await fixture());
    oneHost.hostResults = [oneHost.hostResults[0]] as never;
    expect(validatePhysicalPhaseC(oneHost).errors).toContain(
      'Phase C requires exactly two physical host results',
    );
  });
});
