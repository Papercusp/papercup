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

function sourceVersionFingerprint(version: Omit<ContextSourceVersion, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify([version.schemaVersion, version.normalizer,
    version.namespace, version.ref, version.revision, version.updatedAt, version.validity.status,
    version.validity.validAt, version.validity.invalidAt, version.validity.supersededBy,
    version.fullTextSha256, version.fullTextBytes, version.passage.startByte,
    version.passage.endByte, version.passage.sha256])).digest('hex');
}

/** Read the content-free metadata carried by the registered search adapters.
 * Malformed, altered or misaddressed metadata must permit replay. */
export function parseContextSourceVersion(wire: unknown, ref: string): ContextSourceVersion | null {
  if (typeof wire !== 'string' || wire.length > 4_096) return null;
  try {
    const version: ContextSourceVersion = JSON.parse(wire);
    const nullableText = (value: unknown) => value === null || typeof value === 'string';
    const instant = (value: unknown) => value === null ||
      (typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!version || version.schemaVersion !== 'context-source-version-v1' ||
        version.normalizer !== CONTEXT_TEXT_NORMALIZER || typeof version.namespace !== 'string' || !version.namespace ||
        version.ref !== ref || !nullableText(version.revision) || !instant(version.updatedAt) ||
        !version.validity || !['current', 'superseded', 'retracted', 'expired', 'unknown'].includes(version.validity.status) ||
        !instant(version.validity.validAt) || !instant(version.validity.invalidAt) ||
        !nullableText(version.validity.supersededBy) || !hash(version.fullTextSha256) ||
        !Number.isSafeInteger(version.fullTextBytes) || version.fullTextBytes < 0 || !version.passage ||
        !Number.isSafeInteger(version.passage.startByte) || !Number.isSafeInteger(version.passage.endByte) ||
        version.passage.startByte < 0 || version.passage.endByte < version.passage.startByte ||
        version.passage.endByte > version.fullTextBytes || !hash(version.passage.sha256) ||
        !hash(version.fingerprint) || sourceVersionFingerprint(version) !== version.fingerprint) return null;
    return version;
  } catch { return null; }
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
  const version: Omit<ContextSourceVersion, 'fingerprint'> = {
    schemaVersion: 'context-source-version-v1', normalizer: CONTEXT_TEXT_NORMALIZER,
    namespace: input.namespace, ref: input.ref, revision: input.revision, updatedAt, validity,
    fullTextSha256, fullTextBytes: bytes.length, passage };
  return { ...version, fingerprint: sourceVersionFingerprint(version) };
}

/** MemoryBackend.text is the full stored body. Missing reader metadata stays
 * unknown; malformed metadata permits replay instead of suppressing a source. */
export function memoryEntrySourceVersion(entry: {
  id: string; scope: string; text: string; metadata?: Record<string, unknown>;
}): ContextSourceVersion | null {
  try {
    const metadata = entry.metadata ?? {};
    const raw = metadata.validity;
    const validity = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const status = ['current', 'superseded', 'retracted', 'expired'].includes(String(validity.status))
      ? validity.status as ContextSourceVersion['validity']['status'] : 'unknown';
    const timestamp = (value: unknown): string | null => {
      if (value == null) return null;
      if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) return new Date(value).toISOString();
      throw new Error('Invalid source timestamp');
    };
    return contextSourceVersion({ namespace: `memory:${entry.scope}`, ref: entry.id, fullText: entry.text,
      revision: typeof metadata.revision === 'string' ? metadata.revision : null,
      updatedAt: timestamp(metadata.updated_at ?? metadata.updatedAt),
      validity: { status, validAt: timestamp(validity.valid_at), invalidAt: timestamp(validity.invalid_at),
        supersededBy: typeof validity.superseded_by === 'string' ? validity.superseded_by : null } });
  } catch { return null; }
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
