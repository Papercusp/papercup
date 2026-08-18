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
