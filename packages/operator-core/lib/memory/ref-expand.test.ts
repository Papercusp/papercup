/**
 * ref-expand — write-time reference expansion for memory embedding (EI-10048).
 * Pure + dep-injected (a stub RefResolver), so no store/PG needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { extractRefs, buildEmbedText, expandRefsForEmbed, MAX_REFS, type RefResolver } from './ref-expand';

const titles: Record<string, string> = {
  'WI-4028': 'Resume age A/B benchmark',
  'EI-10048': 'Write-time ref-expansion for multi-hop recall',
  'F-001': 'Memory canonical store',
};
const stubResolver: RefResolver = async (id) => (titles[id] ? { id, title: titles[id] } : null);

describe('extractRefs', () => {
  it('pulls distinct work-item-class refs (WI/EI/F/D) in first-seen order', () => {
    expect(extractRefs('see WI-4028 and EI-10048, again WI-4028; also D-002')).toEqual([
      'WI-4028',
      'EI-10048',
      'D-002',
    ]);
  });

  it('returns [] when the body has no refs', () => {
    expect(extractRefs('a plain memory with no references at all')).toEqual([]);
  });

  it('does not match bare words or wrong shapes', () => {
    expect(extractRefs('WIP work, FIXME, D-1 too short, WI-999999 too long')).toEqual([]);
  });

  it('caps at MAX_REFS', () => {
    const many = Array.from({ length: MAX_REFS + 5 }, (_, i) => `WI-${1000 + i}`).join(' ');
    expect(extractRefs(many)).toHaveLength(MAX_REFS);
  });
});

describe('buildEmbedText', () => {
  it('appends resolved "ID: title" pairs under a [refs] delimiter', () => {
    const out = buildEmbedText('body', [
      { id: 'WI-4028', title: 'Resume age A/B benchmark' },
      { id: 'EI-10048', title: 'Write-time ref-expansion' },
    ]);
    expect(out).toBe('body\n\n[refs] WI-4028: Resume age A/B benchmark; EI-10048: Write-time ref-expansion');
  });

  it('returns undefined when nothing resolved', () => {
    expect(buildEmbedText('body', [])).toBeUndefined();
  });
});

describe('expandRefsForEmbed', () => {
  it('enriches the embed-text with resolved titles, leaving the body prefix intact', async () => {
    const out = await expandRefsForEmbed('per WI-4028 we rejected fusion', stubResolver);
    expect(out).toBe('per WI-4028 we rejected fusion\n\n[refs] WI-4028: Resume age A/B benchmark');
  });

  it('resolves multiple refs across kinds', async () => {
    const out = await expandRefsForEmbed('WI-4028 feeds EI-10048', stubResolver);
    expect(out).toContain('WI-4028: Resume age A/B benchmark');
    expect(out).toContain('EI-10048: Write-time ref-expansion for multi-hop recall');
  });

  it('returns undefined when the body has no refs (caller keeps the baseline)', async () => {
    expect(await expandRefsForEmbed('no refs here', stubResolver)).toBeUndefined();
  });

  it('returns undefined when refs are present but none resolve', async () => {
    expect(await expandRefsForEmbed('per WI-9999 (unknown)', stubResolver)).toBeUndefined();
  });

  it('skips the refs that do not resolve, keeping the ones that do', async () => {
    const out = await expandRefsForEmbed('WI-4028 and WI-9999', stubResolver);
    expect(out).toBe('WI-4028 and WI-9999\n\n[refs] WI-4028: Resume age A/B benchmark');
  });

  it('is best-effort: a throwing resolver yields undefined, never throws', async () => {
    const boom: RefResolver = async () => {
      throw new Error('pg down');
    };
    await expect(expandRefsForEmbed('per WI-4028', boom)).resolves.toBeUndefined();
  });

  it('resolves refs in parallel (one call per distinct id)', async () => {
    const spy = vi.fn(stubResolver);
    await expandRefsForEmbed('WI-4028 EI-10048 WI-4028', spy);
    expect(spy).toHaveBeenCalledTimes(2); // deduped
  });
});
