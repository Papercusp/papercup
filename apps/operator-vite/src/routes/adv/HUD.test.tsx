// @vitest-environment jsdom
/**
 * /adv/HUD is a REDIRECT into the tab strip (?tab=hud), not a page — the board
 * itself is rendered by routes/adv/index.tsx and covered there.
 *
 * What this pins is the thing a redirect silently gets wrong: dropping the
 * incoming search params. A deep link like `/adv/HUD?hudcol=blocked&hudsession=x`
 * has to arrive on the board with that state intact, and the redirect must not
 * let an inbound `?tab=` win over 'hud' (or the URL would land on some other tab).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  // The real `redirect` throws a router-internal object; a marker with the args
  // is enough to assert what the route redirects TO.
  redirect: (args: unknown) => ({ __redirect: args }),
}));

import { Route } from './HUD';

type BeforeLoad = (ctx: { search?: Record<string, unknown> }) => void;
const beforeLoad = (Route as unknown as { beforeLoad: BeforeLoad }).beforeLoad;

/** beforeLoad signals the redirect by THROWING it — catch and unwrap. */
function redirectFor(search?: Record<string, unknown>) {
  try {
    beforeLoad({ search });
  } catch (thrown) {
    return (thrown as { __redirect: { to: string; search: Record<string, unknown> } }).__redirect;
  }
  throw new Error('/adv/HUD did not redirect');
}

describe('/adv/HUD', () => {
  it('redirects to the HUD tab', () => {
    expect(redirectFor({})).toEqual({ to: '/adv', search: { tab: 'hud' } });
  });

  it('carries deep-link search params through to the board', () => {
    expect(redirectFor({ hudcol: 'blocked', hudsession: 'su-1' })).toEqual({
      to: '/adv',
      search: { hudcol: 'blocked', hudsession: 'su-1', tab: 'hud' },
    });
  });

  it('survives an absent search object', () => {
    expect(redirectFor(undefined)).toEqual({ to: '/adv', search: { tab: 'hud' } });
  });

  it('forces tab=hud even if the inbound URL names another tab', () => {
    expect(redirectFor({ tab: 'git' })).toEqual({ to: '/adv', search: { tab: 'hud' } });
  });
});
