import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  IMAGE_SCANNER_NETWORK_TAG,
  buildImageScannerInstanceCreateArgs,
  // @ts-expect-error -- side-effect-free .mjs argv builder, deliberately untyped.
} from '../../bin/gcp-image-scan-args.mjs';

const BASE = {
  instanceName: 'pc-scan-vm-test123',
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  machineType: 'e2-standard-2',
  imageFamily: 'debian-12',
  imageProject: 'debian-cloud',
  subnetwork: 'pc-p046-canary-02-a810e759-subnet',
  diskName: 'pc-scan-disk-test123',
  startupScriptPath: '/tmp/pc-image-scan-test123/startup.sh',
};

const SCANNER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'papercusp-image-scan.mjs',
);

describe('buildImageScannerInstanceCreateArgs', () => {
  it('pins the scanner to the supplied subnet instead of the project default VPC', () => {
    const args = buildImageScannerInstanceCreateArgs(BASE) as string[];

    expect(args).toContain(`--subnet=${BASE.subnetwork}`);
    expect(args.some((arg) => arg.startsWith('--network='))).toBe(false);
  });

  it('keeps the scanner private, unprivileged, and reachable only through the IAP path', () => {
    const args = buildImageScannerInstanceCreateArgs(BASE) as string[];

    expect(args).toContain('--no-address');
    expect(args).toContain('--no-service-account');
    expect(args).toContain('--no-scopes');
    expect(args).toContain('--metadata=enable-oslogin=TRUE');
    expect(args).toContain(`--tags=${IMAGE_SCANNER_NETWORK_TAG}`);
    expect(args.some((arg) => arg.startsWith('--address='))).toBe(false);
  });

  it('attaches the candidate read-only and preserves the scanner role label', () => {
    const args = buildImageScannerInstanceCreateArgs(BASE) as string[];

    expect(args).toContain(
      `--disk=name=${BASE.diskName},device-name=candidate,mode=ro,auto-delete=no`,
    );
    expect(args).toContain(`--metadata-from-file=startup-script=${BASE.startupScriptPath}`);
    expect(args).toContain('--labels=papercusp-artifact=workspace-host,papercusp-role=image-scanner');
    expect(args.slice(0, 4)).toEqual(['compute', 'instances', 'create', BASE.instanceName]);
  });

  it('refuses a missing subnet rather than silently returning default-VPC argv', () => {
    for (const subnetwork of [undefined, null, '', '   ']) {
      expect(() =>
        buildImageScannerInstanceCreateArgs({ ...BASE, subnetwork }),
      ).toThrow(/subnetwork is required/i);
    }
  });

  it('wires the production scanner through the private argv builder and IAP preflight', () => {
    const source = readFileSync(SCANNER_SOURCE, 'utf8');

    expect(source).toContain("const subnetwork = requireText(input.subnetwork, 'subnetwork');");
    expect(source).toContain('await assertCleanRoomIapReachable(projectId, subnetwork, SCAN_ZONE);');
    expect(source).toContain('buildImageScannerInstanceCreateArgs({');
  });
});
