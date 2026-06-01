/**
 * substrate-revoke-self-device.test.ts — endpoint tests for
 * handleRevokeSelfDevice.
 *
 * Tests the HTTP-level mapping via `handleRevokeSelfDevice(input, deps)`.
 * All deps injected — no PG, no Hypercore, no gh-token.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleRevokeSelfDevice,
  type RevokeSelfDeviceEndpointInput,
  type RevokeSelfDeviceEndpointDeps,
} from '../substrate-revoke-self-device';

const VALID_INPUT: RevokeSelfDeviceEndpointInput = {
  workspaceId: 'ws1',
  harnessSlug: 'papercup',
  devicePubkey: 'device-pubkey-AAAA',
};

function makeRevokeFn(
  result: Awaited<ReturnType<RevokeSelfDeviceEndpointDeps['revoke']>>,
): RevokeSelfDeviceEndpointDeps['revoke'] {
  return vi.fn(async () => result);
}

describe('handleRevokeSelfDevice', () => {
  it('200 on success', async () => {
    const deps: RevokeSelfDeviceEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, revoked: VALID_INPUT.devicePubkey, live: true }),
    };
    const res = await handleRevokeSelfDevice(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(VALID_INPUT.devicePubkey);
    expect(body.live).toBe(true);
  });

  it('200 when live:false (handle not booted)', async () => {
    const deps: RevokeSelfDeviceEndpointDeps = {
      revoke: makeRevokeFn({ ok: true, revoked: VALID_INPUT.devicePubkey, live: false }),
    };
    const res = await handleRevokeSelfDevice(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toBe(false);
  });

  it('403 on not_your_key', async () => {
    const deps: RevokeSelfDeviceEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'not_your_key' }),
    };
    const res = await handleRevokeSelfDevice(VALID_INPUT, deps);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('not_your_key');
  });

  it('404 on no_contributor_row', async () => {
    const deps: RevokeSelfDeviceEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'no_contributor_row' }),
    };
    const res = await handleRevokeSelfDevice(VALID_INPUT, deps);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('no_contributor_row');
  });

  it('401 on gh_auth_required', async () => {
    const deps: RevokeSelfDeviceEndpointDeps = {
      revoke: makeRevokeFn({ ok: false, code: 'gh_auth_required' }),
    };
    const res = await handleRevokeSelfDevice(VALID_INPUT, deps);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('gh_auth_required');
  });

  it('passes workspaceId + harnessSlug + devicePubkey through to the revoke seam', async () => {
    const revoke = makeRevokeFn({ ok: true, revoked: 'pk', live: true });
    const deps: RevokeSelfDeviceEndpointDeps = { revoke };
    await handleRevokeSelfDevice(
      { workspaceId: 'ws-test', harnessSlug: 'slug-test', devicePubkey: 'pk-test' },
      deps,
    );
    expect(revoke).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harnessSlug: 'slug-test',
      devicePubkey: 'pk-test',
    });
  });
});
