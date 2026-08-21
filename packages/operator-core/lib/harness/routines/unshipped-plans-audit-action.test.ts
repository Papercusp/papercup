import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../../unshipped-plans-audit', () => ({
  runUnshippedPlansAudit: M.run,
}));

import './unshipped-plans-audit-action';
import { getSystemAction } from './system-actions';

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
};

beforeEach(() => {
  M.run.mockReset();
  M.run.mockResolvedValue({
    manifest: {
      rows: [{ slug: 'plan-a' }, { slug: 'plan-b' }],
      bands: {
        protected: 1,
        blockerClaims: 1,
        supersedeOrRetire: 0,
      },
    },
    artifacts: {
      harness: 'papercusp',
      json: 'reports/unshipped-plans-audit/latest.json',
      html: 'reports/unshipped-plans-audit/latest.html',
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('system:unshipped-plans-audit', () => {
  it('registers on the canonical system-action seam', () => {
    expect(getSystemAction('unshipped-plans-audit')).toBeTypeOf('function');
  });

  it('delegates one manual fire with the routine workspace and install harness', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await getSystemAction('unshipped-plans-audit')!(ctx);

    expect(M.run).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'papercusp-workspace',
      artifactHarness: 'papercusp',
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('classified 2 nonterminal plan(s); protected 1, blockers 1'),
    );
  });
});
