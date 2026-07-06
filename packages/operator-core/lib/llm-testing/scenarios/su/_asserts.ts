/**
 * Custom-assert builders for the `su` scenarios.
 *
 * Why custom (not the built-in `tool_called` / `text_excludes`):
 *   - `tool_called` name-matching is a LOOSE tail-match (`docs:get` also
 *     matches `plans:get` / `features:get`), so it can't pin an exact tool or
 *     an arg-presence check.
 *   - `text_excludes` is WARN severity — it can't be a load-bearing (gating)
 *     check. These builders emit ERROR severity so a banned/missing behavior
 *     actually fails the run.
 *
 * Each builder returns a `{ kind: 'custom', name, eval }` DeterministicAssert.
 */

import type { DeterministicAssert, RunSummary, ToolCallEvent, Violation } from '@papercusp/testing-shell/llm';

type CustomAssert = Extract<DeterministicAssert, { kind: 'custom' }>;

interface Meta {
  name: string;
  claim: string;
  suggestion?: string;
}

/** Strip a possible mcp prefix to the canonical colon form. The su target
 *  already records canonical names; this is defensive. */
function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

function allToolCalls(run: RunSummary): ToolCallEvent[] {
  return run.turns.flatMap((t) => t.toolCalls);
}

function violation(meta: Meta, evidenceTurnIdx?: number): Violation {
  return {
    assertKind: `custom:${meta.name}`,
    severity: 'error',
    ...(evidenceTurnIdx !== undefined ? { evidenceTurnIdx } : {}),
    claim: meta.claim,
    ...(meta.suggestion ? { suggestion: meta.suggestion } : {}),
  };
}

/** Does `name` match one of `specs`? A spec is either an exact canonical name
 *  (`docs:get`) or a group wildcard (`design-phase:*`). */
function nameMatches(name: string, specs: string[]): boolean {
  const c = canonical(name);
  return specs.some((spec) => {
    if (spec.endsWith(':*')) return c.startsWith(spec.slice(0, -1)); // 'design-phase:'
    return c === spec;
  });
}

/** ERROR unless at least one tool in any of `groups` was called with a
 *  non-empty STRING value at `argKey` (e.g. docs/plans called WITH a harness
 *  scope arg). */
export function assertToolGroupWithStringArg(
  groups: string[],
  argKey: string,
  meta: Meta,
): CustomAssert {
  const specs = groups.map((g) => `${g}:*`);
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const hit = allToolCalls(run).some((tc) => {
        if (!nameMatches(tc.name, specs)) return false;
        const v = (tc.input as Record<string, unknown> | null | undefined)?.[argKey];
        return typeof v === 'string' && v.trim().length > 0;
      });
      return hit ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless at least one of `specs` (exact or `group:*`) was called. */
export function assertToolCalled(specs: string[], meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (allToolCalls(run).some((tc) => nameMatches(tc.name, specs)) ? [] : [violation(meta)]),
  };
}

/** ERROR if ANY of `specs` (exact or `group:*`) was called — the load-bearing
 *  "must NOT fire" gate (the built-in `tool_not_called` is warn-only). */
export function assertToolNotCalled(specs: string[], meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const hits = allToolCalls(run).filter((tc) => nameMatches(tc.name, specs));
      return hits.length === 0 ? [] : [violation(meta)];
    },
  };
}

/** ERROR if `specs` (exact or `group:*`) were called MORE than `max` times in
 *  total — catches an agent that hand-loops a per-item tool instead of batching
 *  it into one code:run. */
export function assertToolCallCountAtMost(specs: string[], max: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const count = allToolCalls(run).filter((tc) => nameMatches(tc.name, specs)).length;
      return count <= max ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless `specs` (exact or `group:*`) were called AT LEAST `min` times in
 *  total — the load-bearing "must have re-fetched" gate. Used by the delta
 *  fallback scenario (agent-tool-delta-protocol P-007): when the base snapshot
 *  was compacted away, the SUT must FALL BACK to a full re-fetch rather than
 *  hallucinate-merge a delta against a base it no longer holds, so the snapshot
 *  tool fires more times than the happy (base-present) path needs. */
export function assertToolCallCountAtLeast(specs: string[], min: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const count = allToolCalls(run).filter((tc) => nameMatches(tc.name, specs)).length;
      return count >= min ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless the given predicate finds a matching tool call. Use for
 *  compound conditions (e.g. design-phase:* OR docs:* with a design-ish arg). */
export function assertToolMatch(
  predicate: (tc: ToolCallEvent) => boolean,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (allToolCalls(run).some(predicate) ? [] : [violation(meta)]),
  };
}

/** ERROR if ANY turn's assistant text matches `pattern` (a banned behavior the
 *  model expresses in prose — e.g. proposing a raw SQL write or a browser nav
 *  to :3070). Stronger than `text_excludes`, which is warn-only. */
export function assertTextForbids(pattern: RegExp, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      for (let i = 0; i < run.turns.length; i++) {
        if (pattern.test(run.turns[i].assistantText)) return [violation(meta, i)];
      }
      return [];
    },
  };
}

/** ERROR if the selected assistant turn's text matches `pattern`. Use when an
 *  earlier turn may legitimately mention text that must be absent from the
 *  answer under test (for example, a delta scenario's base-list turn naming a
 *  row that the final merged-list turn must remove). */
export function assertTextForbidsInTurn(pattern: RegExp, turnIdx: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      return pattern.test(turn.assistantText) ? [violation(meta, turnIdx)] : [];
    },
  };
}

/** ERROR if the selected assistant turn's text matches `pattern` after
 *  `sectionStart`. Useful when the answer may legitimately discuss a removed
 *  item in a "what changed" preamble, but must not include it in the current
 *  list that follows. If the section marker is absent, fall back to the full
 *  turn so the assert still catches obviously wrong current-list answers. */
export function assertTextForbidsInTurnAfter(
  pattern: RegExp,
  turnIdx: number,
  sectionStart: RegExp,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      const marker = turn.assistantText.search(sectionStart);
      const text = marker >= 0 ? turn.assistantText.slice(marker) : turn.assistantText;
      return pattern.test(text) ? [violation(meta, turnIdx)] : [];
    },
  };
}

/** ERROR unless SOME turn's assistant text matches `pattern` (the model points
 *  at the blessed path — e.g. names the Tauri/desktop flow, or SSE/IPC push). */
export function assertTextRequires(pattern: RegExp, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (run.turns.some((t) => pattern.test(t.assistantText)) ? [] : [violation(meta)]),
  };
}

/** ERROR unless the selected assistant turn's text matches `pattern`. */
export function assertTextRequiresInTurn(pattern: RegExp, turnIdx: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      return pattern.test(turn.assistantText) ? [] : [violation(meta, turnIdx)];
    },
  };
}

/** ERROR unless `pattern` matches within the FIRST `withinTurns` assistant
 *  turns — for the SAME-TURN class of rules (the behavior must fire when its
 *  cue lands, not get queued for close-out; agent policies §19). A full-run
 *  assertTextRequires would pass a deferred mention on the last turn, which is
 *  exactly the failure mode under test. */
export function assertTextRequiresWithin(
  pattern: RegExp,
  withinTurns: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) =>
      run.turns.slice(0, withinTurns).some((t) => pattern.test(t.assistantText))
        ? []
        : [violation(meta)],
  };
}

/** ERROR unless SOME turn from `fromTurnIdx` onward matches `pattern`.
 *
 * (EI-7923/WI-3229) A hardcoded `assertTextRequiresInTurn(pattern, 1, ...)`
 * false-positives whenever the model legitimately needs an extra turn before
 * its substantive answer (e.g. a clarifying question after a compaction wiped
 * disambiguating context) — the correct content lands one turn later than the
 * scenario's fixed index assumed, and the assert fails even though the final
 * delivered answer is right. Use this instead of `assertTextRequiresInTurn`
 * whenever the model may legitimately take an extra turn to get there. */
export function assertTextRequiresFromTurn(
  pattern: RegExp,
  fromTurnIdx: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turns = run.turns.slice(fromTurnIdx);
      const hitIdx = turns.findIndex((t) => pattern.test(t.assistantText));
      return hitIdx >= 0 ? [] : [violation(meta)];
    },
  };
}

/** ERROR if ANY turn from `fromTurnIdx` onward matches `pattern` — the
 *  range-checked sibling of `assertTextForbidsInTurn`, for the same
 *  turn-index-rigidity reason as `assertTextRequiresFromTurn` above: a banned
 *  value can land in whichever turn ends up carrying the final answer, not
 *  necessarily the scenario's originally-assumed fixed index. */
export function assertTextForbidsFromTurn(
  pattern: RegExp,
  fromTurnIdx: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turns = run.turns.slice(fromTurnIdx);
      const hitIdx = turns.findIndex((t) => pattern.test(t.assistantText));
      return hitIdx >= 0 ? [violation(meta, fromTurnIdx + hitIdx)] : [];
    },
  };
}
