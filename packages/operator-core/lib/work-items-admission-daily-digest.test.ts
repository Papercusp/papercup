import { describe, expect, it, vi } from 'vitest';
import {
  buildDailyDigestPrompt,
  dailyDigestWatchdogKey,
  parseDailyDigestProposals,
  runWorkItemAdmissionDailyDigest,
  MIN_DAILY_DIGEST_COVERAGE,
  type DailyDigestContext,
} from './work-items-admission-daily-digest';
import { LEARNING_MODEL_SPEC } from './learning/model-policy';

const context: DailyDigestContext = {
  sourceBulkStageRunId: 'bulk-stage-1',
  sourceCensusRunId: 'census-1',
  censusAfter: 12,
  coverage: { live: 3, covered: 3, uncovered: 0, ratio: 1 },
  items: [
    {
      id: 'WI-1',
      title: 'Checkout command hangs',
      summary: 'The child exits while the checkout lock remains held.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
    {
      id: 'WI-2',
      title: 'Release queue stalls',
      summary: 'Promotion waits for the same orphaned checkout lock.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
    {
      id: 'WI-3',
      title: 'Sync misses deadline',
      summary: 'The worker cannot enter the checkout critical section.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
  ],
  shards: [{ shardId: 0, members: ['WI-1', 'WI-2', 'WI-3'], ghosts: [] }],
};

describe('work-item admission daily digest', () => {
  it('builds an explicit full-corpus prompt with read-only shard context', () => {
    const prompt = buildDailyDigestPrompt(context);
    expect(prompt.system).toContain('DAILY FULL-CORPUS CLUSTER DIGEST');
    expect(prompt.system).toContain('Only IDs present in the CORPUS ITEMS section');
    expect(prompt.user).toContain('Checkout command hangs');
    expect(prompt.user).toContain('census-1');
    expect(prompt.user).toContain('bulk-stage-1');
  });

  it('canonicalizes valid clusters and rejects unknown, overlapping, and undersized groups', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3', 'WI-4']);
    const proposal = {
      title: 'Orphaned checkout locks stall consumers',
      body: 'One dead child leaves a shared checkout lock held.',
      reason: 'Three independent consumers report the same lock boundary.',
      memberIds: ['WI-3', 'WI-1', 'WI-2'],
    };
    expect(parseDailyDigestProposals({ umbrellas: [proposal] }, allowed)[0]?.memberIds).toEqual([
      'WI-1',
      'WI-2',
      'WI-3',
    ]);
    expect(() => parseDailyDigestProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-2', 'WI-X'] }] }, allowed)).toThrow(
      'non-corpus member',
    );
    expect(() => parseDailyDigestProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-1', 'WI-2'] }] }, allowed)).toThrow(
      'needs 3 distinct members',
    );
    expect(() =>
      parseDailyDigestProposals(
        {
          umbrellas: [
            proposal,
            { ...proposal, title: 'Second cause', memberIds: ['WI-2', 'WI-3', 'WI-4'] },
          ],
        },
        allowed,
      ),
    ).toThrow('multiple umbrellas');
  });

  it('derives a stable normalized watchdog key', () => {
    expect(dailyDigestWatchdogKey('papercusp', 'Checkout lock leaked!')).toBe(
      dailyDigestWatchdogKey('papercusp', ' checkout  LOCK--leaked '),
    );
    expect(dailyDigestWatchdogKey('papercusp', 'Checkout lock leaked')).not.toBe(
      dailyDigestWatchdogKey('other', 'Checkout lock leaked'),
    );
  });

  it('records a blocked ledger row and never calls the model before a completed bulk stage', async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = [...strings].join(' ');
      statements.push(statement);
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) return [];
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'daily-blocked',
      now: () => Date.parse('2026-08-27T00:00:00Z'),
      sql,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'awaiting-completed-bulk-stage', modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("run_kind = 'daily-digest'"))).toBe(true);
  });

  /**
   * The ledger's model_id previously wrote LEARNING_MODEL_SPEC unconditionally while the
   * llmCall used the same constant, so there was no way to run the digest on a reachable
   * model when the policy model's accounts were usage-walled — and no way for the ledger
   * to disagree with reality either. These two cases pin ONE resolved value to BOTH sites.
   */
  function digestHarness(opts: { model?: string }) {
    const bound: Array<Record<string, unknown>> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = [...strings].join(' ');
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) {
        return [{ id: 'bulk-1', detail: { resultCensusRunId: 'census-1' } }];
      }
      if (statement.includes("run_kind = 'census'")) return [{ id: 'census-1', census_after: 3 }];
      if (statement.includes('FROM harness_shared.work_items')) {
        return context.items.map((item) => ({
          id: item.id, title: item.title, summary: item.summary,
          state: item.state, kind: item.kind, admission: item.admission,
        }));
      }
      if (statement.includes('dedup_shard_map')) {
        return context.items.map((item) => ({ shard_id: 0, item_id: item.id, role: 'member' }));
      }
      if (statement.includes('UPDATE harness_shared.admission_runs') && statement.includes('model_id =')) {
        bound.push({ statement, values });
      }
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn(async () => ({
      json: { umbrellas: [{ title: 'Orphaned checkout lock', body: 'One lock, three symptoms.', reason: 'shared mechanism', memberIds: ['WI-1', 'WI-2', 'WI-3'] }] },
      text: '', tokensIn: 11, tokensOut: 22,
    })) as unknown as Parameters<typeof runWorkItemAdmissionDailyDigest>[0]['llmCall'];
    return { sql, llmCall, bound };
  }

  it('defaults the model to the learning policy spec and records THAT id on the ledger', async () => {
    const { sql, llmCall, bound } = digestHarness({});
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId: 'daily-default',
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql, llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });
    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    const called = (llmCall as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { model: string };
    expect(called.model).toBe(LEARNING_MODEL_SPEC);
    // the SAME value must reach the ledger, not a re-read of the policy constant
    expect(bound.at(-1)?.values).toContain(LEARNING_MODEL_SPEC);
  });

  it('threads an explicit model override to BOTH the model call and the ledger model_id', async () => {
    const override = 'claude-opus-5:xhigh';
    const { sql, llmCall, bound } = digestHarness({});
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId: 'daily-override', model: override,
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql, llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });
    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    const called = (llmCall as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { model: string };
    expect(called.model).toBe(override);
    expect(bound.at(-1)?.values).toContain(override);
    // the regression this pins: the ledger must NOT name the policy model the run never used
    expect(bound.at(-1)?.values).not.toContain(LEARNING_MODEL_SPEC);
  });

  /**
   * D-028. The census shard map can never cover the live corpus EXACTLY on a live
   * workspace: a census takes ~510s while items arrive at ~8/min, so it is ~67 items
   * stale before it finishes. The old gate demanded exact coverage and therefore never
   * let a digest run at all — while already tolerating the opposite drift direction
   * (map entries whose item has left the corpus) one line above. These cases pin the
   * corrected asymmetry: arrivals are EXCLUDED and DISCLOSED above a floor, and the
   * invariants that actually protect the digest still hard-block.
   */
  function coverageHarness(opts: { corpusIds: string[]; memberIds: string[]; duplicateId?: string }) {
    const bound: Array<{ statement: string; values: unknown[] }> = [];
    const prompts: string[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = [...strings].join(' ');
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) return [{ id: 'bulk-1', detail: { resultCensusRunId: 'census-1' } }];
      if (statement.includes("run_kind = 'census'")) return [{ id: 'census-1', census_after: 3 }];
      if (statement.includes('FROM harness_shared.work_items')) {
        return opts.corpusIds.map((id) => ({
          id, title: `title ${id}`, summary: `summary ${id}`, state: 'open', kind: 'bug', admission: 'admitted',
        }));
      }
      if (statement.includes('dedup_shard_map')) {
        const rows = opts.memberIds.map((id) => ({ shard_id: 0, item_id: id, role: 'member' }));
        if (opts.duplicateId) rows.push({ shard_id: 1, item_id: opts.duplicateId, role: 'member' });
        return rows;
      }
      if (statement.includes('UPDATE harness_shared.admission_runs')) bound.push({ statement, values });
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn(async (call: { messages: Array<{ content: string }> }) => {
      prompts.push(call.messages.map((message) => message.content).join('\n'));
      return { json: { umbrellas: [] }, text: '', tokensIn: 5, tokensOut: 7 };
    }) as unknown as Parameters<typeof runWorkItemAdmissionDailyDigest>[0]['llmCall'];
    const detail = () => {
      const payload = bound.at(-1)?.values.find((value) => typeof value === 'string' && value.startsWith('{'));
      return JSON.parse(String(payload)) as Record<string, unknown>;
    };
    return { sql, llmCall, bound, prompts, detail };
  }

  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, index) => `WI-${index + from}`);

  const runCoverage = async (harness: ReturnType<typeof coverageHarness>, runId: string) =>
    runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId,
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql: harness.sql, llmCall: harness.llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });

  it('D-028: digests the covered subset when items arrived after the census, and discloses the gap', async () => {
    // 10 live, 9 in the map: WI-10 arrived after the census. 0.9 clears the floor.
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(9) });
    const result = await runCoverage(harness, 'daily-drift');

    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    expect(result.coverage).toEqual({ live: 10, covered: 9, uncovered: 1, ratio: 0.9 });
    // the arrival is EXCLUDED from what the model reasons over, not silently shardless
    expect(result.corpusSize).toBe(9);
    expect(harness.prompts[0]).toContain('WI-9');
    expect(harness.prompts[0]).not.toContain('WI-10');
    // and the drift is on the ledger row: disclosed partial coverage, never silent
    expect(harness.detail().coverage).toEqual({ live: 10, covered: 9, uncovered: 1, ratio: 0.9 });
  });

  it('D-028: still blocks below the coverage floor rather than digest a misleading sample', async () => {
    const covered = Math.floor(10 * MIN_DAILY_DIGEST_COVERAGE) - 1; // strictly under the floor
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(covered) });
    const result = await runCoverage(harness, 'daily-under-floor');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'census-coverage-mismatch', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
    // a blocked run still reports what it measured, so the block is diagnosable
    expect(result.coverage).toMatchObject({ live: 10, covered, uncovered: 10 - covered });
    expect(harness.detail().coverage).toMatchObject({ live: 10, covered });
  });

  it('D-028: duplicate member rows still hard-block — coverage tolerance never weakens the one-shard invariant', async () => {
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(10), duplicateId: 'WI-3' });
    const result = await runCoverage(harness, 'daily-duplicate');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'census-coverage-mismatch', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
  });

  it('D-028: an empty corpus still blocks as empty-corpus, never as a coverage mismatch', async () => {
    const harness = coverageHarness({ corpusIds: [], memberIds: [] });
    const result = await runCoverage(harness, 'daily-empty');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'empty-corpus', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
  });
});
