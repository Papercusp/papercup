import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { renderDurableStorageQuotaCore, workspaceHostDurableTenantIdentity } from './aws-host-bootstrap-push-core.mjs';

// No PostgreSQL dependency. Explicit privileged acceptance uses an owned sparse image in a private mount
// namespace. Ordinary unit runs never mount disks or require sudo. On this route,
// absent tooling/capabilities FAIL; they cannot turn acceptance into a skip.
it.runIf(process.env.PAPERCUSP_TEST_DURABLE_QUOTA_KERNEL === '1')(
  'enforces independent DB and shared workspace projects across an ext4 remount', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-kernel-'));
    const quotaBin = process.env.PAPERCUSP_TEST_QUOTA_BIN ?? '/usr/sbin';
    const quota = renderDurableStorageQuotaCore({ dbGiB: 1, workspaceGiB: 1 },
      workspaceHostDurableTenantIdentity('kernel-test', 'customer')).join('\n');
    try {
      const result = spawnSync('sudo', ['-n', 'unshare', '--mount', '--propagation', 'private',
        'bash', '-s', '--', root, quotaBin], {
        encoding: 'utf8', timeout: 60000,
        input: [
          'set -euo pipefail', 'export LC_ALL=C', 'export PATH="$2:/usr/sbin:/usr/bin:/sbin:/bin"',
          'for tool in setquota mkfs.ext4 tune2fs chattr lsattr findmnt fallocate; do command -v "$tool"; done',
          'data_device="$1/data.ext4"', 'data_mount="$1/mount"', 'data_probe_marker="$1/boot"',
          'mkdir "$data_mount"',
          'trap \'mountpoint -q "$data_mount" && umount "$data_mount" || true\' EXIT',
          'truncate -s 3G "$data_device"',
          'mkfs.ext4 -q -O quota,project -E quotatype=prjquota -I 256 "$data_device"',
          'data_uuid=$(blkid -p -s UUID -o value "$data_device")',
          'mount -o loop,prjquota "$data_device" "$data_mount"',
          'mkdir "$data_mount"/{postgres,repositories,transcripts,workspaces,home}',
          'data_freshly_formatted=1', quota,
          'fallocate -l 700M "$data_mount/postgres/database"',
          'fallocate -l 700M "$data_mount/repositories/repository"',
          'expect_edquot() {',
          '  local path="$1" error',
          '  if error=$(fallocate -l 400M "$path" 2>&1); then echo "quota bypass: $path" >&2; exit 1; fi',
          '  [[ "$error" == *"Disk quota exceeded"* ]] || { echo "$error" >&2; exit 1; }',
          '  rm -f "$path"',
          '}',
          'expect_edquot "$data_mount/postgres/overflow"',
          'for directory in transcripts workspaces home; do expect_edquot "$data_mount/$directory/overflow"; done',
          'printf retained > "$data_mount/home/session"',
          'pin=$(sha256sum "$data_mount/.papercusp-storage-quota" | cut -d " " -f1)',
          'umount "$data_mount"',
          'mount -o loop,prjquota "$data_device" "$data_mount"',
          'data_freshly_formatted=0', quota,
          '[[ "$pin" == "$(sha256sum "$data_mount/.papercusp-storage-quota" | cut -d " " -f1)" ]]',
          '[[ "$(cat "$data_mount/home/session")" == retained ]]',
          'expect_edquot "$data_mount/postgres/overflow"',
          'for directory in transcripts workspaces home; do expect_edquot "$data_mount/$directory/overflow"; done',
          'echo KERNEL_EDQUOT_RETAINED_OK',
        ].join('\n'),
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('KERNEL_EDQUOT_RETAINED_OK');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 65000,
);
