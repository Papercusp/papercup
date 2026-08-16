/**
 * The MCP transport cap, and the FOREGROUND command ceiling derived from it.
 *
 * EI-6073: the papercusp-su MCP transport hard-caps a tool call at ~55s. A FOREGROUND
 * command that outruns it is killed by the TRANSPORT with an opaque `request_timeout`
 * BEFORE the handler can respond — so the agent never learns the durable fix is a
 * detached run, and the very capability that exists to remove "shell out + poll"
 * friction pushes them back to it. Every foreground-capable tool therefore clamps its
 * command timeout safely below the cap, so the TOOL always self-times-out first
 * (`status: 'timed_out'`, a machine-separable token) and returns an actionable hint.
 *
 * EI-20645849301780712 is why these live here rather than in `capability:inspect`,
 * where they were first written. Three tools outside that file already imported them
 * (`testing:run`, `build:typecheck`, and now `capability:bash`), which made a tool
 * reach into a SIBLING TOOL to learn a fact about the shared transport. `capability:bash`
 * — the most-used foreground surface of all — was the one that never got the clamp, and
 * the miss is exactly the kind an import-from-a-peer-tool shape hides: there was no
 * single place where "who honours the cap" was answerable. Now there is, and
 * `foreground-transport-cap.test.ts` enumerates the honourers as an invariant.
 *
 * ⚠ Do NOT "fix" a too-short foreground run by RAISING these — that widens the dead
 * window between the ceiling and the transport cap, which is the defect, not the cure.
 * A command that legitimately needs longer belongs in a BACKGROUND job, which returns a
 * handle immediately and is not bound by the transport cap at all (it carries its own,
 * much longer, wall-clock deadline instead — see `DEFAULT_BACKGROUND_TIMEOUT_MS`).
 */

/** The hard per-call ceiling the MCP transport enforces. Not ours to change. */
export const MCP_TRANSPORT_CAP_MS = 55_000;

/** Foreground ceiling — below the transport cap, with ~5s headroom to serialize the response. */
export const FOREGROUND_TIMEOUT_CEILING_MS = 50_000;

/** Clamp a FOREGROUND command timeout below the MCP transport cap (EI-6073).
 *  Background runs skip this clamp — they carry their own (much longer) deadline instead. */
export function clampForegroundTimeoutMs(requestedMs: number): number {
  return Math.min(requestedMs, FOREGROUND_TIMEOUT_CEILING_MS);
}

/**
 * The actionable hint appended when a FOREGROUND run hit the clamped ceiling (EI-6073) — turns an
 * opaque timeout into "this is too large to run inline; re-run detached and poll". Empty for any
 * other status, so a completed/failed run never carries a false timeout hint.
 *
 * `rerunAs` is the caller's OWN detached invocation (each tool has a different one), and stating
 * that the process was KILLED is load-bearing: EI-20645849301780712 was filed because an agent
 * could not tell a killed foreground run from one still executing invisibly server-side.
 *
 * Pure + exported for unit testing.
 */
export function foregroundTimeoutHint(status: string, timeoutMs: number, rerunAs: string): string {
  if (status !== 'timed_out') return '';
  return (
    `\n⏱ hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (kept below the ~${(
      MCP_TRANSPORT_CAP_MS / 1000
    ).toFixed(0)}s MCP transport limit so this returns a hint instead of an opaque request_timeout). ` +
    `The command and its whole process tree were KILLED at the cap — nothing is still running server-side. ` +
    `This is too slow to run inline — re-run detached: ${rerunAs}, then poll capability:bash_output.`
  );
}
