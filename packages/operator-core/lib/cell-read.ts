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
  | {
      status: 'value';
      cell: string;
      value: unknown;
      headline: string;
      resolver: string;
      /**
       * P-021 — the MATERIAL answer, present only when the spec declares
       * `materiality` AND that path resolved in this same result.
       *
       * ⚠ EXTRACTED FROM THE DISPATCH THAT ALREADY HAPPENED — never a second
       * call. That is axis 5 applied to materiality: the material answer is a
       * LENS on the one derivation, so declaring it costs no resolver work and
       * cannot drift from the value it qualifies.
       *
       * ABSENT when the declared path is not in the result. That case is a
       * registration drift, and callers must treat it as "cannot compare
       * materially" and fall back to the LOUD reading — never as "nothing
       * material changed", which is the silent-suppression failure the
       * `materiality.why` rule exists to keep auditable.
       */
      material?: { path: string; value: unknown };
      /**
       * D-039 — THE HOIST. Present exactly when the spec declares `unknownHoist`,
       * which the registry allows only on a `nullable` cell (axis 2). Carries the
       * RESULT-LEVEL unknown channel the resolver already emits — `positionsUnknown[]`,
       * `verdictUnknown[]`, `goalUnknown` — so `value: null` is never handed to a
       * caller with the reason stripped off.
       *
       * ⚠ EMITTED WHETHER OR NOT THE HEADLINE IS NULL, and that is the point rather
       * than an oversight. The hoist is RESULT-level, not headline-level: a
       * `git.pipelinePosition` read can answer `positions.deployed = true` while
       * `positionsUnknown` names `inMain` as never measured. Gating the hoist on a
       * null headline would drop exactly that case — an unknown leg hiding behind a
       * known one, which is the shape of the defect D-039 exists to surface.
       */
      unknownHoist?: CellHoist;
    }
  | { status: 'unknown'; cell: string; unknown: CellUnknown }
  | { status: 'absent'; cell: string };

/**
 * The hoisted result-level unknown channel, named so a consumer can branch on it
 * without reading the registry to learn what to look for.
 *
 * `key` is the declared field name (`spec.unknownHoist`) — carried rather than
 * spliced in as a dynamic top-level key, because a caller that must first consult
 * the spec to know which key to read is the "hurried consumer" D-039's rule is
 * written against. A fixed field is what a caller cannot miss.
 *
 * `drifted` distinguishes the two ways this channel can be quiet, which demand
 * OPPOSITE responses and are indistinguishable without it:
 *
 *   • absent flag, `value: []` / `null` — the resolver MEASURED and has nothing to
 *     report. A real negative result, and the one worth trusting: a hoist that fired
 *     on the healthy path is one agents learn to ignore.
 *   • `drifted: true` — the declared key was NOT in the resolver's result at all.
 *     The channel is broken, not silent. This is the failure that produced this
 *     field (the hoist was declared on six cells, enforced at registration, and
 *     emitted by nothing), so it is reported LOUDLY rather than omitted.
 */
export interface CellHoist {
  key: string;
  value: unknown;
  /** True ⇒ the declared key was absent from the resolver result: registration
   *  drift, NOT a measured silence. `value` is null and means nothing. */
  drifted?: true;
}

/**
 * Render a hoist for a prose surface, or `null` when it has nothing to say.
 * Mirrors `formatCellUnknown` — `key`/`value` tell a program what to do, this tells
 * a reader why, and neither replaces the other.
 *
 * ⚠ RETURNS NULL ON A MEASURED SILENCE, deliberately. An empty `verdictUnknown: []`
 * means the resolver looked and found nothing unknown, and announcing that on every
 * healthy read is how a warning becomes noise a reader learns to skip — which would
 * cost exactly the case the hoist exists for. Prose is spent only when the channel
 * has something.
 */
export function formatCellHoist(h: CellHoist): string | null {
  if (h.drifted) {
    return `⚠ this cell declares the result-level unknown channel "${h.key}", but its resolver did not emit it. The reason a null value carries is MISSING, not empty — treat a null here as unexplained, and read this as a registration defect in the resolver rather than a clean measurement.`;
  }
  if (h.value === null || h.value === undefined) return null;
  if (Array.isArray(h.value) && h.value.length === 0) return null;
  return `⚠ "${h.key}" is not empty — part of this answer is UNKNOWN rather than measured: ${JSON.stringify(h.value)}. Do not read the headline as a complete verdict without checking it.`;
}

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

  // P-021 — the material lens, off the SAME payload. `undefined` means the
  // declared path is not in this result (registration drift): we omit `material`
  // rather than reporting it as unchanged, so the caller falls back to LOUD.
  const materialPath = spec.materiality?.path;
  const materialValue = materialPath === undefined ? undefined : valueAtPath(payload, materialPath);

  return {
    status: 'value',
    cell,
    value,
    headline: spec.headline,
    resolver: spec.resolver,
    ...(spec.unknownHoist === undefined ? {} : { unknownHoist: hoistFrom(payload, spec.unknownHoist) }),
    ...(materialPath !== undefined && materialValue !== undefined
      ? { material: { path: materialPath, value: materialValue } }
      : {}),
  };
}

/**
 * D-039 — lift the resolver's result-level unknown channel out of the payload the
 * dispatch ALREADY returned. Off the same payload, exactly as `material` is: axis 5
 * (one derivation, many lenses) forbids a second call, and a hoist that cost an extra
 * dispatch would be a hoist authors quietly stop declaring.
 *
 * ⚠ THE `drifted` BRANCH IS THE WHOLE REASON THIS FUNCTION IS NOT A ONE-LINER, and it
 * is deliberately the OPPOSITE of `material`'s missing-path rule. `material` OMITS on
 * drift, so a caller falls back to the loud reading and nothing is lost. Omitting here
 * would reproduce the defect this fixes byte for byte: a nullable cell answering
 * `value: null` with no reason attached, silently, forever. So a declared-but-absent
 * hoist is REPORTED — the read still succeeds (P-026: an enrichment may never fail its
 * caller), and the caller is told the channel is broken rather than empty.
 */
function hoistFrom(payload: unknown, key: string): CellHoist {
  const hoisted = valueAtPath(payload, key);
  return hoisted === undefined ? { key, value: null, drifted: true } : { key, value: hoisted };
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
