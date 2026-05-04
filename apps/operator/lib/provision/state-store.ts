/**
 * Provision state.json + write-ahead resource log.
 *
 * For each (harness, plugin) pair we maintain:
 *   - state.json:           authoritative {hashes, createdResources, outputs}
 *   - resources.wal.jsonl:  append-only log of `papercusp_record_resource` calls
 *
 * The WAL exists so a SIGKILL'd setup script doesn't lose its
 * record-of-what-it-created. On any state.json read, the WAL is folded
 * into createdResources first.
 *
 * Storage layout (per harness):
 *   ~/.papercusp/harnesses/<slug>/provision/<plugin>/
 *     ├── state.json
 *     ├── resources.wal.jsonl
 *     └── audit.log
 *
 * Spec: /docs/snapshots/build-scripts#partial-failure-rollback.
 */

import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';

export interface RecordedResource {
  kind: string;
  externalId: string;
  recordedAt: string; // ISO
  metadata?: Record<string, unknown>;
}

export interface ProvisionState {
  schemaVersion: 1;
  hashes: {
    configHash: string;
    scriptHash: string;
    pluginVersion: string;
  } | null;
  createdResources: RecordedResource[];
  outputs: Record<string, unknown>;
  /** ISO timestamp of the last successful setup. Null if never. */
  lastSetupAt: string | null;
  /** ISO timestamp of the last verify pass. */
  lastVerifyAt: string | null;
  /** True when the last setup attempt failed; UI shows banner. */
  setupFailed: boolean;
  setupError?: string;
}

function HARNESSES_DIR() { return papercuspPath('harnesses'); }

export function provisionDir(harness: string, plugin: string): string {
  return join(HARNESSES_DIR(), harness, 'provision', plugin);
}

function statePath(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'state.json');
}

function walPath(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'resources.wal.jsonl');
}

const EMPTY_STATE: ProvisionState = {
  schemaVersion: 1,
  hashes: null,
  createdResources: [],
  outputs: {},
  lastSetupAt: null,
  lastVerifyAt: null,
  setupFailed: false,
};

async function ensureDir(harness: string, plugin: string): Promise<void> {
  await fs.mkdir(provisionDir(harness, plugin), { recursive: true });
}

/**
 * WAL entry — either a recorded resource or a `state_set` op the script
 * called via `papercusp_state_set`. Discriminated on the `$op` tag (only
 * `state_set` is reserved today).
 */
type WalEntry =
  | RecordedResource
  | { $op: 'state_set'; key: string; value: unknown };

async function readWal(harness: string, plugin: string): Promise<WalEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(walPath(harness, plugin), 'utf8');
  } catch {
    return [];
  }
  const out: WalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/**
 * Read state.json, folding any pending WAL entries into createdResources.
 * Idempotent on (kind, externalId) — duplicates collapse.
 */
export async function readState(harness: string, plugin: string): Promise<ProvisionState> {
  let state: ProvisionState;
  try {
    const raw = await fs.readFile(statePath(harness, plugin), 'utf8');
    state = { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<ProvisionState>) };
  } catch {
    state = { ...EMPTY_STATE, createdResources: [], outputs: {} };
  }
  const walEntries = await readWal(harness, plugin);
  if (walEntries.length === 0) return state;

  // Merge WAL into createdResources (dedup on kind+externalId) and outputs
  // (last-writer-wins per key).
  const seen = new Map<string, RecordedResource>();
  for (const r of state.createdResources) seen.set(`${r.kind}\0${r.externalId}`, r);
  const outputs: Record<string, unknown> = { ...state.outputs };
  for (const entry of walEntries) {
    if ('$op' in entry && entry.$op === 'state_set') {
      outputs[entry.key] = entry.value;
      continue;
    }
    if (!('kind' in entry) || !('externalId' in entry)) continue;
    const r = entry;
    const k = `${r.kind}\0${r.externalId}`;
    const existing = seen.get(k);
    if (existing) {
      // Latest metadata wins.
      seen.set(k, { ...existing, ...r, recordedAt: existing.recordedAt });
    } else {
      seen.set(k, r);
    }
  }
  return { ...state, createdResources: [...seen.values()], outputs };
}

export async function writeState(
  harness: string,
  plugin: string,
  state: ProvisionState,
): Promise<void> {
  await ensureDir(harness, plugin);
  const tmp = statePath(harness, plugin) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, statePath(harness, plugin));
  // Compaction: WAL is folded into state.json, drop it.
  try {
    await fs.unlink(walPath(harness, plugin));
  } catch {
    // wal absent → fine
  }
}

/**
 * Append one resource record to the WAL. This is what the
 * `papercusp_record_resource` shell helper invokes via a tiny Node
 * companion process.
 */
export async function appendWalEntry(
  harness: string,
  plugin: string,
  entry: RecordedResource,
): Promise<void> {
  await ensureDir(harness, plugin);
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(walPath(harness, plugin), line);
}

/**
 * Append a `state_set` op to the WAL. Folds into `state.outputs` on the
 * next `readState`. This is what the `papercusp_state_set` shell helper
 * invokes via the FIFO bridge.
 */
export async function appendStateOutput(
  harness: string,
  plugin: string,
  key: string,
  value: unknown,
): Promise<void> {
  await ensureDir(harness, plugin);
  const line = JSON.stringify({ $op: 'state_set', key, value }) + '\n';
  await fs.appendFile(walPath(harness, plugin), line);
}

/**
 * Drop all state for `(harness, plugin)`. Called after teardown completes.
 */
export async function clearState(harness: string, plugin: string): Promise<void> {
  const dir = provisionDir(harness, plugin);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * High-throughput WAL writer for in-process plugins (host-runtime mode).
 * The shell-script invocation path uses appendWalEntry instead.
 */
export class WalWriter {
  private stream: WriteStream | null = null;
  constructor(private harness: string, private plugin: string) {}
  async open(): Promise<void> {
    await ensureDir(this.harness, this.plugin);
    this.stream = createWriteStream(walPath(this.harness, this.plugin), { flags: 'a' });
  }
  async write(entry: RecordedResource): Promise<void> {
    if (!this.stream) await this.open();
    await new Promise<void>((resolve, reject) => {
      this.stream!.write(JSON.stringify(entry) + '\n', (e) => (e ? reject(e) : resolve()));
    });
  }
  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }
}
