/**
 * Coverage for db-encryption-rotation.
 *
 * WI-2144851 / security-boundary-remediation-and-usability-2026-09-04 P-007 —
 * the "rotation" half of the audit's "atomic key creation, and tested key
 * recovery/rotation".
 *
 * What these tests are actually FOR: the crypto is pgcrypto's and needs a live
 * database to exercise, but the part that can silently destroy a store is the
 * ORDERING between the transaction and the key file on disk. That is pure
 * sequencing, it is where every unrecoverable state lives, and it is fully
 * testable here with a fake `sql` and a tmp directory. Each test below names
 * the state it prevents rather than the line it covers.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENCRYPTED_TABLES, DbEncryptionKeyError } from './db-encryption';
import {
  rotateDbEncryptionKey,
  generateDbEncryptionKey,
  INTERRUPTED_ROTATION_HELP,
} from './db-encryption-rotation';

const OLD_KEY = 'OLD_KEY_'.padEnd(44, 'o');
const NEW_KEY = 'NEW_KEY_'.padEnd(44, 'n');

type Recorded = { text: string; values: unknown[] };

/**
 * A postgres.js-shaped fake. It must be callable BOTH as a tagged template and
 * as `sql('identifier')` for the dynamic table name, because the module under
 * test uses both and a fake that only supports one would force the subject to
 * be written around the test.
 */
function makeFakeSql(opts?: {
  rowsFor?: (text: string) => unknown[];
  failOn?: (text: string) => Error | null;
}) {
  const recorded: Recorded[] = [];
  let committed = false;
  let began = false;

  const sql = ((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && 'raw' in (first as object)) {
      const strings = first as unknown as TemplateStringsArray;
      const values = args.slice(1);
      const text = strings.raw.join('?').replace(/\s+/g, ' ').trim();
      recorded.push({ text, values });
      const boom = opts?.failOn?.(text);
      if (boom) return Promise.reject(boom);
      return Promise.resolve(opts?.rowsFor?.(text) ?? []);
    }
    return { __fragment: String(first) };
  }) as never as Parameters<typeof rotateDbEncryptionKey>[0]['sql'];

  (sql as unknown as { begin: unknown }).begin = async <T>(cb: (tx: unknown) => Promise<T>) => {
    began = true;
    const out = await cb(sql);
    committed = true; // only reached when cb did not throw
    return out;
  };

  return {
    sql,
    recorded,
    get committed() {
      return committed;
    },
    get began() {
      return began;
    },
  };
}

let dir: string;
let keyFilePath: string;

/** Every UPDATE reports one rotated row; every plaintext probe reports none. */
const oneRowPerTable = (text: string) => (text.startsWith('UPDATE') ? [{ workspace_id: 'ws' }] : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-rotation-'));
  keyFilePath = join(dir, 'db-encryption-key');
  writeFileSync(keyFilePath, `${OLD_KEY}\n`, { mode: 0o600 });
});

afterEach(() => {
  // tmpdir entries are disposable; leaving them is cheaper than a recursive rm
  // racing a still-open handle.
});

describe('rotateDbEncryptionKey — the happy path', () => {
  it('re-encrypts every ENCRYPTED_TABLE and installs the new key', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });

    const res = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
      now: () => Date.parse('2026-09-05T04:10:00.000Z'),
    });

    // Every table, not just the ones someone remembered.
    expect(res.tables.map((t) => t.table).sort()).toEqual([...ENCRYPTED_TABLES].sort());
    expect(res.rotatedTotal).toBe(ENCRYPTED_TABLES.size);
    expect(res.dryRun).toBe(false);

    // The live key file now holds the new key...
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(NEW_KEY);
    // ...the superseded one is preserved...
    expect(readFileSync(res.previousKeyPath!, 'utf8').trim()).toBe(OLD_KEY);
    // ...and no staged file is left behind to block the next rotation.
    expect(existsSync(`${keyFilePath}.next`)).toBe(false);
  });

  it('passes both keys as BOUND VALUES, never interpolated into SQL text', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });
    await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    });

    const updates = fake.recorded.filter((r) => r.text.startsWith('UPDATE'));
    expect(updates).toHaveLength(ENCRYPTED_TABLES.size);
    for (const u of updates) {
      expect(u.values).toContain(OLD_KEY);
      expect(u.values).toContain(NEW_KEY);
      // A key spliced into the statement text would land in pg_stat_activity
      // and in any query log — a credential leak that still "works".
      expect(u.text).not.toContain(OLD_KEY);
      expect(u.text).not.toContain(NEW_KEY);
    }
  });

  it('verifies with the NEW key inside the transaction, before committing', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });
    await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    });

    const verifies = fake.recorded.filter((r) => r.text.includes('AS verified'));
    expect(verifies).toHaveLength(ENCRYPTED_TABLES.size);
    for (const v of verifies) {
      expect(v.values).toContain(NEW_KEY);
      expect(v.values).not.toContain(OLD_KEY);
      // Re-asserts the shape operator-state-pg.ts's read path casts to.
      expect(v.text).toContain('::jsonb');
    }
  });

  it('does NOT touch updated_at — rotation re-encrypts a payload, it does not change one', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });
    await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    });

    for (const u of fake.recorded.filter((r) => r.text.startsWith('UPDATE'))) {
      expect(u.text).not.toContain('updated_at');
    }
  });

  it('reports plaintext rows rather than silently sweeping them into the new key', async () => {
    // A row with payload_ct IS NULL predates encryption-at-rest and is sitting
    // in the clear. Rotation must surface that, not quietly "fix" it.
    const fake = makeFakeSql({
      rowsFor: (text) =>
        text.startsWith('UPDATE')
          ? [{ workspace_id: 'ws' }]
          : text.includes('payload_ct IS NULL')
            ? [{ workspace_id: 'legacy-ws' }]
            : [],
    });

    const res = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    });

    expect(res.plaintextTotal).toBe(ENCRYPTED_TABLES.size);
    // Reported, but never an error — the rotation itself still succeeded.
    expect(res.rotatedTotal).toBe(ENCRYPTED_TABLES.size);
  });
});

describe('rotateDbEncryptionKey — refuses before it can do damage', () => {
  it('refuses a key shorter than the loader would accept', async () => {
    // The state this prevents: every row re-encrypted under a key that
    // db-encryption.ts then rejects as corrupt on the next boot. The rotation
    // would look like it succeeded and the store would be unreadable.
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });

    await expect(
      rotateDbEncryptionKey({
        sql: fake.sql,
        currentKey: OLD_KEY,
        newKey: 'too-short',
        keyFilePath,
      }),
    ).rejects.toBeInstanceOf(DbEncryptionKeyError);

    expect(fake.began).toBe(false); // refused before opening a transaction
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(OLD_KEY);
    expect(existsSync(`${keyFilePath}.next`)).toBe(false);
  });

  it('refuses to rotate a key to itself', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });

    await expect(
      rotateDbEncryptionKey({
        sql: fake.sql,
        currentKey: OLD_KEY,
        newKey: OLD_KEY,
        keyFilePath,
      }),
    ).rejects.toBeInstanceOf(DbEncryptionKeyError);
    expect(fake.began).toBe(false);
  });

  it('refuses when a staged key from an interrupted rotation is already present', async () => {
    // THE unrecoverable mistake available here: that file may be the only copy
    // of the key the rows are already encrypted under. Overwriting it destroys
    // the store with no way back.
    const staged = `${keyFilePath}.next`;
    writeFileSync(staged, 'A_PREVIOUS_ROTATIONS_KEY'.padEnd(44, 'x'), { mode: 0o600 });
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });

    const err = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(DbEncryptionKeyError);
    // The recovery instruction travels WITH the error, not in a doc.
    expect((err as Error).message).toContain('did not finish');
    expect(readFileSync(staged, 'utf8')).toContain('A_PREVIOUS_ROTATIONS_KEY');
    expect(fake.began).toBe(false);
  });
});

describe('rotateDbEncryptionKey — failure leaves the store exactly as it was', () => {
  it('rolls back and installs nothing when the OLD key is wrong', async () => {
    // pgcrypto raises "Wrong key or corrupt data" on a bad decrypt. The
    // property under test is that we let that abort the transaction rather
    // than catching it and pressing on.
    const fake = makeFakeSql({
      rowsFor: oneRowPerTable,
      failOn: (text) =>
        text.startsWith('UPDATE') ? new Error('Wrong key or corrupt data') : null,
    });

    await expect(
      rotateDbEncryptionKey({
        sql: fake.sql,
        currentKey: 'WRONG_KEY'.padEnd(44, 'w'),
        newKey: NEW_KEY,
        keyFilePath,
      }),
    ).rejects.toThrow(/Wrong key or corrupt data/);

    expect(fake.committed).toBe(false);
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(OLD_KEY);
    // The staged key protected nothing, so it must not be left to block the
    // operator's next attempt.
    expect(existsSync(`${keyFilePath}.next`)).toBe(false);
  });

  it('rolls back when VERIFICATION fails, even though the UPDATE succeeded', async () => {
    // The whole reason verification lives inside the transaction: without it
    // this commits rows only pgcrypto could tell us were unreadable, and the
    // discovery happens at the next credential read instead of here.
    const fake = makeFakeSql({
      rowsFor: oneRowPerTable,
      failOn: (text) => (text.includes('AS verified') ? new Error('Wrong key or corrupt data') : null),
    });

    await expect(
      rotateDbEncryptionKey({
        sql: fake.sql,
        currentKey: OLD_KEY,
        newKey: NEW_KEY,
        keyFilePath,
      }),
    ).rejects.toThrow(/Wrong key or corrupt data/);

    expect(fake.committed).toBe(false);
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(OLD_KEY);
    expect(existsSync(`${keyFilePath}.next`)).toBe(false);
  });
});

describe('rotateDbEncryptionKey — dry run', () => {
  it('reports what a real run would do, and changes nothing', async () => {
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });

    const res = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
      dryRun: true,
    });

    expect(res.dryRun).toBe(true);
    expect(res.rotatedTotal).toBe(ENCRYPTED_TABLES.size);
    expect(res.previousKeyPath).toBeUndefined();
    expect(fake.committed).toBe(false);
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(OLD_KEY);
    expect(existsSync(`${keyFilePath}.next`)).toBe(false);
  });

  it('still runs the verification pass, so its report is worth something', async () => {
    // A dry run that skipped verification would report success for a rotation
    // that a real run would fail — the most useless possible kind of green.
    const fake = makeFakeSql({
      rowsFor: oneRowPerTable,
      failOn: (text) => (text.includes('AS verified') ? new Error('Wrong key or corrupt data') : null),
    });

    await expect(
      rotateDbEncryptionKey({
        sql: fake.sql,
        currentKey: OLD_KEY,
        newKey: NEW_KEY,
        keyFilePath,
        dryRun: true,
      }),
    ).rejects.toThrow(/Wrong key or corrupt data/);
  });
});

describe('key-file custody during rotation', () => {
  it('never leaves the live key path absent — a gap there bootstraps a FRESH key', async () => {
    // getDbEncryptionKey() treats a missing key file as first boot and
    // generates one. If the install step renamed the live file away to back it
    // up, a concurrent operator process landing in that window would encrypt
    // new rows under a key nobody else holds.
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });
    const res = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
      now: () => Date.parse('2026-09-05T04:10:00.000Z'),
    });

    // Backup is a COPY (both paths exist), not a move.
    expect(existsSync(keyFilePath)).toBe(true);
    expect(existsSync(res.previousKeyPath!)).toBe(true);
  });

  it('writes both the staged and backup keys 0600', async () => {
    if (process.platform === 'win32') return;
    const fake = makeFakeSql({ rowsFor: oneRowPerTable });
    const res = await rotateDbEncryptionKey({
      sql: fake.sql,
      currentKey: OLD_KEY,
      newKey: NEW_KEY,
      keyFilePath,
    });

    // The backup holds a live key; a world-readable copy of it would undo the
    // custody work the key file itself does.
    expect(statSync(res.previousKeyPath!).mode & 0o077).toBe(0);
    // And the installed key inherits the staged file's 0600 through rename().
    expect(statSync(keyFilePath).mode & 0o077).toBe(0);
  });

  it('names a distinct backup per rotation, so a second one cannot clobber the first', async () => {
    const run = async (nowMs: number, from: string, to: string) =>
      rotateDbEncryptionKey({
        sql: makeFakeSql({ rowsFor: oneRowPerTable }).sql,
        currentKey: from,
        newKey: to,
        keyFilePath,
        now: () => nowMs,
      });

    const first = await run(Date.parse('2026-09-05T04:10:00.000Z'), OLD_KEY, NEW_KEY);
    const third = 'THIRD_KEY'.padEnd(44, 't');
    const second = await run(Date.parse('2026-09-05T05:11:00.000Z'), NEW_KEY, third);

    expect(second.previousKeyPath).not.toBe(first.previousKeyPath);
    expect(readFileSync(first.previousKeyPath!, 'utf8').trim()).toBe(OLD_KEY);
    expect(readFileSync(second.previousKeyPath!, 'utf8').trim()).toBe(NEW_KEY);
    expect(readFileSync(keyFilePath, 'utf8').trim()).toBe(third);
    // Every superseded key is still on disk — the recovery story depends on it.
    expect(readdirSync(dir).filter((f) => f.includes('.prev-'))).toHaveLength(2);
  });
});

describe('generateDbEncryptionKey', () => {
  it('produces a key the loader will accept, and a different one each time', () => {
    const a = generateDbEncryptionKey();
    const b = generateDbEncryptionKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    // Same shape db-encryption.ts bootstraps with: 32 random bytes, base64.
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
  });
});

describe('INTERRUPTED_ROTATION_HELP', () => {
  it('tells the operator both branches, because only one of them is safe', () => {
    // The dangerous window (committed, key not installed) and the safe one
    // (never committed) look IDENTICAL from outside, and the correct action is
    // opposite in each. Guessing wrong in one direction destroys the store.
    expect(INTERRUPTED_ROTATION_HELP).toContain('do NOT delete it');
    expect(INTERRUPTED_ROTATION_HELP).toContain('did not commit');
  });
});
