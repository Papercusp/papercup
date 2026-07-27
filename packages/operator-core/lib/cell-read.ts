/**
 * cell-read.ts — reading a cell's VALUE (unified-agent-state-plane-2026-07-27 P-004,
 * per D-058).
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * `cell-registry.ts` stores CONTRACTS, not values. `getCell(cell, reader)` returns a
 * `CellSpec` whose `resolver` is a STRING NAME and whose `changeSignal` is
 * `{ kind:'poll', tool, path }` — a POINTER to where the value lives, not the value.
 * Nothing in the registry can invoke anything, and that is deliberate: the registry is
 * domain-free by construction (see its header), so dragging the operator's tool
 * dispatcher into it would be the wrong dependency.
 *
 * So the value read is this module: it composes the registry (which decides IF you may
 * read) with the read-only dispatcher (which decides WHETHER THE RESOLVER WILL ANSWER
 * YOU). It is the only place those two are composed, and every consumer in D-055's
 * enrichment map goes through it.
 *
 * ── ⚠ THE TWO-GATE PROBLEM THIS MODULE EXISTS TO RENDER HONESTLY (D-058) ─────
 *
 * Reading a cell's value passes TWO INDEPENDENT access gates:
 *
 *   1. `canReadCell(spec, reader)` — P-019, on the cell SPEC, keyed on `visibility`
 *      (workspace | harness | role | owner | work_item).
 *   2. the resolver TOOL's ROLE GATE — enforced on every dispatch
 *      (`dispatchReadOnlyTool` bypasses only { capability, quota }).
 *
 * THEY CAN DISAGREE, IN EITHER DIRECTION. A reader can pass a workspace-visible cell's
 * audience check and still be refused by the resolver tool's role gate.
 *
 * That disagreement must NOT collapse to "absent" and must NOT surface as an error:
 *
 *   • ABSENT would be a LIE. `absent` is reserved for "this cell does not exist for
 *     you", and a reader who passed `canReadCell` is entitled to know that it does.
 *     Reporting absent here would also corrupt the one signal `absent` carries.
 *   • AN ERROR would be a category mistake and would break every consumer, because
 *     P-026 requires the projection be TOTAL — an enrichment must never be able to
 *     fail the operation it decorates.
 *
 * So it is an in-band, ENUMERATED unknown (`cell-contract.ts`), which is exactly the
 * mechanism axis 2 already provides. This is the SECOND time this plan has hit the
 * two-access-model composition problem — D-056 found it between the goal (a cell) and
 * the assumptions (facts) — which is why it is handled structurally here rather than
 * case-by-case at each consumer.
 *
 * ── WHY NO FIFTH UNKNOWN CODE ────────────────────────────────────────────────
 *
 * `cell-contract.ts` states that adding a code is a CONTRACT CHANGE, because every
 * caller's branch set changes with it. An access refusal is not a new kind of answer:
 * its correct caller response is `not-measured`'s stated lever verbatim — "ask for it,
 * not retry the same call" (here: obtain the role, or ask a peer who holds it). So it
 * maps onto the existing code, with `detail` carrying the specifics. Mapping is
 * recorded in `UNKNOWN_FOR_DISPATCH_CODE` below so it is auditable rather than folded
 * into an if-chain.
 */

import {
  cellUnknown,
  type CellUnknown,
} from './cell-contract';
import { getCell, type CellReader, type CellSpec } from './cell-registry';
import {
  dispatchReadOnlyTool,
  isAccessDenialCode,
  ReadOnlyDispatchError,
  valueAtPath,
} from './events/await/predicate-watch';

/**
 * The outcome of a cell value read. Three-valued by construction (D-038 axis 2), and
 * the three are NOT interchangeable — each implies a different caller response:
 *
 *   • `value`   — the measurement succeeded. Act on it.
 *   • `unknown` — the cell EXISTS FOR YOU but produced no value. Branch on
 *                 `unknown.code`; the lever differs per code.
 *   • `absent`  — the cell does not exist for you: unregistered, OR registered but
 *                 outside your audience. INDISTINGUISHABLE BY DESIGN (P-019) so a
 *                 refusal cannot be used as a probe oracle to enumerate narrow cells.
 */
export type CellRead =
  | { status: 'value'; cell: string; value: unknown; headline: string; resolver: string }
  | { status: 'unknown'; cell: string; unknown: CellUnknown }
  | { status: 'absent'; cell: string };

/**
 * Dispatcher error code → unknown code. Explicit and total-by-fallback rather than an
 * if-chain, so the classification is readable in one place and testable directly.
 *
 * ACCESS refusals (`role_not_allowed`, `missing_role`, `capability_denied`, …) →
 * `not-measured`: the resolver was never allowed to look, and the lever is to obtain
 * access, not to retry. EVERYTHING ELSE (a timeout, a handler error, an unreachable
 * dependency) → `resolver-failed`: retry-or-escalate.
 */
export function unknownForDispatchError(err: ReadOnlyDispatchError): CellUnknown {
  if (isAccessDenialCode(err.code)) {
    return cellUnknown(
      'not-measured',
      `the resolver refused this reader (${err.code}) — you may see this cell but not read through its resolver. ` +
        'Obtain the role the resolver requires, or ask a peer who holds it; retrying this call unchanged will not help.',
    );
  }
  if (err.code === 'not_read_only' || err.code === 'unknown_tool') {
    return cellUnknown(
      'resolver-failed',
      `this cell's resolver is not usable as a read (${err.code}: ${err.message}). This is a REGISTRATION defect, ` +
        'not a transient failure — the cell should not have registered with this resolver.',
    );
  }
  return cellUnknown('resolver-failed', err.message);
}

/** The dispatch env a cell read runs under. Every field is already known at the call
 *  site (identity + request context), so resolving one costs no lookup. */
export interface CellReadEnv {
  workspaceId: string;
  harnessSlug: string | null;
  /** The role the resolver dispatch runs under — the SECOND gate. Never widened. */
  role: string;
}

/**
 * Read one cell's value AS a specific reader.
 *
 * TOTAL — never throws. Every consumer of this is on a hot path (a lock acquire, a
 * claim, a presence read), and P-026 rule (f) makes that a requirement rather than a
 * courtesy: an enrichment that can throw is an enrichment that can fail the operation
 * it decorates.
 *
 * @param subject the value for a `callerRelativity: { kind:'parameter' }` cell — i.e.
 *   WHAT the cell is being read about (an ownerId for the goal cell, a path for the
 *   pipeline cell). It is NOT an identity override: the audience check always runs
 *   against `reader`, so passing a subject can never widen what you may see.
 */
export async function readCell(
  cell: string,
  reader: CellReader,
  env: CellReadEnv,
  subject?: string,
): Promise<CellRead> {
  // GATE 1 — audience. Unreadable is indistinguishable from unregistered (P-019), so a
  // stranger cannot enumerate narrow cells by probing for a different refusal.
  const spec = getCell(cell, reader);
  if (!spec) return { status: 'absent', cell };

  // An event-signalled cell names no tool to call, so there is nothing for a
  // synchronous read to invoke. NOT `not-applicable`: the question applies perfectly
  // well, the cell simply exposes no poll resolver — and the lever (give it one) is
  // exactly `not-measured`'s "ask for it".
  if (spec.changeSignal.kind !== 'poll') {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'not-measured',
        `this cell is event-signalled (key "${spec.changeSignal.key}") and exposes no poll resolver, so it cannot be ` +
          'read synchronously. Subscribe to it with state:subscribe instead.',
      ),
    };
  }

  // Axis 3 — a parameter-relative cell cannot be read without its subject. More INPUT
  // is the lever, which is `insufficient-data` exactly; the detail names the parameter
  // so the caller does not have to go read the spec to find out what is missing.
  const args = argsForRelativity(spec, subject);
  if (args === MISSING_SUBJECT) {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'insufficient-data',
        `this cell is relative to "${(spec.callerRelativity as { param: string }).param}" and no subject was supplied — ` +
          `pass it (state:read { cell, as }) to say WHAT you are asking about.`,
      ),
    };
  }

  // GATE 2 — the resolver tool's own role gate, enforced on the dispatch.
  let payload: unknown;
  try {
    payload = await dispatchReadOnlyTool(spec.changeSignal.tool, args, {
      workspaceId: env.workspaceId,
      harnessSlug: env.harnessSlug,
      role: env.role,
      onBehalfOf: reader.ownerId,
      spawnId: 'cell-read',
    });
  } catch (err) {
    if (err instanceof ReadOnlyDispatchError || (err as Error)?.name === 'ReadOnlyDispatchError') {
      return { status: 'unknown', cell, unknown: unknownForDispatchError(err as ReadOnlyDispatchError) };
    }
    // Anything the dispatcher did not classify. Still an unknown, never a throw.
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown('resolver-failed', err instanceof Error ? err.message : String(err)),
    };
  }

  const value = valueAtPath(payload, spec.changeSignal.path);
  // The resolver answered but the declared path is not present. This is NOT
  // `resolver-failed` (the resolver worked) and NOT a value (there is none) — the read
  // partly succeeded and cannot support a verdict, which is `insufficient-data`.
  if (value === undefined) {
    return {
      status: 'unknown',
      cell,
      unknown: cellUnknown(
        'insufficient-data',
        `the resolver answered but "${spec.changeSignal.path}" was absent from its result — the cell's declared path and ` +
          "its resolver's shape have drifted apart.",
      ),
    };
  }

  return { status: 'value', cell, value, headline: spec.headline, resolver: spec.resolver };
}

/** Sentinel for "this cell needs a subject and none was given" — distinct from the
 *  legitimate empty-args case, which a plain `{}` would collide with. */
const MISSING_SUBJECT = Symbol('missing-subject');

/**
 * Build the resolver's args from the cell's declared caller-relativity (axis 3).
 *
 *  • `global`    — the same for every caller: no subject, no args.
 *  • `ambient`   — relative to something the caller never passes (its uid, its
 *                  identity). The RESOLVER reads it from context; a subject supplied
 *                  here is ignored rather than injected, because injecting it would
 *                  silently turn an ambient cell into a parameter one and let a caller
 *                  redirect a read that was supposed to be about itself.
 *  • `parameter` — REQUIRES the subject, passed under the declared param name.
 */
function argsForRelativity(spec: CellSpec, subject?: string): Record<string, unknown> | typeof MISSING_SUBJECT {
  const rel = spec.callerRelativity;
  if (rel.kind === 'parameter') {
    if (subject === undefined || subject.trim() === '') return MISSING_SUBJECT;
    return { [rel.param]: subject };
  }
  return {};
}
