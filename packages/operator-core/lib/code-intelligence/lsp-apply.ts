/**
 * `lsp-apply` — lock-safe application of a language server's `WorkspaceEdit`
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-013).
 *
 * This is the ONLY module in `code-intelligence/` that writes a byte. Everything
 * else — the adapter, the `lsp.*` facade — is read-only by construction, and
 * stays that way: `lspRenamePreview` computes a `WorkspaceEdit` and reads it as
 * a REPORT. P-013 exists because "preview" and "apply" have genuinely different
 * safety obligations, and collapsing them into a `dryRun: false` flag on the
 * read path is how a read-only rail stops being one.
 *
 * ── The hazard this module is built around ─────────────────────────────────
 * This is a SHARED checkout. Many agents edit it concurrently, serialized only
 * by the file-lock authority. A multi-file rename is the worst shape of write
 * on such a tree: it is wide (tens of files), it is offset-based (so a
 * one-character drift in an unrelated line silently corrupts the result rather
 * than failing), and it is computed at one instant and applied at another.
 *
 * ⚠ MEASURED, and the reason the staleness check is what it is: the adapter's
 * `ensureOpen` sends `didOpen` at `version: 1` and NEVER sends `didChange`
 * (lsp-adapter.ts). So an open document sits at LSP version 1 for the life of
 * the server, whatever happens on disk. Two things follow, and both invert the
 * obvious design:
 *
 *   (a) The LSP-native staleness check — `documentChanges[].textDocument.version`
 *       against the client's tracked version — would compare a constant to a
 *       constant here. It cannot fail, which makes it worse than no check: it
 *       looks like a guard and certifies nothing. We therefore do NOT rely on
 *       it, and this module does not ask for `documentChanges` versioning.
 *   (b) Per the LSP spec the server MUST prefer the client's `didOpen` text over
 *       disk for an open document. So after a peer writes that file, the server
 *       keeps answering from OUR stale snapshot — and a `WorkspaceEdit` computed
 *       then carries offsets for content that is no longer on disk.
 *
 * The check that actually catches (b) is therefore a content compare-and-swap
 * against DISK, taken twice: once when the edit is computed, once after the
 * lock is held. See `CONTENT-CAS` below.
 *
 * ── The invariants, and why each one refuses rather than repairs ────────────
 * Every failure below returns a typed refusal and writes NOTHING. None of them
 * "fixes up" the edit, because every repair we could make is a guess about what
 * the caller meant, applied to a shared tree at scale.
 *
 *  1. COMPLETE TARGET SET. Both `WorkspaceEdit` encodings are read (`changes`
 *     and `documentChanges`). A `documentChanges` array may also carry
 *     `CreateFile`/`RenameFile`/`DeleteFile` operations; we reject the whole
 *     edit rather than apply its text half, because applying the text of a
 *     rename-plus-move without the move produces a tree that compiles nowhere
 *     and is not what any caller asked for. Reading only `changes` — which is
 *     what a naive implementation does, and what the PREVIEW currently does —
 *     would silently under-report the target set for exactly the servers that
 *     prefer the modern encoding.
 *  2. ATOMIC, FAIL-CLOSED LOCKING. One all-or-nothing acquire over the entire
 *     target set. ⚠ `guardFileLock` FAILS OPEN on lock-infra faults — correct
 *     for a single-file `capability:edit` (parity with the PreToolUse hook:
 *     never wedge an agent on a blip), and WRONG here. A fail-open 40-file
 *     rewrite during a lock outage is the precise event the lock exists to
 *     prevent, so this path passes `failClosed`.
 *  3. ROOT CONFINEMENT, AFTER `realpath`. A `file://` URI can point anywhere,
 *     and a symlink inside the root can point outside it. The containment test
 *     is applied to the RESOLVED path.
 *  4. STALENESS (`CONTENT-CAS`). Per target: sha256 at plan time vs sha256 read
 *     under the lock. Any difference means someone else wrote the file in the
 *     window the lock could not cover, so the offsets are no longer trustworthy.
 *  5. CANONICAL APPLICATION. Edits are validated for overlap and bounds against
 *     the content actually on disk, then applied in reverse document order so
 *     that an earlier edit cannot shift a later one's offsets. An out-of-bounds
 *     range is itself a staleness signal and refuses.
 *  6. ALL-OR-NOTHING ACROSS FILES. Originals are held in memory and restored if
 *     any write fails, so a partial multi-file rename never survives the call.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 * It does not accept a caller-supplied `WorkspaceEdit`. If it did, `lsp.apply`
 * would be a general "write arbitrary text at arbitrary byte offsets" primitive
 * wearing an LSP costume — strictly more dangerous than `capability:write` and
 * with none of its reviewability. The edit is always computed by the language
 * server, from a request naming a cursor and a new name.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An LSP position: ZERO-indexed line, UTF-16 code-unit offset within the line. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** One `TextEdit` exactly as a language server states it. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/**
 * A `WorkspaceEdit` in either encoding. `documentChanges` entries are a union:
 * a `TextDocumentEdit` carries `textDocument` + `edits`; a file operation
 * carries `kind`. We keep the file-operation arm typed loosely on purpose —
 * we only ever need to DETECT one, never to execute it.
 */
export interface RawWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]> | null;
  documentChanges?: Array<Record<string, unknown>> | null;
}

/** Why an application refused. A closed union so callers can branch, not parse. */
export type ApplyRefusalReason =
  | 'flag_disabled'
  | 'empty_edit'
  | 'unsupported_file_operation'
  | 'malformed_edit'
  | 'out_of_root'
  | 'missing_file'
  | 'stale_document'
  | 'overlapping_edits'
  | 'edit_out_of_bounds'
  | 'file_locked'
  | 'lock_unavailable'
  | 'apply_failed'
  | 'backend_error';

export interface ApplyRefusal {
  ok: false;
  reason: ApplyRefusalReason;
  /** One sentence a human or agent can act on. Never a bare code. */
  message: string;
  /** Repo-relative (or absolute, when outside the root) paths implicated. */
  paths: string[];
}

/** One file's resolved, validated edit set. */
export interface EditTarget {
  /** Absolute, `realpath`-resolved, proven inside the root. */
  absPath: string;
  /** Root-relative POSIX-ish path, for messages and lock keys. */
  relPath: string;
  edits: LspTextEdit[];
}

export interface ResolvedTargets {
  ok: true;
  targets: EditTarget[];
}

export function refuse(
  reason: ApplyRefusalReason,
  message: string,
  paths: string[] = [],
): ApplyRefusal {
  return { ok: false, reason, message, paths };
}

/** sha256 of a document's text. The CONTENT-CAS token. */
export function contentSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Is `abs` inside `root`? Both must already be `realpath`-resolved by the
 * caller — symlink resolution is the whole point of the check and doing it here
 * would hide it. A path EQUAL to the root is not a file and is also rejected.
 */
export function isInsideRoot(abs: string, root: string): boolean {
  if (!isAbsolute(abs) || !isAbsolute(root)) return false;
  const rel = relative(root, abs);
  if (rel === '' || rel === '..') return false;
  if (rel.startsWith(`..${sep}`)) return false;
  // `relative` on Windows can return a rooted path when the drives differ.
  return !isAbsolute(rel);
}

function isTextEditShape(v: unknown): v is LspTextEdit {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.newText !== 'string') return false;
  const r = e.range as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return false;
  for (const key of ['start', 'end'] as const) {
    const p = r[key] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return false;
    if (!Number.isInteger(p.line) || !Number.isInteger(p.character)) return false;
    if ((p.line as number) < 0 || (p.character as number) < 0) return false;
  }
  return true;
}

/**
 * Stage 1 — resolve the COMPLETE target set from either encoding, and confine
 * it to the root.
 *
 * `realpathFn` is injected so the symlink-escape case is testable without
 * creating symlinks in a shared, auto-committing checkout. It must throw for a
 * path that does not exist; that is reported as `missing_file` rather than
 * being silently dropped, since an edit naming a file that is not there is a
 * stale plan, not an empty one.
 */
export function resolveEditTargets(
  raw: RawWorkspaceEdit | null | undefined,
  rootPath: string,
  realpathFn: (p: string) => string,
): ResolvedTargets | ApplyRefusal {
  if (!raw || typeof raw !== 'object') {
    return refuse('empty_edit', 'the language server returned no WorkspaceEdit');
  }

  let root: string;
  try {
    root = realpathFn(resolve(rootPath));
  } catch {
    return refuse('out_of_root', `project root does not exist: ${rootPath}`, [rootPath]);
  }

  /** uri → edits, merged across both encodings (a server may use either). */
  const byUri = new Map<string, LspTextEdit[]>();

  const ingest = (uri: unknown, edits: unknown): ApplyRefusal | null => {
    if (typeof uri !== 'string' || uri.length === 0) {
      return refuse('malformed_edit', 'a WorkspaceEdit entry has no document URI');
    }
    if (!Array.isArray(edits)) {
      return refuse('malformed_edit', `WorkspaceEdit entry for ${uri} has no edit array`, [uri]);
    }
    for (const e of edits) {
      if (!isTextEditShape(e)) {
        return refuse('malformed_edit', `WorkspaceEdit for ${uri} contains a malformed TextEdit`, [uri]);
      }
    }
    const list = byUri.get(uri) ?? [];
    list.push(...(edits as LspTextEdit[]));
    byUri.set(uri, list);
    return null;
  };

  for (const [uri, edits] of Object.entries(raw.changes ?? {})) {
    const bad = ingest(uri, edits);
    if (bad) return bad;
  }

  for (const entry of raw.documentChanges ?? []) {
    if (!entry || typeof entry !== 'object') {
      return refuse('malformed_edit', 'a documentChanges entry is not an object');
    }
    // INVARIANT 1. A file operation makes the edit something other than "change
    // text in place". Refuse the whole edit; never apply half of it.
    if (typeof entry.kind === 'string') {
      const target =
        (typeof entry.uri === 'string' && entry.uri) ||
        (typeof entry.oldUri === 'string' && entry.oldUri) ||
        '(unnamed)';
      return refuse(
        'unsupported_file_operation',
        `WorkspaceEdit contains a '${entry.kind}' file operation (${target}). ` +
          `lsp.apply changes text in place only; applying the text half of an edit that also ` +
          `creates, renames or deletes files would leave the tree in a state no caller asked for.`,
        [target],
      );
    }
    const doc = entry.textDocument as Record<string, unknown> | undefined;
    if (!doc || typeof doc !== 'object') {
      return refuse('malformed_edit', 'a documentChanges entry has no textDocument');
    }
    const bad = ingest(doc.uri, entry.edits);
    if (bad) return bad;
  }

  if (byUri.size === 0) {
    return refuse('empty_edit', 'the WorkspaceEdit names no documents');
  }

  const targets: EditTarget[] = [];
  for (const [uri, edits] of byUri) {
    if (edits.length === 0) continue;

    let raw2: string;
    try {
      raw2 = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
    } catch {
      return refuse('malformed_edit', `WorkspaceEdit document URI is not a file path: ${uri}`, [uri]);
    }
    if (!isAbsolute(raw2)) {
      return refuse('out_of_root', `WorkspaceEdit names a non-absolute path: ${raw2}`, [raw2]);
    }

    // INVARIANT 3. Resolve symlinks FIRST, then test containment. A symlink
    // inside the root pointing outside it is the case a string-prefix test on
    // the unresolved path passes and should not.
    let abs: string;
    try {
      abs = realpathFn(raw2);
    } catch {
      return refuse(
        'missing_file',
        `WorkspaceEdit names a file that does not exist: ${raw2}. The plan is stale.`,
        [raw2],
      );
    }
    if (!isInsideRoot(abs, root)) {
      return refuse(
        'out_of_root',
        `WorkspaceEdit would write outside the project root: ${abs} is not inside ${root}`,
        [abs],
      );
    }
    targets.push({ absPath: abs, relPath: relative(root, abs), edits });
  }

  if (targets.length === 0) {
    return refuse('empty_edit', 'the WorkspaceEdit names no documents with edits');
  }

  // Stable order so a refusal message, a lock-key set and a result listing are
  // reproducible across runs rather than hash-ordered.
  targets.sort((a, b) => (a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0));
  return { ok: true, targets };
}

/** Byte offset of the start of each line, including a synthetic EOF entry. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * LSP position → JS string index. `null` when the position is not addressable
 * in this text.
 *
 * JS strings ARE UTF-16 code units, which is the unit LSP's `character` counts,
 * so no transcoding is needed. CRLF needs no special case either: `starts` is
 * computed from `\n` alone, so a `\r` is simply part of the line's content.
 */
export function positionToOffset(text: string, starts: number[], pos: LspPosition): number | null {
  if (pos.line < 0 || pos.line >= starts.length) return null;
  const lineStart = starts[pos.line];
  const lineEnd = pos.line + 1 < starts.length ? starts[pos.line + 1] : text.length;
  // The line's own content excludes its terminator; a position may sit at the
  // very end of the content (an append), so `<=` is correct here.
  const lineLen = Math.max(0, lineEnd - lineStart - (text.charCodeAt(lineEnd - 1) === 10 ? 1 : 0));
  if (pos.character > lineLen) return null;
  return lineStart + pos.character;
}

export interface AppliedText {
  ok: true;
  text: string;
  /** How many edits were applied. Equals `edits.length`; returned for evidence. */
  applied: number;
}

/**
 * Stage 2 — apply one document's edits to its CURRENT content.
 *
 * INVARIANT 5. Pure, and total: every rejection path returns a refusal rather
 * than throwing or producing a best-effort string.
 *
 *  - Ranges are resolved against `text`, so an edit computed against different
 *    content fails `edit_out_of_bounds` instead of landing at a wrong offset.
 *  - Overlapping edits refuse. The LSP spec forbids them; a server that emits
 *    them is confused about the document, and silently picking a winner would
 *    corrupt the file in a way no test downstream would attribute back here.
 *  - Application runs in REVERSE document order, so no applied edit can shift
 *    the offsets of one not yet applied.
 */
export function applyTextEdits(text: string, edits: readonly LspTextEdit[]): AppliedText | ApplyRefusal {
  if (edits.length === 0) return { ok: true, text, applied: 0 };

  const starts = lineStarts(text);
  const resolved: Array<{ start: number; end: number; newText: string; order: number }> = [];

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const start = positionToOffset(text, starts, e.range.start);
    const end = positionToOffset(text, starts, e.range.end);
    if (start === null || end === null) {
      return refuse(
        'edit_out_of_bounds',
        `an edit targets ${e.range.start.line + 1}:${e.range.start.character}–` +
          `${e.range.end.line + 1}:${e.range.end.character}, which is outside the file as it is ` +
          `on disk now. The edit was computed against different content.`,
      );
    }
    if (end < start) {
      return refuse('malformed_edit', 'an edit has an inverted range (end before start)');
    }
    resolved.push({ start, end, newText: e.newText, order: i });
  }

  // Ascending by start, then by original array order — the spec's tie-break for
  // several pure insertions at one position.
  resolved.sort((a, b) => a.start - b.start || a.order - b.order);
  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i].start < resolved[i - 1].end) {
      return refuse(
        'overlapping_edits',
        `two edits overlap (offsets ${resolved[i - 1].start}–${resolved[i - 1].end} and ` +
          `${resolved[i].start}–${resolved[i].end}). A WorkspaceEdit must not contain overlapping ` +
          `ranges; applying one would corrupt the other.`,
      );
    }
  }

  let out = text;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    out = out.slice(0, r.start) + r.newText + out.slice(r.end);
  }
  return { ok: true, text: out, applied: resolved.length };
}

/**
 * Stage 3 — INVARIANT 4, the CONTENT-CAS.
 *
 * `planned` is what each target hashed to when the edit was computed; `current`
 * is what it hashes to now that the lock is held. A difference means a peer
 * wrote the file inside the window the lock could not cover, so every offset in
 * the plan is suspect. Refuse; do not recompute, because a silent recompute
 * turns "your plan was stale" into "we renamed something you never previewed".
 *
 * A caller may ALSO pass `expected` — hashes it captured from an earlier
 * preview — to close a longer window than plan→apply. It is optional because
 * the plan→apply window is the one this module can guarantee; a caller that
 * wants preview→apply guaranteed must say what it saw.
 */
export function checkContentCas(
  targets: readonly EditTarget[],
  planned: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  expected?: ReadonlyMap<string, string>,
): ApplyRefusal | null {
  const drifted: string[] = [];
  for (const t of targets) {
    const before = planned.get(t.absPath);
    const now = current.get(t.absPath);
    if (before === undefined || now === undefined || before !== now) drifted.push(t.relPath);
  }
  if (drifted.length > 0) {
    return refuse(
      'stale_document',
      `${drifted.length} file(s) changed on disk between computing this edit and acquiring the ` +
        `lock, so the edit's offsets no longer describe them: ${drifted.join(', ')}. ` +
        `Re-run the preview against current content.`,
      drifted,
    );
  }

  if (expected) {
    const mismatched: string[] = [];
    for (const t of targets) {
      const want = expected.get(t.absPath) ?? expected.get(t.relPath);
      if (want === undefined) continue; // caller vouched for a subset; that is its choice.
      if (want !== current.get(t.absPath)) mismatched.push(t.relPath);
    }
    if (mismatched.length > 0) {
      return refuse(
        'stale_document',
        `${mismatched.length} file(s) no longer match the content hash the caller previewed: ` +
          `${mismatched.join(', ')}. Someone edited them since the preview.`,
        mismatched,
      );
    }
  }
  return null;
}

/** One file's diagnostic count, before and after the write. */
export interface DiagnosticDeltaEntry {
  path: string;
  before: number;
  after: number;
  /** `after - before`. Positive means this write introduced problems. */
  delta: number;
}

export interface DiagnosticDelta {
  /** Per-file counts. Empty when diagnostics could not be collected. */
  files: DiagnosticDeltaEntry[];
  beforeTotal: number;
  afterTotal: number;
  /**
   * FALSE when either side could not be measured. An UNMEASURED delta must never
   * read as a clean one — "no new diagnostics" and "we did not look" are the two
   * readings this flag separates, and only the first is evidence.
   */
  measured: boolean;
  note: string | null;
}

export function summarizeDiagnosticDelta(
  files: DiagnosticDeltaEntry[],
  measured: boolean,
  note: string | null,
): DiagnosticDelta {
  return {
    files,
    beforeTotal: files.reduce((n, f) => n + f.before, 0),
    afterTotal: files.reduce((n, f) => n + f.after, 0),
    measured,
    note,
  };
}

export interface ApplySuccess {
  ok: true;
  /** Root-relative paths written, in the deterministic order they were applied. */
  filesChanged: string[];
  /** Total TextEdits applied across all files. */
  editsApplied: number;
  diagnostics: DiagnosticDelta;
  /** Post-write sha256 per root-relative path — the next CAS token. */
  contentAfter: Record<string, string>;
  latencyMs: number;
}

export type ApplyResult = ApplySuccess | ApplyRefusal;
