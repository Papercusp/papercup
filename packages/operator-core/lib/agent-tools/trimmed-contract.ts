/**
 * trimmed-contract.ts — EI-20803112372029993.
 *
 * A tool may declare a `shape.trimmed` projection that REBUILDS each row from a
 * hardcoded allowlist. `trimmed` is the tier agents get BY DEFAULT. Nothing
 * checked that allowlist against the tool's own `guidance.returns` prose, so the
 * two drifted silently — and the failure is invisible in the worst way: the tool
 * returns `ok:true` with a well-formed row that is simply missing the field,
 * which reads as "this row has no such data" rather than "the shaper removed it".
 *
 * `routines:list` shipped this defect THREE times on the same allowlist:
 *   1. EI-19336000265007219 — `paused` dropped; a deliberate hold read as a stall.
 *   2. EI-20503768406496801 — `health` + `lastFiredAt` dropped, one field over.
 *   3. (this item) — `triggerKind` + `targetRole`, still dropped, while `returns`
 *      named all eleven row fields.
 *
 * Each fix added the missing field back and left a comment warning the next
 * author. Prose in a comment is not a mechanism; this file is the mechanism.
 *
 * ── WHY THE FIELD LIST IS DERIVED, NOT DECLARED ──────────────────────────────
 * The obvious fix is a second list on the tool (`trimmedContract: [...]`) that
 * the shaper is checked against. That is a THIRD hand-typed list beside the
 * `returns` prose and the allowlist, and it rots the same way the first two did.
 * Instead the contract's FIELDS come from the tool's own `returns` promise — the
 * sentence the agent actually reads — so the promise and the check are one
 * artifact. A tool opts in by naming only its row key, which is stable.
 *
 * ── WHY OPT-IN RATHER THAN A BLANKET RAIL ────────────────────────────────────
 * Measured population (2026-08-18): 21 tools declare `shape.trimmed`; 5 also
 * carry `returns`. A blanket "every trimmed shaper must preserve everything
 * promised" rail would be WRONG for at least `coord:orient`, whose trimmed tier
 * deliberately and correctly omits whole optional legs and says so in-band
 * (`optionalLegsOmitted`). Dropping data is that tool's job. The defect class is
 * specifically the ROW-REBUILD allowlist, so that is what this checks.
 */

/**
 * Parse the documented `returns` convention: `Each row: { a, b, c }`.
 *
 * Returns null when the prose is not in that form — the caller must treat that
 * as "no derived contract", never as "the contract is empty" (an empty contract
 * passes vacuously, which is the failure mode this whole file exists to stop).
 */
export function parseReturnsRowFields(returns: unknown): string[] | null {
  if (typeof returns !== 'string') return null;
  const m = returns.match(/Each row:\s*\{([^}]*)\}/);
  if (!m) return null;
  const fields = m[1]
    .split(',')
    .map((f) => f.trim())
    .filter((f) => /^[A-Za-z_$][\w$]*$/.test(f));
  return fields.length > 0 ? fields : null;
}

export interface TrimmedContractSubject {
  /** Tool name, for the failure message. */
  name: string;
  /** The tool's `shape` block. */
  shape?: {
    trimmed?: (data: unknown, sctx: { args: unknown; tier: 'trimmed' | 'standard' }) => unknown;
    contract?: { rows: string; fields?: readonly string[] };
  };
  /** The tool's `guidance.returns` prose. */
  returns?: unknown;
}

export interface TrimmedContractViolation {
  tool: string;
  /** Fields the `returns` promise names that the trimmed shaper did not emit. */
  dropped: string[];
  /** Every field the contract required, for the message. */
  required: string[];
  detail: string;
}

/**
 * A sentinel value per field. Distinct non-null strings, so a shaper that maps
 * a field through `?? null` still yields something we can see, and a shaper that
 * drops the key entirely is distinguishable from one that nulls it.
 *
 * Nulling a promised field is NOT treated as a drop: several shapers legitimately
 * null a field they cannot cheaply compute, and the key's presence is what tells
 * a reader "this row has no such data" rather than "the shaper removed it".
 */
function syntheticRow(fields: readonly string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of fields) row[f] = `__contract__${f}`;
  return row;
}

/**
 * Check ONE tool. Returns null when the tool does not opt in, or when it opts in
 * but no field list can be resolved (that is reported separately by
 * `unresolvableContracts` — a tool that opts in and yields no fields must be
 * loud, not silently skipped).
 */
export function checkTrimmedContract(tool: TrimmedContractSubject): TrimmedContractViolation | null {
  const contract = tool.shape?.contract;
  const trimmed = tool.shape?.trimmed;
  if (!contract || typeof trimmed !== 'function') return null;

  const required = contract.fields ? [...contract.fields] : parseReturnsRowFields(tool.returns);
  if (!required || required.length === 0) return null;

  const input = { [contract.rows]: [syntheticRow(required)] };
  let out: unknown;
  try {
    out = trimmed(input, { args: {}, tier: 'trimmed' });
  } catch (err) {
    return {
      tool: tool.name,
      dropped: [],
      required,
      detail: `its trimmed shaper THREW on a synthetic ${contract.rows} row: ${String(err)}`,
    };
  }

  const rows = (out as Record<string, unknown> | null)?.[contract.rows];
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      tool: tool.name,
      dropped: [],
      required,
      detail:
        `its trimmed shaper returned no \`${contract.rows}\` rows for a 1-row input — ` +
        `either \`contract.rows\` names the wrong key, or the shaper dropped the row set entirely.`,
    };
  }

  const emitted = new Set(Object.keys((rows[0] ?? {}) as Record<string, unknown>));
  const dropped = required.filter((f) => !emitted.has(f));
  if (dropped.length === 0) return null;

  return {
    tool: tool.name,
    dropped,
    required,
    detail:
      `\`returns\` promises { ${required.join(', ')} } on each row, but the trimmed shaper — ` +
      `the tier agents get BY DEFAULT — emitted a row without ${dropped.map((d) => `\`${d}\``).join(', ')}. ` +
      `An allowlist that rebuilds the row drops anything not on it, and the result still reads ok:true, ` +
      `so the field looks absent from the data rather than removed by the shaper.`,
  };
}

/**
 * Tools that OPT IN (`shape.contract`) but from which no field list can be
 * resolved. Reported loudly: such a tool would otherwise pass vacuously, which
 * is indistinguishable from a real pass.
 */
export function unresolvableContracts(tools: readonly TrimmedContractSubject[]): string[] {
  return tools
    .filter((t) => t.shape?.contract && typeof t.shape.trimmed === 'function')
    .filter((t) => {
      const c = t.shape!.contract!;
      const fields = c.fields ? [...c.fields] : parseReturnsRowFields(t.returns);
      return !fields || fields.length === 0;
    })
    .map((t) => t.name);
}

export function trimmedContractViolations(
  tools: readonly TrimmedContractSubject[],
): TrimmedContractViolation[] {
  const out: TrimmedContractViolation[] = [];
  for (const t of tools) {
    const v = checkTrimmedContract(t);
    if (v) out.push(v);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COVERAGE — EI-21353488282456582.
 *
 * The contract above is opt-in, deliberately: a blanket "every trimmed shaper
 * must preserve everything promised" rail would be wrong for `coord:orient`,
 * whose trimmed tier correctly omits whole optional legs and says so in-band.
 * That reasoning still holds and is not what this section changes.
 *
 * What it changes is that opt-in with nothing forcing the choice is opt-in
 * nobody takes. Measured 2026-09-05, 18 days after this file landed (commit
 * 0e42cc6295, 2026-08-18): exactly ONE of the 22 tools declaring a payload
 * shaper had opted in — `routines:list`,
 * the tool whose three repeated defects motivated building the mechanism. The
 * guard covered its own motivating instance and nothing else, which is
 * indistinguishable from a guard that works until a second instance appears.
 *
 * The coverage assertion that should have caught that read
 * `expect(optedIn.length).toBeGreaterThanOrEqual(1)`. The instinct was right —
 * its comment says "if this drops to zero the suite above is green because it
 * checked nothing" — but the floor was set at the then-current population of
 * one, and nothing ratchets it, so a single adopter satisfies it forever.
 *
 * So this does not widen the contract. It forces a DECISION: a tool declaring
 * a payload shaper either opts in (`shape.contract`), or is listed in
 * SHAPER_CONTRACT_EXEMPT with a reason. Adding a shaper without classifying it
 * fails the build. That is the same inversion that works elsewhere in this repo
 * — a live-population scan where every member must be a deliberate
 * covered/exempt decision, rather than an allowlist that only grows.
 *
 * The check is BIDIRECTIONAL on purpose. An exemption naming a tool that no
 * longer declares a shaper is reported too: a one-way list rots into a set of
 * claims about code that has moved, which is the failure this file's header
 * already names for hand-typed lists.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why an entry is not opted in. The two cases are governed DIFFERENTLY and must
 * not be conflated — mirroring `DarkCase` in libs/flags, where a reasoned
 * kill-switch and an unfinished-work parking slot share one list but only the
 * parking subset is rationed by a watermark.
 *
 * - `reasoned` — a deliberate decision that this shaper should not carry a row
 *   contract. Not rationed; it is an answer, not debt.
 * - `unclassified-baseline` — DEBT. Nobody has audited this shaper yet. It
 *   predates the coverage gate and is recorded only so the gate can fail on
 *   anything NEW. Rationed by SHAPER_BASELINE_HIGH_WATERMARK and shrink-only.
 *
 * Recording debt as though it were a decision is the failure this split exists
 * to prevent: it would make the gate read fully-covered while 21 shapers had
 * never been looked at.
 */
export type ShaperExemptionCase = 'reasoned' | 'unclassified-baseline';

export interface ShaperExemption {
  case: ShaperExemptionCase;
  reason: string;
}

/**
 * Tools that declare a payload shaper and are not opted in to the row contract.
 *
 * Every entry needs a REASON, not a placeholder — the reason is what a later
 * reader uses to decide whether it still holds. Seed and re-seed this from a
 * measuring run over the live registry (the coverage test names every offender
 * on failure), never from a grep: a filename glob is wrong in both directions
 * here — `policy-shape.ts` is not a payload shaper at all, while
 * `work_items/search.ts`, `scheduler/running.ts` and `fleet_registry/status.ts`
 * each declare one with no `*-shape.ts` file to glob.
 */
export const SHAPER_CONTRACT_EXEMPT: Readonly<Record<string, ShaperExemption>> = {
  'coord:orient': {
    case: 'reasoned',
    reason:
      'Its trimmed tier deliberately omits whole optional legs and says so in-band via ' +
      '`optionalLegsOmitted`. Dropping data is this tool\'s job, so a preserve-everything ' +
      'contract would be actively wrong for it (see this file\'s header).',
  },

  // ── BASELINE (debt, shrink-only) ─────────────────────────────────────────
  // Measured 2026-09-05 from the live registry by the coverage test below.
  // These predate the gate and have NOT been audited. Removing one — by opting
  // it in, or by promoting it to `reasoned` after actually looking — is the
  // intended direction of travel. See SHAPER_BASELINE_HIGH_WATERMARK.
  'agent_tools:list': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'coord:presence': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'coord:roster': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'fleet:assignments': {
    case: 'unclassified-baseline',
    reason:
      'pre-existing; not yet audited. This is the CONFIRMED instance of the class ' +
      '(EI-18763132241176410 re-added a dropped top-level `scope` block). The re-add was ' +
      'bespoke — the shaper still rebuilds from a hand-written key list — so the same drop ' +
      'can recur for the next field added to the source tool.',
  },
  'fleet:leader-brief': {
    case: 'unclassified-baseline',
    reason:
      'pre-existing; not yet audited. Builds its result with a mutative accumulator ' +
      '(`const out = {}` … `return out`), a third shape beside spread-source and ' +
      'key-list-rebuild, in which a key can only ever appear by explicit addition.',
  },
  'fleet:status': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'harness_docs:list': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'locks:list': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'logs:read': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'plans:attention': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'plans:get': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'plans:items': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'plans:list': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'scheduler:running': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:burn_down': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:claim': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:complete': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:get': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:list': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
  'work_items:search': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
};

/**
 * Ceiling on the `unclassified-baseline` subset — SHRINK-ONLY.
 *
 * Seeded at the measured population on 2026-09-05. It rations DEBT only;
 * `reasoned` exemptions are not counted, so recording a genuine decision never
 * has to fight this budget. Lower it as shapers get audited; raising it means
 * a new shaper shipped unclassified, which is what the gate exists to stop.
 */
export const SHAPER_BASELINE_HIGH_WATERMARK = 20;

export interface ShaperClassification {
  /** Declares a shaper but is neither opted in nor exempt — an undecided tool. */
  unclassified: string[];
  /** Exempt but no longer declares a shaper — the exemption has gone stale. */
  staleExemptions: string[];
  /** Entries recorded as unaudited debt, rationed by the watermark. */
  baseline: string[];
}

/**
 * Classify every tool that declares a payload shaper.
 *
 * `unclassified` is the build-failing set: a shaper nobody decided about. An
 * empty result means every declared shaper is a deliberate choice, NOT that
 * every shaper preserves every field — that stronger property is what
 * `trimmedContractViolations` checks, and only for the opted-in subset.
 */
export function classifyDeclaredShapers(
  tools: readonly TrimmedContractSubject[],
  exempt: Readonly<Record<string, ShaperExemption>> = SHAPER_CONTRACT_EXEMPT,
): ShaperClassification {
  const declaresShaper = (t: TrimmedContractSubject): boolean =>
    typeof t.shape?.trimmed === 'function';

  const unclassified = tools
    .filter(declaresShaper)
    .filter((t) => !t.shape?.contract)
    .filter((t) => !Object.prototype.hasOwnProperty.call(exempt, t.name))
    .map((t) => t.name)
    .sort();

  const declaring = new Set(tools.filter(declaresShaper).map((t) => t.name));
  const staleExemptions = Object.keys(exempt)
    .filter((name) => !declaring.has(name))
    .sort();

  // Counted from the LIVE population, not from the literal's length: an entry
  // for a tool that no longer declares a shaper is stale, and counting it here
  // would let the watermark be satisfied by debt that has already evaporated.
  const baseline = Object.entries(exempt)
    .filter(([name, e]) => e.case === 'unclassified-baseline' && declaring.has(name))
    .map(([name]) => name)
    .sort();

  return { unclassified, staleExemptions, baseline };
}
