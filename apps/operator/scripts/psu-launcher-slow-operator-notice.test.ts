/**
 * psu-launcher-slow-operator-notice.test.ts — WI-10006057.
 *
 * While the operator behind the MCP proxy is down, the proxy holds psu's request
 * for its ~90s retry window, and psu used to print nothing at all. These tests
 * pin the wiring in fetchWithResilience: a request still pending after
 * slowNoticeAfterMs prints the diagnosis, and a response that arrives first
 * silences it. The diagnosis itself is covered in
 * psu-operator-down-diagnosis.test.ts.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-slow-operator-notice.test.ts
 */
import { describe, it, expect } from 'vitest';

import { fetchWithResilience } from './psu-launcher.mjs';

const URL = 'http://127.0.0.1:9171/api/agent-mcp/console/bootstrap-su';
const NOTICE = 'psu: still waiting. The operator on :3170 is not answering\n';

function respondAfter(ms: number) {
  return () =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{"status":"ok"}', { status: 200 })), ms));
}

async function launch(fetchDelayMs: number, noticeDelayMs = 0) {
  const notices: string[] = [];
  let asked = 0;
  const res = await fetchWithResilience(URL, {}, {
    fetchImpl: respondAfter(fetchDelayMs) as unknown as typeof fetch,
    onNotice: (msg: string) => {
      notices.push(msg);
      return true;
    },
    slowNoticeAfterMs: 5,
    slowRequestNotice: async ({ url }: { url: string }) => {
      asked += 1;
      expect(url).toBe(URL);
      await new Promise((r) => setTimeout(r, noticeDelayMs));
      return NOTICE;
    },
  });
  expect(res.status).toBe(200);
  return { notices, asked };
}

describe('psu explains a slow request while it is still waiting', () => {
  it('prints the diagnosis once the request has been pending past the threshold', async () => {
    const { notices, asked } = await launch(60);
    expect(asked).toBe(1);
    expect(notices).toEqual([NOTICE]);
  });

  it('does not ask when the response arrives before the threshold', async () => {
    const { notices, asked } = await launch(0);
    expect(asked).toBe(0);
    expect(notices).toEqual([]);
  });

  it('drops a diagnosis that finishes after the response already arrived', async () => {
    const { notices, asked } = await launch(20, 80);
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toBe(1);
    expect(notices).toEqual([]);
  });
});
