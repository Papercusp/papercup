import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
  WORKSPACE_HOST_BOOTSTRAP_CHECKS,
  WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_PHASES,
  WORKSPACE_HOST_AGENT_NODE_SHA256,
  WORKSPACE_HOST_AGENT_NODE_VERSION,
  WORKSPACE_HOST_OLLAMA_SHA256,
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
  WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS,
  WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
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
} from "./workspace-host-bootstrap";
// Imported from the PROBE's own module, not restated: the assertions below check that the
// installer stages exactly what the probe asks for, which only means something if both sides
// read the same constant.
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from './workspace-host-agent-authentication';
import { deriveWorkspaceHostCanonicalArtifactUrls } from './workspace-host-build-manifest';
import { WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV } from './workspace-host-remote-initializer';
import { WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV } from './workspace-host-credential-delivery';

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
    workspaceAuthorizedKeys: [
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller',
    ],
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
      agentLaunchers: { claude: true, codex: true, omp: true },
      agentRuntimesVerifiedByBootstrap: false,
      agentRuntimesInstalledByBootstrap: false,
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
      agentUser: DEFAULT_WORKSPACE_HOST_AGENT_USER,
      agentGroup: DEFAULT_WORKSPACE_HOST_AGENT_USER,
      runtimeRoot: WORKSPACE_HOST_RUNTIME_ROOT,
      stateRoot: WORKSPACE_HOST_STATE_ROOT,
      workspaceRoot: WORKSPACE_HOST_DATA_ROOT,
      runtimeReadableByWorkspaceUser: false,
      runtimeWritableByWorkspaceUser: false,
      runtimeReadableByAgentUser: true,
      runtimeWritableByAgentUser: false,
      agentHomeReadableBySshUser: false,
      workspaceWritableByService: true,
      workspaceWritableBySshUser: true,
      workspaceWritableByAgentUser: true,
      sudo: false,
      serviceGroupMember: false,
      operatorIngress: 'ssh-local-forward',
      updateMode: 'signed-atomic-release-swap',
    },
    checks: WORKSPACE_HOST_BOOTSTRAP_CHECKS.map((name) => ({ name, ok: true })),
    ...overrides,
  };
}

/**
 * D-259 fixtures. Byte-sized stand-ins for the real vendor install argvs — what is under test is
 * how the bootstrap RUNS and VERIFIES them, never what the vendor scripts themselves do.
 */
const AGENT_RUNTIME_INSTALLS = [
  { agent: 'claude', command: 'bash', args: ['-c', 'echo install-claude'] },
  { agent: 'codex', command: 'bash', args: ['-c', 'echo install-codex'] },
  { agent: 'omp', command: 'bash', args: ['-c', 'echo install-omp'] },
] as const;

describe('buildWorkspaceHostBootstrap agent runtime installs (D-259)', () => {
  it('installs nothing and attests the negative when no installs are configured', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain('AGENT_RUNTIME_PATH');
    expect(script).toContain('agentRuntimesInstalledByBootstrap:false');
    expect(script).not.toContain('agentRuntimes:{');
  });

  it('runs each install as the AGENT identity and dies if the runtime does not resolve', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    for (const { agent } of AGENT_RUNTIME_INSTALLS) {
      // Installed as the agent identity, in the agent's own home. Every argv element is
      // individually quoted, so a vendor install script containing spaces or shell
      // metacharacters cannot word-split into extra arguments.
      expect(script).toContain(
        `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" 'bash' '-c' 'echo install-${agent}' || die 'agent runtime install failed: ${agent}'`,
      );
      // ...and then RESOLVED, with a die on absence. An install that exits 0 while leaving
      // nothing on disk is the unbacked boolean this whole item exists to remove.
      expect(script).toContain(
        `[[ -n "$AGENT_RUNTIME_${agent.toUpperCase()}" ]] || die 'agent runtime did not resolve after install: ${agent}'`,
      );
    }
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  /**
   * THE REGRESSION THIS FILE MOST NEEDS. `$RELEASE_DIR/bin` holds the psu WRAPPERS named
   * `claude`/`codex`/`omp`. If it were on the resolve PATH, `command -v claude` would find a
   * wrapper and report success on a host with no vendor runtime at all — which is exactly the
   * confusion that made D-247 read as a probe bug for three sessions.
   */
  it('resolves against dirs the installers write to, never the release bin holding the psu wrappers', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const pathLine = script
      .split('\n')
      .find((line) => line.startsWith('AGENT_RUNTIME_PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('$AGENT_HOME/.local/bin');
    expect(pathLine).toContain('$AGENT_HOME/.papercusp/runtime/node_modules/.bin');
    expect(pathLine).not.toContain('RELEASE_DIR');
    expect(pathLine).not.toContain('RUNTIME_ROOT');
  });

  /**
   * D-263. The codex install argv is the DESKTOP onboarding script and it shells `npm`, which this
   * host has nowhere: not in the apt contract, and not in the bundle (a bare `node`, no npm). That
   * killed bootstrap before the initialize entrypoint was installed, surfacing as every canary
   * failing `0/6` with `exit 127 ... papercusp-workspace-host-initialize: No such file or directory`
   * — an error naming the wrong artifact entirely. These assertions pin the repair.
   */
  it('installs a pinned Node into the agent home BEFORE any vendor install that needs npm', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    // Runs as the AGENT identity, in the agent's own home — not as root, and not into the
    // root-owned release tree the agent only holds rX on.
    expect(script).toContain(
      `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" /bin/bash -c '`,
    );
    expect(script).toContain(
      `|| die 'agent Node runtime install failed (v${WORKSPACE_HOST_AGENT_NODE_VERSION})'`,
    );
    // ORDERING IS THE WHOLE POINT: npm has to exist before codex's installer runs, so a node
    // install emitted after the loop would reproduce the original failure exactly.
    const nodeAt = script.indexOf('installing agent Node runtime');
    const codexAt = script.indexOf("'echo install-codex'");
    expect(nodeAt).toBeGreaterThan(-1);
    expect(codexAt).toBeGreaterThan(-1);
    expect(nodeAt).toBeLessThan(codexAt);
  });

  it('pins the Node tarball by version AND checksum, and verifies npm survived the extract', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain(
      `https://nodejs.org/dist/v${WORKSPACE_HOST_AGENT_NODE_VERSION}/$dir.tar.gz`,
    );
    // The digest is the trust boundary — a swapped upstream tarball must fail rather than execute.
    expect(script).toContain(WORKSPACE_HOST_AGENT_NODE_SHA256.x64);
    expect(script).toContain(WORKSPACE_HOST_AGENT_NODE_SHA256.arm64);
    expect(script).toContain('sha256sum -c -');
    // .tar.gz, never .tar.xz: the apt contract deliberately ships no xz-utils.
    expect(script).not.toContain('.tar.xz');
    expect(WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES).not.toContain('xz-utils');
    // npm is a symlink into lib/, so asserting only `node` would pass on an extract that leaves
    // npm dangling — the failure would then land inside the codex install and read as codex's bug.
    expect(script).toContain('"$target/bin/npm" --version >/dev/null');
  });

  /**
   * D-266. OMP is credential-free by contract (D-245), and the OTHER half of that contract is
   * that it proves readiness by LOCAL INFERENCE. Nothing implemented that half, so `omp` could
   * never pass and canary-09 stopped at 5/6 with a failure that read as a credential fault.
   */
  it('installs the pinned local-inference runtime and the exact model the OMP probe requests', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    // The pin is the trust boundary for a ROOT install, exactly as the Node runtime pin is.
    expect(script).toContain(WORKSPACE_HOST_OLLAMA_SHA256.x64);
    expect(script).toContain(WORKSPACE_HOST_OLLAMA_SHA256.arm64);
    expect(script).toContain(
      '|| die "local-inference runtime digest mismatch"',
    );
    // The GPU bundles are 2.0G of a 2.1G install and are dead weight on a CPU-only host.
    expect(script).toContain('--exclude="lib/ollama/cuda_v*"');
    expect(script).toContain('--exclude="lib/ollama/vulkan"');
    // THE MODEL IS ONE FACT, NOT TWO. The installer pulls whatever the probe asks for, so this
    // asserts the shared constant reaches the script rather than re-typing the tag — a second
    // copy is what silently leaves a host pulling one model and failing a probe wanting another.
    expect(script).toContain(`ollama pull '${WORKSPACE_HOST_OMP_LOCAL_MODEL}'`);
    expect(script).toContain(
      `ollama show '${WORKSPACE_HOST_OMP_LOCAL_MODEL}'`,
    );
  });

  /**
   * MEASURED on canary-11 (2026-09-03): a GCE startup-script runs as root with NO $HOME, and the
   * ollama CLI panics in `envconfig.Models()` (config.go:120) from `NewCLI()` — BEFORE any
   * subcommand runs — when it is unset:
   *
   *     panic: $HOME is not defined
   *
   * That is a whole class, not one call: it took down `ollama pull` (canary-10's undiagnosable
   * 26ms failure) and it silently defeated the version guard too, because `ollama --version`
   * panicked to empty stdout so the comparison never matched and the runtime was re-downloaded
   * on every boot. So the guard is "every CLI invocation carries HOME", enumerated from the
   * rendered script rather than spot-checked — a NEW ollama CLI call added without HOME fails
   * here instead of on a host. The SERVER is deliberately exempt: systemd derives HOME from
   * `User=`, which is why this is a CLI-only fix and not a global export.
   */
  it('gives every ollama CLI invocation a HOME, since a startup-script has none', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain('OLLAMA_CLI_HOME="${HOME:-/root}"');

    const cliInvocations = script
      .split('\n')
      .filter(
        (line) =>
          // RUNNING the binary with a subcommand — not `[[ -x /usr/local/bin/ollama ]]`, which
          // is a file test that starts no process and therefore needs no environment.
          /\/usr\/local\/bin\/ollama\s+(--version|pull|show)\b/.test(line) &&
          // The systemd unit's own ExecStart is the server, not the CLI.
          !line.includes('ExecStart='),
      );
    // A calibration case: if this ever selects nothing, the assertion below would pass
    // vacuously and report a fixed script as safe.
    expect(cliInvocations.length).toBeGreaterThanOrEqual(3);
    for (const line of cliInvocations) {
      expect(line).toContain('HOME="$OLLAMA_CLI_HOME"');
    }

    // HOME must be defined before the first invocation that relies on it.
    expect(script.indexOf('OLLAMA_CLI_HOME="${HOME:-/root}"')).toBeLessThan(
      script.indexOf('HOME="$OLLAMA_CLI_HOME"'),
    );
  });

  /**
   * D-264's rule, applied one service later: when a phase MUTATES a service, nothing after it may
   * assume that service's runtime state. `systemctl enable --now` returns once systemd has forked
   * the unit, not once its HTTP API accepts connections — and the pull talks to that API.
   */
  it('waits for the local-inference API to answer before pulling, and binds it to loopback', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const readyAt = script.indexOf('OLLAMA_READY=1');
    const pullAt = script.indexOf('ollama pull');
    expect(readyAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(readyAt);
    expect(script).toContain(
      '|| die "local-inference runtime did not become ready within 60s"',
    );
    // An inference endpoint on a routable address is an unauthenticated model server exposed to
    // the network. The probe reaches it over loopback and nothing else may.
    expect(script).toContain('Environment=OLLAMA_HOST=127.0.0.1:11434');
  });

  it('stages no local-inference runtime on a host that does not install OMP', () => {
    const script = buildWorkspaceHostBootstrap(
      input({
        agentRuntimeInstalls: AGENT_RUNTIME_INSTALLS.filter(
          (install) => install.agent !== 'omp',
        ).map((install) => ({ ...install, args: [...install.args] })),
      }),
    );
    // ~450 MiB of runtime plus model is not worth staging on a host with nothing to prove by it.
    expect(script).not.toContain('ollama');
  });

  /**
   * The repair must not buy npm by putting the release's `bin/` on the resolve PATH — that
   * directory holds the psu wrappers, and this is the D-247 hole the sibling test above guards.
   */
  it('obtains node without widening the resolve surface onto the release wrappers', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    const pathLine = script
      .split('\n')
      .find((line) => line.startsWith('AGENT_RUNTIME_PATH='));
    // The install lands in $AGENT_HOME/.local, which the PATH ALREADY carried — so the fix adds
    // no entry at all, and the wrapper directory stays excluded.
    expect(pathLine).toContain('$AGENT_HOME/.local/bin');
    expect(pathLine).not.toContain('RELEASE_DIR');
    expect(pathLine).not.toContain('RUNTIME_ROOT');
    expect(script).toContain('target="$HOME/.local"');
  });

  it('fetches no Node when no agent runtimes are configured', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).not.toContain('nodejs.org');
    expect(script).not.toContain('installing agent Node runtime');
  });

  /**
   * INSTALLED is strictly narrower than VERIFIED. The bootstrap can prove the runtime is present
   * and executable; it cannot prove it is authenticated. D-252's validator refuses the optimistic
   * lie, and that refusal must survive this feature.
   */
  it('never upgrades the installed claim into the authenticated one', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain('agentRuntimesVerifiedByBootstrap:false');
    expect(script).toContain('agentRuntimesInstalledByBootstrap:true');
    expect(script).not.toContain('agentRuntimesVerifiedByBootstrap:true');
    expect(
      validateWorkspaceHostBootstrapAttestation(
        attestation({
          runtime: {
            nodeMajor: 22,
            minimumNodeMajor: 22,
            psu: true,
            pui: true,
            agentLaunchers: { claude: true, codex: true, omp: true },
            // the lie D-252 exists to refuse, now alongside a true installed flag
            agentRuntimesVerifiedByBootstrap: true as unknown as false,
            agentRuntimesInstalledByBootstrap: true,
          },
        }),
        input(),
      ).ok,
    ).toBe(false);
  });

  it('records each resolved runtime path so the probe can exec the vendor bin, not the wrapper', () => {
    const script = buildWorkspaceHostBootstrap(
      input({ agentRuntimeInstalls: [...AGENT_RUNTIME_INSTALLS] }),
    );
    expect(script).toContain(
      'agentRuntimes:{claude:$agentRuntimeClaude,codex:$agentRuntimeCodex,omp:$agentRuntimeOmp}',
    );
    expect(script).toContain('--arg agentRuntimeClaude "$AGENT_RUNTIME_CLAUDE"');
  });

  it('refuses a duplicate or malformed install at render time, not on a host', () => {
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          agentRuntimeInstalls: [
            { agent: 'claude', command: 'bash', args: [] },
            { agent: 'claude', command: 'bash', args: [] },
          ],
        }),
      ),
    ).toThrow(/duplicate entry for 'claude'/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          agentRuntimeInstalls: [{ agent: 'claude', command: '  ', args: [] }],
        }),
      ),
    ).toThrow(/command must be a non-empty string/);
  });
});

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
      `REMOTE_INITIALIZER_CONDUIT='${WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT}'`,
    );
    expect(first).toContain(
      `CREDENTIAL_DELIVERY_CONDUIT='${WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT}'`,
    );
    expect(first).toContain(
      `PRIVILEGED_CONDUIT_SUDOERS='${WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS}'`,
    );
    expect(first).toContain("initializer conduit: refused argv");
    expect(first).toContain("credential delivery conduit: refused argv");
    expect(first).toContain("Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_INITIALIZER");
    expect(first).toContain("Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_DELIVERY");
    expect(first).toContain('visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS"');
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
    expect(first).not.toMatch(/usermod .*sudo/);
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
  it('runs the agents as a THIRD identity, so the runtime is readable by whoever executes it and never by the SSH login (D-043, D-246, D-248)', () => {
    const script = buildWorkspaceHostBootstrap(input());

    // The defect D-246 measured: the account that receives Claude/Codex/OMP credentials could not
    // traverse /opt/papercusp, so all three probes died with `env: 'claude': Permission denied`
    // (exit 126) six steps into a live canary. The grant is a named-user ACL on the runtime root
    // AND across the extracted release — the agent CLIs are wrappers that re-exec the bundled
    // node and read scripts/psu.mjs, so the entrypoints alone are not enough.
    //
    // The identity D-248 corrects: it is $AGENT_USER, not $WORKSPACE_USER. Both halves are
    // asserted here BECAUSE EITHER ONE ALONE IS SATISFIABLE BY A BROKEN HOST — a host with only
    // the grant is D-246's violation of the D-043 owner ruling, and a host with only the ban has
    // no runnable agents. That is exactly how the first fix passed every test it ran.
    expect(script).toContain(
      'setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"',
    );
    expect(script).toContain('setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"');
    expect(script).not.toContain('setfacl -m "u:$WORKSPACE_USER:r-x" "$RUNTIME_ROOT"');
    expect(script).not.toContain('setfacl -R -m "u:$WORKSPACE_USER:rX" "$RELEASE_DIR"');

    // Ordering guard. NOT because the current sequence would otherwise break: measured over this
    // exact chmod set, the resulting mask is `r-x` either way, since `g-w`/`g+rx`/`g+r` are all
    // additive. It is pinned because chmod's group bits address the ACL MASK once an ACL exists,
    // so changing any of them to an assigning form (`chmod g=r`) with the ACL applied first would
    // clamp execute away — a failure invisible until an agent CLI refuses to run on a real host.
    expect(script.indexOf('find "$RELEASE_DIR" -type f -exec chmod g+r {} +')).toBeLessThan(
      script.indexOf('setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"'),
    );

    // The recurrence guard for D-246: prove executability at bootstrap time, which is where this
    // should have failed instead of inside a live canary — now as the agent identity.
    expect(script).toContain(
      '  runuser -u "$AGENT_USER" -- test -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "agent identity cannot execute agent entrypoint: $agent_entrypoint"',
    );

    // The recurrence guard for D-248: the assertion D-246 deleted is back. This is the mechanical
    // enforcement of the D-043 sentence, and deleting it is how a widened grant ships unnoticed.
    expect(script).toContain(
      'runuser -u "$WORKSPACE_USER" -- test ! -r "$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT" || die "workspace SSH user can read the Papercusp runtime"',
    );
    expect(script).toContain(
      '  runuser -u "$WORKSPACE_USER" -- test ! -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "workspace SSH user can execute agent entrypoint: $agent_entrypoint"',
    );

    // The credential half. On a BYOC host the SSH account is the CUSTOMER's access path, and
    // before D-248 it OWNED the delivered agent credentials at 0600 in its own home.
    expect(script).toContain(
      'install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"',
    );
    expect(script).toContain(
      'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "workspace SSH user can read the agent credential home"',
    );

    // The agent identity is confined in every direction the SSH account is, and is non-login.
    expect(script).toContain('die "agent identity can write the Papercusp runtime"');
    expect(script).toContain('die "agent identity can read the runtime state root"');
    expect(script).toContain('die "agent identity belongs to the runtime service group"');
    expect(script).toContain('die "agent identity belongs to sudo"');
    expect(script).toContain('die "agent identity has a login shell"');
    expect(script).toContain(
      'usermod --lock --gid "$AGENT_GROUP" --groups "" --home "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"',
    );

    // Confinement of the SSH account is unchanged.
    expect(script).toContain('die "workspace SSH user can write the Papercusp runtime"');
    expect(script).toContain('die "workspace SSH user can read the runtime state root"');
    expect(script).toContain('die "runtime release tree must not be world-readable"');
    expect(script).toContain(
      'die "workspace SSH user belongs to the runtime service group"',
    );
    expect(script).toContain('die "workspace SSH user belongs to the agent group"');
    expect(script).toContain('die "workspace SSH user belongs to sudo"');
    expect(script).toContain('usermod --lock --gid "$WORKSPACE_GROUP" --groups ""');

    // All three identities write the scoped workspace root — otherwise the customer cannot edit
    // over SSH what the agent wrote, which is the product.
    expect(script).toContain(
      'setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    );
    expect(script).toContain('die "agent identity cannot write the scoped workspace root"');
    expect(script).toContain('die "workspace SSH user cannot write the scoped workspace root"');
  });

  it('attests agent LAUNCHERS, never agent RUNTIMES, and refuses the optimistic claim (D-252)', () => {
    const script = buildWorkspaceHostBootstrap(input());

    // What bootstrap can prove is `test -x` on three 539-byte psu launcher wrappers. It ships no
    // vendor CLI and nothing installs one, so the old flat `claude:true,codex:true,omp:true` —
    // read by every caller as "this host can run Claude" — was measuring a file permission while
    // naming a product property. Same defect class as the pre-D-251 read boolean.
    expect(script).toContain(
      'agentLaunchers:{claude:true,codex:true,omp:true},agentRuntimesVerifiedByBootstrap:false',
    );
    expect(script).not.toContain('pui:true,claude:true,codex:true,omp:true');

    // The validator must refuse the OPTIMISTIC direction specifically. A host asserting that
    // bootstrap verified its agent runtimes is running pre-D-252 code or was hand-edited; either
    // way nothing could have established the claim, since bootstrap has no such probe.
    const overclaiming = validateWorkspaceHostBootstrapAttestation(
      attestation({
        runtime: {
          ...attestation().runtime,
          agentRuntimesVerifiedByBootstrap: true as false,
        },
      }),
      input(),
    );
    expect(overclaiming.ok).toBe(false);
    expect(overclaiming.errors).toContain(
      'attestation claims bootstrap verified the agent runtimes; bootstrap cannot establish that (D-252)',
    );

    // A missing launcher is still a refusal — narrowing the CLAIM must not weaken the CHECK.
    const missingLauncher = validateWorkspaceHostBootstrapAttestation(
      attestation({
        runtime: {
          ...attestation().runtime,
          agentLaunchers: { ...attestation().runtime.agentLaunchers, codex: false as true },
        },
      }),
      input(),
    );
    expect(missingLauncher.ok).toBe(false);
    expect(missingLauncher.errors).toContain('agent launcher prerequisite check failed');

    expect(validateWorkspaceHostBootstrapAttestation(attestation(), input()).ok).toBe(true);
  });

  it('refuses to collapse the agent identity onto either existing account (D-248)', () => {
    // Each collapse is individually plausible and individually catastrophic: onto the SSH login
    // it re-grants the customer runtime read (D-043) and hands them the platform's agent
    // credentials; onto the service account it gives the agent runtime $STATE_ROOT, which holds
    // embedded PG and every delivered credential. Neither is caught downstream — every later
    // check passes on both shapes — so the refusal has to be here.
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { agentUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER } }),
      ),
    ).toThrow(/agent identity must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({ isolation: { agentUser: DEFAULT_WORKSPACE_HOST_SERVICE_USER } }),
      ),
    ).toThrow(/agent identity must differ/);
    expect(() =>
      buildWorkspaceHostBootstrap(
        input({
          isolation: {
            agentUser: 'pc-agent',
            agentGroup: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
          },
        }),
      ),
    ).toThrow(/agent group must differ/);
  });

  it('attests the runtime as agent-readable and NEVER workspace-readable (D-043, D-248)', () => {
    const script = buildWorkspaceHostBootstrap(input());
    expect(script).toContain(
      'runtimeReadableByWorkspaceUser:false,runtimeWritableByWorkspaceUser:false,runtimeReadableByAgentUser:true,runtimeWritableByAgentUser:false,agentHomeReadableBySshUser:false',
    );

    // Three separate refusals, because the three failure shapes are different hosts. The
    // validator is what a caller who never saw the host runs, so each has to be legible there.
    const readable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeReadableByWorkspaceUser: true as false,
        },
      }),
      input(),
    );
    expect(readable.ok).toBe(false);
    expect(readable.errors).toContain(
      'workspace SSH user can read the Papercusp runtime (D-043)',
    );

    const unrunnable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeReadableByAgentUser: false as true,
        },
      }),
      input(),
    );
    expect(unrunnable.ok).toBe(false);
    expect(unrunnable.errors).toContain(
      'agent identity cannot read the runtime it must execute agents from',
    );

    const exposed = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          agentHomeReadableBySshUser: true as false,
        },
      }),
      input(),
    );
    expect(exposed.ok).toBe(false);
    expect(exposed.errors).toContain(
      'workspace SSH user can read the delivered agent credential home',
    );

    const writable = validateWorkspaceHostBootstrapAttestation(
      attestation({
        isolation: {
          ...attestation().isolation,
          runtimeWritableByAgentUser: true as false,
        },
      }),
      input(),
    );
    expect(writable.ok).toBe(false);
    expect(writable.errors).toContain('an unprivileged identity can write the runtime');

    // A correctly-attesting host must not trip any of them.
    expect(
      validateWorkspaceHostBootstrapAttestation(attestation(), input()).errors,
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /read the Papercusp runtime|must execute agents from|credential home|can write the runtime/,
        ),
      ]),
    );
  });

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

  it("grants only the two fixed protocol argv through root-owned conduits", () => {
    const script = buildWorkspaceHostBootstrap(input());
    const conduit = script.slice(
      script.indexOf(
        'install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"',
      ),
      script.indexOf('cat > "/etc/systemd/system/$SERVICE_NAME.service"'),
    );

    expect(conduit).toContain(
      "papercusp-remote-initializer --protocol-version papercusp-gcp-iap-initialization-v2 --json-stdin",
    );
    expect(conduit).toContain(
      "papercusp-deliver-material --protocol-version papercusp-workspace-host-credential-delivery-v1 --json-stdin",
    );
    expect(conduit.match(/NOPASSWD:/g)).toHaveLength(1);
    expect(conduit).not.toMatch(
      /ALL=\(ALL|NOPASSWD:\s*ALL|\*|\beval\b|\bsh -c\b/,
    );
    expect(conduit).toContain(
      "Defaults!PAPERCUSP_WORKSPACE_HOST_INITIALIZER env_reset, !setenv",
    );
    expect(conduit).toContain(
      "Defaults!PAPERCUSP_WORKSPACE_HOST_DELIVERY env_reset, !setenv",
    );
  });

  it("dispatches both privileged conduits through the bundled interpreter, in the wrapper and the sudoers allowlist alike", () => {
    // REGRESSION (p046-canary-03, 2026-09-02). Both targets are `#!/usr/bin/env node` scripts and
    // the sudoers entries pin `env_reset, !setenv`, so the shebang resolves `node` against sudo's
    // secure_path — which never contains the bundle's own runtime. Every privileged invocation
    // therefore died with `/usr/bin/env: 'node': No such file or directory` (exit 127) before
    // reading its request, while file ownership, mode and `visudo -cf` all reported green.
    //
    // The sibling case above could not catch it: it asserts the SUBSTRING
    // "papercusp-remote-initializer --protocol-version …", which stays true no matter what does
    // (or does not) precede the script. So this pins the whole command VECTOR — interpreter, then
    // script, then argv — which is what sudo actually matches and what execve actually needs.
    const script = buildWorkspaceHostBootstrap(input());
    const node = `${WORKSPACE_HOST_RUNTIME_ROOT}/current/${DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.node}`;

    for (const [target, argv] of [
      [
        DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.remoteInitializer,
        WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV,
      ],
      [
        DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.credentialDelivery,
        WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV,
      ],
    ] as const) {
      const program = `${WORKSPACE_HOST_RUNTIME_ROOT}/current/${target}`;
      // The wrapper's exec line: sudo, then interpreter, then script — never the script alone.
      expect(script).toContain(
        `exec /usr/bin/sudo -n -- '${node}' '${program}' "$@"`,
      );
      // The allowlist repeats that same vector; a mismatch here refuses the invocation above.
      expect(script).toContain(`${node} ${program} ${argv.join(" ")}`);
      expect(script).not.toContain(`exec /usr/bin/sudo -n -- '${program}'`);
    }

    // And the stage verifies at run time what static emission cannot: that the pinned interpreter
    // is really present and executable on the host being bootstrapped.
    expect(script).toContain(
      'die "conduit interpreter is missing or not executable',
    );
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
  // D-238. harden-os sets `AuthenticationMethods publickey` + `AllowUsers $WORKSPACE_USER` and
  // locks the workspace account, so the authorized_keys this renders is the ONLY way back into
  // the host. Provider metadata cannot substitute: the GCP provider sets enable-oslogin=TRUE and
  // block-project-ssh-keys=TRUE, and the workspace account is a local user OS Login never answers
  // for. A render that omits it produced a host that bootstrapped, attested "healthy", and was
  // unreachable — measured on p046-canary-04.
  describe('workspace authorized keys (D-238)', () => {
    const KEY =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller';

    it('installs the authorized key for the workspace account, base64-encoded', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        `WORKSPACE_AUTHORIZED_KEYS_B64='${Buffer.from(`${KEY}\n`, 'utf8').toString('base64')}'`,
      );
      expect(script).toContain(
        'printf %s "$WORKSPACE_AUTHORIZED_KEYS_B64" | base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
      expect(script).toContain(
        'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER/.ssh"',
      );
      expect(script).toContain(
        'chmod 0600 "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
    });

    // The ordering IS the correctness property, not a style preference: writing the key after the
    // sshd reload leaves a window in which the host is hardened and not yet reachable.
    it('installs the key BEFORE sshd hardening takes effect', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const keyInstalled = script.indexOf(
        '/home/$WORKSPACE_USER/.ssh/authorized_keys',
      );
      const hardened = script.indexOf('AllowUsers $WORKSPACE_USER');
      const reloaded = script.indexOf('systemctl reload-or-restart ssh');
      expect(keyInstalled).toBeGreaterThan(-1);
      expect(keyInstalled).toBeLessThan(hardened);
      expect(hardened).toBeLessThan(reloaded);
    });

    // p046-canary-08: bootstrap aborted in phase:harden-os with
    //   Missing privilege separation directory: /run/sshd   (sshd -t, exit 255)
    // /run/sshd is ssh.service's systemd RuntimeDirectory, so systemd removes it whenever that
    // unit stops — which the apt step in this SAME phase causes whenever it upgrades
    // openssh-server. That made the step's success depend on whether the boot happened to pull an
    // openssh update: canary-07 passed, canary-08 failed six hours later on "3 upgraded".
    // Reproduced with a negative control (ubuntu:24.04 + openssh-server): with /run/sshd removed
    // `sshd -t` prints that exact line and exits 255; after `mkdir -p /run/sshd` it exits 0.
    it('creates the sshd privilege-separation directory BEFORE validating the config', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const privsep = script.indexOf('install -d -m 0755 -o root -g root /run/sshd');
      const validated = script.indexOf('sshd -t');
      expect(privsep).toBeGreaterThan(-1);
      expect(validated).toBeGreaterThan(-1);
      // Ordering is the whole property: created after the test would not prevent the abort.
      expect(privsep).toBeLessThan(validated);
    });

    // The line immediately after `sshd -t` had the same latent dependency: `systemctl reload` of
    // a STOPPED unit fails, and an openssh upgrade can leave ssh.service stopped. Under
    // `set -euo pipefail` that aborts the bootstrap one line past the trap fixed above.
    it('applies the hardened config with reload-or-restart, so a stopped ssh.service is not fatal', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'systemctl reload-or-restart ssh 2>/dev/null || systemctl reload-or-restart sshd',
      );
      // A bare `systemctl reload ssh` is precisely what regresses this.
      expect(script).not.toMatch(/systemctl reload ssh\b/);
    });

    it('fails the bootstrap rather than leaving an empty authorized_keys', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die',
      );
    });

    it('refuses to render a host nobody can reach', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(input({ workspaceAuthorizedKeys: [] })),
      ).toThrow(/at least one OpenSSH public key/);
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({
            workspaceAuthorizedKeys: undefined as unknown as readonly string[],
          }),
        ),
      ).toThrow(/at least one OpenSSH public key/);
    });

    it('refuses malformed keys and authorized_keys option prefixes', () => {
      for (const bad of [
        'not-a-key',
        'ssh-ed25519',
        `command="/bin/false" ${KEY}`,
        `${KEY}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma smuggled`,
      ]) {
        expect(() =>
          buildWorkspaceHostBootstrap(
            input({ workspaceAuthorizedKeys: [bad] }),
          ),
        ).toThrow(/plain OpenSSH public key line/);
      }
    });

    it('round-trips a comment containing shell metacharacters byte-for-byte', () => {
      const awkward = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma it's "me" $(whoami)`;
      const script = buildWorkspaceHostBootstrap(
        input({ workspaceAuthorizedKeys: [awkward] }),
      );
      const encoded = /WORKSPACE_AUTHORIZED_KEYS_B64='([^']+)'/.exec(script);
      expect(encoded).not.toBeNull();
      expect(
        Buffer.from(encoded![1], 'base64').toString('utf8'),
      ).toBe(`${awkward}\n`);
    });

    it('authorizes several distinct keys, one per line', () => {
      const second =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq second';
      const script = buildWorkspaceHostBootstrap(
        input({ workspaceAuthorizedKeys: [KEY, second] }),
      );
      const encoded = /WORKSPACE_AUTHORIZED_KEYS_B64='([^']+)'/.exec(script);
      expect(Buffer.from(encoded![1], 'base64').toString('utf8')).toBe(
        `${KEY}\n${second}\n`,
      );
    });

    // Refused, not silently deduped: a repeated key means the caller assembled the list wrong,
    // and quietly accepting it hides that from whoever has to debug access later.
    it('refuses a repeated key', () => {
      expect(() =>
        buildWorkspaceHostBootstrap(
          input({ workspaceAuthorizedKeys: [KEY, KEY] }),
        ),
      ).toThrow(/must not repeat a key/);
    });
  });

  // EI-22185970114422986 — the CLASS the lockout belonged to: a step that reports success on a
  // property it never observed. `checks` is serialized into the attestation by the RENDERER as
  // `{ name, ok: true }` for every name, and `validateWorkspaceHostBootstrapAttestation` then
  // requires exactly that — so the array could not report a failure of anything. The design
  // (every name has a `die` guard upstream, so reaching attest-health is the proof) is sound and
  // is kept; what was missing is anything BINDING a name to its guard.
  describe('attested checks are bound to a host-side observation (EI-22185970114422986)', () => {
    it('renders the observation that establishes every attested check', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const attestingOnNothing = WORKSPACE_HOST_BOOTSTRAP_CHECKS.filter(
        (name) => !script.includes(WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE[name]),
      );
      // Named, never counted: the failure has to say WHICH check is attesting on nothing.
      expect(attestingOnNothing).toEqual([]);
    });

    it('declares evidence for every attested name and for no name that is not attested', () => {
      expect(
        Object.keys(WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE).sort(),
      ).toEqual([...WORKSPACE_HOST_BOOTSTRAP_CHECKS].sort());
    });

    // A guard that has never failed is a guard nobody has tested. The map is only worth its line
    // count if an unrendered fragment is actually REPORTED, so prove that here rather than
    // trusting it — with a fabricated copy, so nothing in the tree is mutated to run the control.
    it('is falsifiable: a check whose observation is not rendered is reported by name', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const fabricated: Record<string, string> = {
        ...WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE,
        'ssh-forwarding-policy': 'die "no bootstrap has ever emitted this line"',
      };
      const attestingOnNothing = WORKSPACE_HOST_BOOTSTRAP_CHECKS.filter(
        (name) => !script.includes(fabricated[name]),
      );
      expect(attestingOnNothing).toEqual(['ssh-forwarding-policy']);
    });
  });

  // The second half of the same item: the property the ORIGINAL host died of was not among the
  // attested checks at all, and its only guard fired five phases before `healthy` was claimed.
  describe('attest-time SSH reachability observation (EI-22185970114422986)', () => {
    it('re-observes authorized_keys where healthy is CLAIMED, not only in harden-os', () => {
      const script = buildWorkspaceHostBootstrap(input());
      const hardenGuard = script.indexOf(
        'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die',
      );
      const attestGuard = script.indexOf(
        '[[ -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" ]] || die "workspace authorized_keys is unreadable or empty at attest time',
      );
      const attestationWritten = script.indexOf('ATTESTATION_PATH=');
      expect(hardenGuard).toBeGreaterThan(-1);
      // Ordering IS the property: an observation after the attestation cannot inform it, and one
      // that only runs in harden-os cannot speak for the host minutes later.
      expect(attestGuard).toBeGreaterThan(hardenGuard);
      expect(attestGuard).toBeLessThan(attestationWritten);
    });

    it('asserts sshd will actually read the key file this bootstrap wrote', () => {
      const script = buildWorkspaceHostBootstrap(input());
      expect(script).toContain(
        'stat -c "%U %a" "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
      );
      expect(script).toContain(
        'grep -Fx "pubkeyauthentication yes" <<<"$SSHD_POLICY"',
      );
      expect(script).toContain(
        'grep -Eq "^authorizedkeysfile .*\\.ssh/authorized_keys" <<<"$SSHD_POLICY"',
      );
    });

    it('names the check so the attestation is not silent about reachability', () => {
      expect(WORKSPACE_HOST_BOOTSTRAP_CHECKS).toContain(
        'workspace-ssh-authorized-keys',
      );
      // The validator iterates the same list, so an attestation that omits the new check is
      // refused rather than accepted as healthy.
      const verdict = validateWorkspaceHostBootstrapAttestation(
        attestation({
          checks: WORKSPACE_HOST_BOOTSTRAP_CHECKS.filter(
            (name) => name !== 'workspace-ssh-authorized-keys',
          ).map((name) => ({ name, ok: true })),
        }),
        input(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toContain(
        "required bootstrap check 'workspace-ssh-authorized-keys' did not pass",
      );
    });
  });

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
        // Post-D-248 there are TWO violating read shapes and they point opposite ways: the SSH
        // login reading the runtime is D-043's violation, and the agent identity NOT reading it
        // is a host with no runnable agents. Drift both at once so the validator has to name
        // them separately rather than collapsing to one message.
        runtimeReadableByWorkspaceUser: true as false,
        runtimeReadableByAgentUser: false as true,
        runtimeWritableByAgentUser: true as false,
        agentHomeReadableBySshUser: true as false,
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
        'workspace SSH user can read the Papercusp runtime (D-043)',
        'agent identity cannot read the runtime it must execute agents from',
        'workspace SSH user can read the delivered agent credential home',
        'an unprivileged identity can write the runtime',
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
