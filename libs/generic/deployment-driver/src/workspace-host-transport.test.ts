import { describe, expect, it } from 'vitest';

import {
  evaluateWorkspaceHostTransportCompatibility,
  type WorkspaceHostTransportProfile,
} from './index';

const profile: WorkspaceHostTransportProfile = {
  kind: 'test-ssh-tunnel',
  endpoint: 'test-ssh-tunnel://host-1',
  supportedClientPlatforms: ['linux', 'macos'],
  features: {
    command: true,
    pty: true,
    tcpForward: true,
    fileTransfer: true,
    clipboard: false,
  },
  prerequisites: [],
  constraints: [],
  reconnect: 'recreate',
  audited: true,
  compatibility: {
    requirements: [
      {
        id: 'test-cli',
        label: 'Test CLI',
        kind: 'client-tool',
        minimumVersion: '2.3.4',
        requiredFor: ['command', 'pty', 'tcpForward', 'fileTransfer'],
      },
      {
        id: 'remote-agent',
        label: 'Remote agent',
        kind: 'remote-agent',
        minimumVersion: '1.1.0',
        requiredFor: ['command', 'pty', 'tcpForward', 'fileTransfer'],
      },
    ],
    traffic: { interactive: 'recommended', 'bulk-transfer': 'discouraged' },
    limits: {
      unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
      notes: ['Test contract'],
    },
    proxy: {
      mode: 'allowlist-required',
      requiredDomains: ['tunnel.example.test'],
      notes: [],
    },
    cost: { model: 'included', meters: [], notes: [] },
    audit: {
      controlPlaneEvents: true,
      sessionMetadata: true,
      sessionContent: false,
      fileTransferEvents: false,
      notes: [],
    },
    hostKey: {
      initialEnrollment: 'verify-before-connect',
      replacement: 'block-and-reverify',
      notes: [],
    },
    fallbacks: [
      {
        feature: 'fileTransfer',
        trafficClass: 'bulk-transfer',
        strategy: 'provider-object-storage',
        description: 'Use object storage',
      },
      {
        feature: 'clipboard',
        strategy: 'unsupported',
        description: 'No clipboard transport',
      },
    ],
  },
};

function compatibleClient() {
  return {
    platform: 'linux',
    requirements: {
      'test-cli': { status: 'satisfied' as const, version: '2.3.4' },
      'remote-agent': { status: 'satisfied' as const, version: '1.2.0' },
    },
    corporateProxy: { enabled: true, allowedDomains: ['tunnel.example.test'] },
    hostKey: 'verified' as const,
  };
}

describe('evaluateWorkspaceHostTransportCompatibility', () => {
  it('accepts a fully observed compatible interactive client', () => {
    const result = evaluateWorkspaceHostTransportCompatibility(profile, {
      feature: 'tcpForward',
      trafficClass: 'interactive',
      client: compatibleClient(),
    });

    expect(result).toEqual({ compatible: true, errors: [], warnings: [] });
  });

  it('fails closed on missing evidence, old or unparsable versions, proxy policy, and host-key changes', () => {
    const result = evaluateWorkspaceHostTransportCompatibility(profile, {
      feature: 'tcpForward',
      trafficClass: 'interactive',
      client: {
        ...compatibleClient(),
        platform: 'windows',
        requirements: {
          'test-cli': { status: 'satisfied', version: '2.3.3' },
          'remote-agent': { status: 'satisfied', version: 'unknown' },
        },
        corporateProxy: { enabled: true, allowedDomains: [] },
        hostKey: 'changed',
      },
    });

    expect(result.compatible).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'unsupported-platform',
        'minimum-version-not-met',
        'unverifiable-version',
        'corporate-proxy-domain-blocked',
        'host-key-unverified',
      ]),
    );

    const missingEvidence = evaluateWorkspaceHostTransportCompatibility(profile, {
      feature: 'tcpForward',
      trafficClass: 'interactive',
      client: {
        ...compatibleClient(),
        requirements: { 'test-cli': { status: 'satisfied', version: '2.3.4' } },
      },
    });
    expect(missingEvidence.errors).toContainEqual(
      expect.objectContaining({ code: 'missing-requirement-evidence', requirementId: 'remote-agent' }),
    );
  });

  it('rejects a legacy or malformed profile with no structured contract', () => {
    const { compatibility: _compatibility, ...legacyProfile } = profile;
    const result = evaluateWorkspaceHostTransportCompatibility(legacyProfile as WorkspaceHostTransportProfile, {
      feature: 'tcpForward',
      trafficClass: 'interactive',
      client: compatibleClient(),
    });

    expect(result).toMatchObject({
      compatible: false,
      errors: [{ code: 'invalid-profile' }],
    });
  });

  it('separates large-file suitability from the file-transfer feature and returns the declared fallback', () => {
    const result = evaluateWorkspaceHostTransportCompatibility(profile, {
      feature: 'fileTransfer',
      trafficClass: 'bulk-transfer',
      client: compatibleClient(),
    });

    expect(result.compatible).toBe(true);
    expect(result.warnings.map(({ code }) => code)).toEqual(['traffic-class-discouraged']);
    expect(result.fallback).toMatchObject({
      strategy: 'provider-object-storage',
    });

    const clipboard = evaluateWorkspaceHostTransportCompatibility(profile, {
      feature: 'clipboard',
      trafficClass: 'interactive',
      client: compatibleClient(),
    });
    expect(clipboard.compatible).toBe(false);
    expect(clipboard.errors.map(({ code }) => code)).toContain('unsupported-feature');
    expect(clipboard.fallback).toMatchObject({ strategy: 'unsupported' });
  });
});
