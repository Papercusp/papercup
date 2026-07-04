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
 * Normalise ONE `completion` value to the CompletionRecord shape. Handles:
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
 */
export function gatherFlatCompletion(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  if (args.completion !== undefined || args.items !== undefined) return args;
  if (typeof args.id !== 'string') return args;

  const flat: Record<string, unknown> = {};
  let found = false;
  for (const f of COMPLETION_FIELDS) {
    if (args[f] !== undefined) {
      flat[f] = args[f];
      found = true;
    }
  }
  if (!found) return args;

  const out: Record<string, unknown> = { ...args };
  for (const f of COMPLETION_FIELDS) delete out[f];
  out.completion = flat;
  return out;
}
