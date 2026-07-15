import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_PORT_ARTIFACT_TTL_MS = 15 * 60_000;

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

export function parsePortToken(token: string): { portId: string; secret: string } | null {
  const match = String(token ?? '').match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/i);
  return match ? { portId: match[1], secret: match[2] } : null;
}

export function verifyPortToken(token: string, expectedHash: string): boolean {
  const parsed = parsePortToken(token);
  if (!parsed || !/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  return timingSafeEqual(Buffer.from(sha(parsed.secret), 'hex'), Buffer.from(expectedHash, 'hex'));
}

export async function writeSessionPortArtifact(input: {
  seed: string;
  portId?: string;
  root?: string;
  now?: number;
}): Promise<{ portId: string; token: string; tokenHash: string; path: string; expiresAt: string }> {
  const portId = input.portId ?? randomUUID();
  const secret = randomBytes(32).toString('hex');
  const root = input.root ?? join(homedir(), '.papercusp', 'session-ports');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = join(root, `${portId}.seed.md`);
  const temp = join(root, `.${portId}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(temp, 'wx', 0o600);
  try {
    await fh.writeFile(input.seed, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
  return {
    portId,
    token: `${portId}.${secret}`,
    tokenHash: sha(secret),
    path,
    expiresAt: new Date((input.now ?? Date.now()) + SESSION_PORT_ARTIFACT_TTL_MS).toISOString(),
  };
}

export async function consumeSessionPortArtifact(input: {
  token: string;
  expectedTokenHash: string;
  expectedPath: string;
  expiresAt: string;
  now?: number;
}): Promise<string> {
  if (!verifyPortToken(input.token, input.expectedTokenHash)) throw new Error('invalid session-port token');
  if (new Date(input.expiresAt).getTime() <= (input.now ?? Date.now())) throw new Error('session-port token expired');
  const seed = await readFile(input.expectedPath, 'utf8');
  await unlink(input.expectedPath);
  return seed;
}
