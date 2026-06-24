import { describe, it, expect } from 'vitest';
import { unwrapBulkGet } from './plans';

/**
 * plans:get became a BULK tool (get.ts → runBulk → bulkContent), so even a
 * single-slug call returns `{ ok, results: [plan], counts }`. The plans admin
 * UI is single-plan and reads `data.raw/prose/frontmatter` straight off the
 * response; without unwrapping `results[0]` the editor renders BLANK (the
 * reported "select a plan, nothing shows" bug). unwrapBulkGet restores the
 * route's clean-single-object contract.
 */

/** Wrap a plain object as the MCP tool-result envelope the host returns. */
function toolResult(obj: unknown, status = 200) {
  return {
    status,
    body: { content: [{ type: 'text', text: JSON.stringify(obj) }] },
  };
}

describe('unwrapBulkGet — single-plan unwrap of the plans:get bulk envelope', () => {
  it('returns results[0] (the plan object) from a one-slug bulk envelope', async () => {
    const plan = {
      ok: true,
      slug: 'demo',
      prose: '# Demo\n\nbody',
      raw: '---\nslug: demo\n---\n\n# Demo\n\nbody',
      frontmatter: { slug: 'demo', status: 'ready' },
      contentHash: 'abc',
    };
    const res = unwrapBulkGet(toolResult({ ok: true, results: [plan], counts: { ok: 1, failed: 0 } }));
    const data = await res.json();
    expect(data.slug).toBe('demo');
    // Both the body and the exact raw bytes survive — read + edit round-trip.
    expect(data.prose).toContain('# Demo');
    expect(data.raw).toContain('slug: demo');
    expect(data.frontmatter.status).toBe('ready');
    expect(data.contentHash).toBe('abc');
  });

  it('maps an empty results array to a clean not_found shape', async () => {
    const res = unwrapBulkGet(toolResult({ ok: true, results: [], counts: { ok: 0, failed: 1 } }));
    const data = await res.json();
    expect(data.error?.code).toBe('not_found');
  });

  it('passes a bare { error } (trust/validation failure) through unchanged', async () => {
    const res = unwrapBulkGet(
      toolResult({ error: { code: 'forbidden', message: 'trust unverified-loopback not in allowlist' } }),
    );
    const data = await res.json();
    expect(data.error.code).toBe('forbidden');
    expect(data.results).toBeUndefined();
  });

  it('forwards a non-200 tool failure verbatim with its status', async () => {
    const res = unwrapBulkGet({ status: 500, body: { error: 'boom' } });
    expect(res.status).toBe(500);
  });
});
