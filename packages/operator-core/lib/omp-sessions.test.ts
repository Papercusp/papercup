import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let fakeHome = '';

function writeSession(relativeDir: string, fileName: string, lines: unknown[]): string {
  const dir = join(fakeHome, '.omp', 'agent', 'sessions', relativeDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return filePath;
}

describe('omp-sessions', () => {
  beforeEach(() => {
    vi.resetModules();
    fakeHome = mkdtempSync(join(tmpdir(), 'omp-sessions-'));
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => fakeHome };
    });
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('lists sessions and filters by query', async () => {
    writeSession('-tmp', '2026-05-24T18-38-57-367Z_a.jsonl', [
      { type: 'session', version: 3, id: 'a', timestamp: '2026-05-24T18:38:57.367Z', cwd: '/tmp', title: 'Agent Compaction Handoff Prompt' },
      { type: 'message', id: 'm1', timestamp: '2026-05-24T18:39:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Need a handoff brief.' }] } },
    ]);
    writeSession('-repo', '2026-05-24T19-38-57-367Z_b.jsonl', [
      { type: 'session', version: 3, id: 'b', timestamp: '2026-05-24T19:38:57.367Z', cwd: '/repo', title: 'Unrelated session' },
      { type: 'message', id: 'm2', timestamp: '2026-05-24T19:39:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Something else' }] } },
    ]);

    const mod = await import('./omp-sessions');
    const all = mod.listOmpSessions({ limit: 10 });
    expect(all.map((s) => s.id)).toEqual(['b', 'a']);

    const filtered = mod.listOmpSessions({ query: 'handoff', limit: 10 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('a');
  });

  it('reads a session by id and extracts structured state', async () => {
    writeSession('-tmp', '2026-05-24T18-38-57-367Z_a.jsonl', [
      { type: 'session', version: 3, id: 'a', timestamp: '2026-05-24T18:38:57.367Z', cwd: '/tmp', title: 'Agent Compaction Handoff Prompt' },
      { type: 'message', id: 'u1', timestamp: '2026-05-24T18:39:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Investigate compaction degradation.' }] } },
      { type: 'message', id: 't1', timestamp: '2026-05-24T18:40:00.000Z', message: { role: 'toolResult', toolName: 'todo_write', content: [{ type: 'text', text: 'Remaining items (1):\n  - Write handoff [in_progress] (Verification)' }], details: { phases: [{ name: 'Verification', tasks: [{ content: 'Write handoff', status: 'in_progress', notes: ['Remember session id a'] }] }] } } },
      { type: 'message', id: 't2', timestamp: '2026-05-24T18:41:00.000Z', message: { role: 'toolResult', toolName: 'job', isError: true, content: [{ type: 'text', text: 'Background command failed' }] } },
      { type: 'message', id: 'a1', timestamp: '2026-05-24T18:42:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will write a successor handoff and mention origin session a.' }] } },
      { type: 'session_compact', id: 'c1', timestamp: '2026-05-24T18:43:00.000Z', compactionEntry: { summary: 'compacted' } },
      { type: 'message', id: 'h1', timestamp: '2026-05-24T18:44:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '<handoff-context>resume from session a</handoff-context>' }] } },
    ]);

    const mod = await import('./omp-sessions');
    const read = mod.readOmpSession({ id: 'a', limit: 2 });
    expect(read?.header.id).toBe('a');
    expect(read?.turns).toHaveLength(2);
    expect(read?.truncated).toBe(true);

    const state = mod.getOmpSessionState({ id: 'a' });
    expect(state?.header.id).toBe('a');
    expect(state?.messages.user).toBe(1);
    expect(state?.messages.toolResults).toBe(2);
    expect(state?.todos[0]?.tasks[0]?.content).toBe('Write handoff');
    expect(state?.toolCounts.find((tool) => tool.toolName === 'job')?.errors).toBe(1);
    expect(state?.compactions).toHaveLength(1);
    expect(state?.handoffs).toHaveLength(1);
  });

  it('searches session history with snippets and context', async () => {
    writeSession('-tmp', '2026-05-24T18-38-57-367Z_a.jsonl', [
      { type: 'session', version: 3, id: 'a', timestamp: '2026-05-24T18:38:57.367Z', cwd: '/tmp', title: 'Compaction search test' },
      { type: 'message', id: 'm1', timestamp: '2026-05-24T18:39:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'First line before the decision.' }] } },
      { type: 'message', id: 'm2', timestamp: '2026-05-24T18:40:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: the next agent should search session history for origin session a.' }] } },
      { type: 'message', id: 'm3', timestamp: '2026-05-24T18:41:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Line after the decision.' }] } },
    ]);

    const mod = await import('./omp-sessions');
    const result = mod.searchOmpSessions({ query: 'origin session', sessionId: 'a', limit: 10, context: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.snippet).toContain('origin session a');
    expect(result.matches[0]?.contextBefore[0]).toContain('First line before');
    expect(result.matches[0]?.contextAfter[0]).toContain('Line after');
  });

  it('prefers exact cwd when locating a nearby session', async () => {
    writeSession('-tmp', '2026-05-24T18-38-57-367Z_a.jsonl', [
      { type: 'session', version: 3, id: 'a', timestamp: '2026-05-24T18:38:57.367Z', cwd: '/tmp/project', title: 'Exact match' },
    ]);
    writeSession('-tmp', '2026-05-24T18-38-58-367Z_b.jsonl', [
      { type: 'session', version: 3, id: 'b', timestamp: '2026-05-24T18:38:58.367Z', cwd: '/tmp/project/subdir', title: 'Prefix match' },
    ]);

    const mod = await import('./omp-sessions');
    const found = mod.findOmpSessionNear({
      startedAtMs: new Date('2026-05-24T18:38:58.000Z').getTime(),
      cwd: '/tmp/project',
      windowMs: 10_000,
    });

    expect(found?.id).toBe('a');
    expect(found?.matchKind).toBe('exact-cwd');
  });
});
