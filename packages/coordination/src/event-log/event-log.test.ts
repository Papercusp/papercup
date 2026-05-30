/**
 * Conformance suite for CoordEventLog — run against BOTH FsCoordLog and
 * InMemoryCoordLog. A passing in-memory impl against the same suite is
 * the swappability proof (P-050).
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoordEnvelope } from '../core/envelope';
import type { CoordEventLog } from './types';
import { FsCoordLog } from './fs-log';
import { InMemoryCoordLog } from './memory-log';

function env(p: Partial<CoordEnvelope> & Pick<CoordEnvelope, 'msg_id' | 'kind' | 'from'>): CoordEnvelope {
  return { ts: '2026-01-01T00:00:00.000Z', to: ['*'], ...p } as CoordEnvelope;
}

function suite(name: string, make: () => Promise<{ log: CoordEventLog; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let log: CoordEventLog;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ log, cleanup } = await make());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('messages: per-writer append + union read', async () => {
      await log.appendLine('messages', 'A', env({ msg_id: 'a1', kind: 'message', from: 'A', to: ['B'] }));
      await log.appendLine('messages', 'B', env({ msg_id: 'b1', kind: 'message', from: 'B', to: ['A'] }));
      const lines = await log.readLines('messages');
      expect(lines.map((l) => l.msg_id).sort()).toEqual(['a1', 'b1']);
    });

    it('plan-events: append + read', async () => {
      await log.appendLine('plan-events', 'system', env({ msg_id: 'p1', kind: 'plan_event', from: 'system', plan_slug: 'x' }));
      const lines = await log.readLines('plan-events');
      expect(lines.map((l) => l.msg_id)).toEqual(['p1']);
    });

    it('handoffs: putEvent + getEvent + readEvents', async () => {
      await log.putEvent('handoffs', 'h1', env({ msg_id: 'h1', kind: 'handoff', from: 'A' }));
      expect((await log.getEvent('handoffs', 'h1'))?.msg_id).toBe('h1');
      expect((await log.readEvents('handoffs')).map((r) => r.msg_id)).toEqual(['h1']);
    });

    it('escalations: putEvent round-trips and getEvent misses null', async () => {
      await log.putEvent('escalations', 'e1', env({ msg_id: 'e1', kind: 'escalation', from: 'A', to: ['human'] }));
      expect((await log.getEvent('escalations', 'e1'))?.kind).toBe('escalation');
      expect(await log.getEvent('escalations', 'nope')).toBeNull();
    });

    it('empty surfaces read as []', async () => {
      expect(await log.readLines('messages')).toEqual([]);
      expect(await log.readEvents('handoffs')).toEqual([]);
    });
  });
}

suite('InMemoryCoordLog', async () => ({
  log: new InMemoryCoordLog(),
  cleanup: async () => {},
}));

suite('FsCoordLog', async () => {
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
