import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { disqualification, HARNESS_TAG, parseAcceptanceLines, parseHarnessLine, type Candidate, type EvidenceRow } from './release-acceptance';
import { runReleaseAcceptance } from './release-acceptance-run';

describe('release acceptance evidence parsing', () => {
  it('reads every record when Vitest batches two console writes into one chunk', () => {
    // The exact shape the installed-candidate run printed on 2026-09-23: PUI-TASK
    // logged its task row and its promote row back to back, and Vitest delivered
    // them as ONE log. The single-record parser dropped both.
    const chunk = [
      'PUI_TASK_ACCEPTANCE {"binary":"/r/bin/pui","binarySha256":"abc","chatId":"chat-1"}',
      'PUI_TASK_PROMOTE_ACCEPTANCE {"binary":"/r/bin/pui","binarySha256":"abc","chatId":"chat-1","taskId":"t-2"}',
      '',
    ].join('\n');

    const { lines, unparsed } = parseAcceptanceLines(chunk);

    expect(lines.map((line) => line.tag)).toEqual(['PUI_TASK_ACCEPTANCE', 'PUI_TASK_PROMOTE_ACCEPTANCE']);
    expect(lines[1].payload).toMatchObject({ chatId: 'chat-1', taskId: 't-2' });
    expect(unparsed).toEqual([]);
  });

  it('still reads a single record, including a pretty-printed payload', () => {
    expect(parseAcceptanceLines('AUTO_BAR_R_12_P_012_ACCEPTANCE {"binarySha256":"abc"}').lines)
      .toEqual([{ tag: 'AUTO_BAR_R_12_P_012_ACCEPTANCE', payload: { binarySha256: 'abc' } }]);
    const pretty = `PUI_USAGE_ACCEPTANCE ${JSON.stringify({ chatId: 'c', traffic: [{ path: '/api/x' }] }, null, 2)}`;
    expect(parseAcceptanceLines(pretty).lines[0].payload).toEqual({ chatId: 'c', traffic: [{ path: '/api/x' }] });
  });

  it('reports a printed tag whose JSON does not parse instead of dropping it', () => {
    const chunk = 'PUI_ABOUT_SUPPORT_ACCEPTANCE {"binary":\nPUI_TASK_ACCEPTANCE {"chatId":"c"}';
    const { lines, unparsed } = parseAcceptanceLines(chunk);
    expect(lines.map((line) => line.tag)).toEqual(['PUI_TASK_ACCEPTANCE']);
    expect(unparsed).toEqual(['PUI_ABOUT_SUPPORT_ACCEPTANCE']);
  });

  it('ignores prose and non-acceptance tags, and finds a harness stamp batched with a record', () => {
    const chunk = [
      '[session-archive] adv 13 looks LIVE — nothing touched',
      `${HARNESS_TAG} {"operator":"production","binary":"/r/bin/pui","binarySha256":"abc"}`,
      'PUI_SETTINGS_FAILURE {"stage":"pick"}',
      'PUI_SETTINGS_PICKERS_ACCEPTANCE {"chatId":"c"}',
    ].join('\n');

    expect(parseAcceptanceLines(chunk).lines.map((line) => line.tag)).toEqual(['PUI_SETTINGS_PICKERS_ACCEPTANCE']);
    expect(parseHarnessLine(chunk)).toMatchObject({ operator: 'production', binarySha256: 'abc' });
    expect(parseHarnessLine(`${HARNESS_TAG} {"operator":"mock"}`)).toBeNull();
  });

  it('never lets an unparsed row qualify, even with an otherwise passing test', () => {
    const candidate = { installedBinarySha256: 'abc', installRoot: '/r' } as Candidate;
    const row: EvidenceRow = {
      tag: 'PUI_TASK_ACCEPTANCE', test: 't', module: 'm', state: 'passed',
      harness: { operator: 'production' } as EvidenceRow['harness'], platform: 'Linux x86_64', engine: 'scripted',
      model: null, binary: '/r/bin/pui', binaryRealpath: '/r/bin/pui', binarySha256: 'abc', correlation: null,
    };
    expect(disqualification(row, candidate)).toBeNull();
    expect(disqualification({ ...row, unparsed: true }, candidate)).toBe('its acceptance line did not parse');
  });
});

describe('release acceptance account preflight', () => {
  it('refuses a missing or invalid routed catalog before opening the archive or running suites', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'pui-acceptance-preflight-'));
    const archive = path.join(work, 'missing.tar.gz');
    try {
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: '',
      } }] })).rejects.toThrow(/PUI_NATIVE_ACCOUNT_CATALOG.*before installed suites run/);
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: 'relative-accounts.json',
      } }] })).rejects.toThrow(/must be an absolute path/);

      const catalog = path.join(work, 'accounts.json');
      writeFileSync(catalog, '{"accounts":[{"id":"bad id","provider":"claude"}]}');
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: catalog,
      } }] })).rejects.toThrow(/valid id\/provider metadata/);

      writeFileSync(catalog, '{"accounts":[{"id":"claude-main","provider":"claude"}]}');
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: catalog,
      } }] })).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
