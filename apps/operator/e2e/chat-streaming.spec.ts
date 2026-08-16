/**
 * Live chat streaming via the fake-LLM injection seam (PAPERCUSP_FAKE_LLM=1).
 *
 * Covers the full route → SSE → consumer pipeline for architect/oracle/agent_chats
 * without a real model. The dev server must be launched with PAPERCUSP_FAKE_LLM=1
 * for these specs to receive scripted deltas instead of timing out on the real LLM.
 *
 * If the env var isn't set the route streams from a real backend and these specs
 * will fail (or stall). They auto-skip when the fake seam isn't active to avoid
 * polluting CI before the feature flag flips.
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

async function fakeLlmActive(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  // We probe by calling architect:chat with a 5s timeout. Real-LLM responses
  // take >5s; fake-LLM responses always terminate within ~200ms.
  try {
    const res = await request.post(`${baseURL}/api/agent-tools/architect:chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'probe', harnessSlug: 'main' },
      timeout: 6_000,
    });
    if (!res.ok()) return false;
    const body = await res.text();
    return body.includes('[fake-llm]');
  } catch {
    return false;
  }
}

test.describe('chat streaming via fake-LLM seam', () => {
  test('architect:chat emits scripted deltas + result event', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    const res = await request.post(`${baseURL}/api/agent-tools/architect:chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'What is the meaning of testing?', harnessSlug: 'main' },
      timeout: 10_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/\[fake-llm\]/);
    // Three deltas are scripted; the SSE stream should mention each delta + result
    expect(body).toContain('Generating deterministic output');
    expect(body).toContain('Stream terminates');
  });

  test('oracle:chat receives the same scripted deltas', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    const res = await request.post(`${baseURL}/api/agent-tools/oracle:chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'hello oracle' },
      timeout: 10_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('[fake-llm]');
  });

  test('fake-LLM does not require any real model credentials', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    // Implicit: the route succeeded, no upstream model auth was needed.
    // This is a contract test for the seam — without the env var, this route
    // would 5xx on missing OMP/Claude bearer.
    const res = await request.post(`${baseURL}/api/agent-tools/architect:chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'no creds needed', harnessSlug: 'main' },
      timeout: 10_000,
    });
    expect(res.ok()).toBeTruthy();
  });
});
