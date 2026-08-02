import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  planWalCheckpoints,
  discoverWalCandidates,
  checkpointOne,
  runWalCheckpointSweep,
  DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES,
  type WalCandidate,
} from './localstorage-wal-guard';

const MB = 1024 * 1024;

function cand(p: Partial<WalCandidate> & { walPath: string }): WalCandidate {
  return { dbPath: p.walPath.replace(/-wal$/, ''), sizeBytes: 0, ...p };
}

describe('planWalCheckpoints (pure)', () => {
  it('filters out anything below the threshold', () => {
    const out = planWalCheckpoints(
      [cand({ walPath: '/a-wal', sizeBytes: 10 * MB }), cand({ walPath: '/b-wal', sizeBytes: 300 * MB })],
      200 * MB,
    );
    expect(out.map((c) => c.walPath)).toEqual(['/b-wal']);
  });

  it('sorts survivors largest-first', () => {
    const out = planWalCheckpoints(
      [
        cand({ walPath: '/small-wal', sizeBytes: 250 * MB }),
        cand({ walPath: '/huge-wal', sizeBytes: 900 * MB }),
        cand({ walPath: '/mid-wal', sizeBytes: 500 * MB }),
      ],
      200 * MB,
    );
    expect(out.map((c) => c.walPath)).toEqual(['/huge-wal', '/mid-wal', '/small-wal']);
  });

  it('defaults to DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES (200MB) when unset', () => {
    expect(DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES).toBe(200 * MB);
    const out = planWalCheckpoints([
      cand({ walPath: '/under-wal', sizeBytes: 199 * MB }),
      cand({ walPath: '/over-wal', sizeBytes: 201 * MB }),
    ]);
    expect(out.map((c) => c.walPath)).toEqual(['/over-wal']);
  });

  it('empty input → empty output', () => {
    expect(planWalCheckpoints([])).toEqual([]);
  });
});

describe('discoverWalCandidates (real fs)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds only *.localstorage-wal files, skipping other extensions and dirs', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-disc-'));
    const db = new DatabaseSync(join(dir, 'http_localhost_3070.localstorage'));
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE t (v TEXT);');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    db.close();
    // an unrelated file that must be ignored
    require('node:fs').writeFileSync(join(dir, 'notes.txt'), 'hi');

    const found = discoverWalCandidates([dir]);
    expect(found).toHaveLength(1);
    expect(found[0].walPath).toBe(join(dir, 'http_localhost_3070.localstorage-wal'));
    expect(found[0].dbPath).toBe(join(dir, 'http_localhost_3070.localstorage'));
    expect(found[0].sizeBytes).toBeGreaterThan(0);
  });

  it('a missing root is skipped, not thrown', () => {
    expect(discoverWalCandidates(['/definitely/not/here/' + Date.now()])).toEqual([]);
  });

  it('no roots given → empty (never throws)', () => {
    expect(discoverWalCandidates([])).toEqual([]);
  });
});

describe('checkpointOne (real sqlite)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims the WAL to (near) zero when nothing else holds a snapshot open', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-ckpt-'));
    const dbPath = join(dir, 'test.localstorage');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE t (v TEXT);');
    const stmt = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 3000; i++) stmt.run('x'.repeat(2000));
    db.close(); // no lingering connection of our own

    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const before = statSync(walPath).size;
    expect(before).toBeGreaterThan(1 * MB);

    const outcome = checkpointOne(dbPath);
    expect(outcome.ok).toBe(true);
    expect(outcome.walBytesBefore).toBe(before);
    // TRUNCATE mode with no contention reclaims fully.
    expect(outcome.walBytesAfter).toBe(0);
    expect(outcome.busy).toBe(false);
  });

  it('degrades gracefully (no throw, partial progress) when a reader holds an old snapshot open', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-busy-'));
    const dbPath = join(dir, 'busy.localstorage');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE t (v TEXT);');
    const stmt = writer.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 1000; i++) stmt.run('x'.repeat(2000));

    // A second connection holding a long-lived read transaction — the WebKit
    // reader-pins-the-WAL scenario the whole module exists to survive.
    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN;');
    reader.prepare('SELECT count(*) FROM t').get();

    for (let i = 0; i < 1000; i++) stmt.run('y'.repeat(2000));

    const outcome = checkpointOne(dbPath);
    expect(outcome.ok).toBe(true); // never throws under contention
    expect(outcome.busy).toBe(true);
    // Nothing corrupted, nothing lost — the file is still a valid, readable WAL.
    expect(reader.prepare('SELECT count(*) AS n FROM t').get()).toBeTruthy();

    reader.exec('COMMIT;');
    reader.close();
    writer.close();
  });

  it('refuses to open (and so never creates) a db path that does not exist', () => {
    const outcome = checkpointOne('/tmp/wal-guard-does-not-exist-' + Date.now() + '.db');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('db_file_missing');
    expect(existsSync('/tmp/wal-guard-does-not-exist-' + Date.now() + '.db')).toBe(false);
  });
});

describe('runWalCheckpointSweep (end-to-end, real fs + sqlite)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('checkpoints only the over-threshold db and reports bytes reclaimed', () => {
    dir = mkdtempSync(join(tmpdir(), 'wal-guard-sweep-'));

    // A big WAL, over threshold.
    const bigDb = join(dir, 'big.localstorage');
    const big = new DatabaseSync(bigDb);
    big.exec('PRAGMA journal_mode=WAL;');
    big.exec('CREATE TABLE t (v TEXT);');
    const bigStmt = big.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 4000; i++) bigStmt.run('x'.repeat(2000));
    big.close();

    // A tiny WAL, under threshold — must be left untouched.
    const smallDb = join(dir, 'small.localstorage');
    const small = new DatabaseSync(smallDb);
    small.exec('PRAGMA journal_mode=WAL;');
    small.exec('CREATE TABLE t (v TEXT);');
    small.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    small.close();

    const smallWalBefore = statSync(`${smallDb}-wal`).size;
    const bigWalBefore = statSync(`${bigDb}-wal`).size;
    expect(bigWalBefore).toBeGreaterThan(1 * MB);

    const result = runWalCheckpointSweep({ thresholdBytes: 1 * MB, roots: [dir] });

    expect(result.checked).toBe(2);
    expect(result.overThreshold).toBe(1);
    expect(result.checkpointed).toBe(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);

    // The small one was never touched.
    expect(statSync(`${smallDb}-wal`).size).toBe(smallWalBefore);
    expect(statSync(`${bigDb}-wal`).size).toBe(0);
  });

  it('a missing root sweeps to an empty, error-free result', () => {
    const result = runWalCheckpointSweep({ roots: ['/nope/' + Date.now()] });
    expect(result).toEqual({ checked: 0, overThreshold: 0, checkpointed: 0, bytesReclaimed: 0, errors: [] });
  });
});
