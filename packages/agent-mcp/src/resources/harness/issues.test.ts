/**
 * `papercusp://harness/{slug}/issues` resource — template list expansion +
 * per-harness read.
 *
 * Importing the module registers its RFC-6570 template in the tooldef
 * resource catalog, so `read()` resolves {slug} through the real
 * matchResource. `ctx.tx` is mocked as a DUAL-shape postgres-js client:
 * a template tag for queries AND a plain identifier call (`tx(schema)`) —
 * the handler interpolates the per-harness schema as an identifier. The
 * logic under test:
 *   - list(): one entry per projects row, with the templated uri
 *   - read(): slug extracted from the uri; the schema identifier is the
 *     sanitized `harness_<slug>` (non [a-z0-9_] → '_'); rows served under
 *     {slug, issues}
 *   - a query error (e.g. missing per-harness schema) → degraded envelope,
 *     not a throw
 *   - a non-matching uri throws the invalid-URI error
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import resource from './issues';

let projectRows: Array<{ slug: string; name: string }> = [];
let issueRows: Array<Record<string, unknown>> = [];
let failRead: Error | null = null;
const identifierCalls: string[] = [];

// Dual-shape tx: template-tag call (strings is an array) vs identifier call.
const tx = (first: unknown, ...rest: unknown[]) => {
  if (Array.isArray(first)) {
    const text = (first as TemplateStringsArray).join(' ');
    if (text.includes('harness_shared.projects')) return Promise.resolve(projectRows);
    if (failRead) return Promise.reject(failRead);
    return Promise.resolve(issueRows);
  }
  identifierCalls.push(String(first));
  return { __identifier: first, rest };
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

function payload(res: { text?: string }) {
  return JSON.parse(res.text!) as {
    slug: string;
    issues: unknown[];
    degraded?: boolean;
    degradedReason?: string;
  };
}

beforeEach(() => {
  projectRows = [];
  issueRows = [];
  failRead = null;
  identifierCalls.length = 0;
});

describe('harness:issues resource — list()', () => {
  it('expands the template to one entry per harness', async () => {
    projectRows = [
      { slug: 'sheets', name: 'Sheets' },
      { slug: 'forms', name: 'Forms' },
    ];
    const entries = await resource.list!(CTX());
    expect(entries).toEqual([
      {
        uri: 'papercusp://harness/sheets/issues',
        name: 'sheets issues',
        description: 'Issues filed against tasks in harness "Sheets".',
        mimeType: 'application/json',
      },
      {
        uri: 'papercusp://harness/forms/issues',
        name: 'forms issues',
        description: 'Issues filed against tasks in harness "Forms".',
        mimeType: 'application/json',
      },
    ]);
  });
});

describe('harness:issues resource — read()', () => {
  it('extracts {slug}, reads the sanitized per-harness schema, serves the rows', async () => {
    issueRows = [{ id: 'I-1', task_id: 'T-1', filed_by: 'validator', severity: 'major', body: 'b', created_at: 1 }];
    const res = await resource.read('papercusp://harness/my-app/issues', CTX());
    expect(payload(res)).toEqual({ slug: 'my-app', issues: issueRows });
    // '-' is outside [a-z0-9_] → sanitized to '_'
    expect(identifierCalls).toEqual(['harness_my_app']);
  });

  it('degrades (instead of throwing) when the per-harness schema is missing', async () => {
    failRead = new Error('schema "harness_ghost" does not exist');
    const res = await resource.read('papercusp://harness/ghost/issues', CTX());
    const p = payload(res);
    expect(p.slug).toBe('ghost');
    expect(p.issues).toEqual([]);
    expect(p.degraded).toBe(true);
    expect(p.degradedReason).toMatch(/harness_ghost/);
  });

  it('throws on a uri that does not match the template', async () => {
    await expect(resource.read('papercusp://harness//issues', CTX())).rejects.toThrow(
      /Invalid harness\/issues URI/,
    );
  });
});
