import { describe, expect, it } from 'vitest';
import type { OwnerDirectiveRow } from '@papercusp/operator-core/lib/owner-directives';
import {
  incompleteDesktopScopeRefusal,
  partialScopeApprovalDirectiveId,
} from './release-owner-approval';

const missing = [{ product: 'server' as const, platform: 'darwin-universal' }];

function approval(overrides: Partial<OwnerDirectiveRow> = {}): OwnerDirectiveRow {
  return {
    id: 123,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: 'owner-session',
    sourceTurnRef: 'owner-turn',
    verbatimText: 'I explicitly approve the partial desktop scope for 0.0.21 alpha; omit macOS and Windows.',
    recordedBy: 'owner-session',
    createdAtMs: 1,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    capturedByHook: true,
    ...overrides,
  };
}

describe('incompleteDesktopScopeRefusal', () => {
  it('requires captured owner authority for an incomplete scope', () => {
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, null, 'papercusp-workspace'),
    ).toMatch(/REFUSING TO RECORD.*explicit owner approval/u);
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        missing,
        approval({ capturedByHook: false }),
        'papercusp-workspace',
      ),
    ).toMatch(/captured owner directive/u);
  });

  it('requires approval to match version, channel, partial intent, and every missing platform', () => {
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, approval(), 'papercusp-workspace'),
    ).toBeNull();
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        missing,
        approval({ verbatimText: 'I approve this partial release' }),
        'papercusp-workspace',
      ),
    ).toMatch(/does not explicitly approve/u);
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        [{ product: 'server', platform: 'windows-x86_64' }],
        approval({ verbatimText: 'I explicitly approve the partial desktop scope for 0.0.21 alpha; omit macOS.' }),
        'papercusp-workspace',
      ),
    ).toMatch(/does not approve omission of windows/u);
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        missing,
        approval({ verbatimText: 'I approve the partial desktop scope for 0.0.21 alpha; macOS remains required.' }),
        'papercusp-workspace',
      ),
    ).toMatch(/does not approve omission of darwin-universal/u);
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        missing,
        approval({ verbatimText: 'I do not approve the partial desktop scope for 0.0.21 alpha; omit macOS and Windows.' }),
        'papercusp-workspace',
      ),
    ).toMatch(/REFUSING TO RECORD/u);
    expect(
      incompleteDesktopScopeRefusal(
        '0.0.21',
        'alpha',
        missing,
        approval({ workspaceId: 'other-workspace' }),
        'papercusp-workspace',
      ),
    ).toMatch(/captured owner directive/u);
    expect(incompleteDesktopScopeRefusal('0.0.21', 'alpha', [], null, 'papercusp-workspace')).toBeNull();
  });
});

describe('partialScopeApprovalDirectiveId', () => {
  it('reads only the canonical approval note and rejects malformed ids', () => {
    expect(partialScopeApprovalDirectiveId('owner-approved partial desktop scope by directive #123')).toBe(123);
    expect(partialScopeApprovalDirectiveId('owner-approved partial desktop scope by directive #0')).toBeNull();
    expect(partialScopeApprovalDirectiveId('owner-approved partial desktop scope: 123')).toBeNull();
    expect(partialScopeApprovalDirectiveId(null)).toBeNull();
  });
});
