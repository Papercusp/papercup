/**
 * Render temporal-lite validity state on recall text.
 *
 * Default recall excludes closed rows, so this is inert unless a caller opts
 * into history (`include_superseded`). When history is requested, the marker
 * rides the body so compact orient/brief folds cannot accidentally discard the
 * validity metadata while leaving stale guidance looking current.
 */

import { createHash } from 'node:crypto';

/** Canonical source identity is separate from the exact emitted-body hash.
 * Do not trim, redact, summarize or otherwise rewrite the source here. */
export const CONTEXT_TEXT_NORMALIZER = 'text-normalization-v1' as const;
export function normalizeContextSourceText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

export interface ContextSourceVersion {
  schemaVersion: 'context-source-version-v1';
  normalizer: typeof CONTEXT_TEXT_NORMALIZER;
  namespace: string;
  ref: string;
  /** Supplied by the canonical reader; null means it has no revision clock. */
  revision: string | null;
  updatedAt: string | null;
  validity: {
    status: 'current' | 'superseded' | 'retracted' | 'expired' | 'unknown';
    validAt: string | null;
    invalidAt: string | null;
    supersededBy: string | null;
  };
  fullTextSha256: string;
  fullTextBytes: number;
  /** Half-open UTF-8 byte range in the canonical full text. */
  passage: { startByte: number; endByte: number; sha256: string };
  fingerprint: string;
}

/** The caller must possess the canonical full source. A search excerpt or
 * contextUnit alone cannot establish this identity. Validity is explicit
 * reader metadata, never inferred from recalled text or a missing field. */
export function contextSourceVersion(input: {
  namespace: string; ref: string; fullText: string;
  revision: string | null; updatedAt: string | null;
  validity: ContextSourceVersion['validity'];
  passage?: { startByte: number; endByte: number };
}): ContextSourceVersion {
  const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
  const instant = (value: string | null): string | null => {
    if (value === null) return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid context source timestamp');
    return parsed.toISOString();
  };
  if (typeof input.namespace !== 'string' || !input.namespace || typeof input.ref !== 'string' || !input.ref ||
      !nullableText(input.revision) || !nullableText(input.updatedAt) || !input.validity ||
      !['current', 'superseded', 'retracted', 'expired', 'unknown'].includes(input.validity.status) ||
      !nullableText(input.validity.validAt) || !nullableText(input.validity.invalidAt) ||
      !nullableText(input.validity.supersededBy)) throw new Error('Invalid context source identity');
  const bytes = Buffer.from(normalizeContextSourceText(input.fullText), 'utf8');
  const { startByte = 0, endByte = bytes.length } = input.passage ?? {};
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 ||
      endByte < startByte || endByte > bytes.length ||
      !Buffer.from(bytes.subarray(0, startByte).toString('utf8')).equals(bytes.subarray(0, startByte)) ||
      !Buffer.from(bytes.subarray(startByte, endByte).toString('utf8')).equals(bytes.subarray(startByte, endByte))) {
    throw new Error('Context source passage must be a complete UTF-8 byte range');
  }
  const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const validity = { status: input.validity.status, validAt: instant(input.validity.validAt),
    invalidAt: instant(input.validity.invalidAt), supersededBy: input.validity.supersededBy };
  const updatedAt = instant(input.updatedAt);
  const fullTextSha256 = sha256(bytes);
  const passage = { startByte, endByte, sha256: sha256(bytes.subarray(startByte, endByte)) };
  // Fixed field order is the wire contract; input object key order is irrelevant.
  const fingerprint = sha256(JSON.stringify(['context-source-version-v1', CONTEXT_TEXT_NORMALIZER,
    input.namespace, input.ref, input.revision, updatedAt, validity.status, validity.validAt,
    validity.invalidAt, validity.supersededBy, fullTextSha256, bytes.length,
    passage.startByte, passage.endByte, passage.sha256]));
  return { schemaVersion: 'context-source-version-v1', normalizer: CONTEXT_TEXT_NORMALIZER,
    namespace: input.namespace, ref: input.ref, revision: input.revision, updatedAt, validity,
    fullTextSha256, fullTextBytes: bytes.length, passage, fingerprint };
}

/** Source content is quoted evidence. A size limit may replace a whole unit
 * with provenance, but must never retain an imperative prefix and lose its
 * conditions. The hash describes this retrieved unit, not an unseen full source. */
export function renderContextSourceUnit(text: string, source: {
  kind: string; ref: string; link: string;
}, maxChars: number, pointerOnly = false): { text: string; operative: boolean } {
  const quoted = `source-evidence ${JSON.stringify(text)}`;
  if (!pointerOnly && quoted.length <= maxChars) return { text: quoted, operative: true };
  const unitHash = createHash('sha256').update(normalizeContextSourceText(text)).digest('hex');
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
