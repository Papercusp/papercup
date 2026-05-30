/**
 * Runs the shared CoordEventLog conformance suite (conformance.ts) against
 * the two host-free backends — InMemoryCoordLog and FsCoordLog. A passing
 * in-memory impl against the SAME suite is the swappability proof (P-050).
 * The PG backend (PgCoordLog) runs the same suite from the operator's
 * live-PG integration test.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeCoordEventLogConformance,
  envelope as env,
} from './conformance';
import { FsCoordLog } from './fs-log';
import { InMemoryCoordLog } from './memory-log';

describeCoordEventLogConformance('InMemoryCoordLog', async () => ({
  log: new InMemoryCoordLog(),
  cleanup: async () => {},
}));

describeCoordEventLogConformance('FsCoordLog', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'coord-log-'));
  return {
    log: new FsCoordLog({ coordDir: () => dir }),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
});

// Fs-specific: plan-events month rotation + filesBack hint, and the
// legacy pre-rotation file is still read.
describe('FsCoordLog plan-events rotation', () => {
  it('reads legacy + monthly files and honours filesBack', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'coord-rot-'));
    try {
      await fs.writeFile(
        join(dir, 'plan-events.jsonl'),
        JSON.stringify(env({ msg_id: 'old', kind: 'plan_event', from: 'system' })) + '\n',
        'utf8',
      );
      await fs.writeFile(
        join(dir, 'plan-events-2026-04.jsonl'),
        JSON.stringify(env({ msg_id: 'apr', kind: 'plan_event', from: 'system' })) + '\n',
        'utf8',
      );
      await fs.writeFile(
        join(dir, 'plan-events-2026-05.jsonl'),
        JSON.stringify(env({ msg_id: 'may', kind: 'plan_event', from: 'system' })) + '\n',
        'utf8',
      );
      const log = new FsCoordLog({ coordDir: () => dir });
      expect((await log.readLines('plan-events')).map((l) => l.msg_id)).toEqual(['old', 'apr', 'may']);
      // filesBack=1 → only the newest rotation file.
      expect((await log.readLines('plan-events', { filesBack: 1 })).map((l) => l.msg_id)).toEqual(['may']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
