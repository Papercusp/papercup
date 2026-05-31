/**
 * cf-pages.test.ts — Cloudflare Pages client unit coverage (Plan 2 Phase A, P-004).
 *
 * Covers the pure `cfStageToStatus` mapping (deploy-status → our status), the
 * `local-stub` short-circuits (so the publish flow is exercisable without real
 * CF creds), and `getProject`'s 404→null / success contract via a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cfStageToStatus,
  ensureProject,
  createDeployment,
  getDeployment,
  getProject,
} from './cf-pages.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const localEnv: any = { CF_MASTER_TOKEN: 'local-stub', CF_ACCOUNT_ID: 'acct' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realEnv: any = { CF_MASTER_TOKEN: 'real-token', CF_ACCOUNT_ID: 'acct' };

describe('cfStageToStatus', () => {
  it('maps a successful deploy stage → live', () => {
    expect(cfStageToStatus({ name: 'deploy', status: 'success' })).toBe('live');
    expect(cfStageToStatus({ name: 'success', status: 'success' })).toBe('live');
  });
  it('maps a failed stage → failed', () => {
    expect(cfStageToStatus({ name: 'build', status: 'failure' })).toBe('failed');
  });
  it('maps an in-progress stage → building', () => {
    expect(cfStageToStatus({ name: 'build', status: 'active' })).toBe('building');
    // success status but a non-terminal stage name is still in-flight.
    expect(cfStageToStatus({ name: 'build', status: 'success' })).toBe('building');
  });
});

describe('local-stub short-circuits (no CF call)', () => {
  it('ensureProject fabricates a project, created:false', async () => {
    const r = await ensureProject(localEnv, 'proj');
    expect(r).toMatchObject({ created: false, project: { name: 'proj' } });
  });
  it('createDeployment fabricates a successful deployment', async () => {
    const d = await createDeployment(localEnv, 'proj', {});
    expect(d.id).toBe('cfdep_localstub');
    expect(d.latest_stage).toMatchObject({ status: 'success' });
  });
  it('getDeployment fabricates a deployment for the id', async () => {
    const d = await getDeployment(localEnv, 'proj', 'dep-9');
    expect(d.id).toBe('dep-9');
  });
});

describe('getProject (real CF path; fetch mocked)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [] }), { status: 404 }),
    );
    expect(await getProject(realEnv, 'missing')).toBeNull();
  });

  it('returns the project on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { name: 'p', subdomain: 's' } }), { status: 200 }),
    );
    expect(await getProject(realEnv, 'p')).toMatchObject({ name: 'p', subdomain: 's' });
  });

  it('throws on a non-404 CF error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 }),
    );
    await expect(getProject(realEnv, 'p')).rejects.toThrow();
  });
});
