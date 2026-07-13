/**
 * Deterministic lock keys for authorized files outside a repository.
 *
 * The lock store intentionally accepts only relative POSIX keys. Home-directory
 * configuration is still shared mutable state, though, and previously bypassed
 * coordination entirely. Map an absolute path under the current user's home to
 * a reserved logical key; the Claude/Codex hook implements this exact mapping.
 */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EXTERNAL_HOME_LOCK_PREFIX = '@external/home';

export function externalHomePathToLockKey(input: string, home = homedir()): string {
  if (!isAbsolute(input)) {
    throw new Error(`external path must be absolute (received ${JSON.stringify(input)})`);
  }
  if (input.includes('\u0000')) throw new Error('external path contains a NUL byte');
  const absolute = resolve(input);
  const root = resolve(home);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`external path must name a file below the current user's home (${root})`);
  }
  return `${EXTERNAL_HOME_LOCK_PREFIX}/${rel.split(sep).join('/')}`;
}
