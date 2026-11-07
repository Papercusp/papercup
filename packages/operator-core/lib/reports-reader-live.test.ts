import { describe, expect, it } from 'vitest';
import { reportFullFixture } from '../../../apps/operator-vite/src/components/reports/reports-test-fixture';
import { assertReportBrowserTerminal, assertStableReportRuntime, liveReportInput, markdownHash, REPORT_READER_CASES, REPORT_READER_SPEC } from './reports-reader-live';

const env = { OPERATOR_REPORT_PROOF_JSON: '/owned/get.json', OPERATOR_E2E_BASE_URL: 'http://127.0.0.1:3170',
  OPERATOR_REPORT_BUILD_SHA: 'abcdef012345', OPERATOR_REPORT_MARKER: 'unique stored marker', OPERATOR_REPORT_LIVE_OUTPUT_DIR: '/owned/browser' };
const body = '## Evidence\n\nunique stored marker';
const receipt = () => ({ ok: true, results: [{ ok: true, report: { ...reportFullFixture, report_id: 'report / exact',
  path: '/reports?sel=report%20%2F%20exact', body_md: body, body_sha256: markdownHash(body) } }] });
const runtime = () => ({ origin: env.OPERATOR_E2E_BASE_URL, sha: 'abcdef0123', generation: 'serving-generation-v1:measured', asset: '/assets/index.js', assetSha256: 'a'.repeat(64) });
const terminal = () => ({ stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: REPORT_READER_CASES.map(title => ({ title,
  tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] })) }] });
const source = 'b'.repeat(40);
const ledger = () => [{ outcome: 'inserted', id: '123', filePath: REPORT_READER_SPEC, status: 'pass', row: {
  status: 'pass', commitSha: source, worktreeDirty: false, isScratchConfig: false } }];
const proof = () => ({ reportId: 'report / exact', sourceMarkdownSha256: markdownHash(body), exportSha256: 'c'.repeat(64), externalRequests: [] });

describe('live Reports browser acceptance guards', () => {
  it('admits the canonical report wire shape with exact encoded selector and full-body hash', () => {
    expect(liveReportInput(env, receipt())).toMatchObject({ reportId: 'report / exact', selector: '/reports?sel=report%20%2F%20exact', bodyHash: markdownHash(body) });
  });
  it.each(['OPERATOR_REPORT_PROOF_JSON', 'OPERATOR_E2E_BASE_URL', 'OPERATOR_REPORT_BUILD_SHA', 'OPERATOR_REPORT_MARKER', 'OPERATOR_REPORT_LIVE_OUTPUT_DIR'])('refuses absent %s rather than falling back to fixtures', key => {
    expect(() => liveReportInput({ ...env, [key]: undefined }, receipt())).toThrow();
  });
  it.each(['https://foreign.invalid', 'http://user:secret@127.0.0.1:3170', 'http://127.0.0.1:3170/other'])('refuses an unsafe selected runtime %s', origin => {
    expect(() => liveReportInput({ ...env, OPERATOR_E2E_BASE_URL: origin }, receipt())).toThrow('local operator origin');
  });
  it.each(['path', 'body_sha256', 'body_md'])('refuses a mismatched readback %s', key => {
    const data = receipt(); Object.assign(data.results[0].report, { [key]: 'wrong' });
    expect(() => liveReportInput(env, data)).toThrow();
  });
  it('refuses a missing or unsuccessful reports:get receipt', () => {
    expect(() => liveReportInput(env, {})).toThrow('successful reports:get');
    expect(() => liveReportInput(env, { ...receipt(), ok: false })).toThrow('successful reports:get');
  });
  it('refuses a blank marker and absent offline request evidence', () => {
    expect(() => liveReportInput({ ...env, OPERATOR_REPORT_MARKER: '   ' }, receipt())).toThrow('unique stored');
    expect(() => assertReportBrowserTerminal(terminal(), { ...proof(), externalRequests: undefined }, ledger(), liveReportInput(env, receipt()), source)).toThrow('offline export');
  });
  it('accepts unchanged measured runtime and clean terminal browser/ledger evidence', () => {
    const input = liveReportInput(env, receipt());
    assertStableReportRuntime(runtime(), runtime(), input);
    expect(assertReportBrowserTerminal(terminal(), proof(), ledger(), input, source)).toBe('123');
  });
  it.each(['sha', 'generation', 'asset', 'assetSha256'] as const)('refuses a changed serving %s', key => {
    expect(() => assertStableReportRuntime(runtime(), { ...runtime(), [key]: 'changed' }, liveReportInput(env, receipt()))).toThrow('changed');
  });
  it('refuses the wrong declared build even when pre/post snapshots agree', () => {
    expect(() => assertStableReportRuntime(runtime(), runtime(), { ...liveReportInput(env, receipt()), buildSha: '1234567' })).toThrow('serving build');
  });
  it.each(['skipped', 'unexpected', 'flaky'] as const)('refuses %s browser execution', key => {
    const data = terminal(); data.stats[key] = 1;
    expect(() => assertReportBrowserTerminal(data, proof(), ledger(), liveReportInput(env, receipt()), source)).toThrow('non-skipped');
  });
  it('refuses a substituted case even if the aggregate count passes', () => {
    const data = terminal(); data.suites[0].specs[0].title = 'fixture mode' as typeof REPORT_READER_CASES[number];
    expect(() => assertReportBrowserTerminal(data, proof(), ledger(), liveReportInput(env, receipt()), source)).toThrow('exact published-report');
  });
  it('refuses absent ledger insertion, dirty source, wrong commit and wrong selected report', () => {
    const input = liveReportInput(env, receipt());
    expect(() => assertReportBrowserTerminal(terminal(), proof(), [], input, source)).toThrow('inserted');
    for (const patch of [{ worktreeDirty: true }, { commitSha: 'wrong' }]) {
      const rows = ledger(); Object.assign(rows[0].row, patch);
      expect(() => assertReportBrowserTerminal(terminal(), proof(), rows, input, source)).toThrow('clean committed source');
    }
    expect(() => assertReportBrowserTerminal(terminal(), { ...proof(), reportId: 'wrong' }, ledger(), input, source)).toThrow('selected stored report');
  });
});
