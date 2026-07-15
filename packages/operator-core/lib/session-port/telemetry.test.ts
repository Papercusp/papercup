import { describe, expect, it } from 'vitest';
import { classifySessionPortFailure, sessionPortTelemetryDetails } from './telemetry';

describe('session-port telemetry', () => {
  it('is content-free by construction even when a caller supplies extra data', () => {
    const details = sessionPortTelemetryDetails({
      workspaceId: 'ws', stage: 'prepared', sourceAdvSessionId: 4,
      targetBackend: 'codex', renderedHash: 'a'.repeat(64), redactions: 2,
      transcript: 'SECRET CONVERSATION', artifactPath: '/secret/path', token: 'opaque',
    } as any);
    expect(details).toMatchObject({ stage: 'prepared', target_backend: 'codex', redactions: 2 });
    expect(JSON.stringify(details)).not.toMatch(/SECRET CONVERSATION|secret\/path|opaque/);
  });

  it('maps raw failures to bounded classes instead of persisting messages', () => {
    expect(classifySessionPortFailure(new Error('native transcript persistence timed out'))).toBe('native-persistence');
    expect(classifySessionPortFailure(new Error('migration 611 missing'))).toBe('protocol-or-rollout');
    expect(classifySessionPortFailure(new Error('something novel'))).toBe('unknown');
  });
});
