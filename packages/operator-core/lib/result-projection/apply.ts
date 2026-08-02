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

// ── the stage ─────────────────────────────────────────────────────────────────

export interface ApplyProjectionOpts {
  /** Canonical tool name — names the tool in the in-band footer. */
  toolName?: string;
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
    const items = result.content;
    if (!Array.isArray(items)) return result;

    // A delta result reconstructs client-side from structured JSON in
    // content[0].text; appending a footer (or reshaping the body) breaks that
    // parse. The delta protocol is itself a result-shrinking mechanism, so the
    // caller loses nothing here beyond the projection — say so in _meta, which
    // is not part of the parsed payload.
    if (result._meta && (result._meta as { delta?: unknown }).delta != null) {
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
              'projection SKIPPED: this is a delta-protocol result, whose body is client-parsed JSON — ' +
                'reshaping it would corrupt the reconstruction. Re-call without delta to project.',
            ],
          } satisfies ProjectionReport,
        },
      };
    }

    const textItems = items.filter(isTextItem);
    if (textItems.length === 0) return result;

    const original = textItems.map((it) => it.text).join('\n\n');
    const notes: string[] = [];
    let working = original;
    let regexFlavor: 'js-regexp' | undefined;

    if (spec.pick) {
      let parsed: unknown;
      let parseOk = true;
      try {
        parsed = JSON.parse(working);
      } catch {
        parseOk = false;
      }
      if (!parseOk) {
        notes.push(
          'pick SKIPPED: this result body is not JSON, so there are no fields to select — ' +
            'the text was passed to `pipe` unchanged. Use `pipe` line operators for text results.',
        );
      } else {
        const { picked, unmatched } = applyPick(parsed, spec.pick);
        if (unmatched.length === spec.pick.length) {
          notes.push(
            `pick matched NOTHING (${unmatched.join(', ')}) — body left unprojected rather than ` +
              `returning an empty object. Check the real shape with a smaller path first.`,
          );
        } else {
          if (unmatched.length > 0) notes.push(`pick path(s) matched nothing: ${unmatched.join(', ')}`);
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
      notes.push(
        'structuredContent dropped: it would have carried the UNPROJECTED payload alongside the ' +
          'reduced text. Re-call without `projection` if you need the structured form.',
      );
    }

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

    const footer =
      `\n[projection: ${describeProjection(spec)} → ${linesOut.toLocaleString()} of ` +
      `${linesIn.toLocaleString()} lines, ${projectedText.length.toLocaleString()} of ` +
      `${original.length.toLocaleString()} chars (${pct(projectedText.length, original.length)} saved)` +
      (regexFlavor ? ' · grep pattern applied as a JavaScript RegExp, not GNU ERE' : '') +
      (notes.length ? `\n⚠ ${notes.join('\n⚠ ')}` : '') +
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
