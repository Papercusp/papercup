/**
 * completion-coerce.ts — EI-7031: be liberal in what `work_items:complete` accepts.
 *
 * work_items:complete failed ~15% of calls in the wild (52/348 in 24h). The live
 * `tool_invocations` breakdown showed the failures are NOT connectivity / logic /
 * idempotency — they are almost entirely MALFORMED `completion` SHAPE from LLM
 * callers, and each one means a real, FINISHED unit of work had its completion
 * REJECTED and lost (and the item left claimable, so the auto-loop re-places it):
 *
 *   18×  completion passed as a bare STRING           ("expected object, received string")
 *   ~4×  scalar↔array field swaps                      (whatLanded/deferred/migrations given a
 *                                                        string; tests given an array)
 *    2×  summary omitted                               ("expected string, received undefined")
 *   22×  neither { id, completion } nor items:[…]      (the completion fields passed FLAT,
 *                                                        no `completion` wrapper — the top-level
 *                                                        refine then rejects)
 *
 * EI-7311 (2026-07-04): a related but DISTINCT mis-shape — a JSON-STRINGIFIED completion
 * object (`completion: '{"summary":"...","tests":"..."}'` as a literal string, not an
 * object). This one doesn't reject; it silently SUCCEEDS with the wrong content: the bare-
 * string branch below wraps the whole JSON text as `{ summary: <entire blob> }`, dropping
 * every other field (confirmed live via tool_invocations.args_json on 2 real completions,
 * EI-6516/EI-6528, whose `tests` field vanished this way and tripped a false
 * verificationWarning). Detected + parsed back into an object before the rest of the
 * coercion runs.
 *
 * The durable fix is coercion at the input boundary (a Zod `preprocess`), applied
 * BEFORE validation so a well-meant-but-mis-shaped completion is normalised to the
 * CompletionRecord contract instead of hard-rejected. WELL-FORMED input passes
 * through byte-for-byte unchanged — this only rescues the shapes that would
 * otherwise 400. It cannot mask a logic bug: the fields still validate after
 * coercion; we just stop losing finished work to shape variance.
 */

/** CompletionRecord fields that are arrays of strings (a lone scalar → `[scalar]`). */
const ARRAY_FIELDS = ['whatLanded', 'migrations', 'deferred', 'filesChanged'] as const;
/** CompletionRecord fields that are plain strings (an array → joined). */
const STRING_FIELDS = [
  'summary',
  'status',
  'tests',
  'testsRun',
  'testResult',
  'verifiedHow',
  'deploy',
  'coordNotes',
  'planSlug',
  'agent',
  'title',
  'workItem',
] as const;
const BOOL_FIELDS = ['addedTests'] as const;
/** Every completion-record field name — used to recognise a FLAT completion. */
export const COMPLETION_FIELDS: readonly string[] = [...ARRAY_FIELDS, ...STRING_FIELDS, ...BOOL_FIELDS, 'verification'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Join a mis-typed array into the single string the field expects (drops empties). */
function joinToString(v: readonly unknown[]): string {
  return v
    .map((x) => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x)))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * EI-7311: a JSON-STRINGIFIED completion object (e.g. `completion: '{"summary":
 * "...", "tests": "..."}'`) hits the bare-string branch below and gets wrapped
 * whole as `{ summary: <the entire JSON text> }` — silently DROPPING every
 * other field, including `tests`/`deferred`, which then trips the false
 * verificationWarning ("neither tests nor deferred populated") even though the
 * caller's original completion had `tests` populated. Confirmed live via
 * tool_invocations.args_json on 2 real completions (EI-6516, EI-6528) that hit
 * exactly this shape. Detect a string that PARSES to a plain object (as
 * opposed to genuine prose) and recurse into the normal object-coercion path
 * instead of swallowing it as a summary blob.
 */
function tryParseJsonObject(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise ONE `completion` value to the CompletionRecord shape. Handles:
 *  - a JSON-stringified object → parsed + coerced as an object (EI-7311)
 *  - a bare string        → { summary: <string> }
 *  - array-typed field given a scalar → wrapped in a 1-element array (lossless)
 *  - string-typed field given an array → joined with '; '
 *  - a missing/empty summary → derived from title / first whatLanded / status
 *    (turns a hard reject into a recorded completion — far better than losing it,
 *    since this call also closes the item).
 * A value that is neither a string nor a plain object is returned untouched.
 */
export function coerceCompletionShape(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const parsedObject = tryParseJsonObject(raw);
    if (parsedObject) return coerceCompletionShape(parsedObject);
    const s = raw.trim();
    return s ? { summary: s } : raw; // empty string: let validation reject it
  }
  if (!isPlainObject(raw)) return raw;

  const out: Record<string, unknown> = { ...raw };

  // array-typed fields: a lone scalar becomes a 1-element array (lossless, no splitting).
  for (const f of ARRAY_FIELDS) {
    const val = out[f];
    if (val == null || Array.isArray(val)) continue;
    if (typeof val === 'string') {
      const s = val.trim();
      out[f] = s ? [s] : undefined;
    } else {
      out[f] = [val];
    }
  }

  // string-typed fields: an array becomes a joined string.
  for (const f of STRING_FIELDS) {
    const val = out[f];
    if (Array.isArray(val)) out[f] = joinToString(val) || undefined;
  }

  for (const f of BOOL_FIELDS) {
    const val = out[f];
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(s)) out[f] = true;
      if (['false', 'no', 'n', '0'].includes(s)) out[f] = false;
    }
  }

  // derive a summary if the caller omitted it (after array-coercion, so whatLanded[0] is safe).
  if (typeof out.summary !== 'string' || !out.summary.trim()) {
    const wl = out.whatLanded;
    const derived =
      (typeof out.title === 'string' && out.title.trim()) ||
      (Array.isArray(wl) && typeof wl[0] === 'string' && wl[0].trim()) ||
      (typeof out.status === 'string' && out.status.trim()) ||
      'done';
    out.summary = String(derived);
  }

  return out;
}

/**
 * Rescue a FLAT completion at the top-level args boundary: when the caller passed
 * completion fields directly on the args (no `completion` wrapper) alongside an
 * `id`, gather them into `completion` so the single-complete shorthand validates
 * instead of tripping the "pass { id, completion } …" refine. A call that already
 * has `completion` or `items` (or no completion-ish fields) is returned unchanged.
 *
 * EI-9930: also rescues flat completion-ish SIBLINGS of an EXISTING `completion`
 * object (e.g. a caller who passed `{ id, completion, tests: "…" }` — `tests`
 * outside the wrapper by mistake). The tool's top-level args schema has no such
 * field, so zod's default object parsing silently STRIPS it (no unknown-arg
 * error) — the caller's stated verification vanished and a false
 * verificationWarning ("neither tests nor deferred populated") fired even
 * though they DID say how it was checked (repro: WI-4223, 2026-07-12). Merge
 * any such siblings INTO the completion object, filling only fields the
 * nested object didn't already set — an explicit nested value always wins,
 * never clobbered by a flat sibling. No siblings found (or `completion` isn't
 * a plain object, e.g. still a raw JSON string awaiting `coerceCompletionShape`)
 * → returned unchanged, same reference, exactly like before.
 */
export function gatherFlatCompletion(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  if (args.items !== undefined) return args;

  const flat: Record<string, unknown> = {};
  let found = false;
  for (const f of COMPLETION_FIELDS) {
    if (args[f] !== undefined) {
      flat[f] = args[f];
      found = true;
    }
  }

  if (args.completion !== undefined) {
    if (!found || !isPlainObject(args.completion)) return args;
    const out: Record<string, unknown> = { ...args };
    for (const f of COMPLETION_FIELDS) delete out[f];
    out.completion = { ...flat, ...(args.completion as Record<string, unknown>) };
    return out;
  }

  if (typeof args.id !== 'string') return args;
  if (!found) return args;

  const out: Record<string, unknown> = { ...args };
  for (const f of COMPLETION_FIELDS) delete out[f];
  out.completion = flat;
  return out;
}
