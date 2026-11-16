import { expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { currentSuNativeRetainedArtifacts, CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS } from '../../test/isolated-integration-proof';

it.for([false, true])('retains current-su phase artifacts through pruning (managedCarry=%s)', async managedCarry => {
  const fixture = mkdtempSync(join(tmpdir(), 'current-su-retention-'));
  const evidenceRoot = join(fixture, 'isolated-integration');
  const requests = '[{"model":"private-fixture","managedCarry":true}]\n';
  const egressPreflight = '{"status":"ready","runId":"original-egress-fixture","cleanupErrors":[]}\n';
  const mcpPreflight = '{"status":"ready","sourceSha":"retained-source","toolsDigest":"retained-tools"}\n';
  const allocationOriginals = ['{"currentRef":"WI-123","peerRef":"WI-124","nativeLaunches":0}\n',
    '{"workspace":"test-runtime-retained","clock":{"epoch":"2026-01-01T00:00:00.000Z"}}\n'];
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(fixture, 'retention'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(fixture, 'locks'));
  // The runner also publishes at the canonical reader root. Keep that namespace
  // private: fixed fixture run IDs must never collide with another case/run.
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', fixture);
  try {
    const original = await runHarness({
      contract: { name: 'isolated-integration', phases: [{ id: 'prepare' }, { id: 'execute' }] },
      evidenceRoot, guardRails: [],
      retainedArtifacts: [...currentSuNativeRetainedArtifacts(managedCarry), ...CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS],
      runPhase: async ({ phase, evidenceDir }) => {
        if (phase === 'prepare') {
          writeFileSync(join(evidenceDir, 'operator-api-build.log'), 'original build\n');
          writeFileSync(join(evidenceDir, 'operator-api-build-result.json'), '{"status":0}\n');
          writeFileSync(join(evidenceDir, 'native-egress-preflight.json'), egressPreflight);
          writeFileSync(join(evidenceDir, 'bundle-restricted-hold-inputs.json'), '[]\n');
          writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'), '{"event":"end"}\n');
        } else {
          writeFileSync(join(evidenceDir, 'private-mcp-preflight.json'), mcpPreflight);
          if (managedCarry) writeFileSync(join(evidenceDir, 'native-model-requests.json'), requests);
          for (const [index, path] of CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS.entries())
            writeFileSync(join(evidenceDir, path.split('/').at(-1)!), allocationOriginals[index]!);
        }
        return { ok: true };
      },
    });
    expect(original.verdict).toBe('pass');
    await runHarness({ contract: { name: 'isolated-integration', phases: [{ id: 'execute' }] },
      evidenceRoot, runId: '20991014T000000Z-1', guardRails: [], runPhase: async () => ({ ok: true }) });
    expect(await pruneRuns(evidenceRoot, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(original.runId);
    expect(existsSync(original.evidenceDir)).toBe(false);
    const retainedRequests = join(evidenceRoot, 'retained', original.runId, 'phases/execute/native-model-requests.json');
    if (managedCarry) expect(readFileSync(retainedRequests, 'utf8')).toBe(requests);
    else expect(existsSync(retainedRequests)).toBe(false);
    expect(readFileSync(join(evidenceRoot, 'retained', original.runId,
      'phases/prepare/operator-api-build.log'), 'utf8')).toBe('original build\n');
    expect(readFileSync(join(evidenceRoot, 'retained', original.runId,
      'phases/prepare/native-egress-preflight.json'), 'utf8')).toBe(egressPreflight);
    expect(readFileSync(join(evidenceRoot, 'retained', original.runId,
      'phases/execute/private-mcp-preflight.json'), 'utf8')).toBe(mcpPreflight);
    for (const [index, path] of CURRENT_SU_RECOVERY_ALLOCATION_ARTIFACTS.entries())
      expect(readFileSync(join(evidenceRoot, 'retained', original.runId, path), 'utf8')).toBe(allocationOriginals[index]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
});
