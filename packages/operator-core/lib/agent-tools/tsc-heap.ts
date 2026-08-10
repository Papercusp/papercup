/**
 * The V8 old-space ceiling for a `tsc` child spawned by an AGENT TOOL, and the
 * NODE_OPTIONS merge that applies it.
 *
 * WHY (EI-20019651513530828 / EI-20013137550825704, measured 2026-08-09):
 * `npx tsc --noEmit` on operator-core builds the whole program in memory (~9k
 * files) and overflows node's DEFAULT ~4GB old-space, dying with
 *
 *     FATAL ERROR: Ineffective mark-compacts near heap limit … heap out of memory
 *     Aborted (core dumped)      # exit 134
 *
 * This is a SIZE limit, not host pressure (the box had ~80GB free), so it recurs
 * and worsens as the tree grows. Both agent-facing typecheck paths —
 * `capability:inspect { check:'typecheck' }` and `build:typecheck` — spawned tsc
 * with no ceiling and so were structurally unable to typecheck their own largest
 * package.
 *
 * ── Relationship to scripts/lib/tsc-baseline-gate.mjs ────────────────────────
 * That module owns the same policy for the `npm run lint:tsc*` GATES and states
 * the rationale at length. This is a deliberate second application point, not a
 * fork: it reads the SAME `PAPERCUSP_TSC_HEAP_MB` override and defaults to the
 * same 8192, so tuning one tunes both. They are not a single module because
 * `scripts/**` is plain ESM `.mjs` outside every workspace and operator-core is
 * compiled TypeScript — there is no import path between them that survives the
 * build. If you change the number, change it in BOTH (they are cross-referenced
 * in each other's header, and `tsc-heap.test.ts` pins the shared default).
 *
 * ⚠ This is a per-process CEILING, not a reservation: concurrent agents each run
 * their own compile, so raise it deliberately.
 */

/** V8 old-space ceiling (MB) for a tsc child. Shares `PAPERCUSP_TSC_HEAP_MB`
 *  with scripts/lib/tsc-baseline-gate.mjs so both move together. */
export const TSC_HEAP_MB = Number(process.env.PAPERCUSP_TSC_HEAP_MB) || 8192;

/**
 * Merge `--max-old-space-size=${TSC_HEAP_MB}` into a NODE_OPTIONS string.
 *
 * - No existing pin → append ours.
 * - An existing LARGER pin → leave it alone (an operator who asked for more wins).
 * - An existing SMALLER pin → RAISE it, rewriting in place.
 *
 * ⚠ That last rule is a CORRECTION, not an oversight, and it must not be
 * "simplified" back to deferring to any existing pin. Doing so froze the fleet
 * gate for ~10h across 11 consecutive reds (WI-37450): a caller that pinned 4096
 * for a FORK POOL handed that env to a whole-program tsc, which then inherited a
 * cap less than half what the compile provably needs. Deferring BELOW what the
 * work requires is not graceful degradation — it converts "this box might be
 * tight" into "this check is structurally unpassable", silently.
 *
 * A second copy is never appended: that would depend on last-wins rather than
 * being explicit.
 */
export function withTscHeap(existingNodeOptions: string | undefined): string {
  const existing = existingNodeOptions ?? '';
  const pinned = /--max-old-space-size(?:=|\s+)(\d+)/.exec(existing);
  if (!pinned) return `${existing} --max-old-space-size=${TSC_HEAP_MB}`.trim();
  if (Number(pinned[1]) >= TSC_HEAP_MB) return existing;
  return existing.replace(/--max-old-space-size(?:=|\s+)\d+/, `--max-old-space-size=${TSC_HEAP_MB}`);
}

/** The `env` overlay for a tsc spawn — just the NODE_OPTIONS pin, so a caller can
 *  spread it over whatever else it passes. */
export function tscHeapEnv(existingNodeOptions: string | undefined = process.env.NODE_OPTIONS): {
  NODE_OPTIONS: string;
} {
  return { NODE_OPTIONS: withTscHeap(existingNodeOptions) };
}
