import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatAction } from './registry';
import type { ChatActionContext } from './types';
import type { CardOption, CardPresentation } from '@papercusp/agent-mcp';

const fetchSyncQueryMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  fetchSyncQuery: (...args: unknown[]) => fetchSyncQueryMock(...args),
}));

// Side-effect import — registers posture-grade into the shared registry once
// for this file (same pattern as PostureActions.test.ts / SessionActions.test.ts).
import './GradeAction';

const ctx: ChatActionContext = { sessionOwnerId: 'su-abc123' };

/** Narrow a CardPresentation to an option-bearing member and pull `options`. */
function optionsOf(presentation: CardPresentation | undefined): CardOption[] {
  if (
    !presentation ||
    (presentation.kind !== 'radio' && presentation.kind !== 'checkbox' && presentation.kind !== 'select')
  ) {
    throw new Error(`expected an option-bearing presentation, got ${presentation?.kind ?? 'undefined'}`);
  }
  return presentation.options;
}

const RUBRIC_ROWS = [
  { rubricId: 'hive-coordination-health', characteristic: 'hive-coordination', title: 'Hive Coordination Health', status: 'active' },
  { rubricId: 'draft-thing', characteristic: 'something', title: 'Draft Thing', status: 'proposed' },
  { rubricId: 'old-retired', characteristic: 'legacy', title: 'Old Retired Rubric', status: 'retired' },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchSyncQueryMock.mockReset();
  fetchSyncQueryMock.mockResolvedValue(RUBRIC_ROWS);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GradeAction — registration', () => {
  it('registers posture-grade in the "posture" group', () => {
    const action = getChatAction('posture-grade');
    expect(action).toBeDefined();
    expect(action?.group).toBe('posture');
  });

  it('is available only when the context carries a sessionOwnerId', () => {
    const action = getChatAction('posture-grade')!;
    expect(action.available(ctx)).toBe(true);
    expect(action.available({ sessionOwnerId: '' })).toBe(false);
  });
});

describe('GradeAction — params (async rubric picker)', () => {
  it('WI-6552: the dropdown rests on "Grade" and the prompt EXPLAINS what grade mode is', async () => {
    const action = getChatAction('posture-grade')!;
    const spec = await action.params!(ctx);
    const p = spec.presentation!;
    if (p.kind !== 'select') throw new Error(`expected select, got ${p.kind}`);
    // [owner 2026-07-27] "a simple dropdown with the default text 'Grade'".
    expect(p.placeholder).toBe('Grade');
    // [owner 2026-07-27] "something that comes up that explains what grade
    // mode is". The old prompt ("Pick a rubric to grade against") named the
    // input without ever saying what grade mode DOES, which is what left the
    // owner unsure what picking a rubric committed them to. Assert the prompt
    // actually explains the behaviour rather than merely being non-empty.
    expect(spec.prompt).toMatch(/grade mode/i);
    expect(spec.prompt).toMatch(/rubric/i);
    expect(spec.prompt.length).toBeGreaterThan(60);
    expect(spec.prompt).not.toBe('Pick a rubric to grade against');
  });

  it('fetches rubrics.list via fetchSyncQuery and offers only ACTIVE rubrics as select options', async () => {
    const action = getChatAction('posture-grade')!;
    const spec = await action.params!(ctx);
    expect(fetchSyncQueryMock).toHaveBeenCalledWith({ queryName: 'rubrics.list', args: {} });
    // WI-6552 [owner 2026-07-27]: MUST be the compact 'select', not 'radio'.
    // radio renders one full-width row per rubric and filled the whole chat
    // popup. This assertion is the guard against that regressing.
    expect(spec.presentation?.kind).toBe('select');
    expect(spec.allowDecline).toBe(true);
    const options = optionsOf(spec.presentation);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      id: 'hive-coordination-health',
      label: 'Hive Coordination Health',
      hint: 'hive-coordination',
    });
  });

  it('excludes proposed and retired rubrics', async () => {
    const action = getChatAction('posture-grade')!;
    const spec = await action.params!(ctx);
    const ids = optionsOf(spec.presentation).map((o) => o.id);
    expect(ids).not.toContain('draft-thing');
    expect(ids).not.toContain('old-retired');
  });

  it('offers no options when there are no active rubrics', async () => {
    fetchSyncQueryMock.mockResolvedValueOnce([]);
    const action = getChatAction('posture-grade')!;
    const spec = await action.params!(ctx);
    expect(optionsOf(spec.presentation)).toEqual([]);
  });
});

describe('GradeAction — run()', () => {
  it('picking a rubric posts a single grade mode:set enabled:true with the rubric id in the reason', async () => {
    const action = getChatAction('posture-grade')!;
    await action.run(ctx, { picks: ['hive-coordination-health'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/mode/set');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ mode: 'grade', enabled: true, agent: 'su-abc123', ownerDirected: true });
    expect(body.reason).toMatch(/hive-coordination-health/);
  });

  it('a non-ok response throws with the mode + status in the message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const action = getChatAction('posture-grade')!;
    await expect(action.run(ctx, { picks: ['hive-coordination-health'] })).rejects.toThrow(/mode:set\(grade\).*500/);
  });

  it('a stickyConflict response throws a distinct, explanatory error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ ok: false, stickyConflict: true }),
    });
    const action = getChatAction('posture-grade')!;
    await expect(action.run(ctx, { picks: ['hive-coordination-health'] })).rejects.toThrow(/owner-directed incumbent/);
  });
});
