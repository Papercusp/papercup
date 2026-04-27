/**
 * Smoke tests for operator-notes file I/O + parsing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { appendOperatorNote, parseNotes, readOperatorNotes } from './operator-notes';

describe('parseNotes', () => {
  it('returns empty for empty / whitespace input', () => {
    expect(parseNotes('')).toEqual([]);
    expect(parseNotes('\n\n  \n')).toEqual([]);
  });

  it('parses one block', () => {
    const raw = '## user 2026-04-27T12:34:56Z\n\nuse a per-row mutex\n';
    const blocks = parseNotes(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      author: 'user',
      ts: '2026-04-27T12:34:56Z',
      body: 'use a per-row mutex',
    });
  });

  it('parses multiple blocks oldest-first', () => {
    const raw = [
      '## user 2026-04-27T10:00:00Z',
      '',
      'first hint',
      '',
      '## user 2026-04-27T11:00:00Z',
      '',
      'second hint',
      '',
    ].join('\n');
    const blocks = parseNotes(raw);
    expect(blocks.map((b) => b.body)).toEqual(['first hint', 'second hint']);
    expect(blocks[0].ts < blocks[1].ts).toBe(true);
  });

  it('handles fractional-second timestamps', () => {
    const raw = '## tool 2026-04-27T12:34:56.123Z\n\nbody\n';
    expect(parseNotes(raw)[0].author).toBe('tool');
  });
});

describe('appendOperatorNote', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'opnotes-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Write a fake registry pointing slug → fake project.
    const projectDir = join(tmpHome, 'project');
    writeFileSync(
      join(tmpHome, '.restart-harness-projects.json'),
      JSON.stringify({ projects: [{ slug: 'demo', path: projectDir }] }),
    );
    // Project + .harness must exist for mkdir(notes/) to land somewhere sensible.
    require('node:fs').mkdirSync(join(projectDir, '.harness'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome !== undefined) process.env.HOME = prevHome;
  });

  it('rejects empty content', async () => {
    const r = await appendOperatorNote({ slug: 'demo', featureId: 'F-001', content: '' });
    expect(r).toEqual({ error: 'content is required' });
  });

  it('rejects bad featureId', async () => {
    const r = await appendOperatorNote({ slug: 'demo', featureId: 'oops', content: 'x' });
    expect('error' in r).toBe(true);
  });

  it('rejects unknown slug', async () => {
    const r = await appendOperatorNote({ slug: 'no-such', featureId: 'F-001', content: 'x' });
    expect(r).toEqual({ error: 'harness "no-such" not registered' });
  });

  it('appends a block and round-trips through readOperatorNotes', async () => {
    const w1 = await appendOperatorNote({ slug: 'demo', featureId: 'F-001', content: 'use mutex', author: 'user' });
    expect('path' in w1).toBe(true);
    const w2 = await appendOperatorNote({ slug: 'demo', featureId: 'F-001', content: 'and add tests', author: 'user' });
    expect('path' in w2).toBe(true);

    const r = readOperatorNotes('demo', 'F-001');
    expect('blocks' in r).toBe(true);
    if ('blocks' in r) {
      expect(r.blocks).toHaveLength(2);
      expect(r.blocks[0].body).toBe('use mutex');
      expect(r.blocks[1].body).toBe('and add tests');
      expect(r.blocks[0].ts < r.blocks[1].ts).toBe(true);
    }
  });

  it('returns empty when feature has no notes file', () => {
    const r = readOperatorNotes('demo', 'F-999');
    expect(r).toEqual({ raw: '', blocks: [] });
  });
});
