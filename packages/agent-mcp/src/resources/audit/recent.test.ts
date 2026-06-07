/**
 * `papercusp://workspace/audit/recent` resource — read projection.
 *
 * `ctx.tx` mocked as a sql template tag. The contract under test: the JSON
 * text payload is `{ entries: <rows verbatim> }`, the uri/mimeType echo, and
 * the query reads audit_log capped at 100. (The audit:read capability gate is
 * dispatch-layer behavior, covered by the gating tests.)
 */

import { describe, expect, it, vi } from 'vitest';
import resource from './recent';

let lastText = '';
let nextRows: unknown[] = [];

const tx = (strings: TemplateStringsArray, ..._values: unknown[]) => {
  lastText = strings.join(' ');
  return Promise.resolve(nextRows);
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

const URI = 'papercusp://workspace/audit/recent';

describe('audit:recent resource', () => {
  it('serves the rows verbatim under {entries}, echoing uri + mimeType', async () => {
    nextRows = [
      { id: 'a1', ts: 5, actor: 'op', action: 'flag.set', subject: 'flags', details: { k: 'v' } },
    ];
    const res = await resource.read(URI, CTX());
    expect(res.uri).toBe(URI);
    expect(res.mimeType).toBe('application/json');
    expect(JSON.parse(res.text!)).toEqual({ entries: nextRows });
  });

  it('reads harness_shared.audit_log most-recent-first with the 100 cap', async () => {
    await resource.read(URI, CTX());
    expect(lastText).toContain('harness_shared.audit_log');
    expect(lastText).toContain('ORDER BY ts DESC');
    expect(lastText).toContain('LIMIT 100');
  });

  it('declares the audit:read capability + the canonical uri', () => {
    expect(resource.capability).toBe('audit:read');
    expect(resource.uri).toBe(URI);
  });
});
