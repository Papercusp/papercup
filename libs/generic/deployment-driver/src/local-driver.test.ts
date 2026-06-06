import { describe, it, expect } from 'vitest';
import { LocalDriver, LOCAL_FRAME } from './local-driver';
import { LOCAL_DEPLOYMENT, type DeploymentContext } from './types';

const ctx: DeploymentContext = { harnessSlug: 'demo', workspaceId: 'ws' };

describe('LocalDriver', () => {
  it('declares the local target + local placement', () => {
    expect(LocalDriver.target).toBe('local');
    expect(LocalDriver.placement).toBe('local');
  });

  it('provision returns the singleton local frame (no side effects)', async () => {
    const frame = await LocalDriver.provision(LOCAL_DEPLOYMENT, ctx);
    expect(frame).toBe(LOCAL_FRAME);
    expect(frame).toMatchObject({ id: 'local', target: 'local', placement: 'local', kind: 'local' });
  });

  it('install / join / teardown are no-ops that resolve', async () => {
    const frame = await LocalDriver.provision(LOCAL_DEPLOYMENT, ctx);
    await expect(LocalDriver.install(frame, LOCAL_DEPLOYMENT, ctx)).resolves.toBeUndefined();
    await expect(LocalDriver.join(frame, LOCAL_DEPLOYMENT, ctx)).resolves.toBeUndefined();
    await expect(LocalDriver.teardown(frame, LOCAL_DEPLOYMENT, ctx)).resolves.toBeUndefined();
  });
});
