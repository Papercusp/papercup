import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  WORKSPACE_HOST_PUI_COMPANION_PATH,
  WORKSPACE_HOST_PUI_ENTRYPOINT,
  WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
  workspaceHostReleaseAddressingErrors,
} from './workspace-host-build-manifest';
import { WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV } from "./workspace-host-credential-delivery";
import { WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV } from "./workspace-host-remote-initializer";
import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';

/**
 * Provider-neutral bootstrap contract for a durable Papercusp workspace host.
 *
 * The cloud adapter supplies a signed public Server bundle and runs the emitted
 * script as root on stock Ubuntu 24.04. Credentials are deliberately absent:
 * cloud, Git, and agent credentials arrive later through their typed runtime
 * channels and are never rendered into a VM image, startup script, or
 * attestation.
 */
export const WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION =
  'papercusp-workspace-host-bootstrap-v2';
export const WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION = '24.04';
export const WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX =
  'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=';
export const DEFAULT_WORKSPACE_HOST_SERVICE_USER = 'papercusp';
export const DEFAULT_WORKSPACE_HOST_WORKSPACE_USER = 'papercusp-workspace';
/**
 * The THIRD identity (D-248). Runs the bundled agent CLIs: reads the signed runtime, owns the
 * delivered agent credential homes, writes the scoped workspace root — and is NOT the SSH
 * account, which is what lets D-043's "keep runtime files non-readable to the workspace user"
 * hold exactly as written while the agents remain runnable.
 */
export const DEFAULT_WORKSPACE_HOST_AGENT_USER = 'papercusp-agent';
export const WORKSPACE_HOST_RUNTIME_ROOT = '/opt/papercusp';
export const WORKSPACE_HOST_STATE_ROOT = '/var/lib/papercusp';
export const WORKSPACE_HOST_DATA_ROOT = '/srv/papercusp/workspaces';
export const WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT =
  "/usr/local/bin/papercusp-workspace-host-initialize";
export const WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT =
  "/usr/local/bin/papercusp-workspace-host-deliver-credential";
export const WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS =
  "/etc/sudoers.d/papercusp-workspace-host-conduits";

/**
 * Shared libraries supplied by Ubuntu 24.04's glibc runtime.
 *
 * These are deliberately an explicit, small baseline rather than an
 * "ignore anything that looks system-provided" heuristic. A new SONAME must
 * either be shipped inside the signed bundle or acquire an explicit apt
 * provider below, otherwise publication fails closed.
 */
export const WORKSPACE_HOST_GLIBC_SONAMES = [
  'ld-linux-aarch64.so.1',
  'ld-linux-x86-64.so.2',
  'libc.so.6',
  'libdl.so.2',
  'libm.so.6',
  'libpthread.so.0',
  'librt.so.1',
  'libutil.so.1',
  'libresolv.so.2',
] as const;

/**
 * SONAME providers for external native-addon dependencies on Ubuntu 24.04.
 *
 * This is the one contract shared by the publication-time readelf check and
 * the generated host bootstrap. Keeping the provider map beside the apt
 * package list prevents a release guard from passing against a package that
 * the clean-room image never installs.
 */
export const WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE = {
  'libasound.so.2': 'libasound2t64',
  'libatomic.so.1': 'libatomic1',
  'libgcc_s.so.1': 'libgcc-s1',
  'liblz4.so.1': 'liblz4-1',
  'libssl.so.3': 'libssl3',
  'libstdc++.so.6': 'libstdc++6',
  'libz.so.1': 'zlib1g',
  'libzstd.so.1': 'libzstd1',
} as const;
export type WorkspaceHostNativeSoname =
  keyof typeof WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE;

/** Host packages unrelated to native addon loading. */
export const WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES = [
  "acl",
  "ca-certificates",
  "curl",
  "jq",
  "minisign",
  "openssh-server",
  "sudo",
  "ufw",
  "unattended-upgrades",
] as const;

/** Packages required by the external SONAME providers above. */
export const WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES = [
  'libasound2t64',
  'libatomic1',
  'libgcc-s1',
  'liblz4-1',
  'libssl3',
  'libstdc++6',
  'libzstd1',
  'zlib1g',
] as const;

/**
 * Complete apt contract for the generated Ubuntu 24.04 bootstrap.
 *
 * Publication checks should compare their derived provider set against this
 * exact list; the bootstrap below renders this same value.
 */
export const WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES = [
  ...WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES,
  ...WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES,
] as const;
export type WorkspaceHostBootstrapAptPackage =
  (typeof WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES)[number];

export interface WorkspaceHostNativeDependencyProvider {
  soname: string;
  aptPackage: string;
}

export interface WorkspaceHostNativeDependencyCoverageInput {
  /** The union of NEEDED SONAMEs read from every bundled `*.node`. */
  neededSonames: Iterable<string>;
  /** SONAMEs whose shared objects are shipped inside the release bundle. */
  bundleInternalSonames?: Iterable<string>;
  /** Defaults to WORKSPACE_HOST_GLIBC_SONAMES; override only for another image ABI. */
  glibcSonames?: Iterable<string>;
  /** Defaults to WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES. */
  aptPackages?: Iterable<string>;
}

export interface WorkspaceHostNativeDependencyCoverage {
  ok: boolean;
  neededSonames: readonly string[];
  bundleInternalSonames: readonly string[];
  glibcSonames: readonly string[];
  /** NEEDED SONAMEs not satisfied by the bundle or glibc baseline. */
  externalSonames: readonly string[];
  /** External SONAMEs without an explicit provider mapping. */
  unknownSonames: readonly string[];
  /** Unique apt packages required by mapped external SONAMEs. */
  requiredAptPackages: readonly string[];
  /** Required provider packages absent from the supplied apt contract. */
  missingAptPackages: readonly string[];
  providers: readonly WorkspaceHostNativeDependencyProvider[];
}

function normalizedSonames(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => normalizeWorkspaceHostSoname(value))
        .filter((value) => value.length > 0),
    ),
  ].sort();
}

function normalizedAptPackages(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort();
}

/**
 * Normalize a SONAME copied from readelf or a hand-built test fixture.
 *
 * `readelf -d` emits `Shared library: [libfoo.so.1]`; accepting the bracketed
 * form here keeps the parser and the evaluator on the same canonical keys.
 */
export function normalizeWorkspaceHostSoname(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]+)\]$/.exec(trimmed);
  return (bracketed?.[1] ?? trimmed).trim();
}

/**
 * Parse the NEEDED entries emitted by `readelf -d`.
 *
 * Other dynamic-section entries are intentionally ignored. Returning a sorted
 * union makes publication manifests reproducible even when archive traversal
 * order changes.
 */
export function parseWorkspaceHostReadelfNeeded(
  readelfOutput: string,
): readonly string[] {
  const matches = readelfOutput.matchAll(
    /Shared library:\s*\[([^\]]+)\]/g,
  );
  return normalizedSonames([...matches].map((match) => match[1] ?? ''));
}

/**
 * Evaluate whether a bundle's native-addon NEEDED union is covered.
 *
 * The evaluator is deliberately pure so publication can run it over the
 * archive's measured bytes, while bootstrap generation can consume the same
 * apt contract without importing a shell/process adapter.
 */
export function evaluateWorkspaceHostNativeDependencyCoverage(
  input: WorkspaceHostNativeDependencyCoverageInput,
): WorkspaceHostNativeDependencyCoverage {
  const neededSonames = normalizedSonames(input.neededSonames);
  const bundleInternalSonames = normalizedSonames(
    input.bundleInternalSonames ?? [],
  );
  const glibcSonames = normalizedSonames(
    input.glibcSonames ?? WORKSPACE_HOST_GLIBC_SONAMES,
  );
  const ignored = new Set([...bundleInternalSonames, ...glibcSonames]);
  const externalSonames = neededSonames.filter(
    (soname) => !ignored.has(soname),
  );
  const providers = externalSonames.flatMap((soname) => {
    const aptPackage =
      WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE[
        soname as WorkspaceHostNativeSoname
      ];
    return aptPackage ? [{ soname, aptPackage }] : [];
  });
  const unknownSonames = externalSonames.filter(
    (soname) =>
      !Object.prototype.hasOwnProperty.call(
        WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE,
        soname,
      ),
  );
  const requiredAptPackages = normalizedAptPackages(
    providers.map(({ aptPackage }) => aptPackage),
  );
  const suppliedAptPackages = new Set(
    normalizedAptPackages(
      input.aptPackages ?? WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
    ),
  );
  const missingAptPackages = requiredAptPackages.filter(
    (aptPackage) => !suppliedAptPackages.has(aptPackage),
  );

  return {
    ok: unknownSonames.length === 0 && missingAptPackages.length === 0,
    neededSonames,
    bundleInternalSonames,
    glibcSonames,
    externalSonames,
    unknownSonames,
    requiredAptPackages,
    missingAptPackages,
    providers,
  };
}

/** Ordered, observable phases of every generated install/upgrade/rollback. */
export const WORKSPACE_HOST_BOOTSTRAP_PHASES = [
  'validate-host',
  'harden-os',
  'verify-release',
  'install-runtime',
  'migrate-database',
  'configure-service',
  'attest-health',
] as const;
export type WorkspaceHostBootstrapPhase =
  (typeof WORKSPACE_HOST_BOOTSTRAP_PHASES)[number];

export const WORKSPACE_HOST_BOOTSTRAP_CHECKS = [
  "ubuntu-24.04",
  "bundle-digest",
  "bundle-signature",
  "node-runtime",
  "embedded-postgres-migration",
  "agent-cli-prerequisites",
  "pui-generation",
  "pui-operator-freshness",
  "loopback-service",
  "service-identity",
  "runtime-permissions",
  "workspace-identity",
  "workspace-acl",
  "privileged-conduits",
  "ssh-forwarding-policy",
] as const;
export type WorkspaceHostBootstrapCheckName =
  (typeof WORKSPACE_HOST_BOOTSTRAP_CHECKS)[number];

export interface WorkspaceHostBootstrapRelease {
  /** Stable, shell-safe release identifier (for example `2026.8.22-1`). */
  version: string;
  /** Public HTTPS Server-bundle tarball. Query credentials are forbidden. */
  bundleUrl: string;
  /** SHA-256 of the compressed bundle. */
  bundleSha256: string;
  /** Public HTTPS detached minisign signature. */
  signatureUrl: string;
  /** Public minisign verification key; never a private signing key. */
  signingPublicKey: string;
  /** SHA-256 of `signingPublicKey`, pinning the exact public trust root. */
  signingKeySha256: string;
}

/** Paths are relative to the immutable extracted Server release directory. */
export interface WorkspaceHostBootstrapEntrypoints {
  install: string;
  rollback: string;
  node: string;
  migrate: string;
  operator: string;
  health: string;
  psu: string;
  /** Native PUI executable installed with its companion + generation manifest. */
  pui: string;
  claude: string;
  codex: string;
  omp: string;
  /**
   * The remote initializer the controller spawns per initialization step. A bundle without it
   * installs and reports healthy, then fails every initialization at the far end — which is
   * exactly the silent failure the `remote-initializer` check exists to convert into a loud one.
   */
  remoteInitializer: string;
  /**
   * The credential-delivery program the controller spawns to place material on the host. Required
   * for the same reason `remoteInitializer` is: a bundle without it installs, reports healthy, and
   * then fails every `git` and `agent` bind at the far end with a message that cannot distinguish
   * "this host cannot receive material" from "delivery was attempted and lost" (D-215).
   */
  credentialDelivery: string;
}

export const DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS: Readonly<WorkspaceHostBootstrapEntrypoints> =
  {
    install: 'bin/papercusp-install',
    rollback: 'bin/papercusp-rollback',
    node: 'bin/node',
    migrate: 'bin/papercusp-migrate',
    operator: 'bin/papercusp-server',
    health: 'bin/papercusp-health',
    psu: 'bin/psu',
    pui: WORKSPACE_HOST_PUI_ENTRYPOINT,
    claude: 'bin/claude',
    codex: 'bin/codex',
    omp: 'bin/omp',
    remoteInitializer: 'bin/papercusp-remote-initializer',
    credentialDelivery: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  };

export interface WorkspaceHostBootstrapService {
  /** systemd unit basename, without `.service`. */
  name: string;
  /** Operator HTTP port. The generated service always binds it to 127.0.0.1. */
  port: number;
  user?: string;
  group?: string;
}

/**
 * Three identities, each with exactly one job, none of them sharing another's group.
 *
 * - `service`  — runs the operator; owns `$STATE_ROOT` (embedded PG, delivered material).
 * - `workspace` — the SSH login account; workspace/data ONLY, zero runtime read (D-043).
 * - `agent`    — runs the bundled agent CLIs; reads the signed runtime, owns the agent
 *   credential homes, writes the scoped workspace root. Non-login (D-248).
 */
export interface WorkspaceHostBootstrapIsolation {
  /** SSH login account that can access customer workspace/data only. */
  workspaceUser?: string;
  /** Primary group for the SSH account; must differ from the service group. */
  workspaceGroup?: string;
  /**
   * Non-login account the bundled agent CLIs execute as. Must differ from BOTH other
   * identities: sharing the service identity would hand it the credential/state root, and
   * sharing the SSH identity is the exact contradiction D-248 exists to remove.
   */
  agentUser?: string;
  /** Primary group for the agent account; must differ from the service and SSH groups. */
  agentGroup?: string;
}

/**
 * One vendor agent runtime to install on the host, as an already-resolved argv.
 *
 * WHY THIS EXISTS (D-259). The release bundle ships psu WRAPPERS named `claude`, `codex` and
 * `omp` — 539 bytes each, re-execing `scripts/psu.mjs --agent=<basename>` — NOT the vendor CLIs.
 * psu does not bundle a backend either: it RESOLVES one from well-known dirs and aborts the
 * launch when it finds none. So a host with no vendor runtime cannot start ANY agent, and
 * P-046's all-three-agent canary is unmeetable. This closes that gap.
 *
 * THE SPECS ARE NOT REBUILT HERE. The caller evaluates the ONE existing spec table
 * (`buildFrameworkInstallSpec`, which is pure) at render time and passes the concrete result, so
 * this generic lib stays domain-free and the install commands can never drift from the ones the
 * desktop onboarding uses.
 *
 * A NEW BUNDLED ENTRYPOINT WAS REJECTED DELIBERATELY: it would require a fresh bundle and image,
 * which D-237 forbids. The bootstrap is rendered per-provision, so an inlined argv reaches a
 * fresh host with no rebake — the same property that carried the D-246 ACL fix to canary-06.
 */
export interface WorkspaceHostAgentRuntimeInstall {
  /** Which backend this installs; also the bare name the post-install resolve probes for. */
  agent: 'claude' | 'codex' | 'omp';
  /** Executable to run. Never a shell string — argv is passed through without re-splitting. */
  command: string;
  args: readonly string[];
}

export interface WorkspaceHostBootstrapInput {
  contractVersion: typeof WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION;
  action: 'install' | 'upgrade' | 'rollback';
  hostId: string;
  release: WorkspaceHostBootstrapRelease;
  /** Durable migration identity expected after the bundled migration command succeeds. */
  migrationId: string;
  minimumNodeMajor: number;
  service: WorkspaceHostBootstrapService;
  isolation?: WorkspaceHostBootstrapIsolation;
  /**
   * OpenSSH public keys authorized for the workspace SSH account. REQUIRED and non-empty.
   *
   * `harden-os` locks this host down to `AuthenticationMethods publickey` +
   * `AllowUsers $WORKSPACE_USER`, and the workspace account is created with `usermod --lock`.
   * A render with no key therefore produces a host that is unreachable by construction — sshd
   * accepts public keys only, for exactly one account, and that account has none. Provider
   * metadata cannot rescue it either: the GCP provider sets `block-project-ssh-keys=TRUE` and
   * `enable-oslogin=TRUE` unconditionally, so `ssh-keys` metadata is ignored, and the workspace
   * account is a plain local user that OS Login's `google_authorized_keys` never answers for.
   *
   * This field is required rather than optional precisely because the failure is silent: the
   * bootstrap succeeds, attests `status:"healthy"`, and only the NEXT connection discovers the
   * host was bricked. Measured on p046-canary-04, 2026-09-02 (D-238).
   */
  workspaceAuthorizedKeys: readonly string[];
  entrypoints?: Partial<WorkspaceHostBootstrapEntrypoints>;
  /**
   * Vendor agent runtimes to install as the AGENT identity during `install-runtime` (D-259).
   *
   * Omitted or empty means no install is attempted, and the attestation then continues to declare
   * `agentRuntimesVerifiedByBootstrap: false` — which is the HONEST reading for such a host, and
   * exactly what every host built before this field reported. Supplying installs is what lets the
   * bootstrap make that claim true, because each one is followed by a resolve that must succeed.
   *
   * ⚠ SUPPLY-CHAIN NOTE, deliberately surfaced rather than buried: the vendor install scripts
   * these argvs run fetch code over the network (the Claude installer is a `curl … | bash`), which
   * is a weaker trust posture than the digest+minisign verification this bootstrap applies to its
   * OWN bundle. It is not a NEW trust relationship — it is the same vendor and the same script the
   * desktop onboarding already runs — but it is a real asymmetry, and vendoring the runtimes into
   * the signed bundle is the stronger long-term answer once an image rebake is permitted again.
   */
  agentRuntimeInstalls?: readonly WorkspaceHostAgentRuntimeInstall[];
  /** Persistable labels only. Secret-shaped keys and private-key values are rejected. */
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostBootstrapAttestationCheck {
  name: WorkspaceHostBootstrapCheckName;
  ok: true;
}

export interface WorkspaceHostBootstrapAttestation {
  contractVersion: typeof WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION;
  hostId: string;
  action: WorkspaceHostBootstrapInput['action'];
  ubuntuVersion: typeof WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION;
  observedAt: string;
  status: 'healthy';
  release: {
    version: string;
    source: string;
    bundleSha256: string;
    signingKeySha256: string;
    signatureVerified: true;
  };
  migration: {
    id: string;
    applied: true;
  };
  runtime: {
    nodeMajor: number;
    minimumNodeMajor: number;
    psu: true;
    pui: true;
    /**
     * PRESENT AND EXECUTABLE — which is the entire claim bootstrap is entitled to make.
     *
     * These were `claude: true, codex: true, omp: true` directly under `runtime`, read by every
     * caller as "this host can run Claude/Codex/OMP". They never meant that. The only thing
     * behind them is `test -x` on `bin/{claude,codex,omp}`, and those three files are 539-byte
     * psu LAUNCHER wrappers — the host ships no vendor CLI at all and nothing installs one
     * (D-252, measured on the r19 bundle). A field whose NAME claims a product property and
     * whose VALUE measures a file permission is the unbacked-boolean class P-046 exists to
     * remove; it is the same defect as the old `runtimeReadableByWorkspaceUser` (D-251).
     */
    agentLaunchers: {
      claude: true;
      codex: true;
      omp: true;
    };
    /**
     * Bootstrap NEVER establishes that an agent runtime is installed and authenticated, so it
     * attests the negative rather than staying silent — silence reads as "not checked", and a
     * reader then supplies the optimistic default this constant exists to deny.
     *
     * The authority for the positive is the readiness probe in
     * `workspace-host-agent-authentication.ts`, run later by the initializer, which reaches a
     * real authenticated surface and scores "exit 0 but unparseable" as a FAILURE.
     */
    agentRuntimesVerifiedByBootstrap: false;
    /**
     * Whether this bootstrap INSTALLED the vendor agent runtimes and resolved each one (D-259).
     *
     * Strictly narrower than the field above, and deliberately a separate one. `install-runtime`
     * runs each configured install as the agent identity and then RESOLVES the binary, dying if it
     * is absent — so a true here is backed by a resolve that passed. It still says nothing about
     * authentication, which is why the `Verified` field remains a hardcoded false: conflating the
     * two is how the launcher wrappers came to be mistaken for working agent CLIs in the first
     * place (D-247).
     *
     * False on any host provisioned without `agentRuntimeInstalls` — including every host built
     * before D-259, which genuinely had no vendor runtime at all.
     */
    agentRuntimesInstalledByBootstrap: boolean;
    /**
     * Absolute path of each installed vendor runtime, as resolved ON the host after install.
     *
     * Present only alongside `agentRuntimesInstalledByBootstrap: true`. This is what lets the
     * readiness probe exec the VENDOR binary directly instead of shelling `bin/<agent>`, which is
     * the psu wrapper and swallows the probe's arguments (D-259 Defect 2).
     */
    agentRuntimes?: Partial<Record<'claude' | 'codex' | 'omp', string>>;
  };
  service: {
    name: string;
    user: string;
    group: string;
    bindHost: '127.0.0.1';
    port: number;
    active: true;
  };
  isolation: {
    workspaceUser: string;
    workspaceGroup: string;
    /** The third identity (D-248): non-login, runs the bundled agent CLIs. */
    agentUser: string;
    agentGroup: string;
    runtimeRoot: typeof WORKSPACE_HOST_RUNTIME_ROOT;
    stateRoot: typeof WORKSPACE_HOST_STATE_ROOT;
    workspaceRoot: typeof WORKSPACE_HOST_DATA_ROOT;
    // FALSE, and back to false deliberately. D-246 flipped this to `true` because the SSH account
    // was then the agent-running identity, which made the runtime read unavoidable — and that
    // violated the D-043 owner ruling. D-248 splits the identity instead, so the property D-043
    // names holds as written AND the agents run. Read the pair below together: the read moved to
    // the agent identity, it did not disappear.
    runtimeReadableByWorkspaceUser: false;
    runtimeWritableByWorkspaceUser: false;
    runtimeReadableByAgentUser: true;
    runtimeWritableByAgentUser: false;
    /**
     * The customer's SSH login cannot read the delivered agent credential home. On a BYOC host
     * that account is the customer's access path, so this is the property that decides whether
     * platform agent credentials are exposed to them — not a mode bit, an asserted negative.
     */
    agentHomeReadableBySshUser: false;
    workspaceWritableByService: true;
    workspaceWritableBySshUser: true;
    workspaceWritableByAgentUser: true;
    sudo: false;
    serviceGroupMember: false;
    operatorIngress: 'ssh-local-forward';
    updateMode: 'signed-atomic-release-swap';
  };
  checks: readonly WorkspaceHostBootstrapAttestationCheck[];
}

export interface WorkspaceHostBootstrapAttestationValidation {
  ok: boolean;
  errors: readonly string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_LINUX_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SAFE_ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function requireSafeId(value: string, label: string): void {
  requireCondition(
    SAFE_ID.test(value),
    `${label} must be a non-empty stable identifier`,
  );
}

function requireSha256(value: string, label: string): void {
  requireCondition(
    SHA256.test(value),
    `${label} must be a 64-character SHA-256 digest`,
  );
}

function requirePublicHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid public HTTPS URL`);
  }
  requireCondition(parsed.protocol === 'https:', `${label} must use HTTPS`);
  requireCondition(
    !parsed.username && !parsed.password,
    `${label} must not contain credentials`,
  );
  requireCondition(
    !parsed.search && !parsed.hash,
    `${label} must not contain query credentials or fragments`,
  );
}

function requireEntrypoint(value: string, label: string): void {
  requireCondition(
    SAFE_ENTRYPOINT.test(value) &&
      !value.startsWith('/') &&
      !value.split('/').some((part) => part === '.' || part === '..'),
    `${label} must be a safe relative release path`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function assertNoSecretShapedMetadata(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretShapedMetadata(entry, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const tokenSet = new Set(tokens);
    const secretShaped =
      ['secret', 'token', 'password', 'passphrase'].some((token) =>
        tokenSet.has(token),
      ) ||
      ((tokenSet.has('api') ||
        tokenSet.has('access') ||
        tokenSet.has('private')) &&
        tokenSet.has('key'));
    requireCondition(
      !secretShaped,
      `Secret-shaped field '${path}.${key}' is forbidden in bootstrap metadata`,
    );
    assertNoSecretShapedMetadata(entry, `${path}.${key}`);
  }
}

function normalizedEntrypoints(
  overrides: Partial<WorkspaceHostBootstrapEntrypoints> | undefined,
): WorkspaceHostBootstrapEntrypoints {
  const entrypoints = {
    ...DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(entrypoints))
    requireEntrypoint(value, `entrypoints.${name}`);
  return entrypoints;
}

interface ValidatedBootstrapInput {
  entrypoints: WorkspaceHostBootstrapEntrypoints;
  serviceUser: string;
  serviceGroup: string;
  workspaceUser: string;
  workspaceGroup: string;
  agentUser: string;
  agentGroup: string;
  workspaceAuthorizedKeys: readonly string[];
  agentRuntimeInstalls: readonly WorkspaceHostAgentRuntimeInstall[];
}

function validateInput(
  input: WorkspaceHostBootstrapInput,
): ValidatedBootstrapInput {
  requireCondition(
    input.contractVersion === WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    `Unsupported workspace-host bootstrap contract '${input.contractVersion}'`,
  );
  requireCondition(
    ['install', 'upgrade', 'rollback'].includes(input.action),
    `Unsupported bootstrap action '${input.action}'`,
  );
  requireSafeId(input.hostId, 'hostId');
  requireCondition(
    SAFE_RELEASE.test(input.release.version),
    'release.version must be shell-safe',
  );
  requirePublicHttpsUrl(input.release.bundleUrl, 'release.bundleUrl');
  requirePublicHttpsUrl(input.release.signatureUrl, 'release.signatureUrl');
  requireSha256(input.release.bundleSha256, 'release.bundleSha256');
  // requirePublicHttpsUrl only proves the URL is well-formed, credential-free HTTPS. It does NOT
  // tie the URL to the digest this release pins, so on its own it accepts a mutable
  // `.../latest.tgz` next to a perfectly valid bundleSha256 — and that URL is interpolated into
  // an install script that runs as root. D-106 puts the addressing rule in one shared place;
  // bootstrap adjudicates it against the release's OWN pins, which is the strongest claim it can
  // make without the build manifest. Run it after requireSha256 so the digest is known well-formed.
  const releaseAddressingErrors = workspaceHostReleaseAddressingErrors(
    input.release,
    {
      sha256: input.release.bundleSha256,
      version: input.release.version,
      subject: 'the digest this release pins',
    },
  );
  requireCondition(
    releaseAddressingErrors.length === 0,
    `release provenance: ${releaseAddressingErrors.join('; ')}`,
  );
  requireSha256(input.release.signingKeySha256, 'release.signingKeySha256');
  requireCondition(
    input.release.signingPublicKey.trim().length > 0,
    'release.signingPublicKey must not be empty',
  );
  requireSafeId(input.migrationId, 'migrationId');
  requireCondition(
    Number.isSafeInteger(input.minimumNodeMajor) &&
      input.minimumNodeMajor >= 20 &&
      input.minimumNodeMajor <= 99,
    'minimumNodeMajor must be a supported integer between 20 and 99',
  );
  requireCondition(
    SAFE_SERVICE.test(input.service.name),
    'service.name must be a safe systemd unit basename',
  );
  requireCondition(
    Number.isSafeInteger(input.service.port) &&
      input.service.port >= 1024 &&
      input.service.port <= 65_535,
    'service.port must be an unprivileged TCP port',
  );
  const serviceUser = input.service.user ?? DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  const serviceGroup = input.service.group ?? serviceUser;
  const workspaceUser =
    input.isolation?.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = input.isolation?.workspaceGroup ?? workspaceUser;
  const agentUser =
    input.isolation?.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = input.isolation?.agentGroup ?? agentUser;
  requireCondition(
    SAFE_LINUX_NAME.test(serviceUser) && serviceUser !== 'root',
    'service.user must be a safe Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(serviceGroup) && serviceGroup !== 'root',
    'service.group must be a safe Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(workspaceUser) && workspaceUser !== 'root',
    'isolation.workspaceUser must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(workspaceGroup) && workspaceGroup !== 'root',
    'isolation.workspaceGroup must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(agentUser) && agentUser !== 'root',
    'isolation.agentUser must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(agentGroup) && agentGroup !== 'root',
    'isolation.agentGroup must be a safe non-root Linux name',
  );
  requireCondition(
    workspaceUser !== serviceUser,
    'workspace SSH user must differ from the runtime service user',
  );
  requireCondition(
    workspaceGroup !== serviceGroup,
    'workspace SSH group must differ from the runtime service group',
  );
  // The whole point of the third identity is that it is a THIRD one. Collapsing it onto either
  // existing account silently restores the contradiction D-248 diagnoses — onto the SSH account
  // it re-grants runtime read to the customer's login (D-043), and onto the service account it
  // hands the agent runtime $STATE_ROOT, which holds embedded PG and every delivered credential.
  requireCondition(
    agentUser !== workspaceUser && agentUser !== serviceUser,
    'agent identity must differ from both the workspace SSH user and the runtime service user',
  );
  requireCondition(
    agentGroup !== workspaceGroup && agentGroup !== serviceGroup,
    'agent group must differ from both the workspace SSH group and the runtime service group',
  );
  assertWorkspaceHostSecretIsolation(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  assertNoSecretShapedMetadata(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  return {
    entrypoints: normalizedEntrypoints(input.entrypoints),
    serviceUser,
    serviceGroup,
    workspaceUser,
    workspaceGroup,
    agentUser,
    agentGroup,
    workspaceAuthorizedKeys: normalizedAuthorizedKeys(
      input.workspaceAuthorizedKeys,
    ),
    agentRuntimeInstalls: normalizedAgentRuntimeInstalls(
      input.agentRuntimeInstalls,
    ),
  };
}

/**
 * Validate the D-259 agent-runtime installs.
 *
 * Absent is legal and means "this host installs no vendor runtime" — the attestation then says so
 * rather than claiming otherwise. What is NOT legal is a malformed or duplicated entry: each is
 * rendered into a root bootstrap as an argv run under `runuser`, so a blank command or a repeated
 * agent is a render-time error, never something to discover on a host.
 */
function normalizedAgentRuntimeInstalls(
  installs: readonly WorkspaceHostAgentRuntimeInstall[] | undefined,
): readonly WorkspaceHostAgentRuntimeInstall[] {
  if (installs === undefined) return [];
  requireCondition(
    Array.isArray(installs),
    'bootstrap.agentRuntimeInstalls must be an array when provided',
  );
  const seen = new Set<string>();
  for (const install of installs) {
    requireCondition(
      typeof install === 'object' &&
        install !== null &&
        (install.agent === 'claude' ||
          install.agent === 'codex' ||
          install.agent === 'omp'),
      "bootstrap.agentRuntimeInstalls[].agent must be 'claude', 'codex' or 'omp'",
    );
    requireCondition(
      typeof install.command === 'string' && install.command.trim().length > 0,
      'bootstrap.agentRuntimeInstalls[].command must be a non-empty string',
    );
    requireCondition(
      // `Array.isArray` widens a readonly string[] to any[], so annotate the callback parameter
      // rather than letting it land as an implicit any under noImplicitAny.
      Array.isArray(install.args) &&
        install.args.every((arg: unknown) => typeof arg === 'string'),
      'bootstrap.agentRuntimeInstalls[].args must be an array of strings',
    );
    requireCondition(
      !seen.has(install.agent),
      `bootstrap.agentRuntimeInstalls has a duplicate entry for '${install.agent}'`,
    );
    seen.add(install.agent);
  }
  return installs.map((install) => ({
    agent: install.agent,
    command: install.command,
    args: [...install.args],
  }));
}

/**
 * A plain OpenSSH public key: `<type> <base64>` with an optional free-text comment.
 *
 * Deliberately NOT the full authorized_keys grammar — an options prefix
 * (`command="…"`, `permitopen=…`) is refused rather than passed through, because the
 * sshd hardening this bootstrap writes is the security boundary and a per-key option
 * would silently reshape it.
 */
const SSH_PUBLIC_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

function normalizedAuthorizedKeys(
  keys: readonly string[] | undefined,
): readonly string[] {
  requireCondition(
    Array.isArray(keys) && keys.length > 0,
    'workspaceAuthorizedKeys must list at least one OpenSSH public key — harden-os sets ' +
      'AuthenticationMethods publickey and AllowUsers $WORKSPACE_USER, so a render with no key ' +
      'produces a host that is unreachable by construction (D-238)',
  );
  const normalized = (keys as readonly string[]).map((key) =>
    typeof key === 'string' ? key.trim() : '',
  );
  normalized.forEach((key, index) => {
    requireCondition(
      SSH_PUBLIC_KEY.test(key),
      `workspaceAuthorizedKeys[${index}] must be one plain OpenSSH public key line ` +
        `('<type> <base64> [comment]', no authorized_keys options and no newline)`,
    );
  });
  const unique = [...new Set(normalized)];
  requireCondition(
    unique.length === normalized.length,
    'workspaceAuthorizedKeys must not repeat a key',
  );
  return unique;
}

function assignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

/**
 * Install the vendor agent runtimes as the AGENT identity (D-259).
 *
 * Each already-resolved argv runs under `runuser`, and is then followed by a RESOLVE that must
 * succeed. The resolve is the whole point: an install that exits 0 while leaving nothing on disk
 * is precisely the unbacked boolean this work exists to remove, so the attestation's
 * `agentRuntimesInstalledByBootstrap` is only ever true downstream of a resolve that passed.
 *
 * ⛔ That is `Installed`, NOT `Verified`. `agentRuntimesVerifiedByBootstrap` stays a hardcoded
 * `false` and D-252's validator still refuses anything else. A passing resolve proves the binary
 * is PRESENT and EXECUTABLE; it proves nothing about whether anyone has authenticated it, and the
 * two claims collapsing into one is how the wrappers came to be mistaken for working agent CLIs.
 *
 * PATH is set explicitly and DELIBERATELY EXCLUDES the release's own `bin/`. That directory holds
 * the psu wrappers named `claude`/`codex`/`omp`; leaving it on PATH would let the resolve find a
 * WRAPPER and report success while no vendor runtime existed — the exact confusion that made
 * D-247 read as a probe bug across three sessions. The dirs included are where these installers
 * actually land: `~/.local/bin` (the Claude installer and the omp download) and
 * `~/.papercusp/runtime/node_modules/.bin` (the codex `npm install --prefix` target).
 *
 * The resolved absolute path is captured per agent so the canary's readiness probe can exec the
 * VENDOR binary directly instead of shelling the wrapper.
 */
function agentRuntimeInstallLines(
  installs: readonly WorkspaceHostAgentRuntimeInstall[],
): string[] {
  if (installs.length === 0) return [];
  const lines: string[] = [
    "",
    "# D-259: the release bundle ships psu WRAPPERS named claude/codex/omp, not the vendor CLIs,",
    "# and psu resolves a real backend from well-known dirs. Without these installs psu aborts",
    "# every agent launch, so the host cannot run an agent at all.",
    'AGENT_RUNTIME_PATH="$AGENT_HOME/.local/bin:$AGENT_HOME/.papercusp/runtime/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  ];
  for (const install of installs) {
    const argv = [install.command, ...install.args].map(shellQuote).join(" ");
    lines.push(
      `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" ${argv} || die ${shellQuote(
        `agent runtime install failed: ${install.agent}`,
      )}`,
    );
  }
  for (const install of installs) {
    const varName = `AGENT_RUNTIME_${install.agent.toUpperCase()}`;
    lines.push(
      `${varName}="$(runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" /bin/bash -c ${shellQuote(
        `command -v ${install.agent}`,
      )} || true)"`,
      `[[ -n "$${varName}" ]] || die ${shellQuote(
        `agent runtime did not resolve after install: ${install.agent}`,
      )}`,
    );
  }
  return lines;
}

/**
 * Emit a deterministic, replay-safe root bootstrap for install, upgrade, or
 * rollback. The release bundle supplies Node, embedded Postgres tooling and psu, plus the psu
 * WRAPPERS named after the agent CLIs; the vendor agent runtimes themselves are installed at
 * provision time from `input.agentRuntimeInstalls` (D-259). apt installs only host
 * security/verification prerequisites.
 */
export function buildWorkspaceHostBootstrap(
  input: WorkspaceHostBootstrapInput,
): string {
  const {
    entrypoints,
    serviceUser,
    serviceGroup,
    workspaceUser,
    workspaceGroup,
    agentUser,
    agentGroup,
    workspaceAuthorizedKeys,
    agentRuntimeInstalls,
  } = validateInput(input);
  const digest = input.release.bundleSha256.toLowerCase();
  const signingKeyDigest = input.release.signingKeySha256.toLowerCase();
  const checksJson = JSON.stringify(
    WORKSPACE_HOST_BOOTSTRAP_CHECKS.map((name) => ({ name, ok: true })),
  );
  // D-259: INSTALLED is a strictly narrower claim than VERIFIED, and they must not be conflated.
  // This render installs the vendor runtimes and RESOLVES each one (the resolve `die`s otherwise,
  // so reaching the attestation is the proof) — that establishes they are present and executable.
  // It establishes NOTHING about whether they are authenticated, which is why
  // `agentRuntimesVerifiedByBootstrap` stays hardcoded false and D-252's validator assertion that
  // refuses the optimistic lie is left exactly as it was. The authority for the authenticated
  // claim remains the readiness probe in workspace-host-agent-authentication.ts.
  const agentRuntimesInstalled = agentRuntimeInstalls.length > 0;
  const jqName = (agent: string): string =>
    `agentRuntime${agent[0].toUpperCase()}${agent.slice(1)}`;
  const agentRuntimeJqArgs = agentRuntimeInstalls
    .map(
      (install) =>
        `--arg ${jqName(install.agent)} "$AGENT_RUNTIME_${install.agent.toUpperCase()}" `,
    )
    .join("");
  const agentRuntimeJqFields = agentRuntimeInstalls.length
    ? `,agentRuntimes:{${agentRuntimeInstalls
        .map((install) => `${install.agent}:$${jqName(install.agent)}`)
        .join(",")}}`
    : "";

  const lines = [
    "#!/usr/bin/env bash",
    `# Generated by ${WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION}; contains public provenance only.`,
    "set -Eeuo pipefail",
    "umask 027",
    assignment("CONTRACT_VERSION", input.contractVersion),
    assignment("BOOTSTRAP_ACTION", input.action),
    assignment("HOST_ID", input.hostId),
    assignment("RELEASE_VERSION", input.release.version),
    assignment("BUNDLE_URL", input.release.bundleUrl),
    assignment("BUNDLE_SHA256", digest),
    assignment("SIGNATURE_URL", input.release.signatureUrl),
    assignment("SIGNING_KEY_SHA256", signingKeyDigest),
    assignment(
      "SIGNING_PUBLIC_KEY_B64",
      base64(input.release.signingPublicKey),
    ),
    assignment("MIGRATION_ID", input.migrationId),
    `MINIMUM_NODE_MAJOR=${input.minimumNodeMajor}`,
    assignment("SERVICE_NAME", input.service.name),
    `SERVICE_PORT=${input.service.port}`,
    assignment("SERVICE_USER", serviceUser),
    assignment("SERVICE_GROUP", serviceGroup),
    assignment("WORKSPACE_USER", workspaceUser),
    // Base64 so the key material cannot interact with shell quoting, and so a comment
    // containing spaces or quotes round-trips byte-for-byte into authorized_keys.
    assignment(
      "WORKSPACE_AUTHORIZED_KEYS_B64",
      base64(`${workspaceAuthorizedKeys.join("\n")}\n`),
    ),
    assignment("WORKSPACE_GROUP", workspaceGroup),
    assignment("AGENT_USER", agentUser),
    assignment("AGENT_GROUP", agentGroup),
    assignment("AGENT_HOME", `/home/${agentUser}`),
    assignment("RUNTIME_ROOT", WORKSPACE_HOST_RUNTIME_ROOT),
    assignment("STATE_ROOT", WORKSPACE_HOST_STATE_ROOT),
    assignment("WORKSPACE_ROOT", WORKSPACE_HOST_DATA_ROOT),
    assignment("INSTALL_ENTRYPOINT", entrypoints.install),
    assignment("ROLLBACK_ENTRYPOINT", entrypoints.rollback),
    assignment("NODE_ENTRYPOINT", entrypoints.node),
    assignment("MIGRATE_ENTRYPOINT", entrypoints.migrate),
    assignment("OPERATOR_ENTRYPOINT", entrypoints.operator),
    assignment("HEALTH_ENTRYPOINT", entrypoints.health),
    assignment("PSU_ENTRYPOINT", entrypoints.psu),
    assignment("PUI_ENTRYPOINT", entrypoints.pui),
    assignment("PUI_COMPANION_PATH", WORKSPACE_HOST_PUI_COMPANION_PATH),
    assignment(
      "PUI_INSTALL_MANIFEST_PATH",
      WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
    ),
    assignment("CLAUDE_ENTRYPOINT", entrypoints.claude),
    assignment("CODEX_ENTRYPOINT", entrypoints.codex),
    assignment("OMP_ENTRYPOINT", entrypoints.omp),
    assignment("REMOTE_INITIALIZER_ENTRYPOINT", entrypoints.remoteInitializer),
    assignment(
      "CREDENTIAL_DELIVERY_ENTRYPOINT",
      entrypoints.credentialDelivery,
    ),
    assignment(
      "REMOTE_INITIALIZER_CONDUIT",
      WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
    ),
    assignment(
      "CREDENTIAL_DELIVERY_CONDUIT",
      WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
    ),
    assignment(
      "PRIVILEGED_CONDUIT_SUDOERS",
      WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS,
    ),
    "",
    'log() { printf "[workspace-host-bootstrap] %s\\n" "$1"; }',
    'die() { log "ERROR: $1" >&2; exit 1; }',
    'phase() { log "phase:$1"; }',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[0]}'`,
    '[[ "${EUID}" -eq 0 ]] || die "bootstrap must run as root"',
    "# shellcheck disable=SC1091",
    "source /etc/os-release",
    `[[ "${"${ID:-}"}" == 'ubuntu' && "${"${VERSION_ID:-}"}" == '${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}' ]] || die "Ubuntu ${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION} is required"`,
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[1]}'`,
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    // Native runtime packages are distinct from build tooling. The exported apt contract above
    // is the source of truth for every mapped external SONAME; keep this rendered install line
    // derived from it so publication and a clean Ubuntu host cannot drift. The initially
    // measured defect was libatomic.so.1 (package libatomic1), which is present on boxes with a
    // compiler installed and therefore reproduced on clean guests but not developer machines.
    //
    // The failure it produced was maximally misleading: require-addon catches the dlopen error
    // and CONTINUES (`catch (err) { cause = err; continue }`, require-addon/lib/node.js), then
    // reports "Cannot find addon '.'" with a candidate list. So a missing SHARED LIBRARY is
    // reported as a missing ADDON FILE — while the file is present, correctly sized, correctly
    // owned and readable by the service user. Do not remove these without re-running the readelf
    // union over the bundle's *.node files; --no-install-recommends means nothing pulls them in.
    `apt-get install -y --no-install-recommends ${WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES.join(" ")}`,
    'getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"',
    'id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"',
    'usermod --lock --shell /usr/sbin/nologin "$SERVICE_USER"',
    'getent group "$WORKSPACE_GROUP" >/dev/null || groupadd "$WORKSPACE_GROUP"',
    'id -u "$WORKSPACE_USER" >/dev/null 2>&1 || useradd --gid "$WORKSPACE_GROUP" --home-dir "/home/$WORKSPACE_USER" --create-home --shell /bin/bash "$WORKSPACE_USER"',
    'usermod --lock --gid "$WORKSPACE_GROUP" --groups "" --home "/home/$WORKSPACE_USER" --shell /bin/bash "$WORKSPACE_USER"',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "workspace SSH user must not belong to the runtime service group"; fi',
    // The THIRD identity (D-248). It exists so that exactly one account both reads the signed
    // runtime and holds the agent credentials, and that account is NOT the customer's SSH login.
    // `--shell /usr/sbin/nologin` + `usermod --lock` because nothing ever logs in as it: the
    // privileged conduits invoke it via `runuser`, so it needs no password, no shell and no key.
    'getent group "$AGENT_GROUP" >/dev/null || groupadd --system "$AGENT_GROUP"',
    'id -u "$AGENT_USER" >/dev/null 2>&1 || useradd --system --gid "$AGENT_GROUP" --home-dir "$AGENT_HOME" --create-home --shell /usr/sbin/nologin "$AGENT_USER"',
    'usermod --lock --gid "$AGENT_GROUP" --groups "" --home "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"',
    // Two memberships, refused for two different reasons. $SERVICE_GROUP would hand the agent
    // runtime $STATE_ROOT — embedded PG and every delivered credential. $WORKSPACE_GROUP would
    // let the SSH account reach the agent's 0700 credential home through the group bits, which
    // is the leak the third identity is for.
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "agent identity must not belong to the runtime service group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$WORKSPACE_GROUP" >/dev/null; then die "agent identity must not belong to the workspace SSH group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$AGENT_GROUP" >/dev/null; then die "workspace SSH user must not belong to the agent group"; fi',
    'install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$STATE_ROOT" "$STATE_ROOT/embedded-pg"',
    'install -d -o root -g "$SERVICE_GROUP" -m 0750 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" /etc/papercusp',
    // The AGENT identity must TRAVERSE the runtime root, because it is the account that runs the
    // bundled agent CLIs: `bind-credential` delivers Claude/Codex/OMP material into its 0700
    // home, and the agent probes execute `$RUNTIME_ROOT/current/bin/{claude,codex,omp}` as this
    // very user. Shipping the runtime root as 0750 root:$SERVICE_GROUP while the account is
    // created with `--groups ""` made those two facts contradictory, and every agent failed
    // identically with `env: 'claude': Permission denied` (exit 126) six steps into a live
    // canary — read as three independent credential faults, which is what made it expensive
    // (D-246, measured on p046-canary-05).
    //
    // The grant is aimed at $AGENT_USER, NOT $WORKSPACE_USER. D-246 originally pointed it at the
    // SSH account because that account was the agent-running identity, and that violated the
    // D-043 owner ruling ("keep runtime files root-owned/non-readable to the workspace user").
    // Splitting the identity is what lets both hold: the runtime is readable by whoever executes
    // it, and the customer's login is not that identity. The verify phase asserts BOTH halves.
    //
    // A NAMED-USER ACL, not group membership and not a world-readable tree: the checks above
    // assert this account is NOT in $SERVICE_GROUP and the verify phase re-asserts it, because
    // that group also gates $STATE_ROOT (embedded PG, delivered credentials) and /etc/papercusp.
    // Traverse-and-read is the entire grant; root stays sole owner and sole writer, so the
    // immutability the 0750 was reaching for is carried by ownership, not by the read bits.
    'setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"',
    "install -d -o root -g root -m 0711 /srv/papercusp",
    'install -d -o root -g root -m 0770 "$WORKSPACE_ROOT"',
    'setfacl --remove-all "$WORKSPACE_ROOT"',
    'setfacl --remove-default "$WORKSPACE_ROOT"',
    // All three identities write the scoped workspace root, and the DEFAULT ACL is what makes
    // that survive: a file the agent creates inherits the SSH user's rwx entry (and vice versa),
    // so the customer can edit what the agent wrote over SSH without either side chown-ing.
    'setfacl -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    'setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER"',
    // 0700 and owned by an account whose group the SSH user is not in. This is the directory
    // `bind-credential` writes Claude/Codex/OMP material into; on the pre-D-248 shape it was the
    // SSH account's own home, so on a BYOC host the customer's login owned and could read the
    // platform's agent credentials (observed on p046-canary-05).
    'install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"',
    'ln -sfn "$WORKSPACE_ROOT" "/home/$WORKSPACE_USER/workspaces"',
    'chown -h "$WORKSPACE_USER:$WORKSPACE_GROUP" "/home/$WORKSPACE_USER/workspaces"',
    // Authorize the controller BEFORE the sshd hardening below takes effect. The config that
    // follows sets `AuthenticationMethods publickey` and `AllowUsers $WORKSPACE_USER`, and the
    // workspace account is `usermod --lock`ed, so once it is reloaded the ONLY way in is a key
    // in this file. Writing it afterwards would leave a window in which the host is already
    // hardened and not yet reachable; failing to write it at all bricks the host (D-238).
    'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER/.ssh"',
    'printf %s "$WORKSPACE_AUTHORIZED_KEYS_B64" | base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    'chown "$WORKSPACE_USER:$WORKSPACE_GROUP" "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    'chmod 0600 "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    // Fail loudly here rather than at the next connection: an empty authorized_keys and a
    // correctly-hardened sshd are indistinguishable from a healthy host until someone tries
    // to reach it, which is exactly how this went undetected.
    'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die "workspace authorized_keys is empty; the host would be unreachable after sshd hardening"',
    "cat > /etc/ssh/sshd_config.d/60-papercusp-workspace.conf <<PAPERCUSP_SSH",
    "# Managed by Papercusp workspace-host bootstrap.",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "PermitRootLogin no",
    "PubkeyAuthentication yes",
    "AllowUsers $WORKSPACE_USER",
    "AllowTcpForwarding local",
    "AllowStreamLocalForwarding no",
    "PermitOpen 127.0.0.1:$SERVICE_PORT",
    "GatewayPorts no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PAPERCUSP_SSH",
    "sshd -t",
    "systemctl reload ssh 2>/dev/null || systemctl reload sshd",
    "ufw default deny incoming",
    "ufw default allow outgoing",
    "ufw allow 22/tcp",
    "ufw --force enable",
    "systemctl enable --now unattended-upgrades.service",
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[2]}'`,
    'WORK_DIR="$(mktemp -d /var/tmp/papercusp-bootstrap.XXXXXX)"',
    'BUNDLE_PATH="$WORK_DIR/server-bundle.tgz"',
    'SIGNATURE_PATH="$WORK_DIR/server-bundle.tgz.minisig"',
    'PUBLIC_KEY_PATH="$WORK_DIR/bootstrap-public.key"',
    'STAGE_DIR=""',
    'PREVIOUS_TARGET="$(readlink -f "$RUNTIME_ROOT/current" 2>/dev/null || true)"',
    "SWITCHED=0",
    "restore_previous() {",
    '  [[ "$SWITCHED" -eq 1 && -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]] || return 0',
    '  ln -sfn "$PREVIOUS_TARGET" "$RUNTIME_ROOT/current.next"',
    '  mv -Tf "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"',
    '  systemctl restart "$SERVICE_NAME.service" || true',
    "}",
    "cleanup() {",
    "  status=$?",
    '  if [[ "$status" -ne 0 ]]; then restore_previous; fi',
    '  [[ -z "$STAGE_DIR" || ! -d "$STAGE_DIR" ]] || rm -rf -- "$STAGE_DIR"',
    '  rm -rf -- "$WORK_DIR"',
    '  exit "$status"',
    "}",
    "trap cleanup EXIT",
    'curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$BUNDLE_URL" --output "$BUNDLE_PATH"',
    'curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$SIGNATURE_URL" --output "$SIGNATURE_PATH"',
    'printf "%s  %s\\n" "$BUNDLE_SHA256" "$BUNDLE_PATH" | sha256sum --check --strict -',
    'printf "%s" "$SIGNING_PUBLIC_KEY_B64" | base64 --decode > "$PUBLIC_KEY_PATH"',
    'printf "%s  %s\\n" "$SIGNING_KEY_SHA256" "$PUBLIC_KEY_PATH" | sha256sum --check --strict -',
    'minisign -Vm "$BUNDLE_PATH" -x "$SIGNATURE_PATH" -p "$PUBLIC_KEY_PATH" >/dev/null',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[3]}'`,
    'RELEASE_DIR="$RUNTIME_ROOT/releases/$RELEASE_VERSION"',
    'if [[ ! -d "$RELEASE_DIR" ]]; then',
    '  STAGE_DIR="$(mktemp -d "$RUNTIME_ROOT/releases/.${RELEASE_VERSION}.XXXXXX")"',
    '  tar --extract --gzip --file "$BUNDLE_PATH" --directory "$STAGE_DIR" --no-same-owner --no-same-permissions',
    '  mv -T "$STAGE_DIR" "$RELEASE_DIR"',
    '  STAGE_DIR=""',
    "fi",
    'chown -R "root:$SERVICE_GROUP" "$RELEASE_DIR"',
    'chmod -R g-w,o-rwx "$RELEASE_DIR"',
    'find "$RELEASE_DIR" -type d -exec chmod g+rx {} +',
    'find "$RELEASE_DIR" -type f -exec chmod g+r {} +',
    // Extend the runtime-root grant across the extracted release (D-246, retargeted from the SSH
    // account to the agent identity by D-248). Ordered after the chmod
    // pass deliberately: on a file that carries an ACL, chmod's group bits address the ACL MASK
    // rather than the group entry, so a mask-narrowing chmod landing after this line would clamp
    // the grant away. MEASURED (2026-09-02, /tmp probe over this exact sequence): with the three
    // chmods above as written the mask is `r-x` in EITHER order, because `g-w`, `g+rx` and `g+r`
    // are all additive — so this ordering is not load-bearing TODAY and no live bug depends on
    // it. It is kept because a later edit to an assigning form (`chmod g=r`) would silently clamp
    // execute, and the resulting failure is invisible until an agent CLI refuses to run.
    //
    // `X` (capital) grants execute only on directories and on files that already carry an
    // execute bit, so this reproduces the group grant for one named user without making data
    // files executable. The agent CLIs are thin wrappers that re-exec `$BIN/node` and read
    // `$ROOT/scripts/psu.mjs`, so the grant has to span the tree rather than the three
    // entrypoints; the group already has exactly this access, and root stays the only writer.
    'setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"',
    'for entrypoint in "$INSTALL_ENTRYPOINT" "$ROLLBACK_ENTRYPOINT" "$NODE_ENTRYPOINT" "$MIGRATE_ENTRYPOINT" "$OPERATOR_ENTRYPOINT" "$HEALTH_ENTRYPOINT" "$PSU_ENTRYPOINT" "$PUI_ENTRYPOINT" "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT" "$REMOTE_INITIALIZER_ENTRYPOINT" "$CREDENTIAL_DELIVERY_ENTRYPOINT"; do',
    '  [[ -x "$RELEASE_DIR/$entrypoint" ]] || die "missing executable release entrypoint: $entrypoint"',
    "done",
    '[[ -s "$RELEASE_DIR/$PUI_COMPANION_PATH" ]] || die "missing or empty PUI companion: $PUI_COMPANION_PATH"',
    '[[ -s "$RELEASE_DIR/$PUI_INSTALL_MANIFEST_PATH" ]] || die "missing or empty PUI install manifest: $PUI_INSTALL_MANIFEST_PATH"',
    '"$RELEASE_DIR/$INSTALL_ENTRYPOINT" --action "$BOOTSTRAP_ACTION" --release-root "$RELEASE_DIR" --state-root "$STATE_ROOT"',
    'if [[ "$BOOTSTRAP_ACTION" == "rollback" ]]; then',
    '  "$RELEASE_DIR/$ROLLBACK_ENTRYPOINT" --from "$PREVIOUS_TARGET" --to "$RELEASE_DIR" --state-root "$STATE_ROOT"',
    "fi",
    'NODE_VERSION="$("$RELEASE_DIR/$NODE_ENTRYPOINT" --version)"',
    'NODE_MAJOR="${NODE_VERSION#v}"',
    'NODE_MAJOR="${NODE_MAJOR%%.*}"',
    '[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge "$MINIMUM_NODE_MAJOR" ]] || die "bundled Node runtime is below the required floor"',
    ...agentRuntimeInstallLines(agentRuntimeInstalls),
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[4]}'`,
    '"$RELEASE_DIR/$MIGRATE_ENTRYPOINT" --database-root "$STATE_ROOT/embedded-pg" --migration-id "$MIGRATION_ID"',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[5]}'`,
    'ln -sfn "$RELEASE_DIR" "$RUNTIME_ROOT/current.next"',
    'mv -Tf "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"',
    "SWITCHED=1",
    // The SSH identity deliberately cannot traverse the immutable runtime or credential root. Two
    // root-owned wrappers are therefore the ONLY privilege seam. Each accepts exactly the fixed
    // protocol argv and sudoers repeats that exact allowlist; variable material remains on stdin.
    //
    // BOTH programs are Node scripts carrying a `#!/usr/bin/env node` shebang, and the sudoers
    // entries below pin `env_reset, !setenv` — so the interpreter is resolved against sudo's
    // `secure_path` (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin` on
    // stock Ubuntu 24.04), NOT the caller's PATH. The runtime this host is pinned to is the
    // BUNDLED one at `$RUNTIME_ROOT/current/<node>`, which is deliberately not on that list, so
    // dispatching through the shebang made every privileged invocation die with
    // `/usr/bin/env: 'node': No such file or directory` (exit 127) before a single byte of the
    // request was read — measured live on p046-canary-03, 2026-09-02. Naming the bundled
    // interpreter explicitly is also the stronger contract: it keeps the privileged seam pinned to
    // the signed release's own Node rather than to whatever a future image happens to put on
    // `secure_path`, which a PATH symlink would silently hand it.
    'install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"',
    "cat > \"$REMOTE_INITIALIZER_CONDUIT\" <<'PAPERCUSP_INITIALIZER_CONDUIT'",
    "#!/bin/sh",
    "set -eu",
    '[ "$#" -eq 3 ] || { echo "initializer conduit: refused argv" >&2; exit 64; }',
    `[ "$1" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[0])} ] && [ "$2" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[1])} ] && [ "$3" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[2])} ] || { echo "initializer conduit: refused argv" >&2; exit 64; }`,
    `exec /usr/bin/sudo -n -- ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node}`)} ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.remoteInitializer}`)} "$@"`,
    "PAPERCUSP_INITIALIZER_CONDUIT",
    'install -o root -g root -m 0755 /dev/null "$CREDENTIAL_DELIVERY_CONDUIT"',
    "cat > \"$CREDENTIAL_DELIVERY_CONDUIT\" <<'PAPERCUSP_DELIVERY_CONDUIT'",
    "#!/bin/sh",
    "set -eu",
    '[ "$#" -eq 3 ] || { echo "credential delivery conduit: refused argv" >&2; exit 64; }',
    `[ "$1" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[0])} ] && [ "$2" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[1])} ] && [ "$3" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[2])} ] || { echo "credential delivery conduit: refused argv" >&2; exit 64; }`,
    `exec /usr/bin/sudo -n -- ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node}`)} ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.credentialDelivery}`)} "$@"`,
    "PAPERCUSP_DELIVERY_CONDUIT",
    'chown root:root "$REMOTE_INITIALIZER_CONDUIT" "$CREDENTIAL_DELIVERY_CONDUIT"',
    'chmod 0755 "$REMOTE_INITIALIZER_CONDUIT" "$CREDENTIAL_DELIVERY_CONDUIT"',
    'cat > "$PRIVILEGED_CONDUIT_SUDOERS" <<PAPERCUSP_CONDUIT_SUDOERS',
    // The allowlist must repeat the conduit's argv EXACTLY, interpreter included: sudo matches the
    // whole command vector, so pinning only the script would refuse the very invocation above.
    `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_INITIALIZER = ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node} ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.remoteInitializer} ${WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV.join(" ")}`,
    `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_DELIVERY = ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node} ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.credentialDelivery} ${WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV.join(" ")}`,
    "Defaults!PAPERCUSP_WORKSPACE_HOST_INITIALIZER env_reset, !setenv",
    "Defaults!PAPERCUSP_WORKSPACE_HOST_DELIVERY env_reset, !setenv",
    "$WORKSPACE_USER ALL=(root) NOPASSWD: PAPERCUSP_WORKSPACE_HOST_INITIALIZER, PAPERCUSP_WORKSPACE_HOST_DELIVERY",
    "PAPERCUSP_CONDUIT_SUDOERS",
    'chown root:root "$PRIVILEGED_CONDUIT_SUDOERS"',
    'chmod 0440 "$PRIVILEGED_CONDUIT_SUDOERS"',
    'visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS" >/dev/null',
    'cat > "/etc/systemd/system/$SERVICE_NAME.service" <<PAPERCUSP_SERVICE',
    "[Unit]",
    "Description=Papercusp durable workspace host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=$SERVICE_USER",
    "Group=$SERVICE_GROUP",
    "WorkingDirectory=$STATE_ROOT",
    "Environment=PAPERCUSP_BIND_HOST=127.0.0.1",
    "Environment=PAPERCUSP_PORT=$SERVICE_PORT",
    "Environment=PAPERCUSP_EMBEDDED_PG_ROOT=$STATE_ROOT/embedded-pg",
    "Environment=PAPERCUSP_WORKSPACE_ROOT=$WORKSPACE_ROOT",
    "Environment=PUI_COMPANION_WASM=$RUNTIME_ROOT/current/$PUI_COMPANION_PATH",
    "Environment=PUI_INSTALL_MANIFEST=$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH",
    // CONTENT ROOTS — pinned to the release, NOT to the working directory.
    //
    // WorkingDirectory above is the STATE root (it has to be: it is the only writable place
    // the service owns), but every one of these content resolvers falls back to probing
    // relative to cwd. So on a vm-release host they all probe under the state root, where
    // none of them exists. `promptsDir()` (prompt-assembly.ts) tries
    // cwd/apps/operator/prompts, then cwd/prompts, then a module walk-up for
    // apps/operator/prompts; the bundle lays its content out at the RELEASE root as
    // prompts/, spa/, internal-docs/, templates/, rubrics/ — so all three branches miss and
    // the server dies at boot with "prompt-assembly: oracle.persona.md not found at
    // <state root>/apps/operator/prompts/oracle.persona.md" (measured, P-046, 2026-08-29).
    //
    // Set HERE rather than only in the bundle's own entrypoint because the entrypoint ships
    // INSIDE the signed artifact: fixing it there alone would require rebuilding and
    // re-signing a 273MB bundle to correct four lines of environment. The entrypoint sets
    // these too (install-workspace-host-entrypoints.sh) so future bundles are self-contained;
    // its exports run later and win. Both layers agree, and neither depends on cwd.
    //
    // Prompts is only the first of these to THROW. The others degrade quietly — a server with
    // no SPA or no docs root starts and serves nothing — which is the worse failure.
    "Environment=PAPERCUSP_PROMPTS_DIR=$RUNTIME_ROOT/current/prompts",
    "Environment=PAPERCUSP_SPA_DIST=$RUNTIME_ROOT/current/spa",
    "Environment=PAPERCUSP_DOCS_ROOT=$RUNTIME_ROOT/current/internal-docs",
    "Environment=PAPERCUSP_TEMPLATES_DIR=$RUNTIME_ROOT/current/templates",
    "Environment=PAPERCUSP_RUBRICS_DIR=$RUNTIME_ROOT/current/rubrics",
    "ExecStart=$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT",
    "ExecStartPost=$RUNTIME_ROOT/current/$HEALTH_ENTRYPOINT --host 127.0.0.1 --port $SERVICE_PORT",
    "Restart=on-failure",
    "RestartSec=5s",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectHome=true",
    "ProtectSystem=strict",
    "ReadOnlyPaths=$RUNTIME_ROOT",
    "ReadWritePaths=$STATE_ROOT $WORKSPACE_ROOT",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "UMask=0027",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=papercusp-workspace",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "PAPERCUSP_SERVICE",
    "systemctl daemon-reload",
    // A failed unit start otherwise dies with systemd's generic "Job for ... failed because
    // the control process exited with error code", which names the JOB and not the cause —
    // and the clean-room VM tears itself down before anyone can read its journal. Emit the
    // status and journal INTO the bootstrap's own output so the cause travels with the
    // failure instead of dying with the instance.
    "service_diagnostics() {",
    '  echo "[workspace-host-bootstrap] --- systemctl status $SERVICE_NAME.service ---" >&2',
    '  systemctl status "$SERVICE_NAME.service" --no-pager --full 2>&1 | tail -40 >&2 || true',
    // -o cat, and deliberately NOT -x: systemd's catalog prose ("Subject:/Defined-By:/Support:"
    // blocks) is ~8 lines of boilerplate per event and crowded the SERVICE's own stderr out of
    // the captured window entirely on the first run that had diagnostics at all. What is wanted
    // here is the process's output explaining why ExecStart exited, not systemd's explanation
    // of what a unit is.
    '  echo "[workspace-host-bootstrap] --- journalctl -u $SERVICE_NAME.service (service output) ---" >&2',
    '  journalctl -u "$SERVICE_NAME.service" --no-pager --no-hostname -o cat -n 200 2>&1 | tail -200 >&2 || true',
    // Native-addon inventory. The server loads prebuilt .node addons out of the extracted
    // release tree, and a failure to load one reports only the CANDIDATE PATHS it searched —
    // never whether the file is absent, unreadable, or present-but-rejected. Those three have
    // completely different causes and the error cannot distinguish them, so the question has
    // to be answered from the guest's own filesystem before the instance is destroyed.
    //
    // Measured (P-046, 2026-08-29): a boot failed with "Cannot find addon '.'" whose FIRST
    // candidate was a path that demonstrably exists in the signed bundle, dlopens under the
    // bundled Node, survives the bootstrap's exact chown/chmod treatment, and loads correctly
    // under a faithful local replica of this very unit's sandbox. Every hypothesis that could
    // be tested off-guest was eliminated; only the guest's extracted tree was left, and no
    // instrumentation existed to look at it.
    '  echo "[workspace-host-bootstrap] --- native addon inventory under $RELEASE_DIR ---" >&2',
    '  echo "extracted .node count: $(find "$RELEASE_DIR" -name "*.node" -type f 2>/dev/null | wc -l)" >&2',
    '  find "$RELEASE_DIR" -name "*.node" -type f -printf "%10s %M %u:%g %p\\n" 2>/dev/null | head -40 >&2 || true',
    '  echo "release tree entries: $(find "$RELEASE_DIR" 2>/dev/null | wc -l)" >&2',
    '  df -Pk "$RELEASE_DIR" 2>&1 | tail -2 >&2 || true',
    // The inventory above answers "is the file THERE" and cannot answer "does it LOAD" — two
    // questions with different causes and different fixes that require-addon collapses into
    // one indistinguishable "Cannot find addon" string. So attempt the load and print the
    // error it swallows into `cause`. Two properties of this probe are load-bearing:
    //   * it runs AS THE SERVICE USER, because the inventory runs as root and is therefore
    //     structurally blind to any permission the service user lacks; and
    //   * it reports unresolved SHARED LIBRARIES, because a missing one (libatomic.so.1 —
    //     see the apt install above) is reported by require-addon as a missing ADDON FILE.
    // A `find` whose stderr is discarded cannot distinguish "no matches" from "could not
    // traverse", so a zero count is explicitly marked as possibly-understated rather than
    // being allowed to read as a confident absence.
    '  ADDON_FIND_ERR="$(find "$RELEASE_DIR" -name "*.node" -type f 2>&1 >/dev/null)"',
    '  [[ -z "$ADDON_FIND_ERR" ]] || echo "WARNING: find reported errors; the .node count above may be UNDERSTATED: $ADDON_FIND_ERR" >&2',
    '  echo "[workspace-host-bootstrap] --- addon load probe (as $SERVICE_USER) ---" >&2',
    '  ADDON_PATH="$(find "$RELEASE_DIR" -name "rocksdb-native.node" -type f 2>/dev/null | head -1)"',
    '  NODE_BIN="$(find "$RELEASE_DIR" -type f -name node -perm -u+x 2>/dev/null | head -1)"',
    '  echo "addon: ${ADDON_PATH:-<not found>}" >&2',
    '  echo "node:  ${NODE_BIN:-<not found>}" >&2',
    '  if [[ -n "$ADDON_PATH" ]]; then',
    '    echo "--- unresolved shared libraries (a dlopen failure is reported as a MISSING ADDON) ---" >&2',
    '    ldd "$ADDON_PATH" 2>&1 | grep -i "not found" >&2 || echo "(ldd reports no missing libraries)" >&2',
    "  fi",
    '  if [[ -n "$ADDON_PATH" && -n "$NODE_BIN" ]]; then',
    `    runuser -u "$SERVICE_USER" -- "$NODE_BIN" -e 'try{require(process.argv[1]);console.error("ADDON LOADED OK")}catch(e){console.error("ADDON LOAD FAILED:",e&&e.message);if(e&&e.cause)console.error("CAUSE:",String(e.cause))}' "$ADDON_PATH" 2>&1 | head -20 >&2 || true`,
    "  fi",
    "}",
    'systemctl enable --now "$SERVICE_NAME.service" || { service_diagnostics; die "workspace service failed to start"; }',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[6]}'`,
    'systemctl is-active --quiet "$SERVICE_NAME.service" || { service_diagnostics; die "workspace service is not active after start"; }',
    '"$RUNTIME_ROOT/current/$HEALTH_ENTRYPOINT" --host 127.0.0.1 --port "$SERVICE_PORT"',
    'PUI_OPERATOR="http://127.0.0.1:$SERVICE_PORT" PUI_COMPANION_WASM="$RUNTIME_ROOT/current/$PUI_COMPANION_PATH" PUI_INSTALL_MANIFEST="$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH" "$RUNTIME_ROOT/current/$PUI_ENTRYPOINT" doctor',
    '[[ "$(systemctl show "$SERVICE_NAME.service" --property User --value)" == "$SERVICE_USER" ]] || die "workspace service is not running under the dedicated service user"',
    '[[ "$(systemctl show "$SERVICE_NAME.service" --property Group --value)" == "$SERVICE_GROUP" ]] || die "workspace service is not running under the dedicated service group"',
    '[[ "$(stat -c %U "$RUNTIME_ROOT")" == "root" ]] || die "runtime root must be owned by root"',
    '[[ -z "$(find "$RUNTIME_ROOT/releases" -xdev \\( -type f -o -type d \\) -perm -0004 -print -quit)" ]] || die "runtime release tree must not be world-readable"',
    // The two halves of D-248, asserted together because either one alone is satisfiable by the
    // broken shape. D-043 (owner ruling) requires the SSH account to be locked out of the runtime
    // tree; D-246 measured that the account running the agents must read it. Both are true, and
    // the resolution is that they are not the same account.
    //
    // HALF ONE — the SSH account still cannot read the runtime. This is the assertion D-246
    // deleted and D-248 restores verbatim in intent: it is the mechanical enforcement of D-043's
    // "keep runtime files root-owned/non-readable to the workspace user". Deleting it is how a
    // widened grant ships unnoticed, so it is the first line here rather than the last.
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT" || die "workspace SSH user can read the Papercusp runtime"',
    'for agent_entrypoint in "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"; do',
    '  runuser -u "$WORKSPACE_USER" -- test ! -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "workspace SSH user can execute agent entrypoint: $agent_entrypoint"',
    "done",
    // HALF TWO — the agent identity CAN execute every agent CLI it holds credentials for. This is
    // the property whose absence cost six steps of a live canary and read as three independent
    // credential faults; it passed as `not readable` on every prior host precisely because the
    // agents were unrunnable, which is why it is asserted positively here.
    'for agent_entrypoint in "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"; do',
    '  runuser -u "$AGENT_USER" -- test -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "agent identity cannot execute agent entrypoint: $agent_entrypoint"',
    "done",
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$STATE_ROOT" || die "workspace SSH user can read the runtime state root"',
    'runuser -u "$WORKSPACE_USER" -- test ! -w "$RUNTIME_ROOT/current" || die "workspace SSH user can write the Papercusp runtime"',
    'runuser -u "$WORKSPACE_USER" -- test -w "$WORKSPACE_ROOT" || die "workspace SSH user cannot write the scoped workspace root"',
    // The credential home is the reason the third identity is worth its cost. On a BYOC host the
    // SSH account is the CUSTOMER's access path; before D-248 it owned the delivered Claude/Codex
    // material at 0600 in its own home. Assert the negative directly rather than inferring it
    // from the 0700 mode, because a later group change would defeat the mode silently.
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "workspace SSH user can read the agent credential home"',
    // The agent identity is confined in every direction the SSH account is: it reads the signed
    // runtime and writes the workspace, and nothing else. Runtime WRITE is the property the old
    // read assertion was actually standing in for, and it is asserted for both accounts.
    'runuser -u "$AGENT_USER" -- test ! -r "$STATE_ROOT" || die "agent identity can read the runtime state root"',
    'runuser -u "$AGENT_USER" -- test ! -w "$RUNTIME_ROOT/current" || die "agent identity can write the Papercusp runtime"',
    'runuser -u "$AGENT_USER" -- test -w "$WORKSPACE_ROOT" || die "agent identity cannot write the scoped workspace root"',
    'runuser -u "$SERVICE_USER" -- test -w "$WORKSPACE_ROOT" || die "runtime service cannot write the scoped workspace root"',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "workspace SSH user belongs to the runtime service group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$AGENT_GROUP" >/dev/null; then die "workspace SSH user belongs to the agent group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx sudo >/dev/null; then die "workspace SSH user belongs to sudo"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "agent identity belongs to the runtime service group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$WORKSPACE_GROUP" >/dev/null; then die "agent identity belongs to the workspace SSH group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx sudo >/dev/null; then die "agent identity belongs to sudo"; fi',
    // Non-login, and asserted rather than assumed: `useradd --shell` is a creation-time argument,
    // so on an UPGRADE over a host whose account predates this contract the shell is whatever it
    // already was. The `usermod` above re-applies it; this proves the re-application landed.
    '[[ "$(getent passwd "$AGENT_USER" | cut -d: -f7)" == /usr/sbin/nologin ]] || die "agent identity has a login shell"',
    '[[ "$(stat -c %U:%G:%a "$REMOTE_INITIALIZER_CONDUIT")" == root:root:755 ]] || die "initializer conduit ownership or mode is unsafe"',
    '[[ "$(stat -c %U:%G:%a "$CREDENTIAL_DELIVERY_CONDUIT")" == root:root:755 ]] || die "credential delivery conduit ownership or mode is unsafe"',
    '[[ "$(stat -c %U:%G:%a "$PRIVILEGED_CONDUIT_SUDOERS")" == root:root:440 ]] || die "conduit sudoers ownership or mode is unsafe"',
    'visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS" >/dev/null || die "conduit sudoers policy is invalid"',
    // Ownership, mode and sudoers syntax were ALL green on a host whose conduits could not run a
    // single request: every privileged invocation died 127 resolving its interpreter. Those three
    // checks describe the wrapper's FILE, and the thing that broke was its EXECUTION, so no
    // strengthening of them could have caught it. Assert instead that each command vector the
    // sudoers allowlist pins is actually executable — the interpreter first, since that is the
    // element `secure_path` decides and the one that was missing.
    'CONDUIT_NODE="$RUNTIME_ROOT/current/$NODE_ENTRYPOINT"',
    '[[ -x "$CONDUIT_NODE" ]] || die "conduit interpreter is missing or not executable: $CONDUIT_NODE"',
    '[[ -x "$RUNTIME_ROOT/current/$REMOTE_INITIALIZER_ENTRYPOINT" ]] || die "conduit initializer target is missing or not executable"',
    '[[ -x "$RUNTIME_ROOT/current/$CREDENTIAL_DELIVERY_ENTRYPOINT" ]] || die "conduit delivery target is missing or not executable"',
    'grep -Fq "$CONDUIT_NODE" "$REMOTE_INITIALIZER_CONDUIT" || die "initializer conduit does not pin the bundled interpreter"',
    'grep -Fq "$CONDUIT_NODE" "$CREDENTIAL_DELIVERY_CONDUIT" || die "credential delivery conduit does not pin the bundled interpreter"',
    'SSHD_POLICY="$(sshd -T -C user="$WORKSPACE_USER",host=localhost,addr=127.0.0.1)"',
    'grep -Fx "allowtcpforwarding local" <<<"$SSHD_POLICY" >/dev/null || die "SSH TCP forwarding must be local-only"',
    'grep -Fx "permitopen 127.0.0.1:$SERVICE_PORT" <<<"$SSHD_POLICY" >/dev/null || die "SSH forwarding must be restricted to the loopback operator"',
    'OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    `CHECKS_JSON=${shellQuote(checksJson)}`,
    'ATTESTATION_PATH="$STATE_ROOT/bootstrap-attestation.json"',
    'jq -n --arg contractVersion "$CONTRACT_VERSION" --arg hostId "$HOST_ID" --arg action "$BOOTSTRAP_ACTION" --arg ubuntuVersion "$VERSION_ID" --arg observedAt "$OBSERVED_AT" --arg releaseVersion "$RELEASE_VERSION" --arg source "$BUNDLE_URL" --arg bundleSha256 "$BUNDLE_SHA256" --arg signingKeySha256 "$SIGNING_KEY_SHA256" --arg migrationId "$MIGRATION_ID" --arg serviceName "$SERVICE_NAME" --arg serviceUser "$SERVICE_USER" --arg serviceGroup "$SERVICE_GROUP" --arg workspaceUser "$WORKSPACE_USER" --arg workspaceGroup "$WORKSPACE_GROUP" --arg agentUser "$AGENT_USER" --arg agentGroup "$AGENT_GROUP" --arg runtimeRoot "$RUNTIME_ROOT" --arg stateRoot "$STATE_ROOT" --arg workspaceRoot "$WORKSPACE_ROOT" --argjson nodeMajor "$NODE_MAJOR" --argjson minimumNodeMajor "$MINIMUM_NODE_MAJOR" --argjson servicePort "$SERVICE_PORT" ' + agentRuntimeJqArgs + '--argjson checks "$CHECKS_JSON" \\',
    '  \'{contractVersion:$contractVersion,hostId:$hostId,action:$action,ubuntuVersion:$ubuntuVersion,observedAt:$observedAt,status:"healthy",release:{version:$releaseVersion,source:$source,bundleSha256:$bundleSha256,signingKeySha256:$signingKeySha256,signatureVerified:true},migration:{id:$migrationId,applied:true},runtime:{nodeMajor:$nodeMajor,minimumNodeMajor:$minimumNodeMajor,psu:true,pui:true,agentLaunchers:{claude:true,codex:true,omp:true},agentRuntimesVerifiedByBootstrap:false,agentRuntimesInstalledByBootstrap:' + agentRuntimesInstalled + agentRuntimeJqFields + '},service:{name:$serviceName,user:$serviceUser,group:$serviceGroup,bindHost:"127.0.0.1",port:$servicePort,active:true},isolation:{workspaceUser:$workspaceUser,workspaceGroup:$workspaceGroup,agentUser:$agentUser,agentGroup:$agentGroup,runtimeRoot:$runtimeRoot,stateRoot:$stateRoot,workspaceRoot:$workspaceRoot,runtimeReadableByWorkspaceUser:false,runtimeWritableByWorkspaceUser:false,runtimeReadableByAgentUser:true,runtimeWritableByAgentUser:false,agentHomeReadableBySshUser:false,workspaceWritableByService:true,workspaceWritableBySshUser:true,workspaceWritableByAgentUser:true,sudo:false,serviceGroupMember:false,operatorIngress:"ssh-local-forward",updateMode:"signed-atomic-release-swap"},checks:$checks}\' > "$ATTESTATION_PATH"',
    'chown "$SERVICE_USER:$SERVICE_GROUP" "$ATTESTATION_PATH"',
    'chmod 0640 "$ATTESTATION_PATH"',
    `printf '${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}%s\\n' "$(base64 --wrap=0 < \"$ATTESTATION_PATH\")"`,
    "SWITCHED=0",
    'log "bootstrap complete"',
  ];

  return `${lines.join('\n')}\n`;
}

function addMismatch(
  errors: string[],
  condition: unknown,
  message: string,
): void {
  if (!condition) errors.push(message);
}

/** Parse the final base64 attestation line from remote bootstrap stdout. */
export function parseWorkspaceHostBootstrapAttestation(
  stdout: string,
): WorkspaceHostBootstrapAttestation {
  const lines = stdout.split(/\r?\n/);
  let line: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX)) {
      line = lines[index];
      break;
    }
  }
  if (!line)
    throw new Error(
      'Workspace-host bootstrap output did not contain an attestation',
    );
  const encoded = line.slice(
    WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX.length,
  );
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8'),
    ) as WorkspaceHostBootstrapAttestation;
  } catch (error) {
    throw new Error(
      'Workspace-host bootstrap attestation is not valid base64 JSON',
      { cause: error },
    );
  }
}

/**
 * Validate the remote result against the exact requested release, trust root,
 * migration, runtime floor, and loopback service contract.
 */
export function validateWorkspaceHostBootstrapAttestation(
  attestation: unknown,
  expected: WorkspaceHostBootstrapInput,
): WorkspaceHostBootstrapAttestationValidation {
  const validated = validateInput(expected);
  const errors: string[] = [];
  try {
    assertWorkspaceHostSecretIsolation(attestation, 'bootstrap.attestation');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (
    !isRecord(attestation) ||
    !isRecord(attestation.release) ||
    !isRecord(attestation.migration) ||
    !isRecord(attestation.runtime) ||
    !isRecord(attestation.service) ||
    !isRecord(attestation.isolation) ||
    !Array.isArray(attestation.checks)
  ) {
    return {
      ok: false,
      errors: [...errors, 'bootstrap attestation has an invalid shape'],
    };
  }
  const candidate = attestation as unknown as WorkspaceHostBootstrapAttestation;

  addMismatch(
    errors,
    candidate.contractVersion === expected.contractVersion,
    'contract version mismatch',
  );
  addMismatch(errors, candidate.hostId === expected.hostId, 'host id mismatch');
  addMismatch(
    errors,
    candidate.action === expected.action,
    'bootstrap action mismatch',
  );
  addMismatch(
    errors,
    candidate.ubuntuVersion === WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
    'Ubuntu version mismatch',
  );
  addMismatch(
    errors,
    Number.isFinite(Date.parse(candidate.observedAt)),
    'observedAt must be an ISO timestamp',
  );
  addMismatch(
    errors,
    candidate.status === 'healthy',
    'bootstrap status is not healthy',
  );
  addMismatch(
    errors,
    candidate.release.version === expected.release.version,
    'release version mismatch',
  );
  addMismatch(
    errors,
    candidate.release.source === expected.release.bundleUrl,
    'release source mismatch',
  );
  addMismatch(
    errors,
    candidate.release.bundleSha256 ===
      expected.release.bundleSha256.toLowerCase(),
    'release digest mismatch',
  );
  addMismatch(
    errors,
    candidate.release.signingKeySha256 ===
      expected.release.signingKeySha256.toLowerCase(),
    'signing key mismatch',
  );
  addMismatch(
    errors,
    candidate.release.signatureVerified === true,
    'release signature was not verified',
  );
  addMismatch(
    errors,
    candidate.migration.id === expected.migrationId,
    'migration id mismatch',
  );
  addMismatch(
    errors,
    candidate.migration.applied === true,
    'migration was not applied',
  );
  addMismatch(
    errors,
    Number.isSafeInteger(candidate.runtime.nodeMajor) &&
      candidate.runtime.nodeMajor >= expected.minimumNodeMajor,
    'Node runtime is below the requested floor',
  );
  addMismatch(
    errors,
    candidate.runtime.minimumNodeMajor === expected.minimumNodeMajor,
    'Node runtime floor mismatch',
  );
  addMismatch(
    errors,
    candidate.runtime.psu === true &&
      candidate.runtime.pui === true &&
      candidate.runtime.agentLaunchers?.claude === true &&
      candidate.runtime.agentLaunchers?.codex === true &&
      candidate.runtime.agentLaunchers?.omp === true,
    'agent launcher prerequisite check failed',
  );
  // Refuse the OPTIMISTIC lie specifically. A host claiming bootstrap verified its agent
  // runtimes is either running pre-D-252 code or has been hand-edited, and in both cases the
  // claim is unbacked — bootstrap has no probe that could establish it. Asserting the literal
  // `false` rather than ignoring the field is what makes a stale attestation legible instead of
  // merely tolerated.
  addMismatch(
    errors,
    candidate.runtime.agentRuntimesVerifiedByBootstrap === false,
    'attestation claims bootstrap verified the agent runtimes; bootstrap cannot establish that (D-252)',
  );
  addMismatch(
    errors,
    candidate.service.name === expected.service.name,
    'service name mismatch',
  );
  addMismatch(
    errors,
    candidate.service.user === validated.serviceUser,
    'service user mismatch',
  );
  addMismatch(
    errors,
    candidate.service.group === validated.serviceGroup,
    'service group mismatch',
  );
  addMismatch(
    errors,
    candidate.service.bindHost === '127.0.0.1',
    'operator must bind to loopback',
  );
  addMismatch(
    errors,
    candidate.service.port === expected.service.port,
    'service port mismatch',
  );
  addMismatch(
    errors,
    candidate.service.active === true,
    'workspace service is not active',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceUser === validated.workspaceUser,
    'workspace SSH user mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceGroup === validated.workspaceGroup,
    'workspace SSH group mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeRoot === WORKSPACE_HOST_RUNTIME_ROOT &&
      candidate.isolation.stateRoot === WORKSPACE_HOST_STATE_ROOT &&
      candidate.isolation.workspaceRoot === WORKSPACE_HOST_DATA_ROOT,
    'workspace isolation path mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.agentUser === validated.agentUser,
    'agent identity mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.agentGroup === validated.agentGroup,
    'agent group mismatch',
  );
  // Asserted here and not only on the host, because this validator is what a caller who never
  // saw the host runs. Each of the three is independently satisfiable by the broken shape: a
  // host with only the first has no runnable agents, one with only the second is D-246's
  // violation of D-043, and one with only the third can hand the customer's login the platform's
  // agent credentials. Naming them separately is what makes the failure legible.
  addMismatch(
    errors,
    candidate.isolation.runtimeReadableByWorkspaceUser === false,
    'workspace SSH user can read the Papercusp runtime (D-043)',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeReadableByAgentUser === true,
    'agent identity cannot read the runtime it must execute agents from',
  );
  addMismatch(
    errors,
    candidate.isolation.agentHomeReadableBySshUser === false,
    'workspace SSH user can read the delivered agent credential home',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeWritableByWorkspaceUser === false &&
      candidate.isolation.runtimeWritableByAgentUser === false,
    'an unprivileged identity can write the runtime',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceWritableByService === true &&
      candidate.isolation.workspaceWritableBySshUser === true &&
      candidate.isolation.workspaceWritableByAgentUser === true,
    'scoped workspace ACL verification failed',
  );
  addMismatch(
    errors,
    candidate.isolation.sudo === false &&
      candidate.isolation.serviceGroupMember === false,
    'workspace SSH user has privileged runtime membership',
  );
  addMismatch(
    errors,
    candidate.isolation.operatorIngress === 'ssh-local-forward',
    'operator ingress is not restricted to authenticated SSH forwarding',
  );
  addMismatch(
    errors,
    candidate.isolation.updateMode === 'signed-atomic-release-swap',
    'runtime update mode is not a signed atomic release swap',
  );

  const checks = candidate.checks.filter(
    (check) => isRecord(check) && typeof check.name === 'string',
  );
  const checkMap = new Map(checks.map((check) => [check.name, check.ok]));
  for (const check of WORKSPACE_HOST_BOOTSTRAP_CHECKS) {
    addMismatch(
      errors,
      checkMap.get(check) === true,
      `required bootstrap check '${check}' did not pass`,
    );
  }
  addMismatch(
    errors,
    checks.length === candidate.checks.length,
    'bootstrap attestation contains invalid checks',
  );
  addMismatch(
    errors,
    checkMap.size === checks.length,
    'bootstrap attestation contains duplicate checks',
  );
  return { ok: errors.length === 0, errors };
}
