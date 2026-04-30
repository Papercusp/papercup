/**
 * Per-file sha256 + canonical-manifest sha256 (§15.5 step 8).
 *
 * The canonical hash binds the manifest's `files[]` to the actual tarball
 * contents. Restore-side recomputes and compares (§15.6 step 4).
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

export async function sha256OfFile(path: string): Promise<string> {
  const fh = await fs.open(path, 'r');
  try {
    const hash = createHash('sha256');
    const stream = fh.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

export async function buildFileEntries(
  paths: { rel: string; abs: string; bytes: number }[],
): Promise<{ path: string; sha256: string; bytes: number }[]> {
  return Promise.all(
    paths.map(async (p) => ({
      path: p.rel,
      sha256: await sha256OfFile(p.abs),
      bytes: p.bytes,
    })),
  );
}
