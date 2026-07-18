/**
 * preserveIncidentCapture — EI-12982's forensic-preservation hook. Filesystem
 * tests (perf-budgets.test.ts stays pure-boundary/no-IO by design), against a
 * real temp dir so the rotation-exemption + bounded-pruning behavior is proven
 * against actual mtimes, not mocked ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveIncidentCapture } from './perf-budgets';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perf-incident-capture-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CAPTURE = JSON.stringify({
  schemaVersion: 'perf-signals-v1',
  capturedAt: '2026-07-16T03:33:00Z',
  hostState: 'wedge-active',
  signals: { operator_3070_reachable: false },
});

describe('preserveIncidentCapture', () => {
  it('returns preserved:false with an empty/missing dir', async () => {
    const out = await preserveIncidentCapture('infra-crit', join(dir, 'does-not-exist'));
    expect(out).toEqual({ preserved: false });
  });

  it('copies the newest non-incident capture into a distinctly-named incident file, leaving the source untouched', async () => {
    await writeFile(join(dir, '2026-07-16T03-30-00-000Z-scheduled.json'), CAPTURE);
    await writeFile(join(dir, '2026-07-16T03-32-00-000Z-scheduled.json'), CAPTURE); // newest

    const out = await preserveIncidentCapture('infra-crit', dir);
    expect(out.preserved).toBe(true);
    expect(out.path).toBeTruthy();
    expect(out.path).toContain('-incident-infra-crit-');

    const files = await readdir(dir);
    // both originals still present (copy, not move) + exactly one new incident file
    expect(files.filter((f) => f.endsWith('-scheduled.json'))).toHaveLength(2);
    expect(files.filter((f) => f.includes('-incident-'))).toHaveLength(1);
  });

  it('sanitizes an unsafe reason string instead of writing a path-breaking filename', async () => {
    await writeFile(join(dir, 'a-scheduled.json'), CAPTURE);
    const out = await preserveIncidentCapture('weird/../reason with spaces!', dir);
    expect(out.preserved).toBe(true);
    expect(out.path).not.toMatch(/\.\.|\/reason| /);
  });

  it('is exempt from the routine *-scheduled.json rotation glob (never itself picked up as a "newest" source on a re-run)', async () => {
    await writeFile(join(dir, 'a-scheduled.json'), CAPTURE);
    const first = await preserveIncidentCapture('infra-crit', dir);
    expect(first.preserved).toBe(true);
    // A second preserve call must still source from the scheduled file, not
    // re-copy the incident file it just wrote (which would compound reasons/
    // names over repeated crit ticks instead of always reflecting the latest
    // real capture).
    const second = await preserveIncidentCapture('infra-crit', dir);
    expect(second.preserved).toBe(true);
    expect(second.path).not.toBe(first.path);
    const content = await import('node:fs/promises').then((m) => m.readFile(second.path!, 'utf8'));
    expect(JSON.parse(content).hostState).toBe('wedge-active'); // sourced from the real capture, not an incident file
  });

  it('bounds the incident set to the newest 100, pruning older ones', async () => {
    await writeFile(join(dir, 'src-scheduled.json'), CAPTURE);
    // Pre-seed 100 incident files with strictly increasing mtimes (oldest first).
    const base = Date.parse('2026-07-01T00:00:00Z');
    for (let i = 0; i < 100; i++) {
      const p = join(dir, `seed-${i}-incident-old.json`);
      await writeFile(p, CAPTURE);
      const t = new Date(base + i * 1000);
      await utimes(p, t, t);
    }
    // One more preserve call pushes the incident count to 101 — the oldest
    // seeded file must be pruned back down to 100.
    const out = await preserveIncidentCapture('infra-crit', dir);
    expect(out.preserved).toBe(true);

    const files = await readdir(dir);
    const incidents = files.filter((f) => f.includes('-incident-'));
    expect(incidents).toHaveLength(100);
    expect(incidents).not.toContain('seed-0-incident-old.json'); // the oldest, pruned
    expect(incidents).toContain('seed-99-incident-old.json'); // newest seed, kept
  });
});
