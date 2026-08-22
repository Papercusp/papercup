/**
 * Self-describing scratch references (orchestration-runtime-unification P-007).
 *
 * The manifest and payload share ONE file: the payload is written once, while
 * readers can enforce expiry/audience and verify integrity before exposing it.
 * Legacy scratch files remain readable as ordinary files.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OutputAudience } from './output-envelope';
import { reserveScratchSpace, RETENTION_MS } from './scratch-gc';

export const SCRATCH_REFERENCE_SCHEMA_VERSION = 'papercusp.scratch-reference/v1' as const;
export const SCRATCH_REFERENCE_MAGIC = `${SCRATCH_REFERENCE_SCHEMA_VERSION}\n`;

export interface ScratchReferenceContentMetadata {
  index: number;
  type: string;
  mimeType?: string;
  byteCount: number;
}

export interface ScratchReferenceManifest {
  schemaVersion: typeof SCRATCH_REFERENCE_SCHEMA_VERSION;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  ownerId?: string;
  audience: OutputAudience;
  mediaType: string;
  byteCount: number;
  sha256: string;
  content: readonly ScratchReferenceContentMetadata[];
}

export interface ParsedScratchReference {
  manifest: ScratchReferenceManifest;
  payload: Buffer;
  payloadByteOffset: number;
}

export class ScratchReferenceError extends Error {
  constructor(
    readonly code:
      | 'invalid_reference'
      | 'expired_reference'
      | 'forbidden_reference'
      | 'workspace_mismatch'
      | 'integrity_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ScratchReferenceError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isAudience(value: unknown): value is OutputAudience {
  return value === 'owner' || value === 'workspace' || value === 'public';
}

function requireManifest(value: unknown): ScratchReferenceManifest {
  if (!value || typeof value !== 'object') {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest must be an object');
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== SCRATCH_REFERENCE_SCHEMA_VERSION) {
    throw new ScratchReferenceError('invalid_reference', 'unsupported scratch reference schema');
  }
  if (
    typeof row.createdAt !== 'string' ||
    typeof row.expiresAt !== 'string' ||
    typeof row.workspaceId !== 'string' ||
    typeof row.mediaType !== 'string' ||
    typeof row.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(row.sha256) ||
    !Number.isSafeInteger(row.byteCount) ||
    Number(row.byteCount) < 0 ||
    !isAudience(row.audience) ||
    (row.ownerId !== undefined && typeof row.ownerId !== 'string') ||
    !Array.isArray(row.content)
  ) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest has invalid fields');
  }
  return row as unknown as ScratchReferenceManifest;
}

export function contentMetadata(items: readonly unknown[]): ScratchReferenceContentMetadata[] {
  return items.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = typeof row.type === 'string' ? row.type : 'unknown';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : undefined;
    const body = type === 'text' && typeof row.text === 'string'
      ? row.text
      : typeof row.data === 'string'
        ? row.data
        : JSON.stringify(item) ?? '';
    return {
      index,
      type,
      ...(mimeType ? { mimeType } : {}),
      byteCount: Buffer.byteLength(body, 'utf8'),
    };
  });
}

export function writeScratchReference(input: {
  filePath: string;
  payload: Buffer | string;
  workspaceId: string;
  ownerId?: string | null;
  audience?: OutputAudience;
  mediaType: string;
  content?: readonly ScratchReferenceContentMetadata[];
  nowMs?: number;
}): ScratchReferenceManifest {
  const payload = Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload, 'utf8');
  const nowMs = input.nowMs ?? Date.now();
  const audience = input.audience ?? (input.ownerId ? 'owner' : 'workspace');
  if (audience === 'owner' && !input.ownerId) {
    throw new ScratchReferenceError('invalid_reference', 'owner audience requires ownerId');
  }
  const manifest: ScratchReferenceManifest = {
    schemaVersion: SCRATCH_REFERENCE_SCHEMA_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + RETENTION_MS).toISOString(),
    workspaceId: input.workspaceId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    audience,
    mediaType: input.mediaType,
    byteCount: payload.length,
    sha256: sha256(payload),
    content: [...(input.content ?? [])],
  };
  const header = Buffer.from(`${SCRATCH_REFERENCE_MAGIC}${JSON.stringify(manifest)}\n`, 'utf8');
  reserveScratchSpace({ workspaceId: input.workspaceId, bytes: header.length + payload.length });
  mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 });
  writeFileSync(input.filePath, Buffer.concat([header, payload]), { mode: 0o600 });
  return manifest;
}

/** Null means a legacy/non-reference scratch file. A matching magic prefix is
 * always parsed fail-closed: a corrupt reference must never fall back to raw. */
export function parseScratchReference(bytes: Buffer): ParsedScratchReference | null {
  const magic = Buffer.from(SCRATCH_REFERENCE_MAGIC, 'utf8');
  if (!bytes.subarray(0, magic.length).equals(magic)) return null;
  const manifestEnd = bytes.indexOf(0x0a, magic.length);
  if (manifestEnd < 0) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is unterminated');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(magic.length, manifestEnd).toString('utf8'));
  } catch {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is not valid JSON');
  }
  const manifest = requireManifest(parsed);
  const payloadByteOffset = manifestEnd + 1;
  const payload = bytes.subarray(payloadByteOffset);
  if (payload.length !== manifest.byteCount) {
    throw new ScratchReferenceError(
      'integrity_mismatch',
      `scratch reference byte count mismatch: manifest=${manifest.byteCount}, actual=${payload.length}`,
    );
  }
  if (sha256(payload) !== manifest.sha256) {
    throw new ScratchReferenceError('integrity_mismatch', 'scratch reference SHA-256 mismatch');
  }
  return { manifest, payload, payloadByteOffset };
}

export function authorizeScratchReference(
  manifest: ScratchReferenceManifest,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
): void {
  const nowMs = caller.nowMs ?? Date.now();
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) {
    throw new ScratchReferenceError('expired_reference', `scratch reference expired at ${manifest.expiresAt}`);
  }
  if (!caller.workspaceId || caller.workspaceId !== manifest.workspaceId) {
    throw new ScratchReferenceError('workspace_mismatch', 'scratch reference belongs to a different workspace');
  }
  if (manifest.audience === 'owner' && caller.ownerId !== manifest.ownerId) {
    throw new ScratchReferenceError('forbidden_reference', 'scratch reference is restricted to its creating owner');
  }
}
