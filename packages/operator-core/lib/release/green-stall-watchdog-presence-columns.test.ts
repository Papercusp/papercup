import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Regression guard for EI-21291109975568717.
 *
 * green-stall-watchdog's paused-gate scan joined `harness_shared.coord_presence cp`
 * and filtered `AND cp.revoked_at IS NULL`. That column does not exist. Postgres
 * rejected the whole statement on every run, and the caller logged it as
 *
 *   [green-stall-watchdog] paused green-checkpoint scan failed (non-fatal):
 *   column cp.revoked_at does not exist
 *
 * ...and carried on. The scan's job is to find a green-checkpoint paused under a
 * D-012/D-013 live-quiescence hold whose serializer is NO LONGER LIVE — i.e. exactly
 * the stranded-pause condition that froze the papercusp gate for three days. Because
 * of one bogus predicate that guard had never returned a row, and the stranded pause
 * had to be found by hand.
 *
 * The failure class is what matters here, not the single column: a watchdog whose
 * query throws is INVISIBLE, because "the guard found nothing" and "the guard could
 * not run" look identical from outside. Static typing cannot see inside a SQL string,
 * so this test is the thing standing between that class and another silent recurrence.
 *
 * The authoritative column list is DERIVED from the generated schema
 * (libs/papercusp/libs/db/src/schema/generated.ts, produced by pull-schema.mjs)
 * rather than hand-maintained here, so a real column rename updates this guard on its
 * own instead of turning it into a second thing that drifts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const GENERATED_SCHEMA = resolve(
  REPO_ROOT,
  "libs/papercusp/libs/db/src/schema/generated.ts",
);
// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout, where
// the git-sync sweep can commit the mutant mid-probe.
const WATCHDOG = process.env.PROBE_WATCHDOG_SRC
  ? resolve(process.env.PROBE_WATCHDOG_SRC)
  : resolve(HERE, "green-stall-watchdog.ts");

/** camelCase -> snake_case, matching drizzle's inference for an unnamed column. */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Pull the DB column names of a harnessShared.table("<name>", { ... }) block out of
 * the generated schema.
 *
 * Both spellings must be handled or the set comes back wrong in the dangerous
 * direction (too small => false alarms, and a silently empty set => a vacuous pass):
 *   ownerId: text("owner_id")  -> explicit  -> "owner_id"
 *   source:  text()            -> inferred  -> "source"
 *   pid:     integer()         -> inferred  -> "pid"
 */
function generatedTableColumns(source: string, tableName: string): Set<string> {
  const start = source.indexOf(`harnessShared.table("${tableName}"`);
  if (start === -1) {
    throw new Error(
      `generated schema has no harnessShared.table("${tableName}") block — ` +
        `did the schema move? (looked in ${GENERATED_SCHEMA})`,
    );
  }
  const bodyStart = source.indexOf("{", start);
  const bodyEnd = source.indexOf("\n}, (table) =>", bodyStart);
  const body = source.slice(
    bodyStart,
    bodyEnd === -1 ? source.indexOf("\n});", bodyStart) : bodyEnd,
  );

  const columns = new Set<string>();
  // <key>: <type>(            optionally followed by "<explicit_db_name>"
  const decl = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*[A-Za-z][A-Za-z0-9]*\s*\(\s*(?:"([^"]+)")?/gm;
  for (const m of body.matchAll(decl)) {
    const [, key, explicit] = m;
    columns.add(explicit ?? toSnakeCase(key));
  }
  return columns;
}

/** Every `cp.<column>` referenced in the watchdog's SQL, ignoring `--` comments. */
function referencedPresenceColumns(source: string): Set<string> {
  const refs = new Set<string>();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/--.*$/, "");
    for (const m of line.matchAll(/\bcp\.([a-z][a-z0-9_]*)/g)) refs.add(m[1]);
  }
  return refs;
}

describe("green-stall-watchdog coord_presence column references", () => {
  const generated = readFileSync(GENERATED_SCHEMA, "utf8");
  const watchdog = readFileSync(WATCHDOG, "utf8");
  const actual = generatedTableColumns(generated, "coord_presence");

  it("parses the generated schema (calibration — proves the guard can see anything at all)", () => {
    // Without this, a parser that silently returned an empty set would make the
    // real assertion below pass vacuously — the exact shape of failure this whole
    // file exists to prevent. Assert both spellings resolved.
    expect(actual.size).toBeGreaterThan(15);
    expect(actual).toContain("heartbeat_at"); // explicit: timestamp("heartbeat_at")
    expect(actual).toContain("last_active_at"); // explicit
    expect(actual).toContain("owner_id"); // explicit
    expect(actual).toContain("source"); // inferred from a bare text()
    expect(actual).toContain("pid"); // inferred from a bare integer()
  });

  it("still reads the presence join (calibration — a renamed alias must not silently disarm this)", () => {
    expect(watchdog).toContain("harness_shared.coord_presence cp");
    const refs = referencedPresenceColumns(watchdog);
    expect(refs.size).toBeGreaterThan(0);
    expect(refs).toContain("owner_id");
  });

  it("does not reference revoked_at, which coord_presence has never had", () => {
    // The specific regression. Presence rows are DELETED, not revoked; liveness is
    // established by the heartbeat_at / last_active_at freshness pair.
    expect(actual.has("revoked_at")).toBe(false);
    expect(referencedPresenceColumns(watchdog).has("revoked_at")).toBe(false);
  });

  it("references only columns that exist on harness_shared.coord_presence", () => {
    const refs = [...referencedPresenceColumns(watchdog)];
    const missing = refs.filter((c) => !actual.has(c));
    expect(
      missing,
      `green-stall-watchdog.ts references coord_presence column(s) that do not exist: ` +
        `${missing.join(", ")}. Postgres rejects the WHOLE statement, and the caller ` +
        `swallows it as "non-fatal", so the paused-gate scan silently stops running ` +
        `instead of failing loudly. Verify against the generated schema before adding ` +
        `any cp.* predicate (EI-21291109975568717).`,
    ).toEqual([]);
  });
});
