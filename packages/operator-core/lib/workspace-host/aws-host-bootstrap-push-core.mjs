import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT = '/var/lib/papercusp';
export const WORKSPACE_HOST_DURABLE_WORKSPACE_ROOT = '/srv/papercusp/workspaces';
export const AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES = 48 * 1024;
export const AWS_HOST_BOOTSTRAP_UNIT = 'papercusp-workspace-host-bootstrap';
export const AWS_HOST_BOOTSTRAP_STAGING_DIR = '/var/lib/papercusp-host-bootstrap';
export const AWS_DATA_DEVICE_WAIT_SEC = 300;
export const AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC = 120;

const VOLUME_ID = /^vol-[0-9a-f]{8,17}$/;

export function awsEbsNvmeDevicePathCore(volumeId) {
  if (!VOLUME_ID.test(volumeId)) throw new Error(`aws_workspace_host_volume_id_invalid: ${JSON.stringify(volumeId)}`);
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace('-', '')}`;
}

/** Customer identity comes from the controller's binding, never provider metadata or a guest. */
export function workspaceHostDurableTenantIdentity(workspaceId, customerWorkspaceId) {
  if (![workspaceId, customerWorkspaceId].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('durable tenant identity requires workspace and customer workspace');
  }
  return createHash('sha256').update(JSON.stringify(['papercusp-durable-tenant-v1', workspaceId, customerWorkspaceId])).digest('hex');
}

/** Shared by both provider renderers: probe failure is never blank-media proof. */
export function renderDurableDataProbeCore(dataMode = 'fresh') {
  if (!['fresh', 'existing'].includes(dataMode)) throw new Error('durable data mode must be fresh or existing');
  return [
    `data_mode='${dataMode}'`,
    'data_freshly_formatted=0',
    // This is on the boot disk, outside the durable mount. A provision script
    // persists across GCP reboots; its fresh-format permission must not persist.
    'data_probe_state_dir=/var/lib/papercusp-host-bootstrap/data-identity',
    '[[ ! -L "$data_probe_state_dir" ]] || { echo "durable identity directory is a symlink" >&2; exit 1; }',
    'install -d -m 0700 "$data_probe_state_dir"',
    'data_probe_marker="$data_probe_state_dir/$(basename "$data_device").uuid"',
    'exec 9>"${data_probe_marker}.lock"',
    'flock -n 9 || { echo "durable data initialization is already running" >&2; exit 1; }',
    '[[ ! -L "$data_probe_marker" ]] || { echo "durable identity marker is a symlink" >&2; exit 1; }',
    'if [[ -e "$data_probe_marker" ]]; then data_mode=existing; fi',
    'data_probe_status=0',
    'data_type=$(blkid -p -s TYPE -o value "$data_device") || data_probe_status=$?',
    'if [[ "$data_probe_status" == 0 && "$data_type" == ext4 ]]; then',
    '  : # Existing ext4 is mounted without formatting.',
    'elif [[ "$data_mode" == fresh && "$data_probe_status" == 2 && -z "$data_type" ]]; then',
    '  data_signatures=$(wipefs --no-act --noheadings --output TYPE "$data_device") || { echo "durable data signature probe failed" >&2; exit 1; }',
    '  [[ -z "${data_signatures//[[:space:]]/}" ]] || { echo "durable data device has existing signatures" >&2; exit 1; }',
    '  mkfs.ext4 "$data_device"',
    '  data_freshly_formatted=1',
    'else',
    '  echo "durable data filesystem unavailable or unsupported; refusing to format" >&2; exit 1',
    'fi',
    'data_uuid=$(blkid -p -s UUID -o value "$data_device")',
    '[[ "$data_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "durable data UUID unavailable" >&2; exit 1; }',
    'if [[ -e "$data_probe_marker" ]]; then',
    '  [[ "$(cat "$data_probe_marker")" == "$data_uuid" ]] || { echo "durable data UUID changed" >&2; exit 1; }',
    'else',
    '  (set -o noclobber; printf "%s\\n" "$data_uuid" > "$data_probe_marker")',
    'fi',
    // Do not let agents/services launched by the later bootstrap inherit the lock.
    'flock -u 9',
    'exec 9>&-',
  ];
}

/** Validate the actual mount and on-volume tenant before touching any customer state. */
export function renderDurableTenantGuardCore(tenantIdentity) {
  if (tenantIdentity !== undefined && !/^[a-f0-9]{64}$/.test(tenantIdentity)) {
    throw new Error('durable tenant identity must be a controller-derived sha256');
  }
  return [
    'data_mounted_uuid=$(findmnt -rn -M "$data_mount" -o UUID)',
    '[[ "$data_mounted_uuid" == "$data_uuid" && "$(findmnt -rn -M "$data_mount" -o FSROOT)" == / ]] || { echo "durable data mount identity mismatch" >&2; exit 1; }',
    'data_tenant_marker="$data_mount/.papercusp-tenant"',
    '[[ ! -L "$data_tenant_marker" ]] || { echo "durable tenant marker is a symlink" >&2; exit 1; }',
    `data_expected_tenant='${tenantIdentity ?? ''}'`,
    'exec 9>"${data_probe_marker}.lock"',
    'flock -n 9 || { echo "durable tenant initialization is already running" >&2; exit 1; }',
    'if [[ -n "$data_expected_tenant" ]]; then',
    '  data_expected_marker="papercusp-tenant-v1:${data_expected_tenant}:${data_uuid}"',
    '  if [[ -e "$data_tenant_marker" ]]; then',
    '    [[ -f "$data_tenant_marker" && "$(stat -c %u:%a "$data_tenant_marker")" == 0:600 && "$(cat "$data_tenant_marker")" == "$data_expected_marker" ]] || { echo "durable tenant identity mismatch" >&2; exit 1; }',
    '  else',
    '    [[ "$data_freshly_formatted" == 1 ]] || { echo "existing durable volume has no tenant marker; refusing empty initialization" >&2; exit 1; }',
    '    (umask 077; set -o noclobber; printf "%s\\n" "$data_expected_marker" > "$data_tenant_marker")',
    '    sync -f "$data_tenant_marker"',
    '  fi',
    'elif [[ -e "$data_tenant_marker" ]]; then',
    '  echo "controller tenant identity required for bound durable volume" >&2; exit 1',
    'fi',
    'flock -u 9',
    'exec 9>&-',
  ];
}

export function renderDurableFilesystemScriptCore(input) {
  if (!/^\/dev\/disk\/by-id\/[A-Za-z0-9._:-]+$/.test(input.devicePath)) {
    throw new Error(`durable data device must be a /dev/disk/by-id path, got ${JSON.stringify(input.devicePath)}`);
  }
  if (!Number.isInteger(input.deviceWaitSec) || input.deviceWaitSec < 1) {
    throw new Error(`durable data device wait must be a positive whole number of seconds, got ${input.deviceWaitSec}`);
  }
  const workspaceDataRoot = input.workspaceDataRoot ?? WORKSPACE_HOST_DURABLE_WORKSPACE_ROOT;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(workspaceDataRoot)) {
    throw new Error(`durable workspace root must be a plain absolute path, got ${JSON.stringify(workspaceDataRoot)}`);
  }
  const userScript = input.hostBootstrapScript?.trim().replace(/^#![^\n]*(?:\n|$)/, '');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `data_device='${input.devicePath}'`,
    `data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`,
    `for attempt in $(seq 1 ${input.deviceWaitSec}); do test -b "$data_device" && break; sleep 1; done`,
    'test -b "$data_device"',
    ...renderDurableDataProbeCore(input.dataMode),
    'install -d -m 0750 "$data_mount"',
    'grep -q "^UUID=${data_uuid} " /etc/fstab || printf "UUID=%s %s ext4 defaults,nofail,discard 0 2\\n" "$data_uuid" "$data_mount" >> /etc/fstab',
    'mountpoint -q "$data_mount" || mount "$data_mount"',
    ...renderDurableTenantGuardCore(input.tenantIdentity),
    'resize2fs "$data_device"',
    'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon -F "$data_mount"; fi',
    'install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}',
    'home_target="$(readlink -f -- /home)"',
    '[[ -n "$home_target" && -d "$home_target" && ! -L "$home_target" ]] || { echo "workspace home mount target is not a real directory: /home -> ${home_target:-unresolved}" >&2; exit 1; }',
    'if [[ ! -e "$data_mount/home" && ! -L "$data_mount/home" ]]; then',
    '  home_seed="$(mktemp -d "$data_mount/.home-seed.XXXXXX")"',
    '  cp -a "$home_target"/. "$home_seed"/',
    '  mv -T -- "$home_seed" "$data_mount/home"',
    'fi',
    '[[ -d "$data_mount/home" && ! -L "$data_mount/home" ]] || { echo "durable home is not a real directory" >&2; exit 1; }',
    'install -d -m 0755 "$home_target"',
    'grep -q " ${home_target} none bind" /etc/fstab || printf "%s %s none bind 0 0\\n" "$data_mount/home" "$home_target" >> /etc/fstab',
    'mountpoint -q "$home_target" || mount --bind "$data_mount/home" "$home_target"',
    '[[ "$(stat -c %d:%i "$home_target")" == "$(stat -c %d:%i "$data_mount/home")" ]] || { echo "workspace home is not backed by the durable directory" >&2; exit 1; }',
    `install -d -m 0711 '${workspaceDataRoot.replace(/\/[^/]+$/, '')}'`,
    `install -d '${workspaceDataRoot}'`,
    `grep -q " ${workspaceDataRoot} none bind" /etc/fstab || printf "%s ${workspaceDataRoot} none bind 0 0\\n" "$data_mount/workspaces" >> /etc/fstab`,
    `mountpoint -q '${workspaceDataRoot}' || mount --bind "$data_mount/workspaces" '${workspaceDataRoot}'`,
    ...(userScript ? ['', '# User-supplied bootstrap follows the durable mount.', userScript] : []),
    '',
  ].join('\n');
}

export function renderAwsHostBootstrapPushCore(input) {
  if (!input.hostBootstrapScript?.trim()) throw new Error('aws_workspace_host_bootstrap_empty');
  if (!/^[A-Z0-9_]+$/.test(input.statusMarker)) throw new Error('aws_workspace_host_bootstrap_status_marker_invalid');
  const unitName = input.unit ?? AWS_HOST_BOOTSTRAP_UNIT;
  const script = renderDurableFilesystemScriptCore({
    devicePath: awsEbsNvmeDevicePathCore(input.volumeId),
    deviceWaitSec: input.deviceWaitSec ?? AWS_DATA_DEVICE_WAIT_SEC,
    hostBootstrapScript: input.hostBootstrapScript,
    dataMode: input.dataMode,
    tenantIdentity: input.tenantIdentity,
    ...(input.workspaceDataRoot ? { workspaceDataRoot: input.workspaceDataRoot } : {}),
  });
  const scriptSha256 = createHash('sha256').update(script, 'utf8').digest('hex');
  const payload = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  if (payload.length > AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `aws_workspace_host_bootstrap_too_large: encoded payload is ${payload.length} bytes; ` +
        `the SSM push ceiling is ${AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES} bytes`,
    );
  }
  const dir = input.stagingDir ?? AWS_HOST_BOOTSTRAP_STAGING_DIR;
  const unit = `${unitName}.service`;
  const commands = [
    'set -eu',
    'umask 077',
    `install -d -m 0700 '${dir}'`,
    `printf '%s' '${payload}' | base64 -d | gunzip > '${dir}/bootstrap.sh.partial'`,
    `printf '%s  %s\\n' '${scriptSha256}' '${dir}/bootstrap.sh.partial' | sha256sum --check --strict --quiet`,
    `mv -f '${dir}/bootstrap.sh.partial' '${dir}/bootstrap.sh'`,
    `state="$(systemctl show -p ActiveState --value '${unit}' 2>/dev/null || true)"`,
    `case "$state" in active|activating|reloading) echo "${unitName} is already $state"; exit 0;; esac`,
    `printf '%s %s\\n' '${input.statusMarker}' running > /dev/console 2>/dev/null || true`,
    `systemd-run --unit='${unitName}' --collect --property=Type=exec /bin/bash '${dir}/bootstrap.sh'`,
    `echo "started ${unitName} sha256=${scriptSha256}"`,
  ];
  return { commands, scriptSha256, encodedPayloadBytes: payload.length };
}
