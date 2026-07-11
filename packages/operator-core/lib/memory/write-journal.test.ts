import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// memory-write-journal-auto-recovery P-009 — unit tests for the write-ahead
// journal: the INSERT-first write path, and the drain's replay / near-dup
// guard / update-replay / attempts-cap behavior. PG is faked with a
// content-dispatching sql tag; the backend with vi.fn()s.
// ---------------------------------------------------------------------------

interface Exec { text: string; values: unknown[] }
const executed: Exec[] = [];
/** Rows returned for the drain's pending-SELECT on the next call. */
let pendingRows: unknown[] = [];
let insertFails = false;

// Deliberately NO `json` helper on the fake: sql.json() mis-binds and throws on
// this stack's prepare:false (pgbouncer) pools, so the journal must never call
// it — a regression back to sql.json fails here as "sql.json is not a function"
// instead of silently passing against a fake that models behavior production
// doesn't have (the WI-4021 zero-rows-ever-journaled incident).
const sqlTag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  executed.push({ text, values });
  if (insertFails) throw new Error('relation does not exist');
  if (text.startsWith('INSERT INTO harness_shared.memory_write_journal')) {
    return [{ id: 'journal-row-1' }];
  }
  if (text.includes('FROM harness_shared.memory_write_journal') && text.includes("status = 'pending'") && text.includes('FOR UPDATE')) {
    return pendingRows;
  }
  return [];
};

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlTag }) }));

const backend = {
  available: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['new-mem-1'], storedEvents: 1 })),
  update: vi.fn(async () => {}),
  search: vi.fn(async () => [] as Array<{ id: string; score?: number }>),
};
vi.mock('./backend', () => ({ getMemoryBackend: () => backend }));

import { journalPendingWrite, markJournalCommitted, drainMemoryWriteJournal } from './write-journal';

const baseRow = {
  id: 'row-1', requested_at: '2026-07-10T20:00:00Z', scope: 'userA', kind: 'project',
  content: 'the fact', metadata: { scope: 'user' }, verbatim: true, attempts: 0,
};

beforeEach(() => {
  executed.length = 0;
  pendingRows = [];
  insertFails = false;
  backend.available.mockClear().mockResolvedValue({ ok: true });
  backend.remember.mockClear().mockResolvedValue({ ids: ['new-mem-1'], storedEvents: 1 });
  backend.update.mockClear().mockResolvedValue(undefined);
  backend.search.mockClear().mockResolvedValue([]);
});

describe('journalPendingWrite / markJournalCommitted', () => {
  it('INSERTs the write-ahead row and returns its id', async () => {
    const id = await journalPendingWrite({ scope: 'userA', content: 'fact', kind: 'project' });
    expect(id).toBe('journal-row-1');
    expect(executed[0].text).toContain('INSERT INTO harness_shared.memory_write_journal');
    expect(executed[0].values).toContain('userA');
  });

  it('binds metadata as a JSON string cast ::text::jsonb — never an object parameter', async () => {
    const id = await journalPendingWrite({
      scope: 'userA', content: 'fact', metadata: { a: 1, nested: { b: 'x' } },
    });
    expect(id).toBe('journal-row-1');
    expect(executed[0].text).toContain('::text::jsonb');
    expect(executed[0].values).toContain(JSON.stringify({ a: 1, nested: { b: 'x' } }));
    // every bound value must be a primitive/null — an object here reproduces the
    // prepare:false mis-bind that skipped journaling on every production write
    for (const v of executed[0].values) {
      expect(typeof v === 'object' && v !== null).toBe(false);
    }
  });

  it('degrades to null (never throws) when the journal table is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      insertFails = true;
      await expect(journalPendingWrite({ scope: 'u', content: 'x' })).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('markJournalCommitted closes only pending rows, and never throws', async () => {
    await markJournalCommitted('row-1', 'mem-9');
    expect(executed[0].text).toContain("SET status = 'committed'");
    expect(executed[0].text).toContain("status = 'pending'");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      insertFails = true;
      await expect(markJournalCommitted('row-1')).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('drainMemoryWriteJournal', () => {
  it('no pending rows → early return, backend never touched', async () => {
    const r = await drainMemoryWriteJournal();
    expect(r.scanned).toBe(0);
    expect(backend.available).not.toHaveBeenCalled();
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('backend still unavailable → rows left untouched (no attempt burned)', async () => {
    pendingRows = [{ ...baseRow }];
    backend.available.mockResolvedValue({ ok: false, reason: 'embedder down' });
    const r = await drainMemoryWriteJournal();
    expect(r.stillPending).toBe(1);
    expect(backend.remember).not.toHaveBeenCalled();
    // no UPDATE was issued — attempts only count real replay failures
    expect(executed.filter((e) => e.text.startsWith('UPDATE'))).toHaveLength(0);
  });

  it('replays a pending remember with recovered_from provenance and commits', async () => {
    pendingRows = [{ ...baseRow }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.remember).toHaveBeenCalledTimes(1);
    const [content, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(content).toBe('the fact');
    expect((opts.metadata as Record<string, unknown>).recovered_from).toBe('journal');
    expect((opts.metadata as Record<string, unknown>).recovered_journal_id).toBe('row-1');
    const commit = executed.find((e) => e.text.includes("SET status = 'committed'"));
    expect(commit?.values).toContain('new-mem-1');
    expect(r.recoveredWindow).toEqual({ from: baseRow.requested_at, to: baseRow.requested_at });
  });

  it('P-004 near-dup guard: an unmistakable duplicate closes the row without re-writing', async () => {
    pendingRows = [{ ...baseRow }];
    backend.search.mockResolvedValue([{ id: 'existing-1', score: 0.95 }]);
    const r = await drainMemoryWriteJournal();
    expect(r.deduped).toBe(1);
    expect(r.recovered).toBe(0);
    expect(backend.remember).not.toHaveBeenCalled();
    const commit = executed.find((e) => e.text.includes('deduped_on_drain'));
    expect(commit?.values).toContain('existing-1');
  });

  it('a borderline match (below 0.9) errs toward recovering the fact', async () => {
    pendingRows = [{ ...baseRow }];
    backend.search.mockResolvedValue([{ id: 'existing-1', score: 0.85 }]);
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.remember).toHaveBeenCalledTimes(1);
  });

  it('replays a journaled text UPDATE via backend.update (never as a new add)', async () => {
    pendingRows = [{
      ...baseRow, id: 'row-u', scope: '__update__:mem-7',
      metadata: { __journal_update_of: 'mem-7' }, content: 'edited text',
    }];
    const r = await drainMemoryWriteJournal();
    expect(r.recovered).toBe(1);
    expect(backend.update).toHaveBeenCalledWith('mem-7', { text: 'edited text' });
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('a replay failure bumps attempts and keeps the row pending; the cap parks it failed_permanent', async () => {
    pendingRows = [{ ...baseRow }];
    backend.remember.mockRejectedValue(new Error('still down'));
    let r = await drainMemoryWriteJournal();
    expect(r.stillPending).toBe(1);
    let upd = executed.find((e) => e.text.startsWith('UPDATE'));
    expect(upd?.values).toContain('pending');

    executed.length = 0;
    pendingRows = [{ ...baseRow, attempts: 29 }]; // MAX_ATTEMPTS default 30
    r = await drainMemoryWriteJournal();
    expect(r.retriesExhausted).toBe(1);
    upd = executed.find((e) => e.text.startsWith('UPDATE'));
    expect(upd?.values).toContain('failed_permanent');
  });
});
