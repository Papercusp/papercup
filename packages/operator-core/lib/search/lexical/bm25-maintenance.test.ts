/**
 * Pure parts of the BM25 maintenance RECLAIM step (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * decision D-010): reading segment totals out of `bm25_summarize_index`, the live-bytes estimate the
 * bloat ratio divides by, and the report line.
 */
import { describe, expect, it, vi } from 'vitest';
const dedicated = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ createDedicatedOrgPg: dedicated.create }));
import {
  estimateBm25LiveBytes,
  formatBm25MaintenanceReport,
  orderBuildCandidates,
  parseBm25SegmentTotals,
  runBm25Maintenance,
  runOrgBm25Maintenance,
  tryAcquireBackupRendezvous,
  type Bm25MaintenanceReport,
} from './bm25-maintenance';

describe('production maintenance connection lifetime', () => {
  it('uses a dedicated session-affine connection and closes it on an engine skip', async () => {
    const sql = Object.assign(vi.fn().mockResolvedValue([{ corpus_index: null, outcome: 'skipped:library-not-preloaded' }]), {
      end: vi.fn().mockResolvedValue(undefined),
    });
    dedicated.create.mockReturnValue({ sql });
    expect((await runOrgBm25Maintenance()).engineSkipped).toBe('skipped:library-not-preloaded');
    expect(dedicated.create).toHaveBeenLastCalledWith('bm25-maintenance', { max: 1, sessionAffinity: true });
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('closes the dedicated client when the database step fails', async () => {
    const sql = Object.assign(vi.fn().mockRejectedValue(new Error('ensure refused')), {
      end: vi.fn().mockResolvedValue(undefined),
    });
    dedicated.create.mockReturnValue({ sql });
    expect((await runOrgBm25Maintenance()).errors).toEqual(['ensure: ensure refused']);
    expect(sql.end).toHaveBeenCalledOnce();
  });
});

describe('host-backup rendezvous admission', () => {
  it('reports a busy host backup without waiting for its advisory lock', async () => {
    const conn = vi.fn().mockResolvedValue([{ locked: false }]);
    await expect(tryAcquireBackupRendezvous(conn as never)).resolves.toBe(false);
    expect(conn).toHaveBeenCalledOnce();
  });

  it('defers a concurrent BM25 build before issuing DDL while the host dump owns the rendezvous', async () => {
    const render = (strings: TemplateStringsArray, values: unknown[]) =>
      strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');
    const connCalls: string[] = [];
    const conn = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        connCalls.push(query);
        if (query.includes('pg_try_advisory_lock')) {
          return [{ locked: query.includes('bm25-maintenance:concurrent-ddl') }];
        }
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connCalls.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        if (query.includes('bm25_ensure_indexes')) {
          return [{ corpus_index: 'work_items_bm25', outcome: 'deferred:build-concurrently' }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );

    const report = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    expect(report.built).toBeNull();
    expect(report.pendingBuilds).toContain('work_items_bm25');
    expect(connCalls.some(query => /(?:CREATE|DROP|REINDEX)\s+INDEX/i.test(query))).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });
});

describe('invalid-index rebuild vacuum admission', () => {
  const render = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');

  it('defers an invalid-index drop before taking the backup rendezvous when its table has an active vacuum', async () => {
    const connectionStatements: string[] = [];
    const conn = Object.assign(
      vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof strings === 'string') return strings;
        const query = render(strings, values);
        connectionStatements.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('FROM pg_index')) return [{ valid: false, vacuum_pid: 3647428 }];
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connectionStatements.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        if (query.includes('bm25_ensure_indexes')) {
          return [{ corpus_index: 'session_turns_bm25', outcome: 'invalid' }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );

    const report = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    expect(report.pendingBuilds).toContain('session_turns_bm25');
    expect(report.rebuiltInvalid).toBe(false);
    expect(report.errors).toEqual([]);
    expect(connectionStatements.some(query => query.includes('pg_stat_progress_vacuum'))).toBe(true);
    expect(connectionStatements.filter(query => query.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(connectionStatements.some(query => query.includes('DROP INDEX CONCURRENTLY'))).toBe(false);
    expect(connectionStatements.some(query => query.includes('bm25_index_ddl'))).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('defers an invalid-index drop on the short lock-timeout race after preflight', async () => {
    const connectionStatements: string[] = [];
    const conn = Object.assign(
      vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof strings === 'string') return strings;
        const query = render(strings, values);
        connectionStatements.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('FROM pg_index')) return [{ valid: false, vacuum_pid: null }];
        if (query.includes('DROP INDEX CONCURRENTLY')) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connectionStatements.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        if (query.includes('bm25_ensure_indexes')) {
          return [{ corpus_index: 'session_turns_bm25', outcome: 'invalid' }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );

    const report = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    const shortTimeout = connectionStatements.findIndex(query => query === "SET lock_timeout = '15s'");
    const drop = connectionStatements.findIndex(query => query.includes('DROP INDEX CONCURRENTLY'));
    expect(shortTimeout).toBeGreaterThanOrEqual(0);
    expect(shortTimeout).toBeLessThan(drop);
    expect(report.pendingBuilds).toContain('session_turns_bm25');
    expect(report.rebuiltInvalid).toBe(false);
    expect(report.built).toBeNull();
    expect(report.errors).toEqual([]);
    expect(connectionStatements.some(query => query.includes('bm25_index_ddl'))).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('restores the long lock timeout for CREATE after an invalid-index drop succeeds', async () => {
    const connectionStatements: string[] = [];
    const conn = Object.assign(
      vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof strings === 'string') return strings;
        const query = render(strings, values);
        connectionStatements.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('FROM pg_index')) return [{ valid: false, vacuum_pid: null }];
        if (query.includes('bm25_index_ddl')) return [{ ddl: 'CREATE INDEX CONCURRENTLY session_turns_bm25' }];
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connectionStatements.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        if (query.includes('bm25_ensure_indexes')) {
          return [{ corpus_index: 'session_turns_bm25', outcome: 'invalid' }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );

    const report = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    const shortTimeout = connectionStatements.findIndex(query => query === "SET lock_timeout = '15s'");
    const drop = connectionStatements.findIndex(query => query.includes('DROP INDEX CONCURRENTLY'));
    const longTimeout = connectionStatements.findIndex(query => query === "SET lock_timeout = '4h'");
    const create = connectionStatements.findIndex(query => query.includes('CREATE INDEX CONCURRENTLY session_turns_bm25'));
    expect(shortTimeout).toBeGreaterThanOrEqual(0);
    expect(shortTimeout).toBeLessThan(drop);
    expect(drop).toBeLessThan(longTimeout);
    expect(longTimeout).toBeLessThan(create);
    expect(report.built).toBe('session_turns_bm25');
    expect(report.rebuiltInvalid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(conn.release).toHaveBeenCalledOnce();
  });
});

describe('orderBuildCandidates', () => {
  it('tries never-attempted builds before indexes whose earlier build died, so one failing index cannot starve the rest', () => {
    const ordered = orderBuildCandidates([
      { corpusIndex: 'work_items_bm25', outcome: 'invalid' },
      { corpusIndex: 'harness_plans_bm25', outcome: 'present' },
      { corpusIndex: 'session_turns_bm25', outcome: 'deferred:build-concurrently' },
      { corpusIndex: 'carry_notes_bm25', outcome: 'invalid' },
      { corpusIndex: 'coord_thread_posts_bm25', outcome: 'deferred:build-concurrently' },
      { corpusIndex: null, outcome: 'deferred:build-concurrently' },
    ]);
    expect(ordered.map(r => r.corpusIndex)).toEqual([
      'session_turns_bm25',
      'coord_thread_posts_bm25',
      'work_items_bm25',
      'carry_notes_bm25',
    ]);
  });

  it('still retries an invalid index once nothing else is waiting', () => {
    expect(orderBuildCandidates([{ corpusIndex: 'work_items_bm25', outcome: 'invalid' }]).map(r => r.corpusIndex))
      .toEqual(['work_items_bm25']);
  });
});

describe('orphan rebuild cleanup', () => {
  const render = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');

  it('defers orphan drops for a relation with an active vacuum before reserving the DDL lock', async () => {
    const statements: string[] = [];
    const reserve = vi.fn();
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        statements.push(query);
        if (query.includes('bm25_ensure_indexes')) return [];
        if (query.includes('FROM pg_index')) {
          return [{
            name: 'session_turns_bm25_ccnew',
            relation: 'harness_shared.session_turns',
            vacuum_pid: 3647428,
          }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve },
    );

    const result = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    expect(result.deferredOrphanDrops).toEqual([{
      index: 'harness_shared.session_turns_bm25_ccnew',
      relation: 'harness_shared.session_turns',
      reason: 'active-vacuum',
      vacuumPid: 3647428,
    }]);
    expect(reserve).not.toHaveBeenCalled();
    expect(statements.some(query => query.includes('DROP INDEX CONCURRENTLY'))).toBe(false);
  });

  it('uses a short lock timeout and records a retryable deferral if a vacuum starts after preflight', async () => {
    const sqlStatements: string[] = [];
    const connectionStatements: string[] = [];
    const conn = Object.assign(
      vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof strings === 'string') return strings;
        const query = render(strings, values);
        connectionStatements.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('DROP INDEX CONCURRENTLY')) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connectionStatements.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        sqlStatements.push(query);
        if (query.includes('bm25_ensure_indexes')) return [];
        if (query.includes('FROM pg_index')) {
          return [{
            name: 'session_turns_bm25_ccnew',
            relation: 'harness_shared.session_turns',
            vacuum_pid: null,
          }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );

    const result = await runBm25Maintenance(sql as never, { maxCompactionSteps: 0 });

    expect(connectionStatements).toContain("SET lock_timeout = '15s'");
    expect(result.deferredOrphanDrops).toEqual([{
      index: 'harness_shared.session_turns_bm25_ccnew',
      relation: 'harness_shared.session_turns',
      reason: 'lock-timeout',
    }]);
    expect(result.errors).toEqual([]);
    expect(conn.release).toHaveBeenCalledOnce();
    expect(sqlStatements.some(query => query.includes('pg_stat_progress_vacuum'))).toBe(true);
  });
});

describe('bloated-index reclaim vacuum admission', () => {
  const render = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');

  function fixture(options: { vacuumPid?: number; dropSqlState?: string; afterBytes?: number } = {}) {
    const connectionStatements: string[] = [];
    const conn = Object.assign(
      vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
        const query = typeof strings === 'string' ? strings : render(strings, values);
        connectionStatements.push(query);
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('pg_stat_progress_vacuum')) {
          return options.vacuumPid === undefined ? [] : [{ pid: options.vacuumPid }];
        }
        if (query.includes('DROP INDEX CONCURRENTLY') && options.dropSqlState) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: options.dropSqlState });
        }
        if (query.includes('pg_relation_size')) return [{ bytes: String(options.afterBytes ?? 50_000_000) }];
        return [];
      }),
      {
        unsafe: vi.fn(async (query: string) => {
          connectionStatements.push(query);
          return [];
        }),
        release: vi.fn(),
      },
    );
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = render(strings, values);
        if (query.includes('bm25_ensure_indexes')) {
          return [{ corpus_index: 'work_items_bm25', outcome: 'present' }];
        }
        if (query.includes('to_regprocedure')) return [{ defined: false }];
        if (query.includes('pg_relation_size(c.oid)')) {
          return [{ name: 'work_items_bm25', bytes: '100000000' }];
        }
        if (query.includes('bm25_summarize_index')) {
          return [{ summary: 'Total: 1 segment, 100 pages (0.8MB), 100 terms, 100 docs (alive=100, dead=0)' }];
        }
        if (query.includes("a.amname = 'bm25'")) return [{ name: 'work_items_bm25' }];
        if (query.includes('bm25_needs_compaction')) return [{ needs: false }];
        return [];
      }),
      { reserve: vi.fn().mockResolvedValue(conn) },
    );
    return { sql, conn, connectionStatements };
  }

  it('defers an actively vacuumed base relation before taking the backup rendezvous', async () => {
    const { sql, conn, connectionStatements } = fixture({ vacuumPid: 3647428 });

    const report = await runBm25Maintenance(sql as never, {
      maxCompactionSteps: 0,
      maxBloatRatio: 1,
      reclaimMinBytes: 1,
    });

    expect(report.pendingReclaims).toContain('harness_shared.work_items_bm25');
    expect(report.errors).toEqual([]);
    expect(connectionStatements.some(query => query.includes('pg_stat_progress_vacuum'))).toBe(true);
    expect(connectionStatements.filter(query => query.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(connectionStatements.some(query => query.includes('DROP INDEX CONCURRENTLY'))).toBe(false);
    expect(connectionStatements.some(query => query.includes('REINDEX INDEX CONCURRENTLY'))).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('defers the reclaim when the transient _ccnew drop races with a lock timeout', async () => {
    const { sql, conn, connectionStatements } = fixture({ dropSqlState: '55P03' });

    const report = await runBm25Maintenance(sql as never, {
      maxCompactionSteps: 0,
      maxBloatRatio: 1,
      reclaimMinBytes: 1,
    });

    const shortTimeout = connectionStatements.indexOf("SET lock_timeout = '15s'");
    const drop = connectionStatements.findIndex(query => query.includes('DROP INDEX CONCURRENTLY'));
    expect(shortTimeout).toBeGreaterThanOrEqual(0);
    expect(shortTimeout).toBeLessThan(drop);
    expect(report.pendingReclaims).toContain('harness_shared.work_items_bm25');
    expect(report.errors).toEqual([]);
    expect(connectionStatements.some(query => query === "SET lock_timeout = '4h'")).toBe(false);
    expect(connectionStatements.some(query => query.includes('REINDEX INDEX CONCURRENTLY'))).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('restores the four-hour lock timeout after _ccnew cleanup and before REINDEX', async () => {
    const { sql, connectionStatements } = fixture({ afterBytes: 40_000_000 });

    const report = await runBm25Maintenance(sql as never, {
      maxCompactionSteps: 0,
      maxBloatRatio: 1,
      reclaimMinBytes: 1,
    });

    const shortTimeout = connectionStatements.indexOf("SET lock_timeout = '15s'");
    const drop = connectionStatements.findIndex(query => query.includes('DROP INDEX CONCURRENTLY'));
    const longTimeout = connectionStatements.indexOf("SET lock_timeout = '4h'");
    const reindex = connectionStatements.findIndex(query => query.includes('REINDEX INDEX CONCURRENTLY'));
    expect(shortTimeout).toBeGreaterThanOrEqual(0);
    expect(shortTimeout).toBeLessThan(drop);
    expect(drop).toBeLessThan(longTimeout);
    expect(longTimeout).toBeLessThan(reindex);
    expect(report.reclaimed?.index).toBe('harness_shared.work_items_bm25');
    expect(report.reclaimed?.afterBytes).toBe(40_000_000);
    expect(report.pendingReclaims).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});

// Verbatim output of bm25_summarize_index on pg_textsearch 1.5.1 (scratch probe, 2026-10-11).
const SUMMARY_WITH_DEAD = `Index: t_bm25

Corpus Statistics:
  total_docs: 31372
  total_len: 254469

Segments:
  L0 Segment 1: block=998, pages=35, size=0.3MB, terms=3430, docs=1506
  L0 Segment 6: block=1, pages=335, size=2.6MB, terms=32364, docs=17143 (alive=13714, dead=3429)
  Total: 6 segments, 740 pages (5.8MB), 72780 terms, 31372 docs (alive=26143, dead=5229)

Index Size:
  on-disk: 8470528 bytes
`;

const SUMMARY_NO_DEAD = `Segments:
  L0 Segment 1: block=1, pages=335, size=2.6MB, terms=32364, docs=17143
  Total: 1 segments, 335 pages (2.6MB), 32364 terms, 17143 docs
`;

// Actual empty event_key_registry_bm25 output on pg_textsearch 1.5.1 (2026-10-12).
const SUMMARY_EMPTY = `Index: harness_shared.event_key_registry_bm25

Corpus Statistics:
  total_docs: 0
  total_len: 0
  docs_persisted: 0
  len_persisted: 0

Memtable:
  terms: 0
  documents: 0

Segments:
  (none)

Index Size:
  on-disk: 8192 bytes
`;

function report(over: Partial<Bm25MaintenanceReport> = {}): Bm25MaintenanceReport {
  return {
    ensure: [],
    engineSkipped: null,
    built: null,
    rebuiltInvalid: false,
    droppedOrphans: [],
    deferredOrphanDrops: [],
    pendingBuilds: [],
    compacted: [],
    reclaimed: null,
    pendingReclaims: [],
    retired: [],
    errors: [],
    ...over,
  };
}

describe('parseBm25SegmentTotals', () => {
  it('reads segments, pages, docs and the alive count from the Total line', () => {
    expect(parseBm25SegmentTotals(SUMMARY_WITH_DEAD)).toEqual({ segments: 6, pages: 740, docs: 31372, alive: 26143 });
  });

  it('treats every doc as alive when the Total line has no alive/dead part', () => {
    expect(parseBm25SegmentTotals(SUMMARY_NO_DEAD)).toEqual({ segments: 1, pages: 335, docs: 17143, alive: 17143 });
  });

  it('recognises the explicit zero-persisted-segment representation instead of reporting a healthy empty index as unreadable', () => {
    const zero = { segments: 0, pages: 0, docs: 0, alive: 0 };
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY)).toEqual(zero);
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.replaceAll('\n', '\r\n'))).toEqual(zero);
    expect(estimateBm25LiveBytes(parseBm25SegmentTotals(SUMMARY_EMPTY)!)).toBe(0);
  });

  it('keeps in-memory documents separate from persisted segment totals', () => {
    const memtableOnly = SUMMARY_EMPTY.replace('total_docs: 0', 'total_docs: 3').replace('documents: 0', 'documents: 3');
    expect(parseBm25SegmentTotals(memtableOnly)).toEqual({ segments: 0, pages: 0, docs: 0, alive: 0 });
  });

  it('rejects contradictory or incomplete empty summaries', () => {
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.replace('docs_persisted: 0', 'docs_persisted: 1'))).toBeNull();
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.replace('  docs_persisted: 0\n', ''))).toBeNull();
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.replace('  (none)', '  unknown format'))).toBeNull();
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.replace('  (none)', '  (none)\n  L0 Segment 1: pages=1, docs=1'))).toBeNull();
    expect(parseBm25SegmentTotals(SUMMARY_EMPTY.split('Index Size:')[0]!)).toBeNull();
  });

  it('never reads a per-segment line as the total', () => {
    const segmentsOnly = SUMMARY_WITH_DEAD.split('\n').filter(l => !l.includes('Total:')).join('\n');
    expect(parseBm25SegmentTotals(segmentsOnly)).toBeNull();
  });

  it('returns null for output it does not recognise', () => {
    expect(parseBm25SegmentTotals('')).toBeNull();
    expect(parseBm25SegmentTotals('Segments:\n  (none)\n')).toBeNull();
  });
});

describe('estimateBm25LiveBytes', () => {
  it('scales data pages by the alive share and counts whole pages plus mandatory metadata', () => {
    const t = { segments: 6, pages: 740, docs: 31372, alive: 26143 };
    expect(estimateBm25LiveBytes(t)).toBe((Math.ceil(740 * (26143 / 31372)) + 2) * 8192);
  });

  it('keeps the fresh one-page segment floor and additional page-map blocks', () => {
    expect(estimateBm25LiveBytes({ segments: 1, pages: 1, docs: 257, alive: 257 })).toBe(3 * 8192);
    expect(estimateBm25LiveBytes({ segments: 1, pages: 2039, docs: 5000, alive: 5000 })).toBe(2042 * 8192);
  });

  it('is zero for an index with no docs', () => {
    expect(estimateBm25LiveBytes({ segments: 0, pages: 0, docs: 0, alive: 0 })).toBe(0);
  });
});

describe('formatBm25MaintenanceReport', () => {
  it('is quiet when nothing happened', () => {
    expect(formatBm25MaintenanceReport(report())).toBeNull();
  });

  it('names every dropped REINDEX leftover', () => {
    expect(formatBm25MaintenanceReport(report({
      droppedOrphans: ['harness_shared.carry_notes_bm25_ccnew', 'harness_shared.work_items_bm25_ccold1'],
    }))).toBe('[bm25-maintenance] dropped orphan harness_shared.carry_notes_bm25_ccnew,harness_shared.work_items_bm25_ccold1');
  });

  it('reports orphan cleanup deferred by an active vacuum', () => {
    expect(formatBm25MaintenanceReport(report({
      deferredOrphanDrops: [{
        index: 'harness_shared.session_turns_bm25_ccnew',
        relation: 'harness_shared.session_turns',
        reason: 'active-vacuum',
        vacuumPid: 3647428,
      }],
    }))).toBe(
      '[bm25-maintenance] orphan drop deferred harness_shared.session_turns_bm25_ccnew '
      + '(active vacuum on harness_shared.session_turns pid=3647428)',
    );
  });

  it('attaches the measured interval to a non-empty maintenance log line and keeps no-op runs quiet', () => {
    const interval = {
      startedAtMs: Date.parse('2026-10-12T01:00:00.000Z'),
      finishedAtMs: Date.parse('2026-10-12T01:00:01.250Z'),
      durationMs: 1_250,
    };
    expect(formatBm25MaintenanceReport(report({ built: 'work_items_bm25' }), interval)).toBe(
      '[bm25-maintenance] built work_items_bm25; startedAt=2026-10-12T01:00:00.000Z '
      + 'finishedAt=2026-10-12T01:00:01.250Z durationMs=1250',
    );
    expect(formatBm25MaintenanceReport(report(), interval)).toBeNull();
  });

  it('names a reclaimed index with its sizes and the ratio that triggered it, and pending reclaims', () => {
    const line = formatBm25MaintenanceReport(report({
      reclaimed: { index: 'harness_shared.work_items_bm25', beforeBytes: 11_362_304, afterBytes: 2_547_712, ratio: 4.46 },
      pendingReclaims: ['harness_shared.session_turns_bm25'],
    }));
    expect(line).toBe(
      '[bm25-maintenance] reclaimed harness_shared.work_items_bm25 10.8MB->2.4MB (was 4.46x live); '
      + 'reclaim pending harness_shared.session_turns_bm25',
    );
  });
});
