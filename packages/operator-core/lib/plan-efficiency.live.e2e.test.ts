import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, inject, it } from 'vitest';
import { readPlanPtoolReply } from '../test/plan-revision-ptool';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const profilePath = 'packages/operator-core/test/fixtures/plan-efficiency.live-profile.json';
type AuditRow = [number, string, number, string | null, string, boolean, boolean, string];
type EpisodeRow = [string, number, number, number | null];
type History = {
  scope: { workspace: string; harness: string; from: string; until: string };
  episodes: EpisodeRow[];
  source: { discovery: { plan_slug: string; record_count: number; records: AuditRow[] }[] };
};

const selected = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE === profilePath;
describe.skipIf(inject('papercuspTestLayer') !== 'e2e' || !selected)('live Plans efficiency reader', () => {
  it('retains the original unclosed November reopening and its unknown duration through the CLI', async () => {
    const { history }: { history: History } = JSON.parse(readFileSync(
      new URL('../test/fixtures/plan-revision-baseline.json', import.meta.url), 'utf8'));
    const { workspace, harness, from, until } = history.scope;
    expect(process.env.PAPERCUSP_TEST_RUN_WORKSPACE).toBe(workspace);
    const profile = JSON.parse(readFileSync(resolve(root, profilePath), 'utf8'));
    expect(profile).toMatchObject({ origin: 'http://127.0.0.1:3170', runtimeUnits: ['hono-host:3170'] });
    function read(verb: string, args: object) {
      return readPlanPtoolReply(execute(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
        verb, '--url=' + profile.origin, '--workspace=' + workspace, '--harness=' + harness, '--raw',
        '--json', JSON.stringify(args)], { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 }));
    }
    expect(process.env.PAPERCUSP_SID).toBeTruthy();
    expect(await read('coord:whoami', {})).toMatchObject({ workspaceId: workspace, ownerId: process.env.PAPERCUSP_SID });

    const unclosed = history.episodes.filter(([, , , restored]) => restored === null);
    expect(unclosed).toEqual([['main-greening-durable-continuation-2026-10-22', 26, 28, null]]);
    const slug = unclosed[0]![0];
    const groups = history.source.discovery.filter(group => group.plan_slug === slug);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.records).toHaveLength(group.record_count);
    const audits = new Map(group.records.map(([auditSeq, revisionId, revisionSeq, , observedAt, ready, changedInput, revisionHash]) =>
      [auditSeq, { auditSeq, revisionId, revisionSeq, revisionHash, observedAt, ready, changedInput }] as const));
    expect(audits.size).toBe(group.record_count);
    function audit(seq: number) {
      const row = audits.get(seq);
      if (!row) throw new Error(`Missing original discovery audit ${seq} for ${slug}`);
      return row;
    }
    const episodes = history.episodes.filter(([plan]) => plan === slug).map(([, prior, opened, restored]) => ({
      prior: audit(prior), opened: audit(opened), restored: restored === null ? null : audit(restored),
    }));
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ opened: { revisionId: '91494' }, restored: null });
    const closed = episodes[0]!;
    if (!closed.restored) throw new Error('The original closed comparison interval is missing');
    const measuredUnavailableMs = Date.parse(closed.restored.observedAt) - Date.parse(closed.opened.observedAt);

    const prefix = 'results[].efficiency.revisionMeasurement.';
    const args = { slug, harness, mode: 'meta', includeEnrichments: false,
      efficiency: { revisionWindow: { from, until } }, payloadTier: 'full',
      projection: { pick: ['results[].ok', 'results[].slug', 'results[].harness',
        ...['window', 'discoveryAudits', 'episodes', 'delay'].map(field => prefix + field)] } };
    const result = await read('plans:get', args);
    expect(result).toMatchObject({ ok: true, slug, harness, efficiency: { revisionMeasurement: {
      window: { from, until }, discoveryAudits: group.record_count, episodes,
      delay: { episodes: 2, measuredEpisodes: 1, measuredUnavailableMs, unavailableMs: null,
        soleBlockerMs: null, independentBlockerCoverage: 'unknown' },
    } } });
  }, 150_000);
});
