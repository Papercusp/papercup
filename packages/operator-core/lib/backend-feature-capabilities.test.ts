import { describe, expect, it } from 'vitest';
import {
  BACKEND_FEATURE_CAPABILITIES,
  backendFeatureCapability,
  backendFeatureGuard,
  backendSupportsFeature,
  interactiveBackendFromSpawnBackend,
  type BackendFeature,
  type InteractiveBackend,
} from './backend-feature-capabilities';

const BACKENDS: InteractiveBackend[] = ['claude', 'codex', 'omp'];
const FEATURES: BackendFeature[] = [
  'fresh-su',
  'resume',
  'role-session',
  'launch-context',
  'saved-prompts',
  'slash-tool-prompts',
  'account-pinning',
  'gateway-routing',
  'file-lock-enforcement',
  'native-fork',
  'forced-native-session-id',
  'runtime-home-inheritance',
  'mcp-http-auth',
  'settings-diagnostics',
];

describe('BACKEND_FEATURE_CAPABILITIES', () => {
  it('covers every backend and feature with an explicit state', () => {
    for (const backend of BACKENDS) {
      expect(Object.keys(BACKEND_FEATURE_CAPABILITIES[backend]).sort()).toEqual([...FEATURES].sort());
      for (const feature of FEATURES) {
        expect(BACKEND_FEATURE_CAPABILITIES[backend][feature].mechanism).toBeTruthy();
      }
    }
  });

  it('records Codex parity guarantees and honest non-native gaps', () => {
    expect(backendSupportsFeature('codex', 'launch-context')).toBe(true);
    expect(backendSupportsFeature('codex', 'mcp-http-auth')).toBe(true);
    expect(backendSupportsFeature('codex', 'runtime-home-inheritance')).toBe(true);

    expect(backendFeatureCapability('codex', 'file-lock-enforcement').state).toBe('soft');
    expect(backendFeatureCapability('codex', 'native-fork').state).toBe('unsupported');
    expect(backendFeatureCapability('codex', 'forced-native-session-id').unsupportedReason).toMatch(/cannot/i);
  });

  it('keeps OMP gateway/account work capability-gated until its provider adapter exists', () => {
    expect(backendFeatureCapability('omp', 'account-pinning').state).toBe('unsupported');
    expect(backendFeatureCapability('omp', 'gateway-routing').unsupportedReason).toMatch(/not implemented/i);
  });

  it('provides a reusable fail-closed guard reason for live launcher paths', () => {
    expect(backendFeatureGuard('claude', 'account-pinning')).toMatchObject({ supported: true, reason: null });
    expect(backendFeatureGuard('omp', 'account-pinning')).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/not implemented/i),
    });
  });

  it('normalizes spawn backend names into the matrix backend keys', () => {
    expect(interactiveBackendFromSpawnBackend('claude-code')).toBe('claude');
    expect(interactiveBackendFromSpawnBackend('codex')).toBe('codex');
    expect(interactiveBackendFromSpawnBackend('omp')).toBe('omp');
  });
});
