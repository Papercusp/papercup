/**
 * Apply a validated projection to a materialized tool result.
 *
 * FAIL-OPEN, WITH THE REASON ATTACHED. Everything reaching this file has already
 * passed parse.ts, so a failure here means the well-formed spec did not FIT the
 * actual result (a `pick` on a body that is not JSON, a path that matched
 * nothing). The tool has already run and returned something valid; throwing that
 * away over a presentational miss would be the wrong trade. So the result passes
 * through and the reason lands in `notes` — visible in `_meta.resultProjection`
 * AND in the in-band footer, because fail-open is only honest if it is loud.
 * A silent no-op would read exactly like "the tool returned everything", which
 * is precisely the misattribution D-042 forbids.
 *
 * Operator semantics track the coreutils they stand in for (uniq collapses only
 * ADJACENT runs; cut passes non-delimited lines through unless -s; grep emits
 * `--` between non-contiguous context groups) so that a rewrite of a real corpus
 * command means what the command meant. Sort is the one deliberate divergence:
 * codepoint order, never locale order, so the same result is reproducible on any
 * host. @see ./types.ts for the regex-flavor contract.
 */

import { describeProjection } from './parse';
import type { ProjectionReport, ProjectionSpec, ProjectionStage } from './types';

/** The subset of an MCP tools/call result this stage reads/rewrites. */
export interface ProjectableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

function isTextItem(it: unknown): it is { type: 'text'; text: string } {
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { type?: unknown }).type === 'text' &&
    typeof (it as { text?: unknown }).text === 'string'
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** How a materialized result body looks to the two projection domains. */
export interface ProjectionBodyShape {
  /** The JSON payload, when the body (or one of its text items) parses. */
  json: { parsed: unknown; itemIndex: number } | null;
  /** Lines the `pipe` operators would see. 1 ⇒ every line operator is
   *  all-or-nothing on this body. */
  lineCount: number;
}

/**
 * Classify a result body for projection: is there a JSON payload (⇒ `pick`
 * reduces it), and how many lines do the `pipe` operators actually see?
 *
 * Extracted so the two callers CANNOT diverge (D-012, plan
 * agent-context-firewall-and-output-spill-2026-08-02): `applyResultProjection`
 * uses it to find the payload `pick` operates on, and the result-door footer
 * uses it to decide which operator to RECOMMEND. Before this, the footer was a
 * constant that led with `pipe` unconditionally — advertising, on a one-line
 * JSON body, the one operator family that provably cannot reduce it (a
 * `grep` no-match returns an EMPTY body, which reads like a successful
 * filter). Same shape as P-015: derive the taught remedy from the code that
 * enforces it, so it cannot drift.
 *
 * The per-item fallback is load-bearing, not defensive: a structured result is
 * routinely NOT one text item — the JSON payload is followed by advisory prose
 * ("See also: …") — so the JOINED text does not parse even though the payload
 * plainly does.
 */
export function classifyProjectionBody(
  textItems: ReadonlyArray<{ text: string }>,
): ProjectionBodyShape {
  const joined = textItems.map((it) => it.text).join('\n\n');
  const lineCount = joined === '' ? 0 : splitLines(joined).lines.length;
  try {
    return { json: { parsed: JSON.parse(joined), itemIndex: -1 }, lineCount };
  } catch {
    /* not the joined body — try each item */
  }
  for (let i = 0; i < textItems.length; i += 1) {
    try {
      return { json: { parsed: JSON.parse(textItems[i].text), itemIndex: i }, lineCount };
    } catch {
      /* not this one — keep looking */
    }
  }
  return { json: null, lineCount };
}

// ── line operators ────────────────────────────────────────────────────────────

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

/** grep, including GNU's `--` separator between non-contiguous context groups. */
function runGrep(lines: string[], s: Extract<ProjectionStage, { op: 'grep' }>): string[] {
  // Compiled ONCE per stage run, not per line — and parse.ts already proved it
  // compiles, so this cannot throw here.
  const re = s.fixed ? null : new RegExp(s.pattern, s.ignoreCase ? 'i' : '');
  const needle = s.fixed && s.ignoreCase ? s.pattern.toLowerCase() : s.pattern;
  const matches = (line: string): boolean => {
    if (re) return re.test(line);
    return s.ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle);
  };

  const hit: boolean[] = lines.map((l) => {
    const m = matches(l);
    return s.invert ? !m : m;
  });

  const before = s.before ?? 0;
  const after = s.after ?? 0;
  if (before === 0 && after === 0) return lines.filter((_, i) => hit[i]);

  // Mark the context window around every hit, then emit runs with `--` between
  // non-adjacent ones (GNU grep's exact presentation).
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!hit[i]) continue;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) keep[j] = true;
  }
  const out: string[] = [];
  let prevKept = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    if (prevKept >= 0 && i > prevKept + 1) out.push('--');
    out.push(lines[i]);
    prevKept = i;
  }
  return out;
}

/** sort — codepoint order (see the file header on why not locale order). */
function runSort(lines: string[], s: Extract<ProjectionStage, { op: 'sort' }>): string[] {
  const cmp = s.numeric
    ? (a: string, b: string) => {
        const na = Number.parseFloat(a);
        const nb = Number.parseFloat(b);
        const va = Number.isNaN(na) ? 0 : na;
        const vb = Number.isNaN(nb) ? 0 : nb;
        return va === vb ? (a < b ? -1 : a > b ? 1 : 0) : va - vb;
      }
    : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  let out = [...lines].sort(cmp);
  if (s.reverse) out.reverse();
  if (s.unique) {
    const seen = new Set<string>();
    out = out.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  }
  return out;
}

/** uniq — ADJACENT runs only, exactly like the binary. `-c` uses its %7d format. */
function runUniq(lines: string[], s: Extract<ProjectionStage, { op: 'uniq' }>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let n = 1;
    while (i + n < lines.length && lines[i + n] === lines[i]) n++;
    out.push(s.count ? `${String(n).padStart(7)} ${lines[i]}` : lines[i]);
    i += n;
  }
  return out;
}

/** cut -f. Non-delimited lines pass through whole unless `onlyDelimited` (-s). */
function runCut(lines: string[], s: Extract<ProjectionStage, { op: 'cut' }>): string[] {
  const delim = s.delimiter ?? '\t';
  const out: string[] = [];
  for (const line of lines) {
    if (!line.includes(delim)) {
      if (!s.onlyDelimited) out.push(line);
      continue;
    }
    const parts = line.split(delim);
    const picked = s.fields.filter((f) => f <= parts.length).map((f) => parts[f - 1]);
    out.push(picked.join(delim));
  }
  return out;
}

function runStage(lines: string[], stage: ProjectionStage): string[] {
  switch (stage.op) {
    case 'grep':
      return runGrep(lines, stage);
    case 'head':
      return lines.slice(0, stage.n);
    case 'tail':
      return stage.n === 0 ? [] : lines.slice(-stage.n);
    case 'sort':
      return runSort(lines, stage);
    case 'uniq':
      return runUniq(lines, stage);
    case 'cut':
      return runCut(lines, stage);
    case 'count':
      return [String(lines.length)];
  }
}

// ── structured `pick` ─────────────────────────────────────────────────────────

type Seg = { kind: 'key'; name: string } | { kind: 'array' } | { kind: 'index'; i: number };

/** `results[].payload.id` → [key results, array, key payload, key id] */
export function parsePickPath(path: string): Seg[] {
  const segs: Seg[] = [];
  for (const token of path.split('.')) {
    if (token === '') continue;
    const head = token.replace(/(\[\d*\])+$/, '');
    if (head) segs.push({ kind: 'key', name: head });
    const brackets = token.slice(head.length).match(/\[\d*\]/g) ?? [];
    for (const b of brackets) {
      const inner = b.slice(1, -1);
      segs.push(inner === '' ? { kind: 'array' } : { kind: 'index', i: Number(inner) });
    }
  }
  return segs;
}

/**
 * Rebuild the sub-shape `segs` selects out of `src`, MERGING into `into` so that
 * sibling paths land in the same object. Merging (rather than one flat
 * `{ path: value }` map) is what keeps `results[].id` and `results[].state`
 * correlated as `results:[{id,state}]` — a flat map would hand back two parallel
 * arrays the caller has to zip by position, and position is exactly the wrong
 * key to correlate a work-item list on.
 */
function projectPath(src: unknown, segs: Seg[], into: unknown, hit: { matched: boolean }): unknown {
  if (segs.length === 0) {
    hit.matched = true;
    return src;
  }
  const [seg, ...rest] = segs;
  if (seg.kind === 'key') {
    if (!isPlainObject(src) || !(seg.name in src)) return into;
    const base = isPlainObject(into) ? into : {};
    base[seg.name] = projectPath(src[seg.name], rest, base[seg.name], hit);
    return base;
  }
  if (!Array.isArray(src)) return into;
  if (seg.kind === 'index') {
    if (seg.i >= src.length) return into;
    const base = Array.isArray(into) ? into : [];
    base[seg.i] = projectPath(src[seg.i], rest, base[seg.i], hit);
    return base;
  }
  const base = Array.isArray(into) ? into : [];
  for (let i = 0; i < src.length; i++) base[i] = projectPath(src[i], rest, base[i], hit);
  return base;
}

/** Apply every `pick` path to a parsed body; reports paths that matched nothing. */
export function applyPick(body: unknown, paths: string[]): { picked: unknown; unmatched: string[] } {
  let acc: unknown = undefined;
  const unmatched: string[] = [];
  for (const p of paths) {
    const hit = { matched: false };
    acc = projectPath(body, parsePickPath(p), acc, hit);
    if (!hit.matched) unmatched.push(p);
  }
  return { picked: acc === undefined ? {} : acc, unmatched };
}

/**
 * Return the outcome paths that are present in a write result.  The paths are
 * discovered from the actual envelope rather than blindly appended: not every
 * write uses the keyed-array contract, and a successful bulk row normally has
 * no `error` property to retain.
 */
function writeOutcomePickPaths(body: unknown): string[] {
  if (!isPlainObject(body)) return [];

  const paths: string[] = [];
  for (const key of ['ok', 'error', 'counts'] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) paths.push(key);
  }

  const results = body.results;
  if (Array.isArray(results)) {
    const rows = results.filter(isPlainObject);
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'ok'))) {
      paths.push('results[].ok');
    }
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'error'))) {
      paths.push('results[].error');
    }
  }
  return paths;
}

// ── the stage ─────────────────────────────────────────────────────────────────

export interface ApplyProjectionOpts {
  /** Canonical tool name — names the tool in the in-band footer. */
  toolName?: string;
  /**
   * The tool's declared side-effect class. Write results retain their outcome
   * envelope even when the caller's pick names only success fields, because a
   * semantic write failure is commonly a resolved, ordinary JSON result rather
   * than an MCP `isError` transport envelope.
   */
  effect?: 'read' | 'write';
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((1 - part / whole) * 100)}%`;
}

/**
 * Apply `spec` to `result`. Returns the ORIGINAL object untouched when there is
 * no spec, when the result is a delta envelope (its content[0].text is
 * client-parsed JSON that a footer would corrupt), or when anything throws —
 * the same fail-soft contract the result-door holds: this stage must never turn
 * a good result into a failure.
 */
export function applyResultProjection<T extends ProjectableResult>(
  result: T,
  spec: ProjectionSpec | null,
  opts: ApplyProjectionOpts = {},
): T {
  if (!spec) return result;
  try {
    // EI-19944567995100280: an ERROR envelope is not a result being reduced —
    // there is nothing in it the caller wants filtered, and a `pipe`/`pick`
    // spec authored for the SUCCESS shape routinely matches nothing against an
    // error body (a one-line `invalid_input: ...` string, or JSON with a
    // completely different shape). Running it anyway silently deletes the
    // reason for the failure — measured live: a `grep` spec against a 94-char
    // `invalid_input` error reduced it to 0 lines / 0 chars, and the footer's
    // own "(100% saved)" wording read as a successful, empty filter rather than
    // a swallowed error. The caller retried three times believing the result
    // set was genuinely empty. Bypass entirely and pass the error through
    // UNTOUCHED — never partially reduced, never even the footer appended, so
    // an agent that greps the reply for the failing arg name still finds it.
    if (result.isError) {
      return {
        ...result,
        _meta: {
          ...result._meta,
          resultProjection: {
            applied: false,
            spec,
            linesIn: 0,
            linesOut: 0,
            charsIn: 0,
            charsOut: 0,
            notes: [
              'projection SKIPPED: this result is an ERROR envelope — reducing an error body ' +
                'risks deleting the reason for the failure, so it is always passed through ' +
                'unfiltered. Fix the call per the error text below, then re-add `projection` once ' +
                'it succeeds.',
            ],
          } satisfies ProjectionReport,
        },
      };
    }

    const items = result.content;
    if (!Array.isArray(items)) return result;

    // A genuine DELTA envelope reconstructs client-side from a patch payload in
    // content[0].text; appending a footer (or reshaping the body) breaks that
    // parse, so it is skipped — noted in _meta, which is not part of what the
    // client parses.
    //
    // But `_meta.delta` alone does NOT mean that. Every delta-CAPABLE tool
    // stamps the block on ordinary responses too, to advertise the capability
    // and carry the cursor: `mode:'full'` + `reason:'no_request'` is a normal
    // full body from a caller who never asked for delta, and
    // `reason:'proxy_reconstructed'` is a plain JSON row array the proxy
    // rebuilt. Both are ordinary content that projects perfectly well.
    //
    // Guarding on mere PRESENCE therefore silently disabled this whole stage
    // for every list tool in the catalog — caught only by running it live
    // against work_items:list, which returned the full 4.8KB payload and no
    // footer while every unit test passed. `mode` is the honest discriminator:
    // 'full' means the body is normal, anything else means it is a patch.
    const deltaMeta = (result._meta as { delta?: { mode?: unknown } } | undefined)?.delta;
    if (deltaMeta != null && deltaMeta.mode !== 'full') {
      return {
        ...result,
        _meta: {
          ...result._meta,
          resultProjection: {
            applied: false,
            spec,
            linesIn: 0,
            linesOut: 0,
            charsIn: 0,
            charsOut: 0,
            notes: [
              `projection SKIPPED: this is a delta-protocol result (mode=${String(deltaMeta.mode)}), whose ` +
                'body is a client-reconstructed patch — reshaping it would corrupt the reconstruction. ' +
                'Re-call without delta to project.',
            ],
          } satisfies ProjectionReport,
        },
      };
    }

    const textItems = items.filter(isTextItem);
    if (textItems.length === 0) return result;

    const original = textItems.map((it) => it.text).join('\n\n');
    // P-015: a note now carries whether it DEGRADES trust in the body it rides
    // on, because the footer's ordering depends on it (see `degraded` below).
    // `degrades` defaults TRUE: a note nobody classified is far more likely to
    // be a caveat than a courtesy, and the failure this fixes is a real caveat
    // read as a footnote — so the unclassified case must fail loud, not quiet.
    const noteRows: Array<{ text: string; degrades: boolean }> = [];
    const note = (text: string, degrades = true): void => {
      noteRows.push({ text, degrades });
    };
    let working = original;
    let regexFlavor: 'js-regexp' | undefined;

    if (spec.pick) {
      // SHARED with the result-door footer (classifyProjectionBody) so the
      // operator we RECOMMEND cannot drift from the one that actually runs —
      // D-012. The per-item fallback inside it is load-bearing: a structured
      // result is routinely NOT one text item (the JSON payload is followed by
      // advisory prose, "See also: …"), so the joined text does not parse even
      // though the payload plainly does. Caught live on work_items:list, where
      // `pick` reported "not JSON" against a body visibly starting `[{"id":…`.
      const { json } = classifyProjectionBody(textItems);
      // itemIndex >= 0 means it took that per-item fallback: say the advisory
      // items were dropped rather than dropping them quietly.
      if (json && json.itemIndex >= 0 && textItems.length > 1) {
        // Not trust-degrading: `pick` did exactly what was asked and says what
        // it set aside. The reader's selection is intact.
        note(
          `pick applied to the JSON payload item; ${textItems.length - 1} advisory text item(s) ` +
            `(e.g. "See also" routing hints) were dropped — re-call without \`pick\` to keep them.`,
          false,
        );
      }
      if (!json) {
        note(
          'pick SKIPPED: this result body is not JSON, so there are no fields to select — ' +
            'the text was passed to `pipe` unchanged. Use `pipe` line operators for text results.',
        );
      } else {
        // A write can fail semantically while still resolving with a normal
        // result body (`{ ok:false, error }`) or a bulk envelope whose top-level
        // `ok` is true but whose row/count fields report failure.  A caller that
        // picks only success fields must never be allowed to project away that
        // outcome.  Retain only fields that exist in this particular envelope so
        // ordinary write responses without the house outcome shape do not gain
        // spurious unmatched-path warnings.
        const implicitWritePaths =
          opts.effect === 'write'
            ? writeOutcomePickPaths(json.parsed).filter((path) => !spec.pick!.includes(path))
            : [];
        const pickPaths = [...spec.pick, ...implicitWritePaths];
        const { picked, unmatched } = applyPick(json.parsed, pickPaths);
        const requestedUnmatched = unmatched.filter((path) => !implicitWritePaths.includes(path));
        const implicitRetained = implicitWritePaths.filter((path) => !unmatched.includes(path));
        if (requestedUnmatched.length === spec.pick.length) {
          note(
            `pick matched NOTHING (${requestedUnmatched.join(', ')}) — body left unprojected rather than ` +
              `returning an empty object. Check the real shape with a smaller path first.`,
          );
        } else {
          if (requestedUnmatched.length > 0) {
            // The PARTIAL miss is the dangerous one and the case P-015 names:
            // the matched path shrinks the body dramatically, the footer reports
            // a large saving, and the field the caller actually came for is
            // silently absent. Loud, and — via `degraded` — ahead of the number.
            note(
              `pick path(s) matched nothing: ${requestedUnmatched.join(', ')} — those field(s) are ABSENT ` +
                `from the body below, which is otherwise a normal-looking result.`,
            );
          }
          if (implicitRetained.length > 0) {
            // This is an intentional, non-degrading addition to the caller's
            // selection: it makes the write outcome observable without making
            // every write projection look like a warning.
            note(
              `write outcome retained implicitly: ${implicitRetained.join(', ')} — ` +
                'projection cannot hide whether the mutation succeeded.',
              false,
            );
          }
          working = JSON.stringify(picked, null, 2);
        }
      }
    }

    const { lines, trailingNewline } = splitLines(working);
    const linesIn = lines.length;
    let current = lines;
    for (const stage of spec.pipe ?? []) {
      if (stage.op === 'grep' && !stage.fixed) regexFlavor = 'js-regexp';
      current = runStage(current, stage);
    }
    const linesOut = current.length;
    const projectedText = current.join('\n') + (trailingNewline && current.length > 0 ? '\n' : '');

    // Decided BEFORE the footer is rendered: a note appended afterwards would
    // live only in _meta, and the in-band footer is the copy the agent actually
    // reads. (Getting this order wrong is how a "loud" fail-open goes quiet.)
    const dropStructured = result.structuredContent !== undefined;
    if (dropStructured) {
      // Not trust-degrading: dropping it is the point of asking for less, and
      // the text body the caller reads is complete on its own terms.
      note(
        'structuredContent dropped: it would have carried the UNPROJECTED payload alongside the ' +
          'reduced text. Re-call without `projection` if you need the structured form.',
        false,
      );
    }

    // EI-19361771982678588: this stage runs AFTER the tool's own payload-tier
    // bounding, so `original` may already be a PARTIAL corpus. The result-door
    // does carry an upstream-truncation warning — but only on the path where it
    // ALSO spills, because it returns early when the result already fits the
    // door budget (result-door.ts:160). A projection that shrinks the body under
    // that budget therefore SUPPRESSES the only notice saying the corpus was
    // incomplete, and this footer replaces it with a confident "N of M lines".
    //
    // The failure that motivated this: a `grep` over a 40-row facts:list that
    // had been tier-trimmed to 4 rows reported `0 of 3 lines` with no caveat,
    // which reads as "no such fact exists". Four matching rows existed. That is
    // the D-042 misattribution this file already guards against, reached from
    // the opposite direction — not "the tool returned everything", but "the
    // corpus I searched was everything". A filter is only honest about a MISS if
    // it is honest about what it was allowed to search.
    const upstream = (
      result._meta as
        | { payloadProjection?: { truncated?: boolean; tier?: string; omittedCount?: number } }
        | undefined
    )?.payloadProjection;
    if (upstream?.truncated) {
      const omitted = upstream.omittedCount ?? 0;
      const scope =
        `payload tier=${String(upstream.tier ?? 'unknown')}` +
        (omitted > 0 ? `, ${omitted.toLocaleString()} field(s)/row(s) omitted upstream` : '');
      const reCall = opts.toolName
        ? `re-call ${opts.toolName} with payloadTier:'full' (or narrower args)`
        : `re-call the tool with payloadTier:'full' (or narrower args)`;
      note(
        linesOut === 0
          ? `ZERO lines survived this projection, and the corpus it searched was ALREADY TRUNCATED ` +
              `before this stage ran (${scope}) — that omitted content was never serialized, so it was ` +
              `never searched. This empty result is NOT evidence of absence: ${reCall} before ` +
              `concluding the value does not exist.`
          : `the corpus this projection filtered was ALREADY TRUNCATED before this stage ran ` +
              `(${scope}) — matches shown come from the RETAINED portion only, and absence from them ` +
              `is not evidence of absence. For an exhaustive answer, ${reCall}.`,
      );
    }

    const notes = noteRows.map((n) => n.text);

    const report: ProjectionReport = {
      applied: true,
      spec,
      linesIn,
      linesOut,
      charsIn: original.length,
      charsOut: projectedText.length,
      ...(regexFlavor ? { regexFlavor } : {}),
      notes,
    };

    // P-015. The footer used to LEAD with a congratulatory savings statistic and
    // relegate every caveat behind it, so the most important case — a `pick`
    // that matched nothing, a corpus already truncated upstream — was headlined
    // "(97% saved)". That reads as a filter that worked; the correction sat
    // below it and was read, if at all, as a footnote to a success. A warning
    // subordinate to a success metric is not a warning.
    //
    // Two changes, both about ORDER and FRAMING, not about the numbers:
    //   1. When any note degrades trust in the body, the caveat goes FIRST and
    //      the statistic follows it.
    //   2. In that state the number stops being an achievement: "N% saved"
    //      becomes "N% of the body removed". A projection that dropped the field
    //      you asked for did not save you anything.
    // An honest reduction — every path matched, nothing truncated upstream —
    // renders exactly as before, so the ordinary case pays nothing for this.
    // `linesOut === 0` earns its own headline: an empty body is the one result
    // that is READ as an answer ("there are none") rather than as a filter
    // artifact, and it is indistinguishable from a genuine empty set without it.
    const emptyLead =
      linesOut === 0 && linesIn > 0
        ? `⚠ THIS PROJECTION REMOVED EVERYTHING — the body below is empty because the filter ` +
          `matched nothing, NOT because the result was empty. Do not read it as an absence.`
        : null;

    // An empty body degrades trust on its own, with or without a note. A pure
    // `pipe` grep that matches nothing pushes NO note, so keying `degraded` off
    // the notes alone left the two halves contradicting each other in one
    // footer: "REMOVED EVERYTHING" above, "(100% saved)" below. Caught by this
    // fix's own test — which is the reason the empty case gets a control.
    const degraded = noteRows.some((n) => n.degrades) || emptyLead !== null;
    const removed = pct(projectedText.length, original.length);
    const stats =
      `[projection: ${describeProjection(spec)} → ${linesOut.toLocaleString()} of ` +
      `${linesIn.toLocaleString()} lines, ${projectedText.length.toLocaleString()} of ` +
      `${original.length.toLocaleString()} chars ` +
      (degraded ? `(${removed} of the body removed)` : `(${removed} saved)`) +
      (regexFlavor ? ' · grep pattern applied as a JavaScript RegExp, not GNU ERE' : '');

    const leadNotes = noteRows.filter((n) => n.degrades).map((n) => n.text);
    const tailNotes = noteRows.filter((n) => !n.degrades).map((n) => n.text);
    const footer =
      '\n' +
      (emptyLead ? `${emptyLead}\n` : '') +
      (leadNotes.length ? `⚠ ${leadNotes.join('\n⚠ ')}\n` : '') +
      stats +
      (tailNotes.length ? `\n⚠ ${tailNotes.join('\n⚠ ')}` : '') +
      ']';

    const rebuilt: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    let placedText = false;
    for (const it of items) {
      if (isTextItem(it)) {
        if (placedText) continue; // every text item was folded into `original`
        rebuilt.push({ type: 'text', text: projectedText });
        placedText = true;
        continue;
      }
      rebuilt.push(it as Record<string, unknown>);
    }
    rebuilt.push({ type: 'text', text: footer });

    const out = {
      ...result,
      content: rebuilt,
      _meta: { ...(result._meta ?? {}), resultProjection: report },
    } as T;
    // A full structuredContent alongside a reduced text body defeats the whole
    // point — it is the larger half of the payload, and the caller asked for
    // less. Dropped here; the note was recorded above so it reaches the footer.
    if (dropStructured) delete (out as { structuredContent?: unknown }).structuredContent;
    return out;
  } catch {
    return result; // fail-soft: never let the projection break a good result
  }
}
