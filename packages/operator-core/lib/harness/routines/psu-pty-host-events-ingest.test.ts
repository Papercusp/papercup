/**
 * psu-pty host-event ingest + retention (P-007 / D-006).
 *
 * The load-bearing test here is `never deletes a file whose ingest failed`. Ingest-then-GC is
 * the ONLY thing standing between a retention sweep and permanent loss of the diagnostic rows
 * this plan exists to preserve, and an ordering bug there is silent: the file count falls,
 * which is exactly what a working sweep also looks like.
 */
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostEventDigest,
  ingestPsuPtyHostEvents,
  ownerIdFromEventLogFilename,
  parseHostEventFile,
} from './psu-pty-host-events-ingest';

const DAY_MS = 86_400_000;

/**
 * Minimal stand-in for the postgres.js client. It must be BOTH callable as `sql(rows, ...cols)`
 * and usable as a tagged template, because the ingester uses both forms in one statement.
 */
function makeFakeSql(opts: { failInsert?: boolean } = {}) {
  const statements: string[] = [];
  const inserts: Array<{ text: string; values: unknown[] }> = [];
  let inserted = 0;

  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const text = (first as unknown as string[]).join(' ? ');
      statements.push(text);
      if (/INSERT INTO/.test(text)) {
        if (opts.failInsert) return Promise.reject(new Error('insert boom'));
        inserts.push({ text, values: rest });
        // The UNNEST insert binds one array per column and every column array has the same
        // length, so the first array-valued parameter gives the chunk size.
        const firstArray = rest.find((v) => Array.isArray(v)) as unknown[] | undefined;
        const n = firstArray ? firstArray.length : 0;
        inserted += n;
        return Promise.resolve(Object.assign([], { count: n }));
      }
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    // The `sql(rows, ...cols)` multi-row helper. Reaching this from the ingester would mean
    // the UNNEST form had been replaced, so fail loudly instead of quietly supporting both.
    throw new Error('unexpected sql() helper call — the ingest insert must bind via unnest');
  }) as never;

  return { sql, statements, inserts, insertedCount: () => inserted };
}

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'psu-pty-ingest-'));
}

function row(kind: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, kind, ...extra });
}

describe('hostEventDigest', () => {
  it('is stable regardless of payload key insertion order', () => {
    const a = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {
      label: 'x',
      polls: 2,
    });
    const b = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {
      polls: 2,
      label: 'x',
    });
    expect(a).toBe(b);
  });

  it('does not collide across tuple boundaries', () => {
    // The property that justifies JSON-encoding the tuple instead of joining it with a
    // separator: shifting a character across a field boundary must change the digest. A naive
    // concatenation without a separator would make these two identical.
    const a = hostEventDigest('su-ab', 'c2026', 'kind', {});
    const b = hostEventDigest('su-a', 'bc2026', 'kind', {});
    expect(a).not.toBe(b);
  });

  it('distinguishes the delivery outcome that the rate depends on', () => {
    const delivered = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {});
    const expired = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'busy-gate-expired', {});
    expect(delivered).not.toBe(expired);
  });
});

describe('ownerIdFromEventLogFilename', () => {
  it('extracts the owner and refuses anything else', () => {
    expect(ownerIdFromEventLogFilename('su-abc.events.jsonl')).toBe('su-abc');
    expect(ownerIdFromEventLogFilename('carry-drills.events.jsonl')).toBe('carry-drills');
    expect(ownerIdFromEventLogFilename('notes.txt')).toBeNull();
    expect(ownerIdFromEventLogFilename('.events.jsonl')).toBeNull();
  });
});

describe('parseHostEventFile', () => {
  it('splits ts/kind out of the payload and keeps the rest', () => {
    const { rows, malformed } = parseHostEventFile(
      'ws',
      'su-1',
      row('turn-delivered', '2026-09-22T00:00:00.000Z', { label: 'turn inject', polls: 3 }),
    );
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('turn-delivered');
    expect(rows[0]!.ts).toBe('2026-09-22T00:00:00.000Z');
    expect(rows[0]!.payload).toEqual({ label: 'turn inject', polls: 3 });
  });

  it('counts a severed leading line without discarding the rest of the file', () => {
    // Front-truncation at EVENT_LOG_MAX_BYTES routinely cuts the first line in half. Dropping
    // the whole file on that would throw away every good row behind it.
    const text = [
      '{"ts":"2026-09-22T00:00:00.000Z","kin',
      row('busy-gate-expired', '2026-09-22T00:00:01.000Z'),
      row('turn-delivered', '2026-09-22T00:00:02.000Z'),
    ].join('\n');
    const { rows, malformed } = parseHostEventFile('ws', 'su-1', text);
    expect(malformed).toBe(1);
    expect(rows.map((r) => r.kind)).toEqual(['busy-gate-expired', 'turn-delivered']);
  });

  it('rejects rows without a usable ts or kind rather than inventing one', () => {
    const text = [
      JSON.stringify({ kind: 'turn-delivered' }),
      JSON.stringify({ ts: '2026-09-22T00:00:00.000Z' }),
      JSON.stringify({ ts: 'not-a-date', kind: 'turn-delivered' }),
      JSON.stringify(['an', 'array']),
    ].join('\n');
    const { rows, malformed } = parseHostEventFile('ws', 'su-1', text);
    expect(rows).toHaveLength(0);
    expect(malformed).toBe(4);
  });
});

describe('ingestPsuPtyHostEvents', () => {
  it('ingests rows and reports what it read', async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-1.events.jsonl'),
      [
        row('turn-delivered', '2026-09-22T00:00:00.000Z'),
        row('busy-gate-expired', '2026-09-22T00:00:01.000Z'),
      ].join('\n'),
    );
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesScanned).toBe(1);
    expect(res.rowsRead).toBe(2);
    expect(res.rowsInserted).toBe(2);
    expect(res.filesDeleted).toBe(0); // fresh file — never GC'd
  });

  it('binds jsonb as a pre-stringified ::jsonb[] parameter, never a raw object', async () => {
    // The EI-607 footgun, made falsifiable. On the getOrgPg client sql.json() THROWS and a
    // bare object does not bind at all — while on the default-config db() pool the opposite
    // is true and JSON.stringify double-encodes. A regression either way would surface only
    // at runtime, so assert the WIRE FORM here: the payload column must arrive as JSON text
    // and the statement must carry the explicit array cast.
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-1.events.jsonl'),
      row('turn-delivered', '2026-09-22T00:00:00.000Z', { label: 'turn inject', polls: 3 }),
    );
    const { sql, inserts } = makeFakeSql();
    await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('::jsonb[]');

    const payloadArray = inserts[0]!.values.find(
      (v): v is string[] =>
        Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' && v[0].startsWith('{'),
    );
    expect(payloadArray).toBeDefined();
    expect(JSON.parse(payloadArray![0]!)).toEqual({ label: 'turn inject', polls: 3 });
  });

  it('NEVER deletes a file whose ingest failed, even when it is past retention', async () => {
    // THE safety property. If this inverts, retention silently destroys the only copy of the
    // rows. `filesRetainedUningested` exists so the refusal is visible rather than inferred.
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql } = makeFakeSql({ failInsert: true });
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });

    expect(res.filesRetainedUningested).toBe(1);
    expect(res.filesDeleted).toBe(0);
    expect(await readdir(dir)).toContain('su-old.events.jsonl');
  });

  it('deletes a past-retention file once its rows are persisted', async () => {
    // The positive control for the test above: without this, "never deletes" would also pass
    // for a sweep that simply never deletes anything.
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });

    expect(res.rowsInserted).toBe(1);
    expect(res.filesDeleted).toBe(1);
    expect(await readdir(dir)).not.toContain('su-old.events.jsonl');
  });

  it('never deletes a file a live host may still be appending to', async () => {
    // mtime IS the liveness evidence — a running session writes continuously.
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-live.events.jsonl'),
      row('turn-delivered', '2026-09-22T00:00:00.000Z'),
    );
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesDeleted).toBe(0);
    expect(await readdir(dir)).toContain('su-live.events.jsonl');
  });

  it('dryRun mutates nothing on disk and issues no INSERT or DELETE', async () => {
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql, statements } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.filesDeleted).toBe(1); // reported as "would delete"
    expect(await readdir(dir)).toContain('su-old.events.jsonl');
    expect(statements.filter((s) => /INSERT INTO|DELETE FROM/.test(s))).toHaveLength(0);
  });

  it('is a no-op when the directory does not exist', async () => {
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({
      sql,
      workspaceId: 'ws',
      dir: join(tmpdir(), 'psu-pty-ingest-does-not-exist-12345'),
    });
    expect(res.filesScanned).toBe(0);
    expect(res.rowsInserted).toBe(0);
  });

  it('bounds the work per run', async () => {
    const dir = await makeDir();
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `su-${i}.events.jsonl`),
        row('turn-delivered', '2026-09-22T00:00:00.000Z'),
      );
    }
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, maxFilesPerRun: 2 });
    expect(res.filesScanned).toBe(2);
  });

  it('ignores files that are not per-owner event logs', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'README.txt'), 'not an event log');
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesScanned).toBe(0);
  });
});
