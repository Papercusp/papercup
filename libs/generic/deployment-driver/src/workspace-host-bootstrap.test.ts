import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
  WORKSPACE_HOST_BOOTSTRAP_CHECKS,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_PHASES,
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_GLIBC_SONAMES,
  WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE,
  WORKSPACE_HOST_RUNTIME_ROOT,
  WORKSPACE_HOST_STATE_ROOT,
  buildWorkspaceHostBootstrap,
  evaluateWorkspaceHostNativeDependencyCoverage,
  normalizeWorkspaceHostSoname,
  parseWorkspaceHostReadelfNeeded,
  parseWorkspaceHostBootstrapAttestation,
  validateWorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapInput,
} from './workspace-host-bootstrap';
import { deriveWorkspaceHostCanonicalArtifactUrls } from './workspace-host-build-manifest';

const DIGEST = 'a'.repeat(64);
const KEY_DIGEST = 'b'.repeat(64);
const OTHER_DIGEST = 'c'.repeat(64);

// D-106: fixtures derive their URLs from the digest instead of hand-authoring one. The previous
// literals pointed at releases.papercusp.com, which D-105 established has no production source or
// DNS — so every fixture in this file was teaching an address that cannot exist.
const ARTIFACTS = deriveWorkspaceHostCanonicalArtifactUrls(DIGEST);

function input(
  overrides: Partial<WorkspaceHostBootstrapInput> = {},
): WorkspaceHostBootstrapInput {
  return {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId: 'host-1',
    release: {
      version: '2026.8.22-1',
      bundleUrl: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signatureUrl: ARTIFACTS.signatureUrl,
      signingPublicKey:
        'untrusted comment: Papercusp release key\nRWQpublickey',
      signingKeySha256: KEY_DIGEST,
    },
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
    publicMetadata: { channel: 'canary' },
    ...overrides,
  };
}

function attestation(
  overrides: Partial<WorkspaceHostBootstrapAttestation> = {},
): WorkspaceHostBootstrapAttestation {
  return {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    hostId: 'host-1',
    action: 'install',
    ubuntuVersion: '24.04',
    observedAt: '2026-08-22T06:00:00Z',
    status: 'healthy',
    release: {
      version: '2026.8.22-1',
      source: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signingKeySha256: KEY_DIGEST,
      signatureVerified: true,
    },
    migration: { id: 'schema-1042', applied: true },
    runtime: {
      nodeMajor: 22,
      minimumNodeMajor: 22,
      psu: true,
      pui: true,
      claude: true,
      codex: true,
      omp: true,
    },
    service: {
      name: 'papercusp-workspace',
      user: DEFAULT_WORKSPACE_HOST_SERVICE_USER,
      group: DEFAULT_WORKSPACE_HOST_SERVICE_USER,
      bindHost: '127.0.0.1',
      port: 3070,
      active: true,
    },
    isolation: {
      workspaceUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      workspaceGroup: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      runtimeRoot: WORKSPACE_HOST_RUNTIME_ROOT,
      stateRoot: WORKSPACE_HOST_STATE_ROOT,
      workspaceRoot: WORKSPACE_HOST_DATA_ROOT,
      runtimeReadableByWorkspaceUser: false,
      workspaceWritableByService: true,
      workspaceWritableBySshUser: true,
      sudo: false,
      serviceGroupMember: false,
      operatorIngress: 'ssh-local-forward',
      updateMode: 'signed-atomic-release-swap',
    },
    checks: WORKSPACE_HOST_BOOTSTRAP_CHECKS.map((name) => ({ name, ok: true })),
    ...overrides,
  };
}

describe('buildWorkspaceHostBootstrap', () => {
  it('emits one deterministic, ordered, signed and loopback-only host contract', () => {
    const first = buildWorkspaceHostBootstrap(input());
    const replay = buildWorkspaceHostBootstrap(input());
    expect(first).toBe(replay);
    const syntax = spawnSync('bash', ['-n'], {
      input: first,
      encoding: 'utf8',
    });
    expect(syntax.status, syntax.stderr).toBe(0);

    let previous = -1;
    for (const phase of WORKSPACE_HOST_BOOTSTRAP_PHASES) {
      const position = first.indexOf(`phase '${phase}'`);
      expect(position, phase).toBeGreaterThan(previous);
      previous = position;
    }

    expect(first).toContain('Ubuntu 24.04 is required');
    expect(first).toContain('PasswordAuthentication no');
    expect(first).toContain('PermitRootLogin no');
    expect(first).toContain('minisign -Vm');
    expect(first).toContain('sha256sum --check --strict');
    expect(first).toContain("SERVICE_USER='papercusp'");
    expect(first).toContain("WORKSPACE_USER='papercusp-workspace'");
    expect(first).toContain(
      'usermod --lock --gid "$WORKSPACE_GROUP" --groups ""',
    );
    expect(first).toContain(
      'setfacl -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx',
    );
    expect(first).toContain('AuthenticationMethods publickey');
    expect(first).toContain('AllowUsers $WORKSPACE_USER');
    expect(first).toContain('AllowTcpForwarding local');
    expect(first).toContain('PermitOpen 127.0.0.1:$SERVICE_PORT');
    expect(first).toContain(
      'PAPERCUSP_EMBEDDED_PG_ROOT=$STATE_ROOT/embedded-pg',
    );
    expect(first).toContain('PAPERCUSP_WORKSPACE_ROOT=$WORKSPACE_ROOT');
    expect(first).toContain('bin/papercusp-migrate');
    expect(first).toContain('bin/psu');
    expect(first).toContain("PUI_ENTRYPOINT='bin/pui'");
    expect(first).toContain("PUI_COMPANION_PATH='pui-companion.wasm'");
    expect(first).toContain("PUI_INSTALL_MANIFEST_PATH='pui-install.json'");
    expect(first).toContain('missing or empty PUI companion');
    expect(first).toContain('missing or empty PUI install manifest');
    expect(first).toContain('bin/claude');
    expect(first).toContain('bin/codex');
    expect(first).toContain('bin/omp');
    expect(first).toContain('Environment=PAPERCUSP_BIND_HOST=127.0.0.1');
    expect(first).toContain(
      'Environment=PUI_COMPANION_WASM=$RUNTIME_ROOT/current/$PUI_COMPANION_PATH',
    );
    expect(first).toContain(
      'Environment=PUI_INSTALL_MANIFEST=$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH',
    );
    expect(first).toContain(
      'PUI_OPERATOR="http://127.0.0.1:$SERVICE_PORT" PUI_COMPANION_WASM=',
    );
    expect(first).toContain('"$RUNTIME_ROOT/current/$PUI_ENTRYPOINT" doctor');
    expect(first).toContain('ReadOnlyPaths=$RUNTIME_ROOT');
    expect(first).toContain('ReadWritePaths=$STATE_ROOT $WORKSPACE_ROOT');
    expect(first).toContain('chown -R "root:$SERVICE_GROUP" "$RELEASE_DIR"');
    expect(first).toContain('runuser -u "$WORKSPACE_USER" -- test ! -r');
    expect(first).toContain('StandardOutput=journal');
    expect(first).toContain(WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX);
    expect(first).toContain(
      `apt-get install -y --no-install-recommends ${WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES.join(' ')}`,
    );
    expect(first).not.toContain('RWQpublickey');
    expect(first).not.toMatch(/PAPERCUSP_(?:API_KEY|TOKEN|PASSWORD)=/);
    expect(first).not.toContain('AllowTcpForwarding yes');
    expect(first).not.toMatch(/NOPASSWD|usermod .*sudo/);
  });

  /**
   * The unit's WorkingDirectory is the STATE root, because that is the only writable place the
   * service owns. Every content resolver in the server falls back to probing relative to cwd,
   * so each content root must be pinned to the RELEASE root explicitly or it resolves under the
   * state root, where none of them exists.
   *
   * Measured (P-046, 2026-08-29): with these absent the server died at boot with
   *   prompt-assembly: oracle.persona.md not found at
   *   /var/lib/papercusp/apps/operator/prompts/oracle.persona.md
   * `promptsDir()` had tried cwd/apps/operator/prompts, cwd/prompts, and a module walk-up for
   * apps/operator/prompts — the bundle ships prompts/ at its own root, so all three missed.
   *
   * Prompts is only the first of these to THROW; a missing SPA or docs root starts a server
   * that quietly serves nothing, which is why all five are pinned rather than just the one
   * that failed loudly.
   */
  it('pins every content root to the release rather than the working directory', () => {
    const unit = buildWorkspaceHostBootstrap(input());

    for (const [envVar, dir] of [
      ['PAPERCUSP_PROMPTS_DIR', 'prompts'],
      ['PAPERCUSP_SPA_DIST', 'spa'],
      ['PAPERCUSP_DOCS_ROOT', 'internal-docs'],
      ['PAPERCUSP_TEMPLATES_DIR', 'templates'],
      ['PAPERCUSP_RUBRICS_DIR', 'rubrics'],
    ] as const) {
      expect(unit).toContain(`Environment=${envVar}=$RUNTIME_ROOT/current/${dir}`);
      // The whole bug: a value that resolves against the state root (or nothing at all).
      expect(unit).not.toContain(`Environment=${envVar}=$STATE_ROOT`);
    }
  });

  it('defines replay-safe install, upgrade, rollback, and failure restoration', () => {
    const upgrade = buildWorkspaceHostBootstrap(input({ action: 'upgrade' }));
    const rollback = buildWorkspaceHostBootstrap(input({ action: 'rollback' }));
    expect(upgrade).toContain("BOOTSTRAP_ACTION='upgrade'");
    expect(upgrade).toContain(
      'PREVIOUS_TARGET="$(readlink -f "$RUNTIME_ROOT/current"',
    );
    expect(upgrade).toContain('restore_previous()');
    expect(upgrade).toContain(
      'ln -sfn "$RELEASE_DIR" "$RUNTIME_ROOT/current.next"',
    );
    expect(rollback).toContain("BOOTSTRAP_ACTION='rollback'");
    expect(rollback).toContain('"$RELEASE_DIR/$ROLLBACK_ENTRYPOINT"');
  });

  it('supports explicit distinct identities and rejects privileged or shared identities', () => {
    const script = buildWorkspaceHostBootstrap(
      input({
        service: {
          name: 'papercusp-workspace',
          port: 3070,
          user: 'papercusp-svc',
          group: 'papercusp-svc',
        },
        isolation: {
          workspaceUser: 'customer-workspace',
          workspaceGroup: 'customer-workspace',
        },
      }),
    );
    expect(script).toContain("SERVICE_USER='papercusp-svc'");
    expect(script).toContain("WORKSPACE_USER='customer-workspace'");

    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          service: { name: 'papercusp-workspace', port: 3070, user: 'root' },
        }),
      ),
    ).toThrow(/service.user must be a safe Linux name/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { workspaceUser: 'papercusp' } }),
      ),
    ).toThrow(/workspace SSH user must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { workspaceGroup: 'papercusp' } }),
      ),
    ).toThrow(/workspace SSH group must differ/);
  });

  it('rejects non-public provenance, unsafe entrypoints, and secret-shaped metadata', () => {
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          release: {
            ...input().release,
            bundleUrl: 'http://example.test/server.tgz',
          },
        }),
      ),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          entrypoints: { operator: '../../tmp/operator' },
        }),
      ),
    ).toThrow(/safe relative release path/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          publicMetadata: { apiToken: 'must-not-be-rendered' },
        }),
      ),
    ).toThrow(/Secret-shaped field/);
  });

  // D-106 / WI-41712. requirePublicHttpsUrl proves only that the URL is well-formed,
  // credential-free HTTPS — it never relates the URL to the digest the release pins. Each case
  // below is well-formed HTTPS and passes every OTHER bootstrap check, so each one FAILS if the
  // shared addressing rule is not wired in. That is the point: these are the falsifiers for the
  // guard, not decoration around it.
  describe('release addressing (D-106)', () => {
    it('accepts the canonical digest-derived artifact URLs', () => {
      expect(() => buildWorkspaceHostBootstrap(input())).not.toThrow();
    });

    it('rejects a mutable release channel even with a well-formed digest', () => {
      // The exact shape that motivated the rule: a valid bundleSha256 sitting next to a URL that
      // can be re-pointed at different bytes tomorrow, interpolated into a script running as root.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: 'https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/latest/server.tgz',
              signatureUrl:
                'https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/latest/server.tgz.minisig',
            },
          }),
        ),
      ).toThrow(/mutable release channel/);
    });

    it('rejects a content-addressed URL that addresses a different digest', () => {
      // Well-shaped and immutable, but it pins someone else's bundle. This must NOT fall through
      // to the version-embedding rule and be accepted as "immutable enough".
      const wrong = deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST);
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: wrong.bundleUrl,
              signatureUrl: wrong.signatureUrl,
            },
          }),
        ),
      ).toThrow(/is content-addressed at/);
    });

    it('rejects a signature that is not the detached companion of the bundle', () => {
      // A valid signature over a DIFFERENT artifact would otherwise satisfy verification.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST)
                .signatureUrl,
            },
          }),
        ),
      ).toThrow(/suffixed with \.minisig/);
    });

    it('rejects a digest that merely appears in the query string', () => {
      // A query parameter does not determine which bytes the origin serves.
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            release: {
              ...input().release,
              bundleUrl: `https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/server.tgz?digest=${DIGEST}`,
              signatureUrl: `https://papercusp-cupboard.aviynw.workers.dev/artifacts/workspace-host/server.tgz?digest=${DIGEST}.minisig`,
            },
          }),
        ),
      ).toThrow();
    });
  });
});

describe('workspace-host native dependency contract', () => {
  it('parses and normalizes the readelf NEEDED union deterministically', () => {
    const output = [
      ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
      ' 0x0000000000000001 (NEEDED)             Shared library: [libatomic.so.1]',
      ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
      ' 0x000000000000000e (SONAME)             Library soname: [ignored.so.1]',
    ].join('\n');
    expect(parseWorkspaceHostReadelfNeeded(output)).toEqual([
      'libatomic.so.1',
      'libstdc++.so.6',
    ]);
    expect(normalizeWorkspaceHostSoname('  [libasound.so.2]  ')).toBe(
      'libasound.so.2',
    );
  });

  it('subtracts glibc and bundle-internal libraries before checking providers', () => {
    const result = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: [
        ...WORKSPACE_HOST_GLIBC_SONAMES,
        'libonnxruntime.so.1',
        'libatomic.so.1',
        'libasound.so.2',
      ],
      bundleInternalSonames: ['libonnxruntime.so.1'],
    });
    expect(result.ok).toBe(true);
    expect(result.externalSonames).toEqual([
      'libasound.so.2',
      'libatomic.so.1',
    ]);
    expect(result.requiredAptPackages).toEqual([
      'libasound2t64',
      'libatomic1',
    ]);
    expect(result.missingAptPackages).toEqual([]);
  });

  it('fails closed for unknown SONAMEs and missing apt providers', () => {
    const unknown = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: ['libnew-native.so.1'],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.unknownSonames).toEqual(['libnew-native.so.1']);

    const missing = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: ['libatomic.so.1', 'libstdc++.so.6'],
      aptPackages: ['libatomic1'],
    });
    expect(missing.ok).toBe(false);
    expect(missing.unknownSonames).toEqual([]);
    expect(missing.missingAptPackages).toEqual(['libstdc++6']);
  });

  it('keeps the provider map and bootstrap apt contract aligned', () => {
    const result = evaluateWorkspaceHostNativeDependencyCoverage({
      neededSonames: Object.keys(WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE),
    });
    expect(result.ok).toBe(true);
    expect(result.requiredAptPackages).toEqual(
      expect.arrayContaining([
        'libasound2t64',
        'libatomic1',
        'libgcc-s1',
        'libstdc++6',
      ]),
    );
  });
});

describe('workspace-host bootstrap attestation', () => {
  it('parses and accepts an exact release/runtime/migration/service result', () => {
    const expected = attestation();
    const encoded = Buffer.from(JSON.stringify(expected), 'utf8').toString(
      'base64',
    );
    const parsed = parseWorkspaceHostBootstrapAttestation(
      `log line\n${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}${encoded}\n`,
    );
    expect(parsed).toEqual(expected);
    expect(validateWorkspaceHostBootstrapAttestation(parsed, input())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects provenance, migration, runtime, service, and check drift together', () => {
    const drifted = attestation({
      release: {
        ...attestation().release,
        source: deriveWorkspaceHostCanonicalArtifactUrls(OTHER_DIGEST)
          .bundleUrl,
      },
      migration: { id: 'schema-old', applied: true },
      runtime: {
        ...attestation().runtime,
        nodeMajor: 20,
        pui: false as true,
      },
      service: {
        ...attestation().service,
        user: 'unexpected-service',
        bindHost: '0.0.0.0' as '127.0.0.1',
      },
      isolation: {
        ...attestation().isolation,
        runtimeReadableByWorkspaceUser: true as false,
        sudo: true as false,
      },
      checks: WORKSPACE_HOST_BOOTSTRAP_CHECKS.slice(1).map((name) => ({
        name,
        ok: true,
      })),
    });
    const result = validateWorkspaceHostBootstrapAttestation(drifted, input());
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'release source mismatch',
        'migration id mismatch',
        'Node runtime is below the requested floor',
        'service user mismatch',
        'operator must bind to loopback',
        'workspace SSH user can read the runtime',
        'workspace SSH user has privileged runtime membership',
        "required bootstrap check 'ubuntu-24.04' did not pass",
      ]),
    );
  });

  it('fails malformed remote JSON closed instead of throwing through the provider workflow', () => {
    expect(
      validateWorkspaceHostBootstrapAttestation({ status: 'healthy' }, input()),
    ).toEqual({
      ok: false,
      errors: ['bootstrap attestation has an invalid shape'],
    });
  });
});
