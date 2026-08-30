/**
 * Hive-confinement harness-ARGUMENT coverage (EI-21910110662818467).
 *
 * ## The defect this exists to stop
 *
 * The hive clamp in `routes/transport/_mcp-handler.ts` answers "does this call
 * name a harness outside my hive?" by LITERALLY reading a hand-maintained list
 * of argument SPELLINGS. Its history is purely reactive — every branch was
 * added only after someone found the previous set insufficient:
 *
 *   harness -> harness_slug -> hive -> coord:presence.scope -> scope:'harness:<slug>'
 *
 * That is a race the clamp loses by construction: any tool may introduce a new
 * way to name a harness, and the clamp cannot learn about it. The failure is
 * SILENT and security-relevant — not a crash, just confinement quietly not
 * applying. WI-1345963 is one measured instance; the first run of THIS module
 * found another (camelCase `harnessSlug`, declared by 34 tools, which overrides
 * ctx in e.g. `roles/list.ts` and which the clamp never reads).
 *
 * ## Why a detector, and not pure derivation
 *
 * Rung 1 of the derived-truth ladder (derive the guarded set from the schemas)
 * is not reachable: "which argument names a harness" is a SEMANTIC property.
 * `harness_slug` names one; `harnessOutputText` does not. So this is rung 2 —
 * PIN: a check that FAILS when a registered tool declares a harness-naming
 * argument the clamp does not cover. New spellings then arrive as a red test at
 * the moment they are introduced, rather than as the next production bypass.
 *
 * ## Two traps this module is built around (both drew blood on the first run)
 *
 *  1. **Never normalize when comparing against the clamp's guarded set.** The
 *     clamp does LITERAL property reads, so `harnessSlug` and `harness_slug`
 *     are DIFFERENT keys to it. An earlier draft normalized both to
 *     `harnessslug`, which reported the live `harnessSlug` hole as GUARDED —
 *     the detector hiding the exact bug it exists to find.
 *  2. **"archived" contains "hive".** A naive /hive/ match flags
 *     `includeArchived`, `archived`, and `archive_floor`. Those are excluded
 *     structurally, not by exemption.
 */

/**
 * The top-level argument names the clamp reads LITERALLY, in its own spelling.
 *
 * ⚠ Exact strings, never normalized — see trap (1) above.
 * `scope` is guarded as a unit by its own branch (the `harness:<slug>` grammar
 * plus `scope:'harness'` + scopeRef), so it is excluded from the name heuristic
 * rather than listed as a slug-bearing arg.
 */
export const HIVE_CLAMP_LITERAL_ARGS: readonly string[] = ['harness', 'harness_slug', 'hive', 'scope'];

/**
 * Names that DESIGNATE a harness but whose value cannot route a call there.
 *
 * Kept deliberately tiny: an argument whose declared schema type is not a
 * string (or array of strings) is skipped STRUCTURALLY by
 * `schemaMayCarrySlug`, so numbers and booleans never need an entry here.
 * Every remaining entry states why — an exemption without a reason is how an
 * allowlist becomes a parking lot.
 *
 * Seeded from a measuring run over the live registry
 * (`npm run lint:harness-arg-coverage -- --list`), never a hand grep.
 */
export const HIVE_CLAMP_ARG_EXEMPTIONS: Readonly<Record<string, string>> = {
  harnessOutputText:
    "gym:signals — the harness's PRODUCED OUTPUT (verdicts, filed issues) being graded, not a selector; it names no harness to route to",
};

/**
 * Does this argument NAME designate a harness / hive / pot?
 *
 * Deliberately wider than the clamp's four literals: this is the SUSPICION net,
 * and every match must be dispositioned (covered by the clamp, or exempt with a
 * reason). A false positive costs one line; a false negative costs a silent
 * confinement hole.
 */
export function designatesHarness(argName: string): boolean {
  const n = argName.toLowerCase().replace(/[_-]/g, '');
  // `scope`/`scopeRef`/`ref` are guarded as a unit by the dedicated scope branch.
  if (n === 'scope' || n === 'scoperef' || n === 'ref') return false;
  // Trap (2): "archived"/"archive" contain the substring "hive".
  const deArchived = n.replace(/archiv\w*/g, '');
  return (
    deArchived.includes('harness') ||
    deArchived.includes('hive') ||
    deArchived === 'pot' ||
    deArchived.includes('potslug') ||
    deArchived.includes('installslug')
  );
}

/**
 * Could this property's DECLARED schema carry a harness slug?
 *
 * Strings and string arrays can. Numbers and booleans cannot, so they are
 * excluded structurally rather than by a hand-written exemption. An UNKNOWN or
 * absent type fails CLOSED (returns true): a schema this module cannot read is
 * exactly the case that must be looked at by a human, not waved through.
 */
export function schemaMayCarrySlug(propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== 'object') return true; // unknown -> fail closed
  const s = propSchema as Record<string, unknown>;
  for (const branchKey of ['anyOf', 'oneOf', 'allOf']) {
    const branches = s[branchKey];
    if (Array.isArray(branches)) {
      if (branches.some((b) => schemaMayCarrySlug(b))) return true;
    }
  }
  const t = s.type;
  if (typeof t === 'string') {
    if (t === 'string') return true;
    if (t === 'array') return schemaMayCarrySlug(s.items);
    return false; // number | integer | boolean | null | object
  }
  if (Array.isArray(t)) return t.includes('string') || t.includes('array');
  return true; // no declared type -> fail closed
}

/** A registered tool, reduced to what this detector needs. */
export interface HarnessArgCoverageTool {
  /** MCP name where present, else any stable identifier for the report. */
  readonly name: string;
  /** The tool's declared JSON-Schema input. */
  readonly inputSchema?: Record<string, unknown> | undefined;
}

/** One tool declaring a harness-naming argument the clamp does not cover. */
export interface UnguardedHarnessArg {
  readonly tool: string;
  readonly arg: string;
}

/** Top-level property entries of a JSON-Schema object, or [] when it declares none. */
export function topLevelArgEntries(
  inputSchema: Record<string, unknown> | undefined,
): Array<[string, unknown]> {
  const props = inputSchema?.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, unknown>);
}

/**
 * Every top-level argument of a CALL whose name designates a harness and whose
 * value actually carries slug(s). This is the runtime seam the clamp sweeps, so
 * the clamp covers new spellings automatically instead of growing a branch.
 *
 * Values that are not strings/string-arrays yield nothing, so a numeric
 * `harnessLimit` or a boolean widener is skipped without an exemption.
 */
export function collectHarnessSlugArgs(
  args: unknown,
  options?: { readonly skip?: readonly string[] },
): Array<{ readonly arg: string; readonly slug: string }> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const skip = new Set(options?.skip ?? HIVE_CLAMP_LITERAL_ARGS);
  const exempt = new Set(Object.keys(HIVE_CLAMP_ARG_EXEMPTIONS));
  const out: Array<{ arg: string; slug: string }> = [];
  for (const [arg, value] of Object.entries(args as Record<string, unknown>)) {
    if (skip.has(arg) || exempt.has(arg)) continue;
    if (!designatesHarness(arg)) continue;
    if (typeof value === 'string') {
      const slug = value.trim();
      if (slug) out.push({ arg, slug });
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.trim()) out.push({ arg, slug: v.trim() });
      }
    }
  }
  return out;
}

/**
 * THE DETECTOR. Every (tool, arg) pair whose argument name designates a harness
 * and whose declared type could carry a slug, but which the clamp neither reads
 * literally nor exempts.
 *
 * A NON-EMPTY result means the hive clamp has a hole: that argument can name a
 * harness outside the caller's hive and nothing will stop it.
 */
export function findUnguardedHarnessArgs(
  tools: readonly HarnessArgCoverageTool[],
  options?: { readonly guarded?: readonly string[]; readonly exemptions?: Readonly<Record<string, string>> },
): UnguardedHarnessArg[] {
  // EXACT match, never normalized — see trap (1).
  const guarded = new Set(options?.guarded ?? HIVE_CLAMP_LITERAL_ARGS);
  const exempt = new Set(Object.keys(options?.exemptions ?? HIVE_CLAMP_ARG_EXEMPTIONS));
  const findings: UnguardedHarnessArg[] = [];
  for (const tool of tools) {
    for (const [arg, propSchema] of topLevelArgEntries(tool.inputSchema)) {
      if (!designatesHarness(arg)) continue;
      if (guarded.has(arg) || exempt.has(arg)) continue;
      if (!schemaMayCarrySlug(propSchema)) continue;
      findings.push({ tool: tool.name, arg });
    }
  }
  return findings.sort((a, b) => a.arg.localeCompare(b.arg) || a.tool.localeCompare(b.tool));
}
