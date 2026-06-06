/**
 * Scenario `toolOverride`s for the `su` suite.
 *
 * The su target's default tool executor returns a benign stub, which is right
 * for scenarios that only need the model's *emitted* tool call. Some scenarios
 * need a tool to return a SPECIFIC result to reproduce their failure mode —
 * that's what `toolOverride` is for (the framework wires it as the session's
 * dispatch override; the su target consults it before stubbing).
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { ToolDispatchOverride } from '@papercusp/testing-shell/llm';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '');
}

/**
 * Returns `harness_required` for any `docs:*` / `plans:*` call that omits a
 * non-empty `harness` arg, and passes through (→ benign stub) when the harness
 * scope IS present. This faithfully reproduces SU-S01's failure surface: the
 * engineer must either pass `harness:'all'`/a slug up front, or RECOVER from
 * the error by re-calling with one — not stall ("can't, no harness selected").
 */
export const HARNESS_REQUIRED_GATE: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (/^(docs|plans):/.test(canon)) {
      const h = (args as Record<string, unknown> | null | undefined)?.harness;
      if (typeof h !== 'string' || !h.trim()) {
        return {
          isError: true,
          content: [
            {
              text: JSON.stringify({
                error: 'harness_required',
                message:
                  "which harness? pass harness:'all' for Papercusp's own (operator-level) docs/plans, or a managed harness slug.",
              }),
            },
          ],
        };
      }
    }
    return PASS_THROUGH;
  },
};
