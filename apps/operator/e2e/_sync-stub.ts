/**
 * Hermetic stubbing of the @papercusp/sync wire contract, for e2e specs.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * Eight specs hand-rolled a `page.route('**\/api/zero-harness/rest-query-batch**')`
 * stub. That route has been DEAD since 2026-07-26 (drop-sync-batcher-2026-07-25):
 * the client batcher was deleted, and `libs/generic/sync/src/server/http-routes.ts`
 * states it plainly — "`POST rest-query-batch` ... is NOT part of the contract this
 * library's own client transport speaks ... papercusp mounts it nowhere."
 *
 * The live contract is ONE GET per query, through a bounded concurrency gate:
 *
 *     GET /api/zero-harness/rest-query?name=<name>&args=<json>  →  { rows, version }
 *
 * So every one of those stubs was intercepting a request the app never makes.
 * Nothing failed — Playwright does not report an unused route, and the sync layer
 * yields a frozen EMPTY ARRAY while a query is unresolved rather than throwing. The
 * panels simply rendered empty and the specs asserted against real (unstubbed)
 * traffic. That is the same false-confidence class as a detector reporting its own
 * blindness as absence: the stub could not be reached, and silence read as success.
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────
 * `assertServed()` is therefore not optional politeness — it is the falsifier that
 * makes this module's own failure mode LOUD. A stub that is silently bypassed must
 * fail the spec, not quietly starve the panel it was written to feed.
 */
import { type Page } from '@playwright/test';

/**
 * Matches the live per-query GET only. Deliberately a RegExp anchored on the `?`
 * so it cannot also swallow `rest-query-batch` — if a spec still stubs the dead
 * batch route, that stays visibly unhit rather than being masked by this one.
 */
const REST_QUERY_ROUTE = /\/api\/zero-harness\/rest-query\?/;

/**
 * Rows for one sync query. Return `undefined` for a query this spec does not
 * model — the stub answers `[]`, which is exactly what the real resolver returns
 * for an empty window, so an unmodelled query stays hermetic instead of falling
 * through to a live backend.
 */
export type SyncRowsResolver = (
  name: string,
  args: Record<string, unknown>,
) => readonly unknown[] | undefined;

export interface SyncQueryStub {
  /** How many `rest-query` requests this stub actually served. */
  readonly hits: number;
  /** Query names served, in request order (duplicates kept — refetches are real). */
  readonly names: readonly string[];
  /**
   * Fail LOUDLY if the stub was never reached, or if a query the spec claims to
   * model was never asked for. Call it after the assertions that depend on the
   * stubbed rows, so a bypassed stub reports itself instead of surfacing as a
   * mystery empty panel 45s later.
   */
  assertServed(...expectedNames: string[]): void;
}

export async function stubSyncQueries(
  page: Page,
  resolve: SyncRowsResolver,
): Promise<SyncQueryStub> {
  const names: string[] = [];

  await page.route(REST_QUERY_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(url.searchParams.get('args') ?? '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    names.push(name);
    const rows = resolve(name, args) ?? [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // `version` must change per response or react-query can treat a refetch as
      // unchanged; the real server sends a monotonic token for the same reason.
      body: JSON.stringify({ rows, version: String(Date.now()) }),
    });
  });

  return {
    get hits() {
      return names.length;
    },
    get names() {
      return names;
    },
    assertServed(...expectedNames: string[]) {
      if (names.length === 0) {
        throw new Error(
          'sync stub was NEVER HIT: no GET /api/zero-harness/rest-query request was ' +
            'intercepted. The app is not speaking the contract this stub answers, so every ' +
            'panel rendered from real (unstubbed) traffic. Check the route pattern against ' +
            'libs/generic/sync/src/server/http-routes.ts — note POST /rest-query-batch has ' +
            'been dead since 2026-07-26 and papercusp mounts it nowhere.',
        );
      }
      const missing = expectedNames.filter((n) => !names.includes(n));
      if (missing.length > 0) {
        throw new Error(
          `sync stub served ${names.length} request(s) but never saw ${missing.join(', ')}. ` +
            `Names seen: ${[...new Set(names)].join(', ') || '(none)'}. Either the panel does ` +
            'not subscribe to that query, or the spec models a query nobody asks for.',
        );
      }
    },
  };
}
