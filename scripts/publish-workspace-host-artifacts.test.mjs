import assert from 'node:assert/strict';
import test from 'node:test';

import { request } from './publish-workspace-host-artifacts.mjs';

test('rejected fetch renders stage, redacted URL, and nested Error.cause fields', async () => {
  const originalFetch = globalThis.fetch;
  const cause = Object.assign(
    new Error('connect ECONNREFUSED token=inner-secret'),
    {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 8788,
    },
  );
  const rejection = new TypeError('fetch failed', { cause });

  try {
    globalThis.fetch = async () => {
      throw rejection;
    };

    await assert.rejects(
      request(
        'https://user:password@example.test/admin/artifacts?uploadId=capability-secret&safe=yes',
        { headers: { authorization: 'Bearer header-secret' } },
        1,
        'initiate multipart',
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, rejection);
        assert.match(error.message, /^initiate multipart request failed URL=/);
        assert.match(error.message, /example\.test/);
        assert.match(error.message, /"cause":\{"name":"Error"/);
        assert.match(error.message, /ECONNREFUSED/);
        assert.match(error.message, /127\.0\.0\.1/);
        assert.doesNotMatch(
          error.message,
          /password|capability-secret|inner-secret|header-secret/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
