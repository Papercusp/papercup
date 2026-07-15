import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  decompressArchiveBlobBounded,
  sha256Hex,
  type SessionArchiveStore,
} from '../session-archive';

export const MAX_SESSION_PORT_SOURCE_BYTES = 64 * 1024 * 1024;

export interface StableSource {
  bytes: Buffer;
  sha256: string;
  highWaterBytes: number;
  completeBytes: number;
  source: 'live-jsonl' | 'archive-manifest';
  relpath: string | null;
}

/** Snapshot an append-only JSONL at one byte high-water. O_NOFOLLOW rejects a
 * swapped transcript symlink; the final partial line is excluded so concurrent
 * appends cannot produce a half-record parse. */
export async function readStableLiveJsonl(
  path: string,
  maxBytes = MAX_SESSION_PORT_SOURCE_BYTES,
): Promise<StableSource> {
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw new Error('session source is not a regular file');
    const highWaterBytes = stat.size;
    if (highWaterBytes > maxBytes) throw new Error(`session source ${highWaterBytes} exceeds ${maxBytes} byte cap`);
    const snapshot = Buffer.allocUnsafe(highWaterBytes);
    let offset = 0;
    while (offset < highWaterBytes) {
      const { bytesRead } = await fh.read(snapshot, offset, highWaterBytes - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const read = snapshot.subarray(0, offset);
    const finalNewline = read.lastIndexOf(0x0a);
    const complete = finalNewline < 0 ? Buffer.alloc(0) : read.subarray(0, finalNewline + 1);
    return {
      bytes: complete,
      sha256: sha256Hex(complete),
      highWaterBytes,
      completeBytes: complete.length,
      source: 'live-jsonl',
      relpath: null,
    };
  } finally {
    await fh.close();
  }
}

/** Read the ONE canonical Claude primary JSONL directly from the archive.
 * Ambiguity is a hard error: concatenating multiple cwd/project transcripts
 * silently changes branch semantics and is never an acceptable fallback. */
export async function readCanonicalClaudeArchive(
  key: { workspaceId: string; sessionId: string },
  store: SessionArchiveStore,
  maxBytes = MAX_SESSION_PORT_SOURCE_BYTES,
): Promise<StableSource> {
  const stamp = await store.readStamp('claude', key.sessionId, key.workspaceId);
  if (!stamp) throw new Error('canonical Claude archive not found');
  const primary = stamp.manifest.filter(
    (entry) =>
      basename(entry.relpath) === `${key.sessionId}.jsonl` &&
      entry.relpath.split(/[/\\]/)[0] === 'projects',
  );
  if (primary.length !== 1) throw new Error(`canonical Claude archive is ${primary.length ? 'ambiguous' : 'missing'}`);
  const manifest = primary[0];
  if (manifest.bytes_raw > maxBytes) throw new Error(`archive source ${manifest.bytes_raw} exceeds ${maxBytes} byte cap`);
  const rows = await store.readFiles('claude', key.sessionId, key.workspaceId);
  const row = rows.find((candidate) => candidate.relpath === manifest.relpath);
  if (!row) throw new Error('canonical Claude archive file row missing');
  if (row.bytes_raw !== manifest.bytes_raw || row.sha256 !== manifest.sha256) {
    throw new Error('canonical Claude archive manifest/file metadata mismatch');
  }
  const raw = await decompressArchiveBlobBounded(row, maxBytes);
  if (sha256Hex(raw) !== manifest.sha256) throw new Error('canonical Claude archive sha mismatch');
  return {
    bytes: raw,
    sha256: manifest.sha256,
    highWaterBytes: raw.length,
    completeBytes: raw.length,
    source: 'archive-manifest',
    relpath: manifest.relpath,
  };
}
