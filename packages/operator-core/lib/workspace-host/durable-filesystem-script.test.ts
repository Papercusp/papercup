import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_HOST_DATA_ROOT } from '@papercusp/deployment-driver';
import {
  renderDurableFilesystemScript,
  WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT,
} from './durable-filesystem-script';

/**
 * The provider-neutral durable data mount (plan aws-byoc-gcp-parity-2026-10-01 D-013 point 2).
 * GCP's output was compared byte-for-byte against its pre-extraction function when this moved
 * (WI-10005172), and gcp-provider.test.ts keeps pinning GCP's startup-script behaviour; this file
 * pins the parts AWS relies on.
 */

const AWS_DEVICE = '/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0';

describe('renderDurableFilesystemScript', () => {
  it('renders valid bash that waits for, formats-if-blank, and mounts the named device', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 180 });
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain(`data_device='${AWS_DEVICE}'`);
    expect(script).toContain(`data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`);
    expect(script).toContain('for attempt in $(seq 1 180); do test -b "$data_device"');
    expect(script).toContain('if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi');
    // Survives a reboot without re-running: every mount is in fstab, and the data mount is nofail.
    expect(script).toContain('defaults,nofail,discard');
    expect(script).toContain(' /home none bind 0 0');
    expect(script).toContain(`${WORKSPACE_HOST_DATA_ROOT} none bind 0 0`);
  });

  it('runs the host bootstrap only after every durable mount, without its shebang', () => {
    const script = renderDurableFilesystemScript({
      devicePath: AWS_DEVICE,
      deviceWaitSec: 30,
      hostBootstrapScript: '#!/usr/bin/env bash\necho papercusp-bootstrap\n',
    });
    const bootstrapAt = script.indexOf('echo papercusp-bootstrap');
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/workspaces"`));
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/home"`));
    expect(script.match(/^#!/gm)).toHaveLength(1);
  });

  it('emits the mount alone when there is no bootstrap', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    expect(script).not.toContain('# User-supplied bootstrap follows the durable mount.');
  });

  it('refuses a device that is not named by a stable /dev/disk/by-id path', () => {
    // The script formats a blank device, so a guessed kernel name could format the wrong disk.
    for (const devicePath of ['/dev/nvme1n1', '/dev/xvdf', '/dev/disk/by-id/', "/dev/disk/by-id/x'; rm -rf /"]) {
      expect(() => renderDurableFilesystemScript({ devicePath, deviceWaitSec: 30 })).toThrow(/by-id/);
    }
  });

  it('refuses a wait that is not a positive whole number of seconds', () => {
    for (const deviceWaitSec of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec })).toThrow(/wait/);
    }
  });
});
