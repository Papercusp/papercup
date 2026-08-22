import { afterEach, describe, expect, it } from 'vitest';
import routes from './dev-operators';

const originalProfile = process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
  else process.env.PAPERCUSP_DISTRIBUTION_PROFILE = originalProfile;
});

describe('desktop dev-operators vm-release guard', () => {
  it('refuses preference mutation before parsing or writing in an immutable runtime', async () => {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    const post = routes.find((route) => route.method === 'POST');
    expect(post).toBeTruthy();
    const response = await post!.handler(
      new Request('http://127.0.0.1/desktop/dev-operators/set-enabled', {
        method: 'POST',
        body: JSON.stringify({ id: 'staging', enabled: true }),
      }),
      {} as never,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'vm_release_immutable' });
  });
});
