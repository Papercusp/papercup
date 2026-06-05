/**
 * fs-log.ts — FsCoordLog: the filesystem CoordEventLog, the portable
 * default that lets a detached agent (no operator, no PG) participate by
 * direct fs reads/writes (the v2 plan's portability goal, D-004).
 *
 * Layout under the resolved coord dir (unchanged from the operator's
 * original modules so existing on-disk data + PAPERCUSP_COORD_DIR tests
 * keep working):
 *
 *   messages/<ownerId>.jsonl        per-sender outbox (append)
 *   handoffs/<msg_id>.json          one immutable file per handoff event
 *   escalations/<msg_id>.json       one immutable file per escalation event
 *   plan-events-<YYYY-MM>.jsonl     monthly-rotated single stream
 *   plan-events.jsonl               pre-rotation legacy file (still read)
 *
 * The coord-dir resolver is injected so the host owns repo-root / env
 * resolution; the package carries no `process.cwd()` policy.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoordEnvelope } from '../core/envelope';
import type {
  CoordEventLog,
  EventSurface,
  LineSurface,
  ReadLinesOpts,
} from './types';

export interface FsCoordLogOptions {
  /** Resolve the coord/ directory (the host owns env/repo-root policy). */
  coordDir: () => string;
}

const PLAN_EVENTS_MONTHLY_RE = /^plan-events-\d{4}-\d{2}\.jsonl$/;

function sanitise(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function appendJsonl(filepath: string, envelope: CoordEnvelope): Promise<void> {
  await fs.mkdir(dirname(filepath), { recursive: true });
  await fs.appendFile(filepath, JSON.stringify(envelope) + '\n', 'utf8');
}

async function readJsonl(filepath: string): Promise<CoordEnvelope[]> {
  let buf: string;
  try {
    buf = await fs.readFile(filepath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: CoordEnvelope[] = [];
  for (const ln of buf.split('\n')) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj as CoordEnvelope);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export class FsCoordLog implements CoordEventLog {
  constructor(private readonly opts: FsCoordLogOptions) {}

  private root(): string {
    return this.opts.coordDir();
  }

  private lineDir(surface: LineSurface): string {
    // 'messages' has a subdir; 'plan-events' lives at the coord root.
    return surface === 'messages' ? join(this.root(), 'messages') : this.root();
  }

  private eventDir(surface: EventSurface): string {
    return join(this.root(), surface);
  }

  private planEventsFile(date: Date = new Date()): string {
    const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return join(this.root(), `plan-events-${ym}.jsonl`);
  }

  /** All plan-events files oldest→newest: legacy first, then monthly. */
  private async planEventsFiles(): Promise<string[]> {
    const dir = this.root();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw e;
    }
    const out: string[] = [];
    if (entries.includes('plan-events.jsonl')) out.push(join(dir, 'plan-events.jsonl'));
    for (const f of entries.filter((x) => PLAN_EVENTS_MONTHLY_RE.test(x)).sort()) {
      out.push(join(dir, f));
    }
    return out;
  }

  async appendLine(surface: LineSurface, writerKey: string, line: CoordEnvelope): Promise<void> {
    if (surface === 'messages') {
      await appendJsonl(join(this.lineDir('messages'), `${sanitise(writerKey)}.jsonl`), line);
    } else {
      // plan-events: writerKey ignored; rotate by current month.
      await appendJsonl(this.planEventsFile(), line);
    }
  }

  async readLines(surface: LineSurface, opts: ReadLinesOpts = {}): Promise<CoordEnvelope[]> {
    if (surface === 'messages') {
      const dir = this.lineDir('messages');
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw e;
      }
      const out: CoordEnvelope[] = [];
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        out.push(...(await readJsonl(join(dir, f))));
      }
      return out;
    }
    // plan-events
    const allFiles = await this.planEventsFiles();
    const files =
      typeof opts.filesBack === 'number' && opts.filesBack > 0
        ? allFiles.slice(-opts.filesBack)
        : allFiles;
    const out: CoordEnvelope[] = [];
    for (const f of files) out.push(...(await readJsonl(f)));
    return out;
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    const file = join(this.eventDir(surface), `${sanitise(msgId)}.json`);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    const dir = this.eventDir(surface);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw e;
    }
    const out: CoordEnvelope[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const buf = await fs.readFile(join(dir, f), 'utf8');
        const rec = JSON.parse(buf);
        if (rec && typeof rec === 'object') out.push(rec as CoordEnvelope);
      } catch {
        // skip malformed files
      }
    }
    return out;
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    const file = join(this.eventDir(surface), `${sanitise(msgId)}.json`);
    try {
      const buf = await fs.readFile(file, 'utf8');
      const rec = JSON.parse(buf);
      return rec && typeof rec === 'object' ? (rec as CoordEnvelope) : null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  }
}
