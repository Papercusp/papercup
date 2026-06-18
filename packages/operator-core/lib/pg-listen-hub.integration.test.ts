/**
 * pg-listen-hub.integration.test.ts — the proof for C1-3
 * (backend-connection-scaling-2026-06-17): when PAPERCUSP_LISTEN_HUB=1, MULTIPLE
 * `hubListen()` subscriptions to DIFFERENT channels ride ONE shared postgres-js
 * backend (postgres-js multiplexes `.listen()` over a single connection), and
 * both callbacks still fire on `pg_notify`.
 *
 * Real Postgres via the shared testcontainer (Docker required), a fresh database
 * per file. The hub resolves its connection through `getHarnessAdminUrl()`, which
 * reads `HARNESS_ADMIN_DATABASE_URL` first — so we point that at the fresh DB and
 * reset the in-process URL cache before exercising the hub.
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/pg-listen-hub.integration.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import postgres, { type Sql } from "postgres";
import { createFreshTestDb, type MigratedTestDb } from "@papercusp/test-config";
import { hubListen, listenHubEnabled, _stopHubForTests } from "./pg-listen-hub";
import { _resetHarnessAdminUrlCacheForTests } from "./embedded-pg-discovery";

let db: MigratedTestDb;
/** A separate client we use to issue the NOTIFYs and inspect pg_stat_activity. */
let probe: Sql;

const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
const SAVED_FLAG = process.env.PAPERCUSP_LISTEN_HUB;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: "listenhub" });
  probe = postgres(db.url, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await probe.end({ timeout: 5 }).catch(() => {});
  await db.drop();
});

beforeEach(() => {
  // Point the hub at the fresh DB and arm the flag, then drop the cached URL so
  // the next getHarnessAdminUrl() re-resolves to it.
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.PAPERCUSP_LISTEN_HUB = "1";
  _resetHarnessAdminUrlCacheForTests();
});

afterEach(async () => {
  await _stopHubForTests();
  _resetHarnessAdminUrlCacheForTests();
  if (SAVED_ADMIN_URL === undefined)
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
  if (SAVED_FLAG === undefined) delete process.env.PAPERCUSP_LISTEN_HUB;
  else process.env.PAPERCUSP_LISTEN_HUB = SAVED_FLAG;
});

/** Resolve when `value` is received, or reject after `ms`. */
function awaitNotify(
  register: (resolve: (v: string) => void) => void,
  ms = 5000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for NOTIFY")),
      ms,
    );
    register((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

function countHubBackends(): Promise<number> {
  return probe`
    SELECT count(*)::int AS n
      FROM pg_stat_activity
     WHERE application_name LIKE 'pcusp:listen-hub:%'
  `.then((rows) => (rows[0] as { n: number }).n);
}

describe("pg-listen-hub (PAPERCUSP_LISTEN_HUB=1)", () => {
  it("multiplexes two channels onto ONE backend and fires both callbacks", async () => {
    expect(listenHubEnabled()).toBe(true);

    let resolveA!: (v: string) => void;
    let resolveB!: (v: string) => void;
    const gotA = awaitNotify((r) => {
      resolveA = r;
    });
    const gotB = awaitNotify((r) => {
      resolveB = r;
    });

    const unsubA = await hubListen("hub_chan_a", (payload) =>
      resolveA(payload),
    );
    const unsubB = await hubListen("hub_chan_b", (payload) =>
      resolveB(payload),
    );

    // EXACTLY ONE backend serves both subscriptions (the collapse 4→1 proof).
    const backendsWhileListening = await countHubBackends();
    expect(backendsWhileListening).toBe(1);

    // Fire both channels from the separate probe client.
    await probe.notify("hub_chan_a", "payload-A");
    await probe.notify("hub_chan_b", "payload-B");

    const [a, b] = await Promise.all([gotA, gotB]);
    expect(a).toBe("payload-A");
    expect(b).toBe("payload-B");

    // First unsub keeps the (still-referenced) connection alive…
    unsubA();
    expect(await countHubBackends()).toBe(1);

    // …last unsub tears it down (give the async .end() a moment to land).
    unsubB();
    await expect.poll(() => countHubBackends(), { timeout: 5000 }).toBe(0);
  });
});
