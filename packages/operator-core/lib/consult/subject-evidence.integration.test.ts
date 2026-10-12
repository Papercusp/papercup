import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupByMcpName, listAllProjectedTools } from '@papercusp/tooldef';
import { _resetForTests } from '@papercusp/db-org';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { orgTemplateKey, provisionOrgTemplate } from '../../test/_org-test-db';
import { flushFallbackObservations } from '../degradation/fallback-observations';
import { buildSidecarAwareReranker, resolveProcessSidecarUrl } from '../memory/embed-sidecar-wiring';
import { isEmbedSidecarRunning, readEmbedSidecarRecord, stopEmbedSidecar } from '../memory/embed-sidecar-spawn';
import { scoreSubjectEvidence, SUBJECT_EVIDENCE_MIN_SCORE } from './relevance-router';
import { evaluateSubjectCases, HELD_OUT_SUBJECT_CASES } from './subject-evidence.fixtures';
import '../agent-tools/index';

describe('registered subject evidence with the real local scorer', () => {
  let configuredPrivateWarmup = false;
  let privateHome: string | undefined;
  let privateDb: MigratedTestDb | undefined;
  const savedHome = process.env.PAPERCUSP_HOME;
  const savedPort = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
  const databaseEnvKeys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL',
    'DATABASE_URL', 'PAPERCUSP_PGBOUNCER', 'PAPERCUSP_SKIP_PG_DISCOVERY'] as const;
  const savedDatabaseEnv = databaseEnvKeys.map(key => [key, process.env[key]] as const);
  beforeAll(async () => {
    // A scorer-only test owns its lazily spawned sidecar. The default Gemma
    // startup is unrelated to this fixture and can overlap the first bounded
    // measurements. Reuse the maintained reranker-only warm profile; explicit
    // shared-sidecar URLs and caller-selected profiles retain their settings.
    if (process.env.PAPERCUSP_EMBED_SIDECAR === '1' &&
        !process.env.PAPERCUSP_EMBED_SIDECAR_URL) {
      // This test changes the product DB URL so its spawned sidecar cannot
      // escape into the live/native database. Retire any process-wide pools
      // created during module setup before changing that target.
      await _resetForTests();
      // No explicit URL does not imply a private scorer: the spawner otherwise
      // adopts a sibling from the tenant's home or its inherited fixed port.
      // Reuse its maintained tenant boundary so this run executes source code.
      privateHome = mkdtempSync(join(tmpdir(), 'subject-scorer-'));
      process.env.PAPERCUSP_HOME = privateHome;
      delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
      // The non-Vitest child opens the admission governor's real PG pool.
      // An ambient explicit DSN outranks the wrapper's private port, so pin
      // every product resolver to an owned, fully migrated database instead.
      privateDb = await createFreshTestDb({ prefix: 'subjectscorer', template: {
        key: orgTemplateKey(), provision: provisionOrgTemplate,
      } });
      process.env.HARNESS_ADMIN_DATABASE_URL = privateDb.url;
      process.env.HARNESS_DATABASE_URL = privateDb.url;
      process.env.DATABASE_URL = privateDb.url;
      process.env.PAPERCUSP_PGBOUNCER = '0';
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      if (process.env.PAPERCUSP_EMBED_SIDECAR_WARM === undefined) {
        process.env.PAPERCUSP_EMBED_SIDECAR_WARM = 'rerank';
        configuredPrivateWarmup = true;
      }
    }
  }, 120_000);
  afterAll(async () => {
    if (privateHome) {
      try {
        await stopEmbedSidecar();
      } finally {
        try {
          // Fallback observations are deferred on a timer. Flush them while
          // their private DB still exists, then clear its pools before restoring
          // the process environment so no later flush rebinds or targets a
          // dropped test database.
          await flushFallbackObservations();
        } finally {
          try {
            await _resetForTests();
          } finally {
            try {
              await privateDb?.drop();
            } finally {
              for (const [key, value] of savedDatabaseEnv) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
              if (savedHome === undefined) delete process.env.PAPERCUSP_HOME;
              else process.env.PAPERCUSP_HOME = savedHome;
              if (savedPort === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
              else process.env.PAPERCUSP_EMBED_SIDECAR_PORT = savedPort;
              if (configuredPrivateWarmup) delete process.env.PAPERCUSP_EMBED_SIDECAR_WARM;
              rmSync(privateHome, { recursive: true, force: true });
            }
          }
        }
      }
    }
    if (configuredPrivateWarmup) delete process.env.PAPERCUSP_EMBED_SIDECAR_WARM;
  });

  it('measures labelled held-out top choice, recall and explicit no-expert outcomes', async () => {
    for (const name of ['computer:provision_desktop', 'computer:observe', 'db:migrate']) {
      expect(lookupByMcpName(name)?.description).toBeTruthy();
    }
    expect(listAllProjectedTools().length).toBeGreaterThan(100);
    const url = await resolveProcessSidecarUrl(undefined, ['POST /rerank']);
    const health = url ? await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).json() : null;
    const runtime = { endpoint: url, engine: url ? 'sidecar' : 'in-process',
      warmProfile: process.env.PAPERCUSP_EMBED_SIDECAR_WARM ?? 'default',
      build: health?.sha ?? null, modelState: health?.models?.rerank ?? null,
      execution: health?.rerankExecutionHealth?.active ?? null };
    console.info('subject-scorer-preflight', JSON.stringify(runtime));
    if (privateHome) {
      // Fail before measurements if a shared/installed runtime was adopted.
      expect(isEmbedSidecarRunning(), 'owned scorer must be spawned by this test').toBe(true);
      const record = readEmbedSidecarRecord();
      expect(record?.port, 'owned launch record must name the serving endpoint').toBe(Number(new URL(url!).port));
      expect(Number.isInteger(health?.pid)).toBe(true);
      if (process.platform === 'linux') {
        // Source launches use npx -> tsx -> node; the record names npx,
        // while health names node. Verify the actual ancestry, not PID equality.
        const ancestry: number[] = [];
        let pid = health.pid as number;
        for (let depth = 0; depth < 8 && pid > 1; depth++) {
          ancestry.push(pid);
          if (pid === record?.pid) break;
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          pid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
        }
        console.info('subject-scorer-ownership', JSON.stringify({ launchPid: record?.pid, ancestry }));
        expect(ancestry, 'serving scorer must descend from the owned launch').toContain(record?.pid);
      }
      expect(privateDb?.name).toMatch(/^subjectscorer_/);
      expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(privateDb?.url);
    }
    const failures: { contracts: string[]; reason: string }[] = [];
    const baseScorer = await buildSidecarAwareReranker();
    const scorer: typeof baseScorer = async (query, contracts, opts) => {
      try {
        const scores = await baseScorer(query, contracts, opts);
        console.info('subject-contract-scores', JSON.stringify({ contracts: contracts.map(c => c.split('\n')[0]), scores }));
        return scores;
      } catch (error) {
        const failure = { contracts: contracts.map(c => c.split('\n')[0]),
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' };
        failures.push(failure);
        console.info('subject-contract-unavailable', JSON.stringify(failure));
        throw error;
      }
    };
    // Cold model construction is an evaluation prerequisite, not time granted
    // to production qualification. Every measured scenario retains its 4s cap.
    const warmStart = Date.now();
    await scorer('SQL migration file', ['Apply a numbered PostgreSQL DDL transaction.'], { deadline: Date.now() + 15_000 });
    console.info('subject-scorer-ready', JSON.stringify({ warmupMs: Date.now() - warmStart }));
    const measurements = [];
    for (const scenario of HELD_OUT_SUBJECT_CASES) {
      const scores = await scoreSubjectEvidence(scenario.subject, scenario.passages.map(p => p.text), Date.now() + 4000, { scorer });
      measurements.push({ id: scenario.id, scores });
    }
    // Persisted in the normal Vitest evidence; labels and full population are
    // independent of score/ranking. Empty-truth cases are assessed separately,
    // rather than misreading the shared evaluator's null recall as zero.
    const { cases: measured, summary } = evaluateSubjectCases(measurements, SUBJECT_EVIDENCE_MIN_SCORE);
    console.info('subject-held-out-metrics', JSON.stringify(measured));
    console.info('subject-held-out-summary', JSON.stringify(summary));
    const positives = measured.filter(r => r.relevant.length);
    const negatives = measured.filter(r => !r.relevant.length);
    expect(summary.unavailable, `all labelled measurements must be available: ${JSON.stringify({ runtime, failures })}`).toBe(0);
    expect(positives[0].selected[0]).toBe('display-repair');
    expect(negatives[0].selected).toEqual([]);
    expect(summary.topChoicePrecision).toBeGreaterThanOrEqual(2 / 3);
    expect(summary.recallAt1).toBeGreaterThanOrEqual(2 / 3);
    expect(summary.falseExpertSelections, 'irrelevant alternatives must not enter the responder menu').toBe(0);
    expect(negatives.filter(r => r.selected.length)).toEqual([]);
  }, 60_000);
});
