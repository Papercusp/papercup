import assert from 'node:assert/strict';

export interface PlanVersion {
  version: number;
  contentHash: string;
}

export interface SaveAttempt {
  requestHash: string;
  expectedVersion: number;
  expectedHash: string;
  httpStatus: number;
  result: 'accepted' | 'stale' | 'other';
  acknowledgement: 'withheld' | 'returned';
}

export interface NativePlanRetryTrace {
  before: PlanVersion;
  afterFirst: PlanVersion;
  afterRetry: PlanVersion;
  attempts: SaveAttempt[];
  editorObservedLoss: boolean;
  editorAfterRetry: 'saved' | 'conflict';
}

export const lostAcknowledgement = 'Test transport lost this plan save acknowledgement';

/** Check the two original submissions and the document read independently after each one. */
export function assertNativePlanRetry(trace: NativePlanRetryTrace) {
  assert.equal(trace.editorObservedLoss, true);
  assert.equal(trace.attempts.length, 2, 'expected the original save and its exact retry');
  const [first, retry] = trace.attempts;
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
  assert.match(trace.before.contentHash, /^[a-f0-9]{64}$/);
  assert.match(trace.afterFirst.contentHash, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(trace.before.version));
  assert.equal(retry.requestHash, first.requestHash, 'retry submitted different bytes');
  for (const attempt of trace.attempts) {
    assert.equal(attempt.expectedHash, trace.before.contentHash);
    assert.equal(attempt.expectedVersion, trace.before.version);
  }
  assert.equal(first.result, 'accepted');
  assert(first.httpStatus >= 200 && first.httpStatus < 300);
  assert.equal(first.acknowledgement, 'withheld');
  assert.equal(retry.acknowledgement, 'returned');
  assert(retry.result === 'accepted' || retry.result === 'stale', 'retry produced an unrelated response');
  assert(retry.result !== 'accepted' || (retry.httpStatus >= 200 && retry.httpStatus < 300));
  assert.equal(trace.editorAfterRetry, retry.result === 'accepted' ? 'saved' : 'conflict');
  assert.notEqual(trace.afterFirst.contentHash, trace.before.contentHash);
  assert.equal(trace.afterFirst.version, trace.before.version + 1);
  assert.deepEqual(trace.afterRetry, trace.afterFirst, 'retry changed the committed plan');
}

/** Native webview fixture for one generated private plan. Both POSTs reach its real writer. */
export function installPlanRetryExpression(scope: { origin: string; workspace: string; slug: string; harness: string }) {
  return `(() => {
    const scope = ${JSON.stringify(scope)};
    const page = new URL(location.href);
    if (page.origin !== scope.origin || !['127.0.0.1', 'localhost'].includes(page.hostname)
      || !page.port || ['3070', '3170', '3270', '3271'].includes(page.port)
      || !/^verify-tauri-isolated-[0-9]+$/.test(scope.workspace) || page.searchParams.get('ws') !== scope.workspace
      || !/^revision-retry-[a-f0-9-]{36}-[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(scope.slug)
      || page.searchParams.get('plan') !== scope.slug || !scope.harness || window.__planRevisionRetry)
      throw new Error('Expected the selected disposable native retry plan');

    const transport = window.fetch;
    const attempts = [];
    function restore() {
      if (window.fetch === submit) window.fetch = transport;
    }

    async function submit(input, init) {
      if (input !== '/api/admin/plans/set-content' || init?.method !== 'POST' || typeof init.body !== 'string')
        return transport.call(window, input, init);
      let plan;
      try { plan = JSON.parse(init.body); }
      catch { return transport.call(window, input, init); }
      if (plan?.slug !== scope.slug || plan.harness !== scope.harness)
        return transport.call(window, input, init);

      const original = attempts.length === 0;
      const attempt = { requestHash: null, expectedVersion: plan.expectedVersion, expectedHash: plan.expectedHash,
        httpStatus: null, result: 'other', acknowledgement: 'unknown' };
      attempts.push(attempt);
      if (!original) restore();
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(init.body));
      attempt.requestHash = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
      const response = await transport.call(window, input, init);
      attempt.httpStatus = response.status;
      const reply = await response.clone().json().catch(() => null);
      if (response.ok && reply?.ok === true) attempt.result = 'accepted';
      else if ((reply?.code ?? reply?.error) === 'stale') attempt.result = 'stale';
      if (original && attempt.result === 'accepted') {
        attempt.acknowledgement = 'withheld';
        throw new TypeError(${JSON.stringify(lostAcknowledgement)});
      }
      attempt.acknowledgement = 'returned';
      restore();
      return response;
    }

    window.__planRevisionRetry = {
      attempts,
      finish() { restore(); delete window.__planRevisionRetry; return attempts; },
    };
    window.fetch = submit;
    return true;
  })()`;
}
