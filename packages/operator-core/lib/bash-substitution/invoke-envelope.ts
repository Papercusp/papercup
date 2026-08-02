/**
 * EXECUTABLE advisories — turn a matched command into the tool call that
 * replaces it (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-009,
 * which absorbed P-008 per D-059).
 *
 * The registry has always been able to say WHICH tool answers a command. What it
 * could not say is WHAT TO TYPE. An advisory reading "capability:read
 * { file_path, tail: N } returns the last N lines" leaves the agent to parse its
 * own command back apart, map `-n 25` onto `tail: 25`, and re-quote the path —
 * for a saving of a few hundred bytes. That is a bad trade at the moment of
 * decision, and the ~2% compliance rate is what a bad trade looks like in
 * aggregate. This module closes it: the advisory carries the finished call.
 *
 * == WHY THE ENVELOPE IS `tools:invoke`, NOT A BARE `{ name, args }` ==
 *
 * D-059 measured the other half of the compliance failure and found it was not
 * defiance: 11 of 17 `advise` rows name a tool that the DOCUMENTED discovery
 * path cannot find. `ToolSearch select:capability:read` answers "No matching
 * deferred tools found", which reads as "this tool does not exist here", and
 * falling back to bash is then the CORRECT inference from what the agent was
 * shown. So handing over `{ file_path, tail: 25 }` alone would fix the
 * translation cost and leave the discovery cost — the agent still has to find a
 * callable `capability:read` before those args are worth anything.
 *
 * `tools:invoke { name, args }` has neither problem. It dispatches any catalog
 * tool server-side under the tool's real identity and the same gating a direct
 * call gets, and it ships in every trimmed seed. So the rendered envelope is
 * executable from ANY session surface with no discovery step, which is what
 * "compliance cost approaches zero" actually requires.
 *
 * == WHY ABSENCE IS THE DEFAULT, AND WHY THAT IS LOAD-BEARING HERE ==
 *
 * An envelope is derived ONLY from a pair's own `rewrite()`. That is already the
 * opt-in contract `types.ts` describes for replay ("a pair earns automatic
 * rewriting by demonstrating one, and silence means no"), and reusing it rather
 * than inventing a second derivation keeps one statement of what a pair can
 * exactly express.
 *
 * It also does a job specific to this module. The `ambient-context` pairs
 * (`date`, `uptime`, `nproc`, `free`) name `coord:orient` as their tool, but
 * their whole point is that the answer ALREADY ARRIVED on the agent's last
 * orient — their advisories say "read it there; do not call anything", because
 * calling orient to read a clock costs more than the `date` it replaced. Those
 * pairs declare no `rewrite()`, so they get no envelope, and the one thing this
 * module must never do — render `tools:invoke { name: "coord:orient" }` as a
 * suggested call — cannot happen by construction rather than by remembering to
 * special-case it.
 *
 * == FAIL-OPEN ==
 *
 * Every entry point swallows. This runs inside a PreToolUse gate on every shell
 * command from every agent on the box, and the module's entire value is a nicer
 * advisory. A throwing `rewrite()` must cost the agent an envelope, never a
 * command — the same trade `match.ts` and `check_command.ts` already make.
 */

import { ALL_PAIRS } from './pairs';
import type { SubstitutionPair } from './types';

/**
 * A finished, executable tool call derived from the command that matched.
 *
 * Deliberately NOT `ReplayToolCall` (which spells the tool `toolName`): this is
 * a WIRE shape that crosses `locks:check_command` into two hooks, and it is
 * named for the `tools:invoke { name, args }` envelope it renders into so the
 * field names and the thing an agent types are the same words.
 */
export interface InvokeEnvelope {
  /** The tool to call, e.g. `capability:read`. */
  name: string;
  /** Arguments derived from the matched atom, e.g. `{ file_path, tail }`. */
  args: Record<string, unknown>;
}

/**
 * The longest rendered envelope we will put in an advisory.
 *
 * An envelope exists to be cheaper than the prose it accompanies. A rewrite that
 * inlines, say, a long SQL string can exceed that, at which point the advisory
 * is no longer doing the agent a favour — so an oversized render is dropped
 * entirely rather than truncated. A truncated `tools:invoke {…` is strictly
 * worse than none: it is not executable, but it LOOKS executable, so the agent
 * pays the paste before discovering it was cut.
 */
export const MAX_RENDERED_ENVELOPE_CHARS = 600;

/** Pairs indexed by `intentLabel` — the key the registry row carries. */
const PAIRS_BY_INTENT = new Map<string, SubstitutionPair>(
  ALL_PAIRS.map((pair) => [pair.intentLabel, pair]),
);

/**
 * The executable call for one matched atom, or null when there isn't one.
 *
 * Null is an ordinary, expected answer with four distinct causes, none of which
 * is an error: the intent has no code pair (a hand-added registry row), the pair
 * declares no `rewrite()` (the opt-in default above), the rewrite declined this
 * atom, or the rewrite threw.
 *
 * The `intentLabel` join is what lets the DB stay the source of truth for WHICH
 * patterns are enforced (D-002) while the code stays the source of truth for how
 * one is expressed. Note the consequence: if a row's `bash_pattern` is edited in
 * the DB to claim atoms the code pair's `cover()` does not recognise, this
 * returns null for those atoms and the advisory silently falls back to prose.
 * That is the correct failure direction — a drifted row loses its envelope, it
 * does not gain a wrong one.
 */
export function deriveInvokeEnvelope(intentLabel: string, atom: string): InvokeEnvelope | null {
  try {
    const pair = PAIRS_BY_INTENT.get(intentLabel);
    if (!pair?.rewrite) return null;

    const call = pair.rewrite(atom);
    if (!call) return null;
    if (!call.toolName || typeof call.args !== 'object' || call.args === null) return null;

    return { name: call.toolName, args: call.args };
  } catch {
    return null;
  }
}

/**
 * The paste-ready line for an envelope, or null when it renders too large.
 *
 * Args are rendered as JSON rather than as JS object literal source because the
 * result is a thing an agent copies into a tool call, and JSON is the one
 * spelling that is unambiguous about quoting — `{ file_path: /tmp/x.log }` is
 * not a valid argument to anything, and the paths this fires on routinely
 * contain characters that need quoting.
 */
export function renderInvokeEnvelope(envelope: InvokeEnvelope): string | null {
  try {
    const args = JSON.stringify(envelope.args);
    const line = `tools:invoke { name: "${envelope.name}", args: ${args} }`;
    return line.length > MAX_RENDERED_ENVELOPE_CHARS ? null : line;
  } catch {
    // A rewrite returning a cyclic or non-serialisable arg. Not representable,
    // so not offered — the prose advisory still stands on its own.
    return null;
  }
}

/** A registry match, plus the executable call for it when one could be derived. */
export interface WithInvokeEnvelope {
  intentLabel: string;
  atom: string;
  invoke?: InvokeEnvelope;
}

/**
 * Attach an envelope to every match that can carry one.
 *
 * Done SERVER-SIDE, in `locks:check_command`, for two reasons. The derivation
 * needs `ALL_PAIRS` — live code, with each pair's real parser — and a PreToolUse
 * hook has only the wire payload, so a hook-side derivation would mean shipping
 * a second, drifting copy of every pair's argument mapping into two hooks (one
 * of which is Python inside a shell script). And computing it once on the server
 * means both hooks render the SAME envelope by construction, which is the same
 * reason `match.ts` is the single matcher rather than one per consumer.
 */
export function attachInvokeEnvelopes<T extends { intentLabel: string; atom: string }>(
  matches: T[],
): (T & { invoke?: InvokeEnvelope })[] {
  return matches.map((match) => {
    const invoke = deriveInvokeEnvelope(match.intentLabel, match.atom);
    return invoke ? { ...match, invoke } : { ...match };
  });
}
