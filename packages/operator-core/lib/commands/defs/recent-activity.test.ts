/**
 * recent-activity.test.ts — the voice read-queries actions.recent /
 * notifications.recent (over user_actions + toast_log). Driven via the command
 * registry; global fetch is stubbed. Pins the handler's OWN logic, not the HTTP
 * endpoint:
 *
 *  - actions.recent: a 404 returns a GRACEFUL {count:0, actions:[]} (a harness
 *    with no actions yet is not an error), while any other !ok THROWS with the
 *    status — a regression collapsing those two would make "what just happened?"
 *    error out on an empty harness.
 *  - the slice-to-limit cap + the `?? []` null-safety (server returns no array).
 *  - notifications.recent: the level filter (a non-'all' level keeps only matching
 *    toasts; 'all'/unset keeps everything), the throw on !ok, and the same cap.
 *  - slug URL-encoding + the limit query param.
 *
 * Mock-the-boundary pattern: global fetch stubbed; the registry is real. Node env
 * (baseUrl takes the server branch when window is absent).
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/commands/defs/recent-activity.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './recent-activity'; // side-effect: register(actionsRecent) + register(notificationsRecent)
import { get } from '../registry';

const actions = get('actions.recent')!;
const notifications = get('notifications.recent')!;

const okResp = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResp = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const url = (i = 0) => fetchMock.mock.calls[i]![0] as string;

describe('actions.recent', () => {
  it('returns {count, actions} and hits the user-actions endpoint with an encoded slug + limit', async () => {
    fetchMock.mockResolvedValueOnce(okResp({ actions: [{ id: 'a1' }, { id: 'a2' }] }));
    const out = (await actions.handler({ slug: 'web app', limit: 5 }, {} as never)) as { count: number; actions: unknown[] };
    expect(out).toEqual({ count: 2, actions: [{ id: 'a1' }, { id: 'a2' }] });
    expect(url()).toContain('/api/user-actions/web%20app?');
    expect(url()).toContain('limit=5');
  });

  it('caps the result at limit (server returns more)', async () => {
    fetchMock.mockResolvedValueOnce(okResp({ actions: [1, 2, 3, 4, 5].map((n) => ({ id: n })) }));
    const out = (await actions.handler({ slug: 'web', limit: 2 }, {} as never)) as { count: number; actions: unknown[] };
    expect(out.count).toBe(2);
    expect(out.actions).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('is null-safe when the server omits the actions array', async () => {
    fetchMock.mockResolvedValueOnce(okResp({}));
    const out = (await actions.handler({ slug: 'web' }, {} as never)) as { count: number; actions: unknown[] };
    expect(out).toEqual({ count: 0, actions: [] });
  });

  it('404 → graceful {count:0, actions:[]} (NOT a throw)', async () => {
    fetchMock.mockResolvedValueOnce(errResp(404));
    await expect(actions.handler({ slug: 'web' }, {} as never)).resolves.toEqual({ count: 0, actions: [] });
  });

  it('non-404 !ok → throws with the status', async () => {
    fetchMock.mockResolvedValueOnce(errResp(500));
    await expect(actions.handler({ slug: 'web' }, {} as never)).rejects.toThrow(/HTTP 500/);
  });
});

describe('notifications.recent', () => {
  const mixed = [
    { level: 'error', message: 'boom' },
    { level: 'warning', message: 'careful' },
    { level: 'info', message: 'fyi' },
  ];

  it('returns all toasts when level is unset/all', async () => {
    fetchMock.mockResolvedValueOnce(okResp({ toasts: mixed }));
    const out = (await notifications.handler({ level: 'all' }, {} as never)) as { count: number; notifications: unknown[] };
    expect(out.count).toBe(3);
    expect(url()).toContain('/api/toast-log?');
  });

  it('a non-all level keeps only matching toasts', async () => {
    fetchMock.mockResolvedValueOnce(okResp({ toasts: mixed }));
    const out = (await notifications.handler({ level: 'warning' }, {} as never)) as {
      count: number;
      notifications: Array<{ level: string }>;
    };
    expect(out.count).toBe(1);
    expect(out.notifications[0]!.level).toBe('warning');
  });

  it('caps at limit and is null-safe when toasts is absent', async () => {
    fetchMock.mockResolvedValueOnce(okResp({ toasts: mixed }));
    const capped = (await notifications.handler({ level: 'all', limit: 2 }, {} as never)) as { count: number };
    expect(capped.count).toBe(2);

    fetchMock.mockResolvedValueOnce(okResp({}));
    const empty = (await notifications.handler({}, {} as never)) as { count: number; notifications: unknown[] };
    expect(empty).toEqual({ count: 0, notifications: [] });
  });

  it('!ok → throws with the status', async () => {
    fetchMock.mockResolvedValueOnce(errResp(503));
    await expect(notifications.handler({}, {} as never)).rejects.toThrow(/HTTP 503/);
  });
});
