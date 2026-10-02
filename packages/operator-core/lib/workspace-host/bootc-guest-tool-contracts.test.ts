/**
 * One bootc image serves every cloud (P-307): bake-cloud-images.sh renders the GCE disk, the
 * AWS AMI disk and the Azure VHD from the same CentOS Stream 9 image. Each cloud's release
 * contract names the guest packages that image must carry, and the release gates check
 * them by RPM name. A name the image does not install can never pass a real release gate
 * (WI-10005605 fixed AWS; WI-10005618 fixed GCP and Azure). These tests pin every
 * contract to what infra/images/bootc/workspace-host.Containerfile actually installs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AWS_AMI_REQUIRED_GUEST_TOOLS } from './aws-ami-release';
import { AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS } from './azure-compute-gallery-release';
import { GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS } from './gcp-image-family';

const BOOTC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'images', 'bootc');
const CONTAINERFILE = join(BOOTC_DIR, 'workspace-host.Containerfile');

/** Ubuntu/Debian package names that have no package of that name on CentOS Stream 9. */
const DEBIAN_ONLY_NAMES = ['ufw', 'unattended-upgrades', 'walinuxagent', 'aws-ssm-agent'];

/**
 * amazon-ssm-agent is installed from AWS's digest-pinned standalone RPM, not the dnf list;
 * aws-ami-scan.test.ts pins that path.
 */
const INSTALLED_OUTSIDE_DNF_LIST: Readonly<Record<string, string>> = {
  'amazon-ssm-agent': 'standalone AWS RPM, pinned by aws-ami-scan.test.ts',
};

/**
 * KNOWN GAPS: required by a contract but not installed by the image, so that cloud's
 * release gate fails on a real bake. WALinuxAgent is tracked by WI-10005639; remove its
 * entry when it lands (the third test below forces that).
 */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  WALinuxAgent: 'WI-10005639',
};

const NOT_IN_DNF_LIST: Readonly<Record<string, string>> = { ...INSTALLED_OUTSIDE_DNF_LIST, ...KNOWN_GAPS };

const CONTRACTS = {
  aws: AWS_AMI_REQUIRED_GUEST_TOOLS,
  gcp: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  azure: AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS,
} as const;

function installedByName(containerfile: string, pkg: string): boolean {
  return new RegExp(`^\\s+${pkg.replace(/[-+.]/g, '\\$&')}\\s*\\\\?$`, 'm').test(containerfile);
}

describe('bootc guest-tool contracts (WI-10005618)', () => {
  const containerfile = readFileSync(CONTAINERFILE, 'utf8');

  it('no cloud contract requires a Debian-only package name', () => {
    for (const [cloud, tools] of Object.entries(CONTRACTS)) {
      for (const name of DEBIAN_ONLY_NAMES) {
        expect(tools as readonly string[], `${cloud} still requires ${name}`).not.toContain(name);
      }
    }
  });

  it('every required tool of every cloud is installed by name in the bootc image', () => {
    for (const [cloud, tools] of Object.entries(CONTRACTS)) {
      for (const tool of tools) {
        if (tool in NOT_IN_DNF_LIST) continue;
        expect(installedByName(containerfile, tool), `${cloud} requires ${tool}, not installed`).toBe(true);
      }
    }
  });

  it('a known gap is really absent from the image, so a fixed gap cannot stay exempt', () => {
    // If WALinuxAgent gets installed, this fails until its entry is removed, so the
    // Azure check above starts covering it.
    for (const [tool, ref] of Object.entries(KNOWN_GAPS)) {
      expect(installedByName(containerfile, tool), `${tool} is installed; close ${ref} and drop the gap`).toBe(false);
    }
  });

  it('the matcher is calibrated: it finds a known package and rejects a substring', () => {
    expect(installedByName(containerfile, 'nftables')).toBe(true);
    expect(installedByName(containerfile, 'dnf-automatic')).toBe(true);
    expect(installedByName(containerfile, 'google-guest')).toBe(false);
    expect(installedByName('         ufw-extra \\\n', 'ufw')).toBe(false);
    expect(installedByName('         ufw \\\n', 'ufw')).toBe(true);
  });

  it('google-guest-agent is installed but skipped off GCE, like amazon-ssm-agent off EC2', () => {
    const dropIn = join(BOOTC_DIR, 'papercusp-google-guest-agent-gce-only.conf');
    expect(existsSync(dropIn)).toBe(true);
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^\[Unit\]\nConditionFirmware=smbios-field\(sys_vendor = "Google"\)$/m);
    expect(containerfile).toMatch(
      /^COPY papercusp-google-guest-agent-gce-only\.conf \/usr\/lib\/systemd\/system\/google-guest-agent\.service\.d\/papercusp-gce-only\.conf$/m,
    );
  });
});
