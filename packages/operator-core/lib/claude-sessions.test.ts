/**
 * claude-sessions tests (EI-4911). Pure helpers + the fs entrypoints against a
 * temp fixture dir (every fs fn takes `root`, so no real $HOME dependency).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeProjectDir,
  extractCwdFromHead,
  recordText,
  firstMatchSnippet,
  listClaudeSessions,
  searchClaudeSessions,
  readClaudeSession,
  allClaudeSessionMetas,
  claudeProjectsRoots,
} from './claude-sessions';

describe('pure helpers', () => {
  it('decodeProjectDir maps dashes to slashes (a hint only)', () => {
    expect(decodeProjectDir('-home-x-proj')).toBe('/home/x/proj');
  });

  it('extractCwdFromHead pulls the first cwd without a full parse', () => {
    expect(extractCwdFromHead('{"type":"user","cwd":"/home/x/proj-alpha","sessionId":"s"}')).toBe('/home/x/proj-alpha');
    expect(extractCwdFromHead('{"no":"cwd here"}')).toBeNull();
  });

  it('recordText handles string and block-array content', () => {
    expect(recordText({ message: { content: 'plain string' } })).toBe('plain string');
    expect(recordText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'thinking' }, { type: 'text', text: 'b' }] } })).toBe('a\nb');
    expect(recordText({ type: 'queue-operation' })).toBe('');
    expect(recordText(null)).toBe('');
  });

  it('firstMatchSnippet finds a case-insensitive match with ellipses', () => {
    const s = firstMatchSnippet('the quick brown WIDGET jumped over', 'widget');
    expect(s?.snippet).toContain('WIDGET');
    expect(firstMatchSnippet('no match here', 'widget')).toBeNull();
  });
});

describe('fs entrypoints (fixture root)', () => {
  let root: string;
  const userRec = (cwd: string, ts: string, text: string) =>
    JSON.stringify({ type: 'user', cwd, sessionId: 'x', timestamp: ts, gitBranch: 'staging', message: { role: 'user', content: text } });
  const asstRec = (cwd: string, ts: string, text: string) =>
    JSON.stringify({ type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }] } });

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'claude-sessions-test-'));
    const dirA = join(root, '-home-x-proj-alpha');
    const dirB = join(root, '-home-x-proj-beta');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const fileA = join(dirA, 'sess-a.jsonl');
    const fileB = join(dirB, 'sess-b.jsonl');
    await fs.writeFile(
      fileA,
      [
        JSON.stringify({ type: 'queue-operation', sessionId: 'sess-a', timestamp: '2026-06-01T00:00:00Z' }),
        userRec('/home/x/proj-alpha', '2026-06-01T00:00:01Z', 'hello WIDGET world'),
        asstRec('/home/x/proj-alpha', '2026-06-01T00:01:00Z', 'I will build the WIDGET now'),
      ].join('\n') + '\n',
    );
    await fs.writeFile(
      fileB,
      [userRec('/home/x/proj-beta', '2026-05-20T00:00:00Z', 'unrelated GADGET stuff')].join('\n') + '\n',
    );
    // A newer than B so it sorts first
    await fs.utimes(fileA, new Date('2026-06-01T00:01:00Z'), new Date('2026-06-01T00:01:00Z'));
    await fs.utimes(fileB, new Date('2026-05-20T00:00:00Z'), new Date('2026-05-20T00:00:00Z'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('listClaudeSessions: newest-first, cwd from head, total/truncated', async () => {
    const { sessions, total, truncated } = await listClaudeSessions({ root });
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    expect(sessions[0].sessionId).toBe('sess-a'); // newer
    expect(sessions[0].cwd).toBe('/home/x/proj-alpha');
    expect(sessions[1].sessionId).toBe('sess-b');
  });

  it('listClaudeSessions: cwd filter narrows', async () => {
    const { sessions } = await listClaudeSessions({ root, cwd: 'beta' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-b');
  });

  it('searchClaudeSessions: finds matches with count + snippet, scoped by cwd', async () => {
    const res = await searchClaudeSessions({ root, query: 'WIDGET' });
    expect(res.filesTotal).toBe(2);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].sessionId).toBe('sess-a');
    expect(res.matches[0].matchCount).toBe(2); // user + assistant
    expect(res.matches[0].snippet).toContain('WIDGET');

    // GADGET lives in beta; scoping to alpha finds nothing
    const scoped = await searchClaudeSessions({ root, query: 'GADGET', cwd: 'alpha' });
    expect(scoped.matches).toHaveLength(0);
  });

  it('readClaudeSession: compact bounded turn list + metadata', async () => {
    const { sessions } = await listClaudeSessions({ root, cwd: 'alpha' });
    const res = await readClaudeSession({ filePath: sessions[0].filePath });
    expect(res).not.toBeNull();
    expect(res!.cwd).toBe('/home/x/proj-alpha');
    expect(res!.gitBranch).toBe('staging');
    expect(res!.totalRecords).toBe(3); // incl. the queue-operation
    expect(res!.turns).toHaveLength(2); // user + assistant only
    expect(res!.turns[0].role).toBe('user');
    expect(res!.turns[1].text).toContain('WIDGET');
    expect(res!.firstTs).toBe('2026-06-01T00:00:00Z');
  });

  it('readClaudeSession: missing file → null', async () => {
    expect(await readClaudeSession({ filePath: join(root, 'nope.jsonl') })).toBeNull();
  });
});

describe('isolation-dir scanning (EI-5790)', () => {
  it('claudeProjectsRoots includes the global root + each per-session isolation projects dir', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'claude-iso-base-'));
    const globalRoot = join(base, 'global');
    const isoBase = join(base, 'session-claude');
    await fs.mkdir(join(isoBase, 'su-owner-1', 'projects'), { recursive: true });
    await fs.mkdir(join(isoBase, 'su-owner-2', 'projects'), { recursive: true });
    try {
      const roots = await claudeProjectsRoots(globalRoot, isoBase);
      expect(roots[0]).toBe(globalRoot);
      expect(roots).toContain(join(isoBase, 'su-owner-1', 'projects'));
      expect(roots).toContain(join(isoBase, 'su-owner-2', 'projects'));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('claudeProjectsRoots fail-soft to global-only when the isolation base is absent', async () => {
    const roots = await claudeProjectsRoots('/tmp/dne-global-xyz', '/tmp/dne-iso-base-xyz');
    expect(roots).toEqual(['/tmp/dne-global-xyz']);
  });

  it('allClaudeSessionMetas merges sessions across roots (global + isolation), newest-first', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'claude-multiroot-'));
    const globalRoot = join(base, 'global');
    const isoRoot = join(base, 'iso-owner', 'projects');
    await fs.mkdir(join(globalRoot, '-home-x-glob'), { recursive: true });
    await fs.mkdir(join(isoRoot, '-home-x-console'), { recursive: true });
    const gFile = join(globalRoot, '-home-x-glob', 'glob-sess.jsonl');
    const cFile = join(isoRoot, '-home-x-console', 'console-sess.jsonl');
    await fs.writeFile(gFile, JSON.stringify({ type: 'user', cwd: '/home/x/glob', message: { role: 'user', content: 'hi' } }) + '\n');
    await fs.writeFile(cFile, JSON.stringify({ type: 'user', cwd: '/home/x/console', message: { role: 'user', content: 'hi' } }) + '\n');
    await fs.utimes(gFile, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    await fs.utimes(cFile, new Date('2026-06-02T00:00:00Z'), new Date('2026-06-02T00:00:00Z')); // newer
    try {
      const metas = await allClaudeSessionMetas({ roots: [globalRoot, isoRoot] });
      const ids = metas.map((m) => m.sessionId);
      expect(ids).toContain('glob-sess');
      expect(ids).toContain('console-sess'); // the isolation-dir console session is now discoverable
      expect(metas[0].sessionId).toBe('console-sess'); // newest-first across roots
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
