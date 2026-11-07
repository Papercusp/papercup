/**
 * Render temporal-lite validity state on recall text.
 *
 * Default recall excludes closed rows, so this is inert unless a caller opts
 * into history (`include_superseded`). When history is requested, the marker
 * rides the body so compact orient/brief folds cannot accidentally discard the
 * validity metadata while leaving stale guidance looking current.
 */

import { createHash } from 'node:crypto';

/** Source content is quoted evidence. A size limit may replace a whole unit
 * with provenance, but must never retain an imperative prefix and lose its
 * conditions. The hash describes this retrieved unit, not an unseen full source. */
export function renderContextSourceUnit(text: string, source: {
  kind: string; ref: string; link: string;
}, maxChars: number, pointerOnly = false): { text: string; operative: boolean } {
  const quoted = `source-evidence ${JSON.stringify(text)}`;
  if (!pointerOnly && quoted.length <= maxChars) return { text: quoted, operative: true };
  const unitHash = createHash('sha256').update(text.normalize('NFC').replace(/\r\n?/g, '\n')).digest('hex');
  // A memory URI repeats the same stable id already carried by ref. Keeping
  // both can make the provenance alone overflow a small native sink's budget.
  const provenance = source.kind === 'memory' ? { kind: source.kind, ref: source.ref } : source;
  return {
    text: `source-pointer ${JSON.stringify({ ...provenance, revision: 'unknown', passage: 'retrieved-unit', unitHash, omitted: true })}`,
    operative: false,
  };
}

type ValidityMetadata = {
  status?: unknown;
  invalid_at?: unknown;
};

function validityOf(metadata: unknown): ValidityMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const validity = (metadata as { validity?: unknown }).validity;
  if (!validity || typeof validity !== 'object' || Array.isArray(validity)) return null;
  return validity as ValidityMetadata;
}

/** A stable UTC day label for a closed validity window. */
export function supersededMemoryMarker(metadata: unknown): string | null {
  const validity = validityOf(metadata);
  if (validity?.status !== 'superseded') return null;
  const instant =
    typeof validity.invalid_at === 'string' ||
    typeof validity.invalid_at === 'number' ||
    validity.invalid_at instanceof Date
      ? new Date(validity.invalid_at)
      : null;
  const date = instant && Number.isFinite(instant.getTime())
    ? instant.toISOString().slice(0, 10)
    : 'date unknown';
  return `[SUPERSEDED ${date}]`;
}

/** Prefix a superseded recall body exactly once; current rows are byte-identical. */
export function annotateSupersededMemory(text: string, metadata: unknown): string {
  const marker = supersededMemoryMarker(metadata);
  if (!marker || text.startsWith(`${marker} `)) return text;
  return `${marker} ${text}`;
}
