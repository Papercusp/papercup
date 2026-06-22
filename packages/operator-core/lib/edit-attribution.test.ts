import { describe, it, expect } from 'vitest';
import { parsePapercuspTrailers } from './edit-attribution';

describe('parsePapercuspTrailers (deterministic-commit-workitem-attribution P-004)', () => {
  it('parses Papercusp-Agent/Work-Item/Session/Plan from a per-agent commit body', () => {
    const body = [
      'fix a [skip ci]',
      '',
      'Co-Authored-By: ag1 <ag1@agents.papercusp>',
      'Papercusp-Agent: su-abc',
      'Papercusp-Work-Item: WI-1, WI-2',
      'Papercusp-Session: sess-9',
      'Papercusp-Plan: plan-x',
    ].join('\n');
    expect(parsePapercuspTrailers(body)).toEqual({
      agent: 'su-abc',
      workItems: ['WI-1', 'WI-2'],
      sessionId: 'sess-9',
      planSlug: 'plan-x',
    });
  });

  it('returns empty workItems and no fields for a plain (un-attributed) commit', () => {
    expect(parsePapercuspTrailers('chore(git-sync): auto-commit [skip ci]')).toEqual({ workItems: [] });
  });

  it('tolerates a single work-item and missing optional trailers', () => {
    const body = 'subj\n\nPapercusp-Agent: a\nPapercusp-Work-Item: WI-9';
    expect(parsePapercuspTrailers(body)).toEqual({ agent: 'a', workItems: ['WI-9'] });
  });

  it('round-trips the exact trailer lines run-git-sync writes', () => {
    // mirrors the `-m` values commitAttributedGroups pushes onto `git commit`.
    const body = ['s', '', 'Papercusp-Agent: ag', 'Papercusp-Work-Item: WI-1, WI-2'].join('\n');
    const p = parsePapercuspTrailers(body);
    expect(p.agent).toBe('ag');
    expect(p.workItems).toEqual(['WI-1', 'WI-2']);
  });

  it('ignores a Papercusp-Work-Item with empty/whitespace tokens', () => {
    expect(parsePapercuspTrailers('s\n\nPapercusp-Work-Item: , WI-1 ,').workItems).toEqual(['WI-1']);
  });

  it('handles an empty / undefined body without throwing', () => {
    expect(parsePapercuspTrailers('')).toEqual({ workItems: [] });
    expect(parsePapercuspTrailers(undefined as unknown as string)).toEqual({ workItems: [] });
  });
});
