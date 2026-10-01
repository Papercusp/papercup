import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES,
  WorkspaceHostAmbientCredentialDeliveryError,
  WorkspaceHostCredentialDeliveryProtocolError,
  WorkspaceHostCredentialGenerationConflictError,
  WorkspaceHostCredentialMaterial,
  WorkspaceHostRevokedCredentialGenerationError,
  assertWorkspaceHostCredentialDeliveryArgv,
  encodeWorkspaceHostCredentialDeliveryRequest,
  executeWorkspaceHostCredentialDelivery,
  handleWorkspaceHostCredentialDeliveryPayload,
  parseWorkspaceHostCredentialDeliveryRequest,
  readWorkspaceHostCredentialRevokedThrough,
  recordWorkspaceHostCredentialRevocation,
  workspaceHostCredentialMaterialPath,
  workspaceHostCredentialRevocationLedgerPath,
  type WorkspaceHostCredentialDeliveryFilesystem,
} from './workspace-host-credential-delivery';
import {
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
} from './workspace-host-credential-namespace';
import {
  createProductionWorkspaceHostCredentialMaterializers,
  type WorkspaceHostCommandInput,
  type WorkspaceHostSystem,
} from './workspace-host-remote-initializer-host';

const ROOT = '/credentials';
const NOW = new Date('2026-08-31T10:00:00.000Z');

const GIT_FIELDS = { forge: 'github', owner: 'papercupai', repository: 'private-canary' };
const GIT_REF = buildWorkspaceHostCredentialReference('git-short-lived-delegation', GIT_FIELDS);
const CLOUD_REF = buildWorkspaceHostCredentialReference('cloud-workload-identity', {
  provider: 'gcp',
  scopeId: 'active-alcove-504205-q3',
  workloadId: 'p046-canary-03',
});

/**
 * Token-shaped bytes on purpose.
 *
 * This value would be REJECTED by `assertWorkspaceHostSecretIsolation` if the request were
 * asserted, so every test that delivers it is a live positive control for the deliberate inbound
 * asymmetry (D-215): delivery is the one boundary that legitimately carries material, and a test
 * suite using innocuous bytes would pass identically whether or not that asymmetry survived.
 */
const MATERIAL = Buffer.from('https://git-user:private-token-value@github.com', 'utf8');
const OTHER_MATERIAL = Buffer.from('https://git-user:rotated-token-value@github.com', 'utf8');

/**
 * One in-memory double for the WHOLE host seam.
 *
 * It implements `WorkspaceHostSystem`, not merely `WorkspaceHostCredentialDeliveryFilesystem`,
 * because those are now one seam — and that is load-bearing for these tests rather than
 * convenient. When the ledger had its own filesystem defaulting to the real node implementation,
 * a test that faked every host operation still reached the real disk and tried to
 * `mkdir /credentials` on the machine running the suite.
 */
class MemoryFilesystem implements WorkspaceHostSystem {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  writes = 0;

  async run(_input: WorkspaceHostCommandInput) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async ensureWorkspaceDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async writePrivateFile(path: string, bytes: Buffer): Promise<void> {
    this.writes += 1;
    this.files.set(path, Buffer.from(bytes));
  }
  async readFileIfPresent(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }
  async pathExists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }
  async removePath(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
  }
}

function deliveryRequest(
  overrides: Partial<{ channel: string; credentialRef: string; generation: number; material: string }> = {},
) {
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    channel: 'git',
    credentialRef: GIT_REF,
    generation: 7,
    material: MATERIAL.toString('base64'),
    ...overrides,
  };
}

function deps(filesystem: WorkspaceHostCredentialDeliveryFilesystem) {
  return { filesystem, materialRoot: ROOT, now: () => NOW };
}

describe('credential delivery — the operation (D-215 points 1-5)', () => {
  it('writes exactly one path, at the layout bind() reads', async () => {
    const fs = new MemoryFilesystem();
    const receipt = await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );

    const expected = `${ROOT}/git-short-lived-delegation/7/material`;
    expect([...fs.files.keys()]).toEqual([expected]);
    expect(fs.files.get(expected)).toEqual(MATERIAL);
    expect(receipt.present).toBe(true);
  });

  /**
   * D-215 point 3. Asserted as an EXACT key set rather than "does not contain a digest": a
   * negative list only rejects the leaks someone already thought of, while the exact set makes any
   * new field — a size, a checksum, a fingerprint — a test failure at the moment it is added.
   */
  it('produces a receipt carrying nothing derived from the bytes', async () => {
    const fs = new MemoryFilesystem();
    const receipt = await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );

    expect(Object.keys(receipt).sort()).toEqual([
      'family',
      'generation',
      'observedAt',
      'present',
      'protocolVersion',
    ]);
    expect(receipt).toEqual({
      protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
      family: 'git-short-lived-delegation',
      generation: 7,
      present: true,
      observedAt: NOW.toISOString(),
    });
    // Calibration: the material really is present in this run, so the absence above is a property
    // of the receipt rather than of a test that delivered nothing.
    expect(fs.files.size).toBe(1);
  });

  it('refuses the ambient family, deriving the exemption from the family spec', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(
          deliveryRequest({ channel: 'cloud', credentialRef: CLOUD_REF }),
        ),
        deps(fs),
      ),
    ).rejects.toBeInstanceOf(WorkspaceHostAmbientCredentialDeliveryError);
    // Nothing may touch the filesystem: a directory created for an ambient family is already the
    // failure, because bind() would then find a path delivery invented.
    expect(fs.files.size).toBe(0);
    expect(fs.directories.size).toBe(0);
  });

  /**
   * Pins the exemption to its SOURCE. If a future family flips `requiresDeliveredMaterial`, the
   * test above keeps passing against a stale expectation; this one fails.
   */
  it('exempts exactly the families whose spec says they need no delivered material', async () => {
    const exempt = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS)
      .filter((spec) => !spec.requiresDeliveredMaterial)
      .map((spec) => spec.family);
    expect(exempt).toEqual(['cloud-workload-identity']);
    // Calibration: a spec table with every flag set the same way would make the filter vacuous.
    expect(
      Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).some(
        (spec) => spec.requiresDeliveredMaterial,
      ),
    ).toBe(true);
  });

  it('is idempotent per (family, generation): the same material is a no-op', async () => {
    const fs = new MemoryFilesystem();
    const request = () => parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest());

    const first = await executeWorkspaceHostCredentialDelivery(request(), deps(fs));
    const second = await executeWorkspaceHostCredentialDelivery(request(), deps(fs));

    expect(second).toEqual(first);
    expect(fs.writes).toBe(1);
  });

  it('refuses the same generation carrying different material', async () => {
    const fs = new MemoryFilesystem();
    await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );

    await expect(
      executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(
          deliveryRequest({ material: OTHER_MATERIAL.toString('base64') }),
        ),
        deps(fs),
      ),
    ).rejects.toBeInstanceOf(WorkspaceHostCredentialGenerationConflictError);

    // The original survives: a refused delivery must not have half-replaced it.
    expect(fs.files.get(`${ROOT}/git-short-lived-delegation/7/material`)).toEqual(MATERIAL);
    expect(fs.writes).toBe(1);
  });
});

describe('credential delivery — revocation is not reversible (D-215 point 5)', () => {
  it('refuses a generation revoke() destroyed, even though the file is gone', async () => {
    const fs = new MemoryFilesystem();
    await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );

    // Exactly what revoke() does: unlink the material, then raise the ledger.
    fs.files.delete(`${ROOT}/git-short-lived-delegation/7/material`);
    await recordWorkspaceHostCredentialRevocation(fs, ROOT, 'git-short-lived-delegation', 7);

    await expect(
      executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
        deps(fs),
      ),
    ).rejects.toBeInstanceOf(WorkspaceHostRevokedCredentialGenerationError);

    // Calibration: absence alone must NOT be what refuses it — a later generation, equally absent,
    // still delivers. Without this the test above would pass against a delivery that simply
    // refused everything.
    const next = await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest({ generation: 8 })),
      deps(fs),
    );
    expect(next.generation).toBe(8);
  });

  it('keeps the high-water mark monotonic when an older generation is revoked later', async () => {
    const fs = new MemoryFilesystem();
    await recordWorkspaceHostCredentialRevocation(fs, ROOT, 'git-short-lived-delegation', 9);
    await recordWorkspaceHostCredentialRevocation(fs, ROOT, 'git-short-lived-delegation', 4);

    expect(
      await readWorkspaceHostCredentialRevokedThrough(fs, ROOT, 'git-short-lived-delegation'),
    ).toBe(9);
  });

  it('refuses to deliver rather than assume nothing was revoked when the ledger is corrupt', async () => {
    const fs = new MemoryFilesystem();
    fs.files.set(
      workspaceHostCredentialRevocationLedgerPath(ROOT, 'git-short-lived-delegation'),
      Buffer.from('not-a-number', 'utf8'),
    );

    await expect(
      executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
        deps(fs),
      ),
    ).rejects.toThrow(/refusing to deliver/);
  });

  it('is raised by the production materializer revoke(), not only by the helper', async () => {
    // The property that matters end-to-end: a real revoke leaves a trace delivery can see.
    const files = new MemoryFilesystem();
    const materializers = createProductionWorkspaceHostCredentialMaterializers(files, ROOT);
    const git = materializers.find((m) => m.family === 'git-short-lived-delegation');
    expect(git).toBeDefined();

    await git?.revoke({
      namespaceVersion: 'papercusp-workspace-host-credential-namespace-v1',
      family: 'git-short-lived-delegation',
      channel: 'git',
      reference: { family: 'git-short-lived-delegation' },
      revocation: { family: 'git-short-lived-delegation' },
      deliveryKind: 'short-lived-delegation',
      generation: 12,
      audience: 'workspace-host-canary',
    } as never);

    expect(
      await readWorkspaceHostCredentialRevokedThrough(files, ROOT, 'git-short-lived-delegation'),
    ).toBe(12);
  });

  it('records no ledger for an ambient family, which has nothing to revoke', async () => {
    const files = new MemoryFilesystem();
    const materializers = createProductionWorkspaceHostCredentialMaterializers(files, ROOT);
    const cloud = materializers.find((m) => m.family === 'cloud-workload-identity');
    await cloud?.revoke({
      namespaceVersion: 'papercusp-workspace-host-credential-namespace-v1',
      family: 'cloud-workload-identity',
      channel: 'cloud',
      deliveryKind: 'provider-identity',
      generation: 3,
      audience: 'workspace-host-canary',
    } as never);

    expect(files.files.size).toBe(0);
  });
});

describe('credential delivery — the envelope', () => {
  it('derives the family from the reference rather than trusting a field', () => {
    const parsed = parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest());
    expect(parsed.family).toBe('git-short-lived-delegation');

    // A reference from another channel cannot be smuggled in under a git label.
    expect(() =>
      parseWorkspaceHostCredentialDeliveryRequest(
        deliveryRequest({ channel: 'git', credentialRef: CLOUD_REF }),
      ),
    ).toThrow(/channel/);
  });

  it('rejects a foreign protocol version before reading anything else', () => {
    expect(() =>
      parseWorkspaceHostCredentialDeliveryRequest({
        ...deliveryRequest(),
        protocolVersion: 'papercusp-gcp-iap-initialization-v2',
      }),
    ).toThrow(/unsupported protocol version/);
  });

  it('refuses non-canonical base64 rather than writing silently-corrupted material', () => {
    expect(() =>
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest({ material: 'not valid !!! b64' })),
    ).toThrow(/canonical base64/);
    expect(() =>
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest({ material: '' })),
    ).toThrow(/non-empty string/);
  });

  it('bounds the delivered artifact', () => {
    const oversized = Buffer.alloc(WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES + 1, 7);
    expect(() =>
      parseWorkspaceHostCredentialDeliveryRequest(
        deliveryRequest({ material: oversized.toString('base64') }),
      ),
    ).toThrow(/exceeds/);
  });

  it('round-trips through the encoder the controller uses', () => {
    const encoded = encodeWorkspaceHostCredentialDeliveryRequest({
      channel: 'git',
      credentialRef: GIT_REF,
      generation: 7,
      material: new WorkspaceHostCredentialMaterial(MATERIAL),
    });
    const parsed = parseWorkspaceHostCredentialDeliveryRequest(JSON.parse(JSON.stringify(encoded)));
    expect(parsed.material.reveal()).toEqual(MATERIAL);
    expect(parsed.generation).toBe(7);
  });

  it('accepts material that secret-isolation would reject, which is the whole point', async () => {
    // If someone "tidies up" by asserting isolation on the request, this fails — which is the
    // alarm we want, because the assertion would reject every real delivery in production.
    const fs = new MemoryFilesystem();
    const receipt = await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );
    expect(receipt.present).toBe(true);
    expect(MATERIAL.toString('utf8')).toMatch(/token/);
  });

  it('refuses argv that is not exactly the controller command', () => {
    expect(() =>
      assertWorkspaceHostCredentialDeliveryArgv([...WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV]),
    ).not.toThrow();
    expect(() => assertWorkspaceHostCredentialDeliveryArgv([])).toThrow(
      WorkspaceHostCredentialDeliveryProtocolError,
    );
  });

  it('returns one JSON receipt line from a raw payload', async () => {
    const fs = new MemoryFilesystem();
    const out = await handleWorkspaceHostCredentialDeliveryPayload(
      JSON.stringify(deliveryRequest()),
      deps(fs),
    );
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out).family).toBe('git-short-lived-delegation');
  });
});

describe('credential delivery — the material box does not serialize itself', () => {
  const boxed = new WorkspaceHostCredentialMaterial(MATERIAL);

  it('redacts through JSON, string coercion and inspection', () => {
    expect(JSON.stringify({ material: boxed })).toBe('{"material":"[redacted]"}');
    expect(`${boxed}`).toBe('[redacted]');
    expect(String(boxed)).toBe('[redacted]');
    expect(JSON.stringify(boxed)).toBe('"[redacted]"');
  });

  it('still yields the bytes through the explicit accessor', () => {
    expect(boxed.reveal()).toEqual(MATERIAL);
  });

  it('redacts a whole parsed request, the object a diagnostic would capture', () => {
    const parsed = parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest());
    const rendered = JSON.stringify(parsed);
    expect(rendered).toContain('[redacted]');
    expect(rendered).not.toContain('private-token-value');
    // Calibration: the secret really is reachable from this object, so the absence above is the
    // box working rather than a request that never carried it.
    expect(parsed.material.reveal().toString('utf8')).toContain('private-token-value');
  });
});

describe('credential delivery — real filesystem modes', () => {
  it('writes 0600 material inside a 0700 directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pc-delivery-'));
    try {
      const filesystem = new NodeWorkspaceHostCredentialDeliveryFilesystem();
      const receipt = await executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
        { filesystem, materialRoot: base, now: () => NOW },
      );
      expect(receipt.present).toBe(true);

      const path = workspaceHostCredentialMaterialPath(base, 'git-short-lived-delegation', 7);
      const fileStat = await stat(path);
      const dirStat = await stat(join(base, 'git-short-lived-delegation', '7'));

      // Masked with 0o777 because the mode word also carries the file type bits.
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(await readFile(path)).toEqual(MATERIAL);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('leaves no temporary file behind after the atomic rename', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pc-delivery-'));
    try {
      const filesystem = new NodeWorkspaceHostCredentialDeliveryFilesystem();
      await executeWorkspaceHostCredentialDelivery(
        parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
        { filesystem, materialRoot: base, now: () => NOW },
      );
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(join(base, 'git-short-lived-delegation', '7'));
      expect(entries).toEqual(['material']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('credential delivery — the on-host layout has ONE definition', () => {
  /**
   * `materialPathFor` in the remote-initializer host is the READER; this module is the WRITER. The
   * two agreeing is the entire point of the operation, and two `join` calls that happen to match
   * today are exactly how they stop matching later.
   */
  it('is the same path the production materializer checks at bind()', async () => {
    // ONE filesystem for both halves — delivery writes into it, then the materializer looks. No
    // hand-copying of paths between two doubles, which would let the test agree with itself while
    // writer and reader disagreed.
    const fs = new MemoryFilesystem();
    await executeWorkspaceHostCredentialDelivery(
      parseWorkspaceHostCredentialDeliveryRequest(deliveryRequest()),
      deps(fs),
    );

    const materializers = createProductionWorkspaceHostCredentialMaterializers(fs, ROOT);
    const git = materializers.find((m) => m.family === 'git-short-lived-delegation');

    const binding = {
      namespaceVersion: 'papercusp-workspace-host-credential-namespace-v1',
      family: 'git-short-lived-delegation',
      channel: 'git',
      deliveryKind: 'short-lived-delegation',
      generation: 7,
      audience: 'workspace-host-canary',
    } as never;

    // The assertion that matters: bind() succeeds ONLY because delivery wrote where it looks.
    await expect(git?.bind(binding)).resolves.toMatchObject({ present: true });

    // Calibration: the same bind against a generation delivery never wrote must still fail, so
    // the pass above is about the path rather than about a materializer that accepts anything.
    await expect(
      git?.bind({ ...(binding as object), generation: 999 } as never),
    ).rejects.toThrow(/not present on the host/);
  });

  it('places the revocation ledger outside any generation directory', () => {
    expect(workspaceHostCredentialRevocationLedgerPath(ROOT, 'git-short-lived-delegation')).toBe(
      `${ROOT}/git-short-lived-delegation/revoked-through`,
    );
    // It must not collide with a generation named "revoked-through" — generations are numeric, so
    // the namespaces cannot overlap, and this pins that they still do not.
    expect(workspaceHostCredentialMaterialPath(ROOT, 'git-short-lived-delegation', 7)).toBe(
      `${ROOT}/git-short-lived-delegation/7/material`,
    );
  });
});

describe('credential delivery — it is NOT on the initialization protocol (D-215 point 1)', () => {
  it('speaks a different protocol version than the remote initializer', async () => {
    const initializer = await import('./workspace-host-remote-initializer');
    expect(WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION).not.toBe(
      initializer.WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    );
  });

  it('is absent from the initializer step kinds, so no step can carry material', async () => {
    const initializer = await import('./workspace-host-remote-initializer');
    const kinds = initializer.WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS as readonly string[];
    expect(kinds.some((kind) => /deliver|material/i.test(kind))).toBe(false);
    // Calibration: the list is non-empty and really does hold the credential lifecycle kinds, so
    // the absence above is a property of the protocol rather than of an empty array.
    expect(kinds).toContain('bind-credential');
  });

  it('still refuses material on an initialization step, unchanged by this work', async () => {
    const initializer = await import('./workspace-host-remote-initializer');
    expect(() =>
      initializer.parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: initializer.WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
        step: {
          id: 'step-1',
          kind: 'bind-credential',
          dependsOn: [],
          idempotencyKey: 'k1',
          input: { channel: 'git', token: MATERIAL.toString('utf8') },
        },
      }),
    ).toThrow(/forbidden/);
  });
});

describe('credential delivery — revocation reference generations stay aligned', () => {
  it('agrees with the namespace revocation reference for the same generation', () => {
    const revocationRef = buildWorkspaceHostCredentialRevocationReference(
      'git-short-lived-delegation',
      GIT_FIELDS,
      7,
    );
    expect(revocationRef.endsWith('/g7')).toBe(true);
  });
});
