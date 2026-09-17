/**
 * Guards for the PRODUCING half of the agent credential pipeline (WI-10001686).
 *
 * The load-bearing test here is the round-trip one. The defect this module fixes was not a wrong
 * value — it was a missing producer, and the thing that let it stay missing for so long is that
 * every consumer validates on a HOST, at bind time, so nothing could observe producer/reader
 * disagreement until a VM was already running. These tests close that by driving the REAL reader
 * (`createOperatorWorkspaceHostCredentialMaterialSource`) against the real producer, so an
 * encoding or key-derivation divergence fails here instead of on a paid host.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertWorkspaceHostAgentHomeBundleAdmissionEligible,
  parseWorkspaceHostAgentHomeBundle,
} from '@papercusp/deployment-driver';

import {
  buildWorkspaceHostAgentCredentialMaterial,
  storeWorkspaceHostAgentCredentialMaterial,
  workspaceHostAgentCredentialMaterialKey,
  WorkspaceHostAgentCredentialMaterialError,
} from './agent-credential-material-producer';
import { createOperatorWorkspaceHostCredentialMaterialSource } from './credential-material-source';

const AGENT_REF = 'pc-agent-forward://owner-wait-20260916/default';

/** Mirrors the fixture shape in workspace-host-agent-home.test.ts. */
function agentFiles(overrides: Partial<Record<'claude' | 'codex' | 'omp', unknown>> = {}) {
  return {
    claude: Buffer.from(
      JSON.stringify(
        overrides.claude ?? { claudeAiOauth: { accessToken: 'claude-secret' } },
      ),
    ),
    codex: Buffer.from(
      JSON.stringify(
        overrides.codex ?? {
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-secret',
            id_token: 'codex-identity',
            refresh_token: '',
          },
        },
      ),
    ),
    omp:
      overrides.omp === null
        ? null
        : Buffer.from(
            JSON.stringify(
              overrides.omp ?? { anthropic: { type: 'oauth', token: { access: 'omp-secret' } } },
            ),
          ),
  };
}

describe('workspace-host agent credential material producer', () => {
  it('stores material the REAL reader resolves, parses, and admits', async () => {
    // The whole point: producer and reader must agree on BOTH the key name and the byte encoding.
    // An in-memory store stands in for operator_integration_credentials; everything else is the
    // production code path.
    const store = new Map<string, string>();

    const receipt = await storeWorkspaceHostAgentCredentialMaterial(
      { credentialRef: AGENT_REF, generation: 1, files: agentFiles() },
      async (name, value) => {
        store.set(name, value);
      },
    );

    // The reader derives its OWN key from the reference; it never sees the producer's receipt.
    // If the two derivations diverged, this resolve would throw "no material is stored under …".
    const source = createOperatorWorkspaceHostCredentialMaterialSource(
      async (name) => store.get(name),
    );
    const material = await source.resolve({
      channel: 'agent',
      credentialRef: AGENT_REF,
      family: 'agent-forwarded-reference',
      generation: 1,
    });

    // And the bytes the reader hands to admission must survive the same gate the host runs.
    const bundle = parseWorkspaceHostAgentHomeBundle(material.reveal());
    expect(() => assertWorkspaceHostAgentHomeBundleAdmissionEligible(bundle)).not.toThrow();

    expect(receipt.key).toBe(workspaceHostAgentCredentialMaterialKey(AGENT_REF, 1));
    expect(receipt.materialBytes).toBeGreaterThan(0);
  });

  it('stores UTF-8 JSON, not base64 — the reader does Buffer.from(value, "utf8")', () => {
    // A base64 round-trip would be invisible until a host tried to bind, so the encoding is
    // asserted directly rather than only through the round-trip above.
    const material = buildWorkspaceHostAgentCredentialMaterial(agentFiles());
    expect(() => JSON.parse(material)).not.toThrow();
    expect(JSON.parse(material)).toMatchObject({ files: expect.any(Object) });
  });

  it('neutralizes the codex refresh token in the stored material (D-311)', () => {
    const material = buildWorkspaceHostAgentCredentialMaterial(
      agentFiles({
        codex: {
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-secret',
            id_token: 'codex-identity',
            refresh_token: 'A-LIVE-REFRESH-TOKEN',
          },
        },
      }),
    );
    // The projection is what makes the codex half self-expiring rather than a mintable credential.
    expect(material).not.toContain('A-LIVE-REFRESH-TOKEN');
  });

  it('refuses material the admission gate would reject at bind time, and writes NOTHING', async () => {
    const writeKey = vi.fn(async () => {});

    await expect(
      storeWorkspaceHostAgentCredentialMaterial(
        // A codex file with no access token can never authenticate; today that is discovered on a
        // provisioned host, which is exactly the cost this refusal removes.
        { credentialRef: AGENT_REF, generation: 1, files: agentFiles({ codex: { auth_mode: 'chatgpt', tokens: {} } }) },
        writeKey,
      ),
    ).rejects.toBeInstanceOf(WorkspaceHostAgentCredentialMaterialError);

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('refuses a non-agent credential reference instead of keying it into the agent namespace', async () => {
    const writeKey = vi.fn(async () => {});

    await expect(
      storeWorkspaceHostAgentCredentialMaterial(
        {
          credentialRef: 'pc-cloud-workload://gcp/active-alcove-504205-q3/pc-vm',
          generation: 1,
          files: agentFiles(),
        },
        writeKey,
      ),
    ).rejects.toThrow();

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('refuses a non-positive generation before encoding any material', async () => {
    const writeKey = vi.fn(async () => {});

    await expect(
      storeWorkspaceHostAgentCredentialMaterial(
        { credentialRef: AGENT_REF, generation: 0, files: agentFiles() },
        writeKey,
      ),
    ).rejects.toThrow();

    expect(writeKey).not.toHaveBeenCalled();
  });

  it('derives a DIFFERENT key per generation, so a rotation cannot overwrite the live generation', () => {
    // Rotation requires the pre- and post-rotation values to coexist: the host may still be asked
    // to bind the generation being replaced.
    expect(workspaceHostAgentCredentialMaterialKey(AGENT_REF, 1)).not.toBe(
      workspaceHostAgentCredentialMaterialKey(AGENT_REF, 2),
    );
  });

  it('derives a DIFFERENT key per host, so one host cannot bind another host material', () => {
    expect(workspaceHostAgentCredentialMaterialKey(AGENT_REF, 1)).not.toBe(
      workspaceHostAgentCredentialMaterialKey('pc-agent-forward://other-host/default', 1),
    );
  });

  it('accepts a credential-free omp slot (files.omp === null)', async () => {
    const store = new Map<string, string>();
    await storeWorkspaceHostAgentCredentialMaterial(
      { credentialRef: AGENT_REF, generation: 1, files: agentFiles({ omp: null }) },
      async (name, value) => {
        store.set(name, value);
      },
    );
    expect(store.size).toBe(1);
  });
});
