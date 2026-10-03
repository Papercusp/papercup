import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Call at the owning module's evaluation boundary. A later checkout read
 * cannot identify the bytes an already-cached module is executing. */
export function captureSourceHash(moduleUrl: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(fileURLToPath(moduleUrl))).digest('hex');
  } catch {
    return null;
  }
}

export const SOURCE_IDENTITY_HASH = captureSourceHash(import.meta.url);
