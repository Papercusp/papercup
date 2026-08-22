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
  'papercusp-workspace-host-bootstrap-v1';
export const WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION = '24.04';
export const WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX =
  'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=';

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
  'ubuntu-24.04',
  'bundle-digest',
  'bundle-signature',
  'node-runtime',
  'embedded-postgres-migration',
  'agent-cli-prerequisites',
  'loopback-service',
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
  claude: string;
  codex: string;
  omp: string;
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
    claude: 'bin/claude',
    codex: 'bin/codex',
    omp: 'bin/omp',
  };

export interface WorkspaceHostBootstrapService {
  /** systemd unit basename, without `.service`. */
  name: string;
  /** Operator HTTP port. The generated service always binds it to 127.0.0.1. */
  port: number;
  user?: string;
  group?: string;
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
  entrypoints?: Partial<WorkspaceHostBootstrapEntrypoints>;
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
    claude: true;
    codex: true;
    omp: true;
  };
  service: {
    name: string;
    bindHost: '127.0.0.1';
    port: number;
    active: true;
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

function validateInput(
  input: WorkspaceHostBootstrapInput,
): WorkspaceHostBootstrapEntrypoints {
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
  requireCondition(
    SAFE_LINUX_NAME.test(input.service.user ?? 'papercusp'),
    'service.user must be a safe Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(input.service.group ?? 'papercusp'),
    'service.group must be a safe Linux name',
  );
  assertWorkspaceHostSecretIsolation(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  assertNoSecretShapedMetadata(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  return normalizedEntrypoints(input.entrypoints);
}

function assignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

/**
 * Emit a deterministic, replay-safe root bootstrap for install, upgrade, or
 * rollback. The release bundle supplies Node, embedded Postgres tooling, psu,
 * and agent CLIs; apt installs only host security/verification prerequisites.
 */
export function buildWorkspaceHostBootstrap(
  input: WorkspaceHostBootstrapInput,
): string {
  const entrypoints = validateInput(input);
  const serviceUser = input.service.user ?? 'papercusp';
  const serviceGroup = input.service.group ?? serviceUser;
  const digest = input.release.bundleSha256.toLowerCase();
  const signingKeyDigest = input.release.signingKeySha256.toLowerCase();
  const checksJson = JSON.stringify(
    WORKSPACE_HOST_BOOTSTRAP_CHECKS.map((name) => ({ name, ok: true })),
  );

  const lines = [
    '#!/usr/bin/env bash',
    `# Generated by ${WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION}; contains public provenance only.`,
    'set -Eeuo pipefail',
    'umask 027',
    assignment('CONTRACT_VERSION', input.contractVersion),
    assignment('BOOTSTRAP_ACTION', input.action),
    assignment('HOST_ID', input.hostId),
    assignment('RELEASE_VERSION', input.release.version),
    assignment('BUNDLE_URL', input.release.bundleUrl),
    assignment('BUNDLE_SHA256', digest),
    assignment('SIGNATURE_URL', input.release.signatureUrl),
    assignment('SIGNING_KEY_SHA256', signingKeyDigest),
    assignment(
      'SIGNING_PUBLIC_KEY_B64',
      base64(input.release.signingPublicKey),
    ),
    assignment('MIGRATION_ID', input.migrationId),
    `MINIMUM_NODE_MAJOR=${input.minimumNodeMajor}`,
    assignment('SERVICE_NAME', input.service.name),
    `SERVICE_PORT=${input.service.port}`,
    assignment('SERVICE_USER', serviceUser),
    assignment('SERVICE_GROUP', serviceGroup),
    assignment('INSTALL_ENTRYPOINT', entrypoints.install),
    assignment('ROLLBACK_ENTRYPOINT', entrypoints.rollback),
    assignment('NODE_ENTRYPOINT', entrypoints.node),
    assignment('MIGRATE_ENTRYPOINT', entrypoints.migrate),
    assignment('OPERATOR_ENTRYPOINT', entrypoints.operator),
    assignment('HEALTH_ENTRYPOINT', entrypoints.health),
    assignment('PSU_ENTRYPOINT', entrypoints.psu),
    assignment('CLAUDE_ENTRYPOINT', entrypoints.claude),
    assignment('CODEX_ENTRYPOINT', entrypoints.codex),
    assignment('OMP_ENTRYPOINT', entrypoints.omp),
    '',
    'log() { printf "[workspace-host-bootstrap] %s\\n" "$1"; }',
    'die() { log "ERROR: $1" >&2; exit 1; }',
    'phase() { log "phase:$1"; }',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[0]}'`,
    '[[ "${EUID}" -eq 0 ]] || die "bootstrap must run as root"',
    '# shellcheck disable=SC1091',
    'source /etc/os-release',
    `[[ "${'${ID:-}'}" == 'ubuntu' && "${'${VERSION_ID:-}'}" == '${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}' ]] || die "Ubuntu ${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION} is required"`,
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[1]}'`,
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y --no-install-recommends ca-certificates curl jq minisign openssh-server ufw unattended-upgrades',
    'getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"',
    'id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --gid "$SERVICE_GROUP" --home-dir /var/lib/papercusp --create-home --shell /usr/sbin/nologin "$SERVICE_USER"',
    'usermod --lock --shell /usr/sbin/nologin "$SERVICE_USER"',
    'install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 /var/lib/papercusp /var/lib/papercusp/embedded-pg',
    'install -d -o root -g "$SERVICE_GROUP" -m 0750 /opt/papercusp /opt/papercusp/releases /etc/papercusp',
    "cat > /etc/ssh/sshd_config.d/60-papercusp-workspace.conf <<'PAPERCUSP_SSH'",
    '# Managed by Papercusp workspace-host bootstrap.',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'PubkeyAuthentication yes',
    'AllowTcpForwarding yes',
    'GatewayPorts no',
    'X11Forwarding no',
    'PAPERCUSP_SSH',
    'sshd -t',
    'systemctl reload ssh 2>/dev/null || systemctl reload sshd',
    'ufw default deny incoming',
    'ufw default allow outgoing',
    'ufw allow 22/tcp',
    'ufw --force enable',
    'systemctl enable --now unattended-upgrades.service',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[2]}'`,
    'WORK_DIR="$(mktemp -d /var/tmp/papercusp-bootstrap.XXXXXX)"',
    'BUNDLE_PATH="$WORK_DIR/server-bundle.tgz"',
    'SIGNATURE_PATH="$WORK_DIR/server-bundle.tgz.minisig"',
    'PUBLIC_KEY_PATH="$WORK_DIR/bootstrap-public.key"',
    'STAGE_DIR=""',
    'PREVIOUS_TARGET="$(readlink -f /opt/papercusp/current 2>/dev/null || true)"',
    'SWITCHED=0',
    'restore_previous() {',
    '  [[ "$SWITCHED" -eq 1 && -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]] || return 0',
    '  ln -sfn "$PREVIOUS_TARGET" /opt/papercusp/current.next',
    '  mv -Tf /opt/papercusp/current.next /opt/papercusp/current',
    '  systemctl restart "$SERVICE_NAME.service" || true',
    '}',
    'cleanup() {',
    '  status=$?',
    '  if [[ "$status" -ne 0 ]]; then restore_previous; fi',
    '  [[ -z "$STAGE_DIR" || ! -d "$STAGE_DIR" ]] || rm -rf -- "$STAGE_DIR"',
    '  rm -rf -- "$WORK_DIR"',
    '  exit "$status"',
    '}',
    'trap cleanup EXIT',
    'curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$BUNDLE_URL" --output "$BUNDLE_PATH"',
    'curl --fail --silent --show-error --location --proto "=https" --tlsv1.2 "$SIGNATURE_URL" --output "$SIGNATURE_PATH"',
    'printf "%s  %s\\n" "$BUNDLE_SHA256" "$BUNDLE_PATH" | sha256sum --check --strict -',
    'printf "%s" "$SIGNING_PUBLIC_KEY_B64" | base64 --decode > "$PUBLIC_KEY_PATH"',
    'printf "%s  %s\\n" "$SIGNING_KEY_SHA256" "$PUBLIC_KEY_PATH" | sha256sum --check --strict -',
    'minisign -Vm "$BUNDLE_PATH" -x "$SIGNATURE_PATH" -p "$PUBLIC_KEY_PATH" >/dev/null',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[3]}'`,
    'RELEASE_DIR="/opt/papercusp/releases/$RELEASE_VERSION"',
    'if [[ ! -d "$RELEASE_DIR" ]]; then',
    '  STAGE_DIR="$(mktemp -d "/opt/papercusp/releases/.${RELEASE_VERSION}.XXXXXX")"',
    '  tar --extract --gzip --file "$BUNDLE_PATH" --directory "$STAGE_DIR" --no-same-owner --no-same-permissions',
    '  mv -T "$STAGE_DIR" "$RELEASE_DIR"',
    '  STAGE_DIR=""',
    'fi',
    'for entrypoint in "$INSTALL_ENTRYPOINT" "$ROLLBACK_ENTRYPOINT" "$NODE_ENTRYPOINT" "$MIGRATE_ENTRYPOINT" "$OPERATOR_ENTRYPOINT" "$HEALTH_ENTRYPOINT" "$PSU_ENTRYPOINT" "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"; do',
    '  [[ -x "$RELEASE_DIR/$entrypoint" ]] || die "missing executable release entrypoint: $entrypoint"',
    'done',
    '"$RELEASE_DIR/$INSTALL_ENTRYPOINT" --action "$BOOTSTRAP_ACTION" --release-root "$RELEASE_DIR" --state-root /var/lib/papercusp',
    'if [[ "$BOOTSTRAP_ACTION" == "rollback" ]]; then',
    '  "$RELEASE_DIR/$ROLLBACK_ENTRYPOINT" --from "$PREVIOUS_TARGET" --to "$RELEASE_DIR" --state-root /var/lib/papercusp',
    'fi',
    'NODE_VERSION="$("$RELEASE_DIR/$NODE_ENTRYPOINT" --version)"',
    'NODE_MAJOR="${NODE_VERSION#v}"',
    'NODE_MAJOR="${NODE_MAJOR%%.*}"',
    '[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge "$MINIMUM_NODE_MAJOR" ]] || die "bundled Node runtime is below the required floor"',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[4]}'`,
    '"$RELEASE_DIR/$MIGRATE_ENTRYPOINT" --database-root /var/lib/papercusp/embedded-pg --migration-id "$MIGRATION_ID"',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[5]}'`,
    'ln -sfn "$RELEASE_DIR" /opt/papercusp/current.next',
    'mv -Tf /opt/papercusp/current.next /opt/papercusp/current',
    'SWITCHED=1',
    'cat > "/etc/systemd/system/$SERVICE_NAME.service" <<PAPERCUSP_SERVICE',
    '[Unit]',
    'Description=Papercusp durable workspace host',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=$SERVICE_USER',
    'Group=$SERVICE_GROUP',
    'WorkingDirectory=/var/lib/papercusp',
    'Environment=PAPERCUSP_BIND_HOST=127.0.0.1',
    'Environment=PAPERCUSP_PORT=$SERVICE_PORT',
    'Environment=PAPERCUSP_EMBEDDED_PG_ROOT=/var/lib/papercusp/embedded-pg',
    'ExecStart=/opt/papercusp/current/$OPERATOR_ENTRYPOINT',
    'ExecStartPost=/opt/papercusp/current/$HEALTH_ENTRYPOINT --host 127.0.0.1 --port $SERVICE_PORT',
    'Restart=on-failure',
    'RestartSec=5s',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectHome=true',
    'ProtectSystem=strict',
    'ReadWritePaths=/var/lib/papercusp',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'StandardOutput=journal',
    'StandardError=journal',
    'SyslogIdentifier=papercusp-workspace',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'PAPERCUSP_SERVICE',
    'systemctl daemon-reload',
    'systemctl enable --now "$SERVICE_NAME.service"',
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[6]}'`,
    'systemctl is-active --quiet "$SERVICE_NAME.service"',
    '"/opt/papercusp/current/$HEALTH_ENTRYPOINT" --host 127.0.0.1 --port "$SERVICE_PORT"',
    'OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    `CHECKS_JSON=${shellQuote(checksJson)}`,
    'ATTESTATION_PATH=/var/lib/papercusp/bootstrap-attestation.json',
    'jq -n --arg contractVersion "$CONTRACT_VERSION" --arg hostId "$HOST_ID" --arg action "$BOOTSTRAP_ACTION" --arg ubuntuVersion "$VERSION_ID" --arg observedAt "$OBSERVED_AT" --arg releaseVersion "$RELEASE_VERSION" --arg source "$BUNDLE_URL" --arg bundleSha256 "$BUNDLE_SHA256" --arg signingKeySha256 "$SIGNING_KEY_SHA256" --arg migrationId "$MIGRATION_ID" --arg serviceName "$SERVICE_NAME" --argjson nodeMajor "$NODE_MAJOR" --argjson minimumNodeMajor "$MINIMUM_NODE_MAJOR" --argjson servicePort "$SERVICE_PORT" --argjson checks "$CHECKS_JSON" \\',
    '  \'{contractVersion:$contractVersion,hostId:$hostId,action:$action,ubuntuVersion:$ubuntuVersion,observedAt:$observedAt,status:"healthy",release:{version:$releaseVersion,source:$source,bundleSha256:$bundleSha256,signingKeySha256:$signingKeySha256,signatureVerified:true},migration:{id:$migrationId,applied:true},runtime:{nodeMajor:$nodeMajor,minimumNodeMajor:$minimumNodeMajor,psu:true,claude:true,codex:true,omp:true},service:{name:$serviceName,bindHost:"127.0.0.1",port:$servicePort,active:true},checks:$checks}\' > "$ATTESTATION_PATH"',
    'chown "$SERVICE_USER:$SERVICE_GROUP" "$ATTESTATION_PATH"',
    'chmod 0640 "$ATTESTATION_PATH"',
    `printf '${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}%s\\n' "$(base64 --wrap=0 < \"$ATTESTATION_PATH\")"`,
    'SWITCHED=0',
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
  validateInput(expected);
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
      candidate.runtime.claude === true &&
      candidate.runtime.codex === true &&
      candidate.runtime.omp === true,
    'agent CLI prerequisite check failed',
  );
  addMismatch(
    errors,
    candidate.service.name === expected.service.name,
    'service name mismatch',
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
