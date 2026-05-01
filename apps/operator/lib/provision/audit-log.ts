/**
 * Provision audit log.
 *
 * Append-only log of every provision event for `(harness, plugin)`,
 * with size cap. When the log exceeds the cap, oldest entries are
 * truncated and a `truncated` notice is recorded at the head.
 *
 * Spec: /docs/snapshots/build-scripts#audit-log.
 */

import { promises as fs, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { provisionDir } from './state-store';

export type AuditKind =
  | 'consent-granted'
  | 'consent-rejected'
  | 'setup-started'
  | 'setup-succeeded'
  | 'setup-failed'
  | 'teardown-started'
  | 'teardown-succeeded'
  | 'teardown-failed'
  | 'verify-started'
  | 'verify-succeeded'
  | 'verify-failed'
  | 'resource-recorded'
  | 'script-output'
  | 'log-truncated';

export interface AuditEntry {
  ts: string;
  kind: AuditKind;
  /** Optional run-id linking related entries. */
  runId?: string;
  /** Per-event payload — kept small. */
  data?: Record<string, unknown>;
}

const DEFAULT_CAP_MB = 10;

function auditPath(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'audit.log');
}

export async function appendAudit(
  harness: string,
  plugin: string,
  entry: Omit<AuditEntry, 'ts'> & { ts?: string },
  capMb = DEFAULT_CAP_MB,
): Promise<void> {
  const dir = provisionDir(harness, plugin);
  await fs.mkdir(dir, { recursive: true });
  const full: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + '\n';
  const path = auditPath(harness, plugin);
  await fs.appendFile(path, line);
  await maybeTruncate(path, capMb);
}

async function maybeTruncate(path: string, capMb: number): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return;
  }
  const capBytes = capMb * 1024 * 1024;
  if (stat.size <= capBytes) return;

  // Read all lines, drop oldest 25%, re-write with truncation marker.
  const raw = await fs.readFile(path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const keepFrom = Math.floor(lines.length * 0.25);
  const dropped = keepFrom;
  const kept = lines.slice(keepFrom);
  const trunc: AuditEntry = {
    ts: new Date().toISOString(),
    kind: 'log-truncated',
    data: { droppedEntries: dropped, capMb },
  };
  const out = JSON.stringify(trunc) + '\n' + kept.join('\n') + '\n';
  await fs.writeFile(path, out);
}

export async function readAudit(
  harness: string,
  plugin: string,
  opts: { limit?: number; sinceTs?: string } = {},
): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath(harness, plugin), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (opts.sinceTs && e.ts <= opts.sinceTs) continue;
      out.push(e);
    } catch {
      // skip
    }
  }
  if (opts.limit) return out.slice(-opts.limit);
  return out;
}

/**
 * High-throughput stream-append for in-process script-output capture.
 * Each `write()` is a separate audit entry of kind `script-output`.
 * Caller is responsible for `close()`.
 */
export class AuditStream {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  constructor(
    private harness: string,
    private plugin: string,
    private runId: string,
  ) {}
  async open(): Promise<void> {
    await fs.mkdir(provisionDir(this.harness, this.plugin), { recursive: true });
    this.stream = createWriteStream(auditPath(this.harness, this.plugin), { flags: 'a' });
  }
  async write(line: string): Promise<void> {
    if (!this.stream) await this.open();
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'script-output',
      runId: this.runId,
      data: { line: line.replace(/\n$/, '') },
    };
    return new Promise((resolve, reject) => {
      this.stream!.write(JSON.stringify(entry) + '\n', (e) => (e ? reject(e) : resolve()));
    });
  }
  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }
}
