import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { disqualification, HARNESS_TAG, parseAcceptanceLines, parseHarnessLine, type Candidate, type EvidenceRow } from './release-acceptance';
import { runCloudDeviceStartSmoke, runReleaseAcceptance } from './release-acceptance-run';

describe('public cloud device-start release guard', () => {
  it('requires a usable grant through HTTP and never records its credentials', async () => {
    let status = 200;
    let body: unknown;
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      let input = '';
      for await (const chunk of req) input += chunk.toString();
      requests.push({ method: req.method, url: req.url, body: input });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const grant = {
      ok: true, deviceCode: 'pdc_PRIVATE_CODE', userCode: 'PRIVATE-USER-CODE',
      verificationUri: `${origin}/api/hosted/cli/device`,
      verificationUriComplete: `${origin}/api/hosted/cli/device?user_code=PRIVATE-USER-CODE`,
      expiresIn: 600, interval: 5,
    };
    try {
      body = grant;
      const passed = await runCloudDeviceStartSmoke(origin);
      expect(passed).toMatchObject({ ok: true, status: 200, problem: null });
      expect(JSON.stringify(passed)).not.toContain('PRIVATE');
      expect(requests).toEqual([{ method: 'POST', url: '/api/hosted/cli/device/code', body: '{}' }]);

      // The actual ingress regression returned HTTP 404; a JSON ok flag must
      // not disguise it. A login page with HTTP 200 must also fail closed.
      status = 404;
      expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status: 404 });
      status = 200;
      body = '<html>sign in</html>';
      expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status: 200 });
      for (const malformed of [
        { ...grant, deviceCode: '' }, { ...grant, userCode: '' },
        { ...grant, expiresIn: 0 }, { ...grant, interval: 0 },
        { ...grant, verificationUriComplete: 'https://other.invalid/device' },
      ]) {
        body = malformed;
        const failed = await runCloudDeviceStartSmoke(origin);
        expect(failed).toMatchObject({ ok: false, status: 200 });
        expect(JSON.stringify(failed)).not.toContain('PRIVATE');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status: null });
  });
});

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
