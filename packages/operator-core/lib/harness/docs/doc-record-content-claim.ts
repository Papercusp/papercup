/**
 * Pure judge for the claim migration 787 writes into the `harness_shared.harness_docs`
 * column comments: `upsertDocRecord` does NOT write `content`, `frontmatter` or
 * `content_mode` (EI-20059518283492409).
 *
 * WHY THIS EXISTS. Those three columns carry comments telling the reader what they
 * mean, and two of them have defaults (`content=''`, `content_mode='authored'`) that
 * make every row this writer creates ASSERT a contract the writer never evaluated.
 * The comments now say plainly that no writer populates them. That sentence is only
 * true for as long as this INSERT stays as it is — and the natural change ("populate
 * content from the file on the anchor path") would silently falsify it, leaving the
 * schema lying in the opposite direction. So the claim is pinned here rather than
 * trusted.
 *
 * The judge is deliberately SYMMETRIC: it fails when the writer starts writing one of
 * these columns AND when the writer cannot be found at all. A detector keyed to a
 * symbol that silently reports "clean" once that symbol is renamed is a coverage loss
 * dressed as a pass (the failure mode filed as EI-20059308594618912), so a missing
 * writer is a violation here, never a quiet ok.
 */

/** The columns migration 787's comments claim are never written by this writer. */
export const CLAIMED_UNWRITTEN_COLUMNS = ['content', 'frontmatter', 'content_mode'] as const;

export type ClaimedUnwrittenColumn = (typeof CLAIMED_UNWRITTEN_COLUMNS)[number];

export type DocRecordContentClaimVerdict = {
  ok: boolean;
  /** True when the writer function was located in the source at all. */
  writerFound: boolean;
  /** Of the claimed-unwritten columns, those the writer now appears to write. */
  writtenColumns: ClaimedUnwrittenColumn[];
  violations: string[];
};

const WRITER = 'upsertDocRecord';

/**
 * Slice the source down to `upsertDocRecord`'s body, so an unrelated mention of
 * these column names elsewhere in the file cannot red the gate. Returns null when
 * the writer is absent (a rename, a move, a deletion) — the caller treats that as a
 * violation rather than a pass.
 */
function sliceWriterBody(source: string): string | null {
  const start = source.indexOf(`export async function ${WRITER}`);
  if (start === -1) return null;
  // The writer ends where the next top-level export begins (the file declares each
  // export at column 0), or at EOF for the last one.
  const rest = source.slice(start + 1);
  const nextExport = rest.indexOf('\nexport ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/** Drop `--` line comments so prose inside the SQL cannot be read as a column write. */
function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Judge a `doc-record.ts` source text against the schema-comment claim.
 *
 * Word-boundary matching is load-bearing: `content_hash` IS written by other paths
 * and legitimately appears near this SQL, and `\bcontent\b` must not match inside it
 * (`_` is a word character, so the boundary does not fall after `content`). The
 * fixture controls in the sibling test pin that specific non-match.
 */
export function judgeDocRecordContentClaim(source: string): DocRecordContentClaimVerdict {
  const body = sliceWriterBody(source);
  if (body === null) {
    return {
      ok: false,
      writerFound: false,
      writtenColumns: [],
      violations: [
        `${WRITER} was not found in doc-record.ts. This guard pins migration 787's column comments ` +
          `("no writer populates content / frontmatter / content_mode") to that writer, so it cannot ` +
          `confirm the claim and must not report clean. If the writer was renamed or moved, update ` +
          `WRITER in doc-record-content-claim.ts; if it was deleted, re-check whether the comments ` +
          `still describe reality.`,
      ],
    };
  }

  const sqlOnly = stripSqlLineComments(body);
  const writtenColumns = CLAIMED_UNWRITTEN_COLUMNS.filter((col) =>
    new RegExp(`\\b${col}\\b`).test(sqlOnly),
  );

  const violations = writtenColumns.map(
    (col) =>
      `${WRITER} now references the column \`${col}\`, but migration 787's comment on ` +
      `harness_shared.harness_docs.${col} states that no writer populates it (measured 2026-08-10: ` +
      `0 of 952 content_mode='authored' rows held content or frontmatter). If this writer now ` +
      `populates ${col}, the comment is stale in the opposite direction — write a new migration ` +
      `correcting it, then update this guard. Do not silence the guard alone.`,
  );

  return { ok: violations.length === 0, writerFound: true, writtenColumns, violations };
}
