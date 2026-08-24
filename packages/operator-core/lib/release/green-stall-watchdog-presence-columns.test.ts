import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

/**
 * Regression guard for EI-21291109975568717, generalized to its whole class.
 *
 * THE BUG: green-stall-watchdog's paused-gate scan joined `harness_shared.coord_presence cp`
 * and filtered `AND cp.revoked_at IS NULL`. That column does not exist. Postgres rejected
 * the entire statement on every run, and the caller logged
 *
 *   [green-stall-watchdog] paused green-checkpoint scan failed (non-fatal):
 *   column cp.revoked_at does not exist
 *
 * ...and carried on. That scan finds a green-checkpoint paused under a D-012/D-013
 * live-quiescence hold whose serializer is NO LONGER LIVE — the stranded-pause condition
 * that froze the papercusp gate for three days. It had never returned a row.
 *
 * WHY A TEST AND NOT TYPES: a watchdog whose query throws is INVISIBLE, because "the guard
 * found nothing" and "the guard could not run" are indistinguishable from outside. This file
 * counted SIX `(non-fatal)` swallows, five of them whole watchdog passes — the paused-gate
 * scan, green-stall, main-behind-staging, release-trigger-freeze, and release-trigger-fire-stale.
 * Any of them can stop guarding for months and leave only a console.warn nobody greps.
 * TypeScript cannot see inside a SQL string, so this static check is the thing standing
 * between that class and a silent recurrence.
 *
 * SCOPE: every `harness_shared.<table> <alias>` binding in this directory, not just the one
 * column that broke. The authoritative column lists are DERIVED from the generated schema
 * (produced by pull-schema.mjs) rather than hand-maintained here, so a genuine column rename
 * updates this guard on its own instead of making it a second thing that drifts.
 *
 * HONESTY: what this canNOT check is reported by the coverage test below rather than left
 * implicit — a guard that silently inspects nothing is the failure mode it exists to prevent.
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
 * Column names for every harnessShared.table("<name>", { ... }) in the generated schema.
 *
 * Both spellings must be handled or the sets come back wrong in the dangerous direction:
 * too small => false alarms on real columns, and silently empty => a vacuous pass.
 *   ownerId: text("owner_id")  -> explicit  -> "owner_id"
 *   source:  text()            -> inferred  -> "source"
 */
function generatedTables(source: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const header = /harnessShared\.table\(\s*"([a-z0-9_]+)"\s*,\s*\{/g;
  const decl =
    /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*[A-Za-z][A-Za-z0-9]*\s*\(\s*(?:"([^"]+)")?/gm;

  for (const m of source.matchAll(header)) {
    const tableName = m[1];
    const bodyStart = source.indexOf("{", m.index!);
    // The block ends at the table's closing brace — either `}, (table) => [` or `});`.
    const withExtras = source.indexOf("\n}, (table) =>", bodyStart);
    const plain = source.indexOf("\n});", bodyStart);
    const candidates = [withExtras, plain].filter((i) => i !== -1);
    if (candidates.length === 0) continue;
    const body = source.slice(bodyStart, Math.min(...candidates));

    const columns = new Set<string>();
    decl.lastIndex = 0;
    for (const c of body.matchAll(decl)) columns.add(c[2] ?? toSnakeCase(c[1]));
    if (columns.size > 0) tables.set(tableName, columns);
  }
  return tables;
}

/** Strip SQL `--` and TS `//` line comments plus block comments, so prose cannot bind aliases. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Tokens that can follow a table name without being an alias. Without this the parser
 * binds `SET`/`WHERE`/`VALUES` to every table they follow, and the resulting ambiguity
 * noise hides genuine findings.
 */
const SQL_KEYWORDS = new Set([
  "as", "on", "set", "where", "values", "from", "join", "left", "right", "inner",
  "outer", "full", "cross", "lateral", "natural", "using", "returning", "order",
  "group", "having", "limit", "offset", "select", "insert", "update", "delete",
  "into", "do", "nothing", "conflict", "when", "then", "else", "end", "case",
  "is", "not", "null", "exists", "in", "by", "desc", "asc", "distinct", "union",
  "all", "and", "or", "for", "of", "with", "add", "drop", "alter", "table",
]);

interface AliasFinding {
  file: string;
  table: string;
  alias: string;
  column: string;
}

/**
 * Resolve `harness_shared.<table> <alias>` bindings in one file, then collect every
 * `<alias>.<column>` reference. An alias bound to more than one table within the same file
 * is AMBIGUOUS and deliberately skipped rather than guessed at.
 */
function auditFile(path: string, tables: Map<string, Set<string>>) {
  const src = stripComments(readFileSync(path, "utf8"));
  const file = basename(path);

  const boundTables = new Map<string, Set<string>>();
  for (const m of src.matchAll(
    /harness_shared\.([a-z0-9_]+)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi,
  )) {
    const [, table, alias] = [m[0], m[1].toLowerCase(), m[2].toLowerCase()];
    // The token after a table name is very often SQL, not an alias:
    // `UPDATE harness_shared.routines SET ...`, `... harness_shared.x WHERE ...`.
    // Treating those as aliases binds one keyword to many tables and produces
    // "ambiguous" noise that would bury a real finding.
    if (SQL_KEYWORDS.has(alias)) continue;
    if (!boundTables.has(alias)) boundTables.set(alias, new Set());
    boundTables.get(alias)!.add(table);
  }

  const bad: AliasFinding[] = [];
  const skipped: string[] = [];

  for (const [alias, tableNames] of boundTables) {
    if (tableNames.size > 1) {
      skipped.push(`${file}: alias "${alias}" bound to ${[...tableNames].join(" and ")} (ambiguous)`);
      continue;
    }
    const table = [...tableNames][0];
    const columns = tables.get(table);
    if (!columns) {
      skipped.push(`${file}: table "${table}" not found in the generated schema`);
      continue;
    }
    const refs = new Set<string>();
    for (const r of src.matchAll(
      new RegExp(`\\b${alias}\\.([a-z][a-z0-9_]*)\\b`, "g"),
    )) {
      refs.add(r[1]);
    }
    for (const column of refs) {
      if (!columns.has(column)) bad.push({ file, table, alias, column });
    }
  }
  return { bad, skipped, aliasCount: boundTables.size };
}

const releaseFiles = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => resolve(HERE, f));

describe("release SQL references only columns that exist", () => {
  const generated = readFileSync(GENERATED_SCHEMA, "utf8");
  const tables = generatedTables(generated);
  const presence = tables.get("coord_presence");

  it("parses the generated schema (calibration — proves the guard can see anything at all)", () => {
    // Without this, a parser that silently returned empty sets would make every assertion
    // below pass vacuously — the exact shape of failure this file exists to prevent.
    expect(tables.size).toBeGreaterThan(20);
    expect(presence, "coord_presence must resolve in the generated schema").toBeDefined();
    expect(presence!.size).toBeGreaterThan(15);
    expect(presence).toContain("heartbeat_at"); // explicit: timestamp("heartbeat_at")
    expect(presence).toContain("owner_id"); // explicit
    expect(presence).toContain("source"); // inferred from a bare text()
    expect(presence).toContain("pid"); // inferred from a bare integer()
  });

  it("still reads the presence join (calibration — a renamed alias must not silently disarm this)", () => {
    const src = stripComments(readFileSync(WATCHDOG, "utf8"));
    expect(src).toContain("harness_shared.coord_presence cp");
    expect(src).toMatch(/\bcp\.owner_id\b/);
  });

  it("does not reference coord_presence.revoked_at, which never existed (the original regression)", () => {
    // Presence rows are DELETED, not revoked; liveness comes from the
    // heartbeat_at / last_active_at freshness pair.
    expect(presence!.has("revoked_at")).toBe(false);
    const src = stripComments(readFileSync(WATCHDOG, "utf8"));
    expect(/\bcp\.revoked_at\b/.test(src)).toBe(false);
  });

  it("every aliased harness_shared column in release/ exists on its table", () => {
    const findings = releaseFiles.flatMap((f) => auditFile(f, tables).bad);
    const rendered = findings.map(
      (f) => `${f.file}: ${f.alias}.${f.column} (no such column on harness_shared.${f.table})`,
    );
    expect(
      rendered,
      `release SQL references column(s) that do not exist. Postgres rejects the WHOLE ` +
        `statement, and these watchdogs swallow the error as "(non-fatal)", so the guard ` +
        `silently stops running instead of failing loudly (EI-21291109975568717). Verify ` +
        `against the generated schema before adding any aliased predicate.`,
    ).toEqual([]);
  });

  it("reports its own coverage (a guard that inspects nothing must not read as a pass)", () => {
    const audits = releaseFiles.map((f) => auditFile(f, tables));
    const aliases = audits.reduce((n, a) => n + a.aliasCount, 0);
    const skipped = audits.flatMap((a) => a.skipped);

    // Coverage floor: if a refactor moves this SQL elsewhere, fail loudly rather than
    // quietly inspecting zero aliases forever.
    expect(releaseFiles.length).toBeGreaterThan(3);
    expect(aliases, `no harness_shared aliases found in ${HERE} — has the SQL moved?`)
      .toBeGreaterThan(3);

    // Skips are legitimate (ambiguous alias, table absent from the schema) but must be
    // VISIBLE, so nobody mistakes an unchecked alias for a checked one. Asserted rather
    // than logged: this repo runs vitest-fail-on-console, and a warning nobody reads is
    // the same invisibility this guard exists to fix. Raise the bound deliberately if a
    // legitimately-ambiguous alias is added, so the skip list stays a reviewed set.
    expect(
      skipped,
      `unchecked harness_shared aliases in ${HERE} — each is SQL this guard did NOT verify`,
    ).toHaveLength(0);
  });
});
