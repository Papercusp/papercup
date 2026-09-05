/**
 * Unit tests for the cookie-session `last_seen_at` write debounce
 * (operator-scalability-event-loop-2026-06-16 P1-3).
 *
 * getSessionUser used to issue a `last_seen_at` UPDATE on EVERY authed request —
 * a second PG round-trip on the hot read path. It is now debounced per token via
 * a bounded TtlMap. PG is mocked (@papercusp/db-org): the `sql` tagged template
 * returns the session row for the SELECT and counts the UPDATE so we can assert
 * how often the write actually fires. No live PG (the integration contract lives
 * in auth.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Closure-configured by each test; read lazily inside the mock's sql fn.
let sessionRows: Array<Record<string, unknown>> = [];
let updateCount = 0;
let getOrgPgCount = 0;

vi.mock('@papercusp/db-org', async (orig) => {
  // tagged-template: sql`...` → sql(strings, ...values). The UPDATE is the only
  // write getSessionUser issues; everything else is the session SELECT.
  const sql = Object.assign(
    (strings: TemplateStringsArray, ..._vals: unknown[]) => {
      if (strings.join(' ').includes('UPDATE')) {
        updateCount++;
        return Promise.resolve([]);
      }
      return Promise.resolve(sessionRows);
    },
    { begin: vi.fn() },
  );
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => {
      getOrgPgCount++;
      return { sql };
    },
  };
});

import {
  getSessionUser,
  SESSION_COOKIE,
  LAST_SEEN_DEBOUNCE_MS,
  _resetLastSeenDebounceForTests,
} from './auth';

const headersFor = (token: string) => new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
const liveSession = (userId = 'u1') => [
  {
    user_id: userId,
    expires_at: new Date(Date.now() + 1_000_000_000),
    id: userId,
    username: 'alice',
    display_name: 'Alice',
    password_hash: null,
    workspace_id: 'papercusp-workspace',
    capabilities: [],
  },
];

beforeEach(() => {
  sessionRows = [];
  updateCount = 0;
  getOrgPgCount = 0;
  _resetLastSeenDebounceForTests();
});

afterEach(() => vi.useRealTimers());

describe('getSessionUser last_seen_at debounce', () => {
  it('writes on the first hit, skips within the window, writes again after it', async () => {
    vi.useFakeTimers();
    sessionRows = liveSession();
    const headers = headersFor('tok-A');

    expect(await getSessionUser(headers)).not.toBeNull();
    expect(updateCount).toBe(1); // first hit marks the session active

    expect(await getSessionUser(headers)).not.toBeNull();
    expect(updateCount).toBe(1); // within window → debounced, no round-trip

    vi.advanceTimersByTime(LAST_SEEN_DEBOUNCE_MS + 1);
    expect(await getSessionUser(headers)).not.toBeNull();
    expect(updateCount).toBe(2); // window elapsed → writes again
  });

  it('debounces each token independently', async () => {
    sessionRows = liveSession();

    await getSessionUser(headersFor('tok-1'));
    await getSessionUser(headersFor('tok-2'));
    expect(updateCount).toBe(2); // each distinct token's first hit writes

    await getSessionUser(headersFor('tok-1'));
    expect(updateCount).toBe(2); // both still inside the window
  });

  it('returns null and issues no write when there is no session cookie', async () => {
    expect(await getSessionUser(new Headers())).toBeNull();
    expect(updateCount).toBe(0);
    expect(getOrgPgCount).toBe(0);
  });

  it('returns null and issues no write when the session row is absent', async () => {
    sessionRows = []; // SELECT finds nothing
    expect(await getSessionUser(headersFor('tok-missing'))).toBeNull();
    expect(updateCount).toBe(0);
  });
});
