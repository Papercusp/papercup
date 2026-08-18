/**
 * NAMED RESULT VIEWS — schema-stable recovery capsules with projection receipts.
 *
 * Plan: named-result-views-schema-stable-recovery-capsules-with-proj-2026-08-14 (P-001).
 *
 * WHY THIS EXISTS, stated against the two things that already work:
 *
 *  - Free-form `projection: { pick: [...] }` reduces ANY result, but the caller
 *    must re-type the field paths every time and nothing guarantees the same
 *    paths still mean the same thing next week. That is fine for an ad-hoc
 *    reduction and useless as a RECOVERY CAPSULE, which by definition is read
 *    by a successor who was not present when the paths were chosen.
 *  - `payloadTier` ('trimmed' | 'full') is coarse and lossy-by-shape: it decides
 *    how much, never exactly which fields.
 *
 * A named view is the missing third thing: a STABLE NAME that resolves to a
 * VERSIONED field-selection plus a byte budget, and reports back which version
 * applied. A cold successor asks for the name; the receipt tells it precisely
 * what it got. That is the whole mechanism.
 *
 * ADDITIVE BY CONSTRUCTION: when no view is named, nothing in this file runs and
 * behavior is byte-identical to today. It cannot regress an existing caller.
 *
 * REUSE: selection is delegated to `applyPick` — the same code path free-form
 * `pick` uses. This module owns the NAME -> (fields, budget, version) table and
 * the receipt; it deliberately implements no selection logic of its own, so a
 * fix to pick semantics is inherited here for free.
 */

import { applyPick } from './apply';
import type { ProjectionSpec } from './types';

/** The dispatch-level argument that names a view. Sibling of `PROJECTION_ARG`. */
export const VIEW_ARG = 'view' as const;

export interface NamedViewDef {
  /**
   * Bumped whenever `fields` or `budgetChars` changes. The receipt reports the
   * version that APPLIED, which is what makes a capsule schema-stable: a
   * successor comparing two capsules can tell "same name, different shape"
   * from "same name, same shape" without diffing the payloads.
   */
  version: number;
  /** Pick paths, in `applyPick` notation (`results[].id`, `gate.stalled`). */
  fields: string[];
  /**
   * Hard ceiling on the rendered capsule, in characters. Enforced AFTER
   * selection. Sized well under the result-door's own cap so a capsule is not
   * itself the thing that trips a spill.
   */
  budgetChars: number;
  /** One line: what this capsule is FOR. Surfaced when a name misses. */
  purpose: string;
}

/**
 * The registry: tool -> view name -> definition.
 *
 * Seeding discipline: every path below was read off a REAL result payload from
 * the tool named, not inferred from its schema. A view whose paths do not match
 * the live shape is worse than no view, because `applyPick` reports unmatched
 * paths in `notes` and the capsule silently comes back near-empty — so the
 * `named-views.test.ts` shape guard pins each seeded view against a recorded
 * sample of its tool's actual output.
 */
export const NAMED_VIEWS: Readonly<Record<string, Readonly<Record<string, NamedViewDef>>>> =
  Object.freeze({
    'dev:pipeline_position': Object.freeze({
      verdict: Object.freeze({
        version: 1,
        purpose:
          'Is my change live, and if not the ONE lever — the three fields that answer it, without the position ticks.',
        budgetChars: 900,
        fields: [
          'blockedOn',
          'nextAction',
          'summary',
          'positions.committedLocal',
          'positions.onStaging',
          'positions.inMain',
          'positions.deployed',
        ],
      }),
      gate: Object.freeze({
        version: 1,
        purpose: 'Gate health only: is it stalled, how red, and is it judging MY change.',
        budgetChars: 700,
        fields: [
          'gate.stalled',
          'gate.consecutiveReds',
          'gate.verdictStale',
          'gate.verdictStaleReasonCode',
          'gate.ownership.workItem',
          'gate.ownership.claimState',
          'changeInCandidate.judgingContainsPath',
          'changeInCandidate.missingReason',
        ],
      }),
    }),

    'work_items:get': Object.freeze({
      capsule: Object.freeze({
        version: 1,
        purpose:
          'Recovery capsule for a cold successor picking up an item: identity, state, holder, and the checkpoint.',
        budgetChars: 2400,
        fields: [
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.title',
          'results[].workItem.assignee',
          'results[].workItem.harness',
          'results[].checkpoint',
        ],
      }),
      roster: Object.freeze({
        version: 1,
        purpose: 'Many items at a glance: id + state + assignee, nothing else.',
        budgetChars: 1200,
        fields: [
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.assignee',
          'counts',
        ],
      }),
    }),

    'plans:get': Object.freeze({
      capsule: Object.freeze({
        version: 1,
        purpose:
          'Is this plan live, and what does it say to do now — frontmatter status (the authority) plus the Now block.',
        budgetChars: 1800,
        fields: [
          'results[].slug',
          'results[].frontmatter.status',
          'results[].frontmatter.title',
          'results[].now.state',
          'results[].now.next',
          'results[].counts',
        ],
      }),
    }),
  });

/** What a view resolution produced. */
export type ViewResolution =
  | {
      ok: true;
      tool: string;
      name: string;
      def: NamedViewDef;
      /** The selection, expressed as the ordinary projection spec `applyPick` takes. */
      spec: ProjectionSpec;
    }
  | {
      ok: false;
      /** Machine-readable reason, for callers that branch. */
      code: 'unknown_view' | 'no_views_for_tool' | 'malformed_view';
      /** Loud, self-correcting message. NEVER silently falls back to a full payload. */
      error: string;
      /** Every valid name for this tool, so the miss costs one round trip, not a guess. */
      validNames: string[];
    };

/** All view names registered for a tool (empty when the tool has none). */
export function viewNamesFor(tool: string): string[] {
  const forTool = NAMED_VIEWS[tool];
  return forTool ? Object.keys(forTool).sort() : [];
}

/**
 * Resolve `name` against `tool`.
 *
 * FAIL-CLOSED, deliberately: an unknown view name is the caller's bug and is
 * knowable without running anything. Falling back to the unprojected payload
 * would hand a caller who asked for a 900-char capsule the full result they
 * explicitly did not agree to pay for — the same reasoning that makes a
 * malformed `projection` fail closed at the dispatch layer.
 */
export function resolveNamedView(tool: string, name: unknown): ViewResolution {
  const validNames = viewNamesFor(tool);

  if (typeof name !== 'string' || name.trim() === '') {
    return {
      ok: false,
      code: 'malformed_view',
      error:
        `view_invalid: \`${VIEW_ARG}\` must be a non-empty string naming a registered view. ` +
        (validNames.length
          ? `Valid names for ${tool}: ${validNames.join(', ')}.`
          : `${tool} has no registered views.`),
      validNames,
    };
  }

  const forTool = NAMED_VIEWS[tool];
  if (!forTool || validNames.length === 0) {
    return {
      ok: false,
      code: 'no_views_for_tool',
      error:
        `view_unknown: ${tool} has no registered named views. ` +
        `Use \`projection: { pick: [...] }\` for an ad-hoc reduction instead.`,
      validNames,
    };
  }

  const def = forTool[name];
  if (!def) {
    return {
      ok: false,
      code: 'unknown_view',
      error:
        `view_unknown: ${tool} has no view named "${name}". ` +
        `Valid names: ${validNames.map((n) => `${n} (${forTool[n]!.purpose})`).join(' · ')}.`,
      validNames,
    };
  }

  return { ok: true, tool, name, def, spec: { pick: [...def.fields] } };
}

/** The receipt emitted alongside a view-projected payload. */
export interface NamedViewReceipt {
  name: string;
  version: number;
  /** True when the selection ran. */
  applied: boolean;
  /** The exact field set the version declares — what the successor actually got. */
  fields: string[];
  budgetChars: number;
  /** Rendered size AFTER selection and any budget enforcement. */
  returnedChars: number;
  /**
   * Set only when the budget actually bound. Carries the pre-enforcement size,
   * so a trimmed capsule can never be mistaken for one that simply fit.
   */
  budgetEnforced?: true;
  charsBeforeBudget?: number;
  /** Declared paths that matched nothing — fail-open is only honest if it is loud. */
  unmatchedFields?: string[];
}

/** Marker appended when the byte budget trims a capsule. Never silent. */
export const VIEW_BUDGET_MARKER = '\n…[view budget reached — capsule trimmed]';

export interface AppliedNamedView {
  /** The rendered capsule text. */
  text: string;
  receipt: NamedViewReceipt;
}

/**
 * Apply a resolved view to a parsed result body: select, render, then enforce
 * the byte budget.
 *
 * Order matters and is the Design's: selection first (so the budget is spent on
 * fields the caller asked for, not on whatever happened to sort first), budget
 * second (so the declared ceiling is a real guarantee rather than a hope).
 */
export function applyNamedView(body: unknown, resolved: Extract<ViewResolution, { ok: true }>): AppliedNamedView {
  const { def, name } = resolved;
  const { picked, unmatched } = applyPick(body, def.fields);

  let text: string;
  try {
    text = JSON.stringify(picked, null, 2) ?? String(picked);
  } catch {
    // A body that will not serialize is not a reason to fail the call; report
    // it as an unapplied view and let the caller see the ordinary payload.
    return {
      text: '',
      receipt: {
        name,
        version: def.version,
        applied: false,
        fields: [...def.fields],
        budgetChars: def.budgetChars,
        returnedChars: 0,
      },
    };
  }

  const receipt: NamedViewReceipt = {
    name,
    version: def.version,
    applied: true,
    fields: [...def.fields],
    budgetChars: def.budgetChars,
    returnedChars: text.length,
  };
  if (unmatched.length) receipt.unmatchedFields = [...unmatched];

  if (text.length > def.budgetChars) {
    const charsBefore = text.length;
    const keep = Math.max(0, def.budgetChars - VIEW_BUDGET_MARKER.length);
    text = text.slice(0, keep) + VIEW_BUDGET_MARKER;
    receipt.budgetEnforced = true;
    receipt.charsBeforeBudget = charsBefore;
    receipt.returnedChars = text.length;
  }

  return { text, receipt };
}

/**
 * Minimal structural shape of a dispatch result this module touches. Kept
 * local (rather than importing the transport's McpCallResult) so this module
 * stays usable from a plain unit test with no transport in scope.
 */
export interface ViewableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Take the `view` argument off a dispatch args object.
 *
 * The view name is a DISPATCH-level control, so it must be stripped before the
 * tool's own schema validation runs — every tool schema is
 * additionalProperties:false, so an unstripped key is rejected as unknown by
 * the entire catalog. Exactly the reservation `projection` already has.
 *
 * BOTH dispatch paths (direct tools/call and the nested tools:invoke) call this
 * one function. That is deliberate: the previous generation of this seam was
 * two hand-mirrored copies, and the nested one silently fell behind.
 */
export type TakeNamedViewResult =
  | { kind: 'none'; args: Record<string, unknown> }
  | { kind: 'error'; error: string; validNames: string[] }
  | { kind: 'view'; args: Record<string, unknown>; resolved: Extract<ViewResolution, { ok: true }> };

export function takeNamedViewFromArgs(
  args: Record<string, unknown> | undefined,
  toolName: string,
): TakeNamedViewResult {
  const source = args && typeof args === 'object' ? args : {};
  if (!(VIEW_ARG in source)) return { kind: 'none', args: source };

  const resolution = resolveNamedView(toolName, source[VIEW_ARG]);
  if (!resolution.ok) {
    return { kind: 'error', error: resolution.error, validNames: resolution.validNames };
  }
  const { [VIEW_ARG]: _stripped, ...rest } = source;
  return { kind: 'view', args: rest, resolved: resolution };
}

function firstTextIndex(content: ViewableResult['content']): number {
  return content.findIndex(
    (it) =>
      !!it &&
      typeof it === 'object' &&
      (it as { type?: unknown }).type === 'text' &&
      typeof (it as { text?: unknown }).text === 'string',
  );
}

/**
 * Apply a resolved view to a dispatched result: select, enforce the budget,
 * attach the receipt to `_meta.namedView`, and append the in-band footer.
 *
 * FAIL-SOFT, like every other stage at this seam: a body that will not parse,
 * or anything that throws, returns the ORIGINAL result untouched. This stage
 * must never turn a good result into a failure — an unknown view name already
 * failed closed earlier, at resolution, which is where a caller bug belongs.
 */
export function applyNamedViewToResult<T extends ViewableResult>(
  result: T,
  resolved: Extract<ViewResolution, { ok: true }>,
): T {
  try {
    // An error envelope is not a result being reduced — leave it whole.
    if (result.isError) return result;

    const idx = firstTextIndex(result.content);
    if (idx < 0) return result;
    const raw = (result.content[idx] as { text: string }).text;

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return result; // not a JSON body; a field selection cannot apply.
    }

    const { text, receipt } = applyNamedView(body, resolved);
    if (!receipt.applied) return result;

    const content = [...result.content];
    content[idx] = { type: 'text' as const, text: `${text}\n${describeNamedView(receipt)}` };

    return {
      ...result,
      content,
      _meta: { ...result._meta, namedView: receipt },
    };
  } catch {
    return result;
  }
}

/**
 * One in-band line describing what the caller got. The receipt lives in
 * `_meta.namedView`, but `_meta` is not what an agent reads — the footer is the
 * copy that actually reaches it, the same reasoning the projection stage uses.
 */
export function describeNamedView(receipt: NamedViewReceipt): string {
  if (!receipt.applied) {
    return `ⓘ view "${receipt.name}" v${receipt.version} did NOT apply — the full result is shown.`;
  }
  const parts = [
    `ⓘ view "${receipt.name}" v${receipt.version} applied — ${receipt.fields.length} field(s), ` +
      `${receipt.returnedChars}/${receipt.budgetChars} chars`,
  ];
  if (receipt.budgetEnforced) {
    parts.push(`TRIMMED at the byte budget (was ${receipt.charsBeforeBudget})`);
  }
  if (receipt.unmatchedFields?.length) {
    parts.push(`matched nothing: ${receipt.unmatchedFields.join(', ')}`);
  }
  return `${parts.join(' · ')}.`;
}
