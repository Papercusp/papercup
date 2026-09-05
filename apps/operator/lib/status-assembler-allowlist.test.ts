/**
 * status-assembler-allowlist.test.ts — WI-1383525 GAP 2 (pui-tui-next-wave-2026-09-05 P-007).
 *
 * The single-source status render (status-display.ts → coord:glance `display`) is the ONE
 * place that assembles fleet/loop/objective chips; every client pipe prints it verbatim.
 * Three LEGACY fallbacks legitimately remain for a pre-display operator (the two hook
 * scripts' `term_title` and the OMP hook's `buildLegacyStatusTitle`), so the consumer side
 * cannot be verified by a zero-count grep — an unenumerated FOURTH local assembler would
 * violate parity just as badly as a divergent known one, and no drill would see it.
 *
 * This guard asserts the set of status-assembling source files EQUALS a declared allowlist,
 * by signature rather than by name: a file that renders the fleet-chip glyph pair
 * (`'👑'` / `'👤'` as string literals — the leader/member chip) or composes the `⟳` loop chip
 * from an interval formatter is assembling status locally. A new member fails here with its
 * path; the fix is to pipe `display.title`, not to extend the allowlist.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");

/** Where a status assembler could plausibly live: every client hook + the coordination tools. */
const SCAN_ROOTS = [
  "apps/operator/scripts/hooks",
  "packages/operator-core/lib/agent-tools/coordination",
];
const SOURCE_EXT = /\.(ts|tsx|mts|mjs|cjs|js|sh|py)$/u;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__\/|\/tests?\/)/u;

/** A fleet chip is rendered: the leader AND member glyphs appear as STRING LITERALS (a docstring
 *  mentioning "👑 leader / 👤 member" does not match — the glyphs are unquoted there). */
const FLEET_CHIP = [/['"`]👑['"`]/u, /['"`]👤['"`]/u];
/** A loop chip is composed from an interval formatter (python f-string or TS template). */
const LOOP_CHIP = /⟳\$?\{\s*(fmt_interval|fmtInterval|legacyFmtInterval)\(/u;

/**
 * The declared population. `role` says WHY each member is allowed; `definition` is the one
 * assembler the file may define (counted, so a second copy inside an allowed file fails too).
 */
const ALLOWLIST: Array<{ file: string; role: string; definition: RegExp }> = [
  {
    file: "packages/operator-core/lib/agent-tools/coordination/status-display.ts",
    role: "THE producer — the single-source render every pipe prints verbatim",
    definition: /^export function renderStatusDisplay\(/mu,
  },
  {
    file: "apps/operator/scripts/hooks/cc/statusline-fleet.sh",
    role: "declared fallback #1 — Claude statusline `term_title` for a pre-display operator",
    definition: /^def term_title\(/mu,
  },
  {
    file: "apps/operator/scripts/hooks/cc/posttooluse-objective-title.sh",
    role: "declared fallback #2 — Codex/OMP title hook `term_title` for a pre-display operator",
    definition: /^def term_title\(/mu,
  },
  {
    file: "apps/operator/scripts/hooks/omp/coord-hook.ts",
    role: "declared fallback #3 — OMP `buildLegacyStatusTitle`, the TS port of term_title (GAP 3)",
    definition: /^export function buildLegacyStatusTitle\(/mu,
  },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function assemblers(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO, root), files);
  const hits: string[] = [];
  for (const abs of files) {
    const rel = relative(REPO, abs);
    if (!SOURCE_EXT.test(rel) || TEST_FILE.test(rel)) continue;
    const text = readFileSync(abs, "utf8");
    const fleet = FLEET_CHIP.every((re) => re.test(text));
    const loop = LOOP_CHIP.test(text);
    if (fleet || loop) hits.push(rel);
  }
  return hits.sort();
}

describe("WI-1383525 GAP 2 — status assemblers are exactly the declared allowlist", () => {
  it("the scan roots exist and the signature finds the producer (positive control — a broken scan reads as an empty, passing set)", () => {
    for (const root of SCAN_ROOTS) expect(statSync(join(REPO, root)).isDirectory()).toBe(true);
    expect(assemblers()).toContain(
      "packages/operator-core/lib/agent-tools/coordination/status-display.ts",
    );
  });

  it("no undeclared local status assembler exists (set equality, not a zero count)", () => {
    const found = assemblers();
    const declared = ALLOWLIST.map((a) => a.file).sort();
    const undeclared = found.filter((f) => !declared.includes(f));
    const missing = declared.filter((f) => !found.includes(f));
    expect(
      undeclared,
      `UNDECLARED status assembler(s): ${undeclared.join(", ")} — pipe display.title from coord:glance instead of assembling chips locally (tui-status-parity-single-source-2026-07-05). If this is genuinely a new fallback, add it to the allowlist WITH its role and extend objective-title-parity.test.ts to drive it.`,
    ).toEqual([]);
    expect(
      missing,
      `allowlisted assembler(s) no longer match the signature: ${missing.join(", ")} — either the fallback was removed (drop it here AND from the parity test) or the signature drifted.`,
    ).toEqual([]);
  });

  it("each allowed file defines its ONE assembler exactly once", () => {
    for (const a of ALLOWLIST) {
      const text = readFileSync(join(REPO, a.file), "utf8");
      const count = text.match(new RegExp(a.definition.source, "gmu"))?.length ?? 0;
      expect(count, `${a.file} (${a.role}): expected exactly one definition`).toBe(1);
    }
  });
});
