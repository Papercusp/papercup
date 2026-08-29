import { describe, expect, it } from 'vitest';

import type { WorkspaceHostCleanRoomInstallFixture } from '@papercusp/deployment-driver';

import { GcpWorkspaceHostCleanRoomExecutor } from './workspace-host-clean-room-executor';
import type {
  GcpImageFamilyCommandResult,
  GcpImageFamilyCommandRunner,
} from './gcp-image-family-adapter';

/**
 * The production WorkspaceHostCleanRoomExecutor is the seam that decides whether the
 * workspace-host release gate is evidence-backed or self-confirming. Before it existed the
 * only implementations in the tree were hermetic fakes, so `passed: true` could never mean
 * "a real machine installed this bundle and said it was healthy".
 *
 * These tests pin the two properties that matter and cannot be checked by typing alone:
 *   1. every field the guest needs to have ANY egress is actually transmitted, and
 *   2. the executor reports only what the guest printed — it never manufactures success.
 */
const placement = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  subnetwork: 'pc-p046-canary-02-a810e759-subnet',
  architecture: 'x86_64',
};

const fixture = {
  fixtureId: 'p046-bootstrap-acceptance',
  bootstrapScript: '#!/usr/bin/env bash\necho hello\n',
  bootstrapScriptSha256: 'a'.repeat(64),
} as unknown as WorkspaceHostCleanRoomInstallFixture;

interface Call {
  command: string;
  args: readonly string[];
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function runnerReturning(result: Partial<GcpImageFamilyCommandResult>): {
  runner: GcpImageFamilyCommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: GcpImageFamilyCommandRunner = {
    async run(command, args = [], options = {}) {
      calls.push({
        command: typeof command === 'string' ? command : command.command,
        args,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
      return { exitCode: 0, stdout: '', stderr: '', ...result };
    },
  };
  return { runner, calls };
}

describe('GcpWorkspaceHostCleanRoomExecutor', () => {
  it('transmits the subnetwork and architecture the guest needs for egress', async () => {
    const { runner, calls } = runnerReturning({
      stdout: JSON.stringify({ stdout: 'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=abc' }),
    });
    const executor = new GcpWorkspaceHostCleanRoomExecutor({ ...placement, commandRunner: runner });

    await executor.execute(fixture);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('papercusp-gcp-bootstrap-acceptance');
    expect(calls[0].args).toEqual(['--json-stdin']);

    const sent = JSON.parse(calls[0].stdin ?? '{}');
    // EI-21744781090863686: a declared-but-untransmitted subnetwork is invisible until it
    // costs a real cloud boot, because --no-address without Cloud NAT means zero egress.
    expect(sent.subnetwork).toBe(placement.subnetwork);
    expect(sent.architecture).toBe('x86_64');
    expect(sent.projectId).toBe(placement.projectId);
    expect(sent.zone).toBe(placement.zone);
    expect(sent.fixture.bootstrapScript).toBe(fixture.bootstrapScript);
    expect(sent.fixture.bootstrapScriptSha256).toBe(fixture.bootstrapScriptSha256);
  });

  it('returns the guest stdout verbatim rather than any locally-built attestation', async () => {
    const guestStdout = 'installing...\nPAPERCUSP_WORKSPACE_HOST_ATTESTATION=eyJhIjoxfQ==\n';
    const { runner } = runnerReturning({ stdout: JSON.stringify({ stdout: guestStdout }) });
    const executor = new GcpWorkspaceHostCleanRoomExecutor({ ...placement, commandRunner: runner });

    await expect(executor.execute(fixture)).resolves.toEqual({ stdout: guestStdout });
  });

  it('fails loudly when the run exits non-zero, surfacing the structured stderr', async () => {
    const { runner } = runnerReturning({
      exitCode: 1,
      stderr: JSON.stringify({
        tool: 'papercusp-gcp-bootstrap-acceptance',
        error: 'could not tear down every resource it created',
        details: { residualResourceIds: ['instance:pc-bootstrap-acc-dead:us-central1-a'] },
      }),
    });
    const executor = new GcpWorkspaceHostCleanRoomExecutor({ ...placement, commandRunner: runner });

    await expect(executor.execute(fixture)).rejects.toThrow(/exit code 1/);
    await expect(executor.execute(fixture)).rejects.toThrow(/residualResourceIds/);
  });

  it('refuses an empty attestation stream instead of degrading into a silent pass', async () => {
    for (const stdout of ['', '   ']) {
      const { runner } = runnerReturning({ stdout: JSON.stringify({ stdout }) });
      const executor = new GcpWorkspaceHostCleanRoomExecutor({ ...placement, commandRunner: runner });
      await expect(executor.execute(fixture)).rejects.toThrow(/no guest stdout/);
    }
  });

  it('requires every placement field rather than defaulting to a no-egress network', async () => {
    for (const field of ['projectId', 'zone', 'subnetwork', 'architecture'] as const) {
      const { runner, calls } = runnerReturning({ stdout: JSON.stringify({ stdout: 'ok' }) });
      const executor = new GcpWorkspaceHostCleanRoomExecutor({
        ...placement,
        [field]: '  ',
        commandRunner: runner,
      });
      await expect(executor.execute(fixture)).rejects.toThrow(
        new RegExp(`placement\\.${field} is required`),
      );
      // It must refuse BEFORE spending a cloud boot, not after.
      expect(calls).toHaveLength(0);
    }
  });

  it('budgets output for an envelope that embeds the whole bootstrap transcript', async () => {
    const { runner, calls } = runnerReturning({ stdout: JSON.stringify({ stdout: 'ok' }) });
    await new GcpWorkspaceHostCleanRoomExecutor({ ...placement, commandRunner: runner }).execute(
      fixture,
    );
    // The attestation marker is emitted LAST, so a truncated envelope destroys exactly the
    // line the acceptance parse needs — and truncated JSON would not even parse.
    expect(calls[0].maxOutputBytes ?? 0).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(calls[0].timeoutMs ?? 0).toBeGreaterThanOrEqual(32 * 60 * 1_000);
  });
});

/**
 * The trap this guards is subtle and expensive: `workspaceHostCleanRoomFixtureAttestation`
 * returns a fully-healthy attestation (signatureVerified: true, every check ok) and exists
 * ONLY as the expected-value builder for fake executors. An executor that returned it would
 * make `runWorkspaceHostCleanRoomAcceptance` report passed:true for a bundle that was never
 * installed anywhere — asserted success wearing the costume of evidence.
 *
 * These assertions verify the acceptance function is genuinely driven by executor stdout, so
 * an executor that stops reporting real guest output cannot keep producing a passing report.
 */
describe('the production executor never manufactures its own evidence', () => {
  /**
   * `workspaceHostCleanRoomFixtureAttestation` returns a fully-healthy attestation
   * (signatureVerified: true, every check ok) and exists ONLY as the expected-value builder
   * for FAKE executors. An executor that reached for it — or that hand-assembled a report
   * instead of returning stdout — would make the gate ratify its own assumption for a bundle
   * that was never installed anywhere.
   *
   * The acceptance function's own pass/fail behaviour is already covered by
   * workspace-host-image.test.ts; what is NOT covered anywhere else is that the PRODUCTION
   * executor stays a dumb transport. That is what this asserts.
   */
  it('does not reference the healthy-attestation builder or assemble a report', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./workspace-host-clean-room-executor.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toContain('workspaceHostCleanRoomFixtureAttestation');
    // Assembling a report (rather than returning stdout) is the same failure one layer up.
    expect(code).not.toContain('runWorkspaceHostCleanRoomAcceptance');
    expect(code).not.toContain('signatureVerified');
    expect(code).not.toContain("passed: true");
  });
});
