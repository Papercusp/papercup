// Portable runtime for the existing release-retention TSV store. Standalone
// desktop/VH cleaners and the server share this parser and filesystem mutex.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { withFsMutex } from './fs-mutex.mjs';

export const RETENTION_SCHEMA = 'papercusp-release-retention/v1';
const TAG_PREFIX = 'agent-pin-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultRetentionDir(env = process.env) {
  return env.PAPERCUSP_RELEASE_RETENTION_ROOT || join(homedir(), '.papercusp', 'release-retention');
}

export function versionFromTag(tag) {
  return /^desktop-v(\d+\.\d+\.\d+)(?:-|$)/.exec(tag)?.[1] ?? null;
}

// Mirrors release_artifacts_retention_lease_read_paths. Unknown lines fail closed.
export function parseRetentionLease(file, text) {
  let schema = '';
  let tag = '';
  let expires = null;
  const paths = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq) : '';
    const value = eq > 0 ? line.slice(eq + 1) : '';
    if (key === 'schema') schema = value;
    else if (key === 'tag') tag = value;
    else if (key === 'created_ns') continue;
    else if (key === 'expires_ns') {
      if (!/^\d+$/.test(value)) return { ok: false, file, reason: 'invalid expires_ns' };
      expires = BigInt(value);
    } else if (key === 'path') paths.push(value);
    else return { ok: false, file, reason: `unexpected line '${line.slice(0, 40)}'` };
  }
  if (schema !== RETENTION_SCHEMA) return { ok: false, file, reason: `schema '${schema}'` };
  if (!tag) return { ok: false, file, reason: 'missing tag' };
  if (expires === null) return { ok: false, file, reason: 'missing expires_ns' };
  return { ok: true, lease: { file, tag, version: versionFromTag(tag), expiresNs: expires, paths } };
}

export function isLeaseLive(lease, nowMs) {
  return lease.expiresNs === 0n || lease.expiresNs > BigInt(Math.floor(nowMs)) * 1_000_000n;
}

const errText = error => (error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)).slice(0, 160);

export function readRetentionLeases(dir) {
  const result = { leases: [], errors: [] };
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (error.code !== 'ENOENT') result.errors.push(`${dir}:${errText(error)}`);
    return result;
  }
  for (const name of names) {
    if (!/^lease-.*\.tsv$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const parsed = parseRetentionLease(file, readFileSync(file, 'utf8'));
      if (parsed.ok) result.leases.push(parsed.lease);
      else result.errors.push(`${name}:${parsed.reason}`);
    } catch (error) { result.errors.push(`${name}:${errText(error)}`); }
  }
  return result;
}

function pinsFromLeases(read, options) {
  const errors = [...read.errors];
  const pins = [];
  for (const lease of read.leases) {
    const pinFile = /[\\/]lease-agent-pin-[^\\/]+\.tsv$/.test(lease.file);
    if (!lease.tag.startsWith(TAG_PREFIX)) {
      if (pinFile) errors.push(`${lease.file}: missing pin metadata`);
      continue;
    }
    try {
      const meta = JSON.parse(Buffer.from(lease.tag.slice(TAG_PREFIX.length), 'base64url').toString('utf8'));
      if (meta.version !== 1 || !UUID.test(meta.id) || typeof meta.owner !== 'string' || !meta.owner.trim() ||
          typeof meta.reason !== 'string' || !meta.reason.trim() || !Number.isFinite(Date.parse(meta.createdAt)) ||
          lease.expiresNs <= 0n || !lease.paths.length || lease.paths.some(p => !isAbsolute(p) || /[\r\n\0]/.test(p))) {
        throw new Error('invalid pin metadata');
      }
      const expiresAt = new Date(Number(lease.expiresNs / 1_000_000n)).toISOString();
      if (options.includeExpired || isLeaseLive(lease, options.nowMs ?? Date.now())) {
        pins.push({ id: meta.id, owner: meta.owner, reason: meta.reason, createdAt: meta.createdAt, expiresAt, paths: lease.paths });
      }
    } catch (error) { errors.push(`${lease.file}: ${errText(error)}`); }
  }
  return { pins: pins.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), errors };
}

export function readRetentionPins(options = {}) {
  return pinsFromLeases(readRetentionLeases(options.dir ?? defaultRetentionDir()), options);
}

/**
 * Publish in the existing lease store. Callers serialize with deleters using
 * papercusp-disk-retention; the target must still exist at publication.
 * @param {{ path: string, owner: string, reason: string, expiresAt: string }} input
 * @param {{ dir?: string, nowMs?: number, id?: string, dryRun?: boolean }} [options]
 */
export function createRetentionPin(input, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const expiry = Date.parse(input.expiresAt);
  if (!input.owner.trim() || !input.reason.trim()) throw new Error('pin requires an owner and reason');
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new Error('pin requires a finite future expiry');
  if (!isAbsolute(input.path) || /[\r\n\0]/.test(input.path)) throw new Error('pin requires an absolute path without line breaks');
  const logical = normalize(input.path);
  const paths = [...new Set([logical, realpathSync(logical)])];
  const dir = options.dir ?? defaultRetentionDir();
  if (options.id !== undefined && !UUID.test(options.id)) throw new Error('invalid pin id');
  const pin = { id: options.id ?? randomUUID(), owner: input.owner.trim(), reason: input.reason.trim(),
    createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiry).toISOString(), paths };
  if (options.dryRun) return pin;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = TAG_PREFIX + Buffer.from(JSON.stringify({ version: 1, id: pin.id, owner: pin.owner,
    reason: pin.reason, createdAt: pin.createdAt })).toString('base64url');
  const body = [`schema=${RETENTION_SCHEMA}`, `tag=${tag}`, `created_ns=${BigInt(Math.floor(nowMs)) * 1_000_000n}`,
    `expires_ns=${BigInt(expiry) * 1_000_000n}`, ...paths.map((p) => `path=${p}`), ''].join('\n');
  const file = join(dir, `lease-agent-pin-${pin.id}.tsv`);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return pin;
}

/**
 * Only the pin's authenticated owner can release it through the agent tool.
 * @param {string} id
 * @param {string} owner
 * @param {{ dir?: string }} [options]
 */
export function removeRetentionPin(id, owner, options = {}) {
  if (!UUID.test(id)) throw new Error('invalid pin id');
  const read = readRetentionPins({ ...options, includeExpired: true });
  if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
  const pin = read.pins.find((p) => p.id === id);
  if (!pin) return false;
  if (pin.owner !== owner) throw new Error('only the pin owner may release it');
  unlinkSync(join(options.dir ?? defaultRetentionDir(), `lease-agent-pin-${id}.tsv`));
  return true;
}

export async function readRetentionPinsAsync(options = {}) {
  const dir = options.dir ?? defaultRetentionDir();
  const read = { leases: [], errors: [] };
  try {
    for (const name of await readdir(dir)) {
      if (!/^lease-.*\.tsv$/.test(name)) continue;
      const file = join(dir, name);
      try {
        const parsed = parseRetentionLease(file, await readFile(file, 'utf8'));
        if (parsed.ok) read.leases.push(parsed.lease);
        else read.errors.push(`${name}:${parsed.reason}`);
      } catch (error) { read.errors.push(`${name}:${errText(error)}`); }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') read.errors.push(`${dir}:${errText(error)}`);
  }
  return pinsFromLeases(read, options);
}

/** A pin covers descendants and containing entries, excluding sibling prefixes. */
export function retentionPinProtectsPath(path, pins, nowMs = Date.now()) {
  const candidate = normalize(path);
  const contains = (outer, inner) => outer === '/' || outer === inner || inner.startsWith(outer + '/');
  return pins.some(pin => Date.parse(pin.expiresAt) > nowMs && pin.paths.some(p =>
    contains(normalize(p), candidate) || contains(candidate, normalize(p))));
}

/** For callers ALREADY holding papercusp-disk-retention. Never acquires a second lock. */
export function pinProtection(pins, nowMs = Date.now(), resolvePath = realpathSync) {
  const physicalPath = path => {
    let physical = path;
    try { physical = resolvePath(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return normalize(physical);
  };
  // Resolve both sides of aliases from the SAME validated, fixed-time snapshot.
  // A child protects its atomic parent, but only descendants of the actual pin
  // qualify as pinned allocation. Do not derive that allowance from keep reasons.
  const snapshot = pins.filter(pin => Date.parse(pin.expiresAt) > nowMs).map(pin => ({
    expiresAt: pin.expiresAt,
    paths: [...new Set(pin.paths.flatMap(path => [normalize(path), physicalPath(path)]))],
  }));
  const isPinned = path => retentionPinProtectsPath(path, snapshot, nowMs)
    || retentionPinProtectsPath(physicalPath(path), snapshot, nowMs);
  const contains = (outer, inner) => outer === '/' || outer === inner || inner.startsWith(outer + '/');
  Object.defineProperty(isPinned, 'coversPath', { value: path => {
    const logical = normalize(path);
    const physical = physicalPath(path);
    return snapshot.some(pin => pin.paths.some(scope => contains(scope, logical) || contains(scope, physical)));
  } });
  return isPinned;
}

/** Final protection read and the entire destructive operation share storage:pin's mutex. */
export async function withRetentionPinProtection(work, options = {}) {
  return withFsMutex('papercusp-disk-retention', async () => {
    const nowMs = options.nowMs ?? Date.now();
    const read = await readRetentionPinsAsync({ ...options, nowMs });
    if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
    return work(pinProtection(read.pins, nowMs, options.resolvePath));
  }, { onWaiting: options.onWaiting, timeoutMs: options.timeoutMs });
}
