import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeScratchReference,
  parseScratchReference,
  ScratchReferenceError,
  writeScratchReference,
} from './scratch-reference';

describe('stable scratch references', () => {
  let dir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scratch-reference-'));
    previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = dir;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
    else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores one self-describing file and verifies its payload hash and byte count', () => {
    const filePath = join(dir, 'ws', 'tool', 'run', 'result.json');
    const payload = Buffer.from('{"ok":true}', 'utf8');
    const manifest = writeScratchReference({
      filePath,
      payload,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'application/json',
      content: [{ index: 0, type: 'text', byteCount: payload.length }],
      nowMs: 1_000,
    });

    const parsed = parseScratchReference(readFileSync(filePath));
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
    expect(parsed!.manifest).toEqual(manifest);
    expect(parsed!.payloadByteOffset).toBeGreaterThan(0);
    expect(manifest.expiresAt).not.toBe(manifest.createdAt);
  });

  it('fails closed on tampering and enforces expiry, workspace, and owner audience', () => {
    const filePath = join(dir, 'ws', 'tool', 'run', 'result.txt');
    const manifest = writeScratchReference({
      filePath,
      payload: 'secret',
      workspaceId: 'ws',
      ownerId: 'su-1',
      mediaType: 'text/plain',
      nowMs: 10_000,
    });

    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-1', nowMs: 10_001,
    })).not.toThrow();
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'other', ownerId: 'su-1', nowMs: 10_001,
    })).toThrowError(ScratchReferenceError);
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-2', nowMs: 10_001,
    })).toThrowError(/restricted to its creating owner/);
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-1', nowMs: Date.parse(manifest.expiresAt),
    })).toThrowError(/expired/);

    const bytes = readFileSync(filePath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(filePath, bytes);
    expect(() => parseScratchReference(readFileSync(filePath))).toThrowError(/SHA-256 mismatch/);
  });

  it('returns null for legacy scratch files', () => {
    expect(parseScratchReference(Buffer.from('legacy payload'))).toBeNull();
  });
});
