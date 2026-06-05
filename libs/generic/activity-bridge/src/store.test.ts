/**
 * store.test.ts — the telemetry-store ingest seam: normalizeReport (pure) +
 * recordActivity over an injected in-memory store. Proves the port is real and
 * the normalize→append flow is host-agnostic (no PG needed).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeReport,
  recordActivity,
  SUMMARY_CAP,
  type ActivityRecord,
  type TelemetryStore,
} from './store';

/** A trivial array-backed store — the seam the host fills (here, no I/O). */
function makeMemoryStore(): TelemetryStore & { rows: ActivityRecord[] } {
  const rows: ActivityRecord[] = [];
  return {
    rows,
    async append(record) {
      rows.push(record);
      return { id: String(rows.length) };
    },
  };
}

describe('normalizeReport', () => {
  it('derives kind/summary/detail from a native edit call', () => {
    const rec = normalizeReport({ owner: 'w1', agent: 'claude', toolName: 'Edit', toolInput: { file_path: '/repo/src/gen.ts' } });
    expect(rec).toMatchObject({
      owner: 'w1',
      agent: 'claude',
      kind: 'tool',
      toolName: 'Edit',
      summary: '✎ gen.ts',
      detail: { file: '/repo/src/gen.ts' },
    });
    // unset optionals normalize to null
    expect(rec.sessionId).toBeNull();
    expect(rec.scope).toBeNull();
    expect(rec.phase).toBeNull();
    expect(rec.status).toBeNull();
    expect(rec.cwd).toBeNull();
  });

  it('maps scope + passes through identity/correlation fields', () => {
    const rec = normalizeReport({
      owner: 'w2', agent: 'codex', sessionId: 'sess-9', scope: 'my-repo',
      toolName: 'Bash', toolInput: { command: 'npm test' }, phase: 'post',
      toolUseId: 'call-1', status: 'error', cwd: '/repo', workspaceId: 'ws-x',
    });
    expect(rec).toMatchObject({
      owner: 'w2', agent: 'codex', sessionId: 'sess-9', scope: 'my-repo',
      kind: 'tool', toolName: 'Bash', phase: 'post', toolUseId: 'call-1',
      summary: '▶ npm test', status: 'error', cwd: '/repo', workspaceId: 'ws-x',
    });
  });

  it('an explicit summary overrides the derived one; explicit kind wins', () => {
    const rec = normalizeReport({ owner: 'w', toolName: 'Edit', toolInput: { file_path: '/x.ts' }, summary: '  custom marker ', kind: 'lifecycle' });
    expect(rec.summary).toBe('custom marker');
    expect(rec.kind).toBe('lifecycle');
  });

  it('a todos snapshot normalizes to kind=todos', () => {
    const rec = normalizeReport({ owner: 'w', toolName: 'TodoWrite', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Bing' }] });
    expect(rec.kind).toBe('todos');
    expect(rec.summary).toBe('⇄ Bing (1/2)');
    expect((rec.detail as { count: number }).count).toBe(2);
  });

  it('no tool name + no todos → lifecycle', () => {
    const rec = normalizeReport({ owner: 'w' });
    expect(rec.kind).toBe('lifecycle');
    expect(rec.summary).toBe('· activity');
  });

  it('caps the stored summary at SUMMARY_CAP', () => {
    const rec = normalizeReport({ owner: 'w', summary: 'z'.repeat(SUMMARY_CAP + 50) });
    expect(rec.summary.length).toBe(SUMMARY_CAP);
    expect(rec.summary.endsWith('…')).toBe(true);
  });
});

describe('recordActivity over an injected store', () => {
  it('normalizes + appends + returns { id, owner, kind, summary }', async () => {
    const store = makeMemoryStore();
    const res = await recordActivity(store, { owner: 'w1', agent: 'claude', toolName: 'Read', toolInput: { file_path: '/r.md' } });
    expect(res).toEqual({ id: '1', owner: 'w1', kind: 'tool', summary: '👁 r.md' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ owner: 'w1', summary: '👁 r.md', detail: { file: '/r.md' } });
  });

  it('appends multiple reports in order', async () => {
    const store = makeMemoryStore();
    await recordActivity(store, { owner: 'w', toolName: 'Edit', toolInput: { file_path: '/a.ts' } });
    await recordActivity(store, { owner: 'w', toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(store.rows.map((r) => r.summary)).toEqual(['✎ a.ts', '▶ ls']);
  });

  it('propagates a null id from a store that does not assign one', async () => {
    const store: TelemetryStore = { async append() { return { id: null }; } };
    const res = await recordActivity(store, { owner: 'w', toolName: 'Read', toolInput: { file_path: '/r.md' } });
    expect(res.id).toBeNull();
    expect(res.summary).toBe('👁 r.md');
  });
});
