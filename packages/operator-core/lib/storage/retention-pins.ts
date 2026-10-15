/** Agent retention pins use the existing release-retention lease store.
 * The unchanged TSV schema protects pins in both shell and TypeScript deleters;
 * owner/reason metadata lives in the opaque tag, not a parallel pin database.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { defaultRetentionDir, isLeaseLive, parseRetentionLease, readRetentionLeases, RETENTION_SCHEMA, type RetentionLease } from '../release-cut-reclaim';
import { retentionPinProtectsPath } from './retention-policy';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
export { retentionPinProtectsPath as pinProtectsPath } from './retention-policy';

/** The final protection read and deletion share storage:pin's cross-process mutex. */
export async function withUnpinnedPath(path: string, remove: () => boolean | Promise<boolean>): Promise<boolean> {
  return withFsMutex('papercusp-disk-retention', async () => {
    const nowMs = Date.now();
    const read = await readRetentionPinsAsync({ nowMs });
    if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
    let physical = path;
    try { physical = await realpath(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (retentionPinProtectsPath(path, read.pins, nowMs) || retentionPinProtectsPath(physical, read.pins, nowMs)) return false;
    return remove();
  });
}

const TAG_PREFIX = 'agent-pin-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RetentionPin {
  id: string;
  owner: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  /** Both the caller's path and its physical path, if different. */
  paths: string[];
}

export function readRetentionPins(options: { dir?: string; nowMs?: number; includeExpired?: boolean } = {}): {
  pins: RetentionPin[]; errors: string[];
} {
  const read = readRetentionLeases(options.dir ?? defaultRetentionDir());
  return pinsFromLeases(read, options);
}

/** Background deleters must not synchronously walk the lease store on the event loop. */
export async function readRetentionPinsAsync(options: { dir?: string; nowMs?: number; includeExpired?: boolean } = {}) {
  const dir = options.dir ?? defaultRetentionDir();
  const read: { leases: RetentionLease[]; errors: string[] } = { leases: [], errors: [] };
  try {
    for (const name of await readdir(dir)) {
      if (!/^lease-.*\.tsv$/.test(name)) continue;
      const file = join(dir, name);
      try {
        const parsed = parseRetentionLease(file, await readFile(file, 'utf8'));
        if (parsed.ok) read.leases.push(parsed.lease);
        else read.errors.push(`${name}:${parsed.reason}`);
      } catch (error) {
        read.errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      read.errors.push(`${dir}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return pinsFromLeases(read, options);
}

function pinsFromLeases(read: { leases: RetentionLease[]; errors: string[] },
  options: { nowMs?: number; includeExpired?: boolean }): { pins: RetentionPin[]; errors: string[] } {
  const errors = [...read.errors];
  const pins: RetentionPin[] = [];
  for (const lease of read.leases) {
    const pinFile = /\/lease-agent-pin-[^/]+\.tsv$/.test(lease.file);
    if (!lease.tag.startsWith(TAG_PREFIX)) {
      if (pinFile) errors.push(`${lease.file}: missing pin metadata`);
      continue;
    }
    try {
      const meta = JSON.parse(Buffer.from(lease.tag.slice(TAG_PREFIX.length), 'base64url').toString('utf8'));
      if (meta.version !== 1 || !UUID.test(meta.id) || typeof meta.owner !== 'string' || !meta.owner.trim() ||
          typeof meta.reason !== 'string' || !meta.reason.trim() || !Number.isFinite(Date.parse(meta.createdAt)) ||
          lease.expiresNs <= 0n || !lease.paths.length || lease.paths.some((p) => !isAbsolute(p) || /[\r\n\0]/.test(p))) {
        throw new Error('invalid pin metadata');
      }
      const expiresAt = new Date(Number(lease.expiresNs / 1_000_000n)).toISOString();
      if (options.includeExpired || isLeaseLive(lease, options.nowMs ?? Date.now())) {
        pins.push({ id: meta.id, owner: meta.owner, reason: meta.reason, createdAt: meta.createdAt, expiresAt, paths: lease.paths });
      }
    } catch (error) {
      errors.push(`${lease.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { pins: pins.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), errors };
}

export function createRetentionPin(input: { path: string; owner: string; reason: string; expiresAt: string },
  options: { dir?: string; nowMs?: number } = {}): RetentionPin {
  const nowMs = options.nowMs ?? Date.now();
  const expiry = Date.parse(input.expiresAt);
  if (!input.owner.trim() || !input.reason.trim()) throw new Error('pin requires an owner and reason');
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new Error('pin requires a finite future expiry');
  if (!isAbsolute(input.path) || /[\r\n\0]/.test(input.path)) throw new Error('pin requires an absolute path without line breaks');
  const logical = normalize(input.path);
  // A missing target is an error, never a silently ineffective pin.
  const paths = [...new Set([logical, realpathSync(logical)])];
  const dir = options.dir ?? defaultRetentionDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pin: RetentionPin = { id: randomUUID(), owner: input.owner.trim(), reason: input.reason.trim(),
    createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiry).toISOString(), paths };
  const tag = TAG_PREFIX + Buffer.from(JSON.stringify({ version: 1, id: pin.id, owner: pin.owner,
    reason: pin.reason, createdAt: pin.createdAt })).toString('base64url');
  const body = [`schema=${RETENTION_SCHEMA}`, `tag=${tag}`, `created_ns=${BigInt(Math.floor(nowMs)) * 1_000_000n}`,
    `expires_ns=${BigInt(expiry) * 1_000_000n}`, ...paths.map((p) => `path=${p}`), ''].join('\n');
  const file = join(dir, `lease-agent-pin-${pin.id}.tsv`);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return pin;
}

/** Only the pin's authenticated owner can release it through the agent tool. */
export function removeRetentionPin(id: string, owner: string, options: { dir?: string } = {}): boolean {
  if (!UUID.test(id)) throw new Error('invalid pin id');
  const read = readRetentionPins({ ...options, includeExpired: true });
  if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
  const pin = read.pins.find((p) => p.id === id);
  if (!pin) return false;
  if (pin.owner !== owner) throw new Error('only the pin owner may release it');
  unlinkSync(join(options.dir ?? defaultRetentionDir(), `lease-agent-pin-${id}.tsv`));
  return true;
}
