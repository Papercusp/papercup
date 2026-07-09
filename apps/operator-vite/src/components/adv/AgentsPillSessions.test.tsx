// @vitest-environment jsdom
/**
 * AgentsPillSessions — pure URL/sanitize/paging helpers behind the agents-pill
 * session search + inactive-sessions expander (agents-pill-inactive-search-
 * 2026-07-09 P-003/P-004/P-006). The heavy neighbors are mocked exactly like
 * AgentsRunningPill.test.tsx so importing the module stays cheap.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: [] }] }) }));
vi.mock('@/app/coord/presence-ui', () => ({ LivenessDot: () => null }));
vi.mock('@/app/harness/AgentInspectorModal', () => ({ default: () => null }));
vi.mock('@/app/harness/AgentThinkingStream', () => ({ ThinkingDot: () => null }));

import {
  appendEndedPage,
  endedDisplayName,
  endedSessionStreamUrl,
  headlineToSafeHtml,
  searchHitStreamUrl,
  type EndedSessionRow,
} from './AgentsPillSessions';
import type { RosterAgent } from './AgentsRunningPill';

const rosterAgent = (over: Record<string, unknown>) => over as unknown as RosterAgent;

function endedRow(over: Partial<EndedSessionRow> = {}): EndedSessionRow {
  return {
    id: 1,
    planSlug: null,
    agent: null,
    role: null,
    feature: null,
    label: null,
    coordOwnerId: null,
    sessionId: null,
    ompThreadId: null,
    startedAt: '2026-07-09T00:00:00Z',
    endedAt: '2026-07-09T01:00:00Z',
    exitCode: 0,
    ...over,
  };
}

describe('searchHitStreamUrl', () => {
  const base = { active: null, session: null };

  it('claude: session uuid + owner from the hit, find + anchorTs appended', () => {
    const url = searchHitStreamUrl(
      { ...base, sourceKind: 'claude', sessionId: 'sid-1' },
      { ts: '2026-07-09T12:00:00Z', owner: 'su-abc' },
      'red gate',
    );
    expect(url).toBe(
      '/api/adv/session/thinking?sessionId=sid-1&owner=su-abc&find=red%20gate&anchorTs=2026-07-09T12%3A00%3A00Z',
    );
  });

  it('claude: owner falls back active.ownerId → session.coordOwnerId → omitted', () => {
    const s = { sourceKind: 'claude', sessionId: 'sid-1' };
    expect(
      searchHitStreamUrl({ ...s, active: rosterAgent({ ownerId: 'su-live' }), session: null }, { ts: null, owner: null }, 'q!'),
    ).toBe('/api/adv/session/thinking?sessionId=sid-1&owner=su-live&find=q!');
    expect(
      searchHitStreamUrl({ ...s, active: null, session: endedRow({ coordOwnerId: 'su-dead' }) }, { ts: null, owner: null }, 'q!'),
    ).toBe('/api/adv/session/thinking?sessionId=sid-1&owner=su-dead&find=q!');
    expect(searchHitStreamUrl({ ...s, ...base }, { ts: null, owner: null }, 'q!')).toBe(
      '/api/adv/session/thinking?sessionId=sid-1&find=q!',
    );
  });

  it('omp keys by thread id; codex by rollout uuid', () => {
    expect(searchHitStreamUrl({ ...base, sourceKind: 'omp', sessionId: 'tid-9' }, { ts: null, owner: null }, 'x')).toBe(
      '/api/adv/session/thinking?ompThreadId=tid-9&find=x',
    );
    expect(searchHitStreamUrl({ ...base, sourceKind: 'codex', sessionId: 'uuid-7' }, { ts: null, owner: null }, 'x')).toBe(
      '/api/adv/session/thinking?codexRolloutId=uuid-7&find=x',
    );
  });

  it('agent_chat (and anything unknown) has no transcript viewer ⇒ null', () => {
    expect(searchHitStreamUrl({ ...base, sourceKind: 'agent_chat', sessionId: 'c1' }, { ts: null, owner: null }, 'x')).toBeNull();
  });
});

describe('endedSessionStreamUrl', () => {
  it('claude leg: sessionId (+ owner isolation hint when recorded)', () => {
    expect(endedSessionStreamUrl(endedRow({ sessionId: 's1', coordOwnerId: 'su-a' }))).toBe(
      '/api/adv/session/thinking?sessionId=s1&owner=su-a',
    );
    expect(endedSessionStreamUrl(endedRow({ sessionId: 's1' }))).toBe('/api/adv/session/thinking?sessionId=s1');
  });

  it('omp + codex legs, and null when no handle was recorded', () => {
    expect(endedSessionStreamUrl(endedRow({ ompThreadId: 't1' }))).toBe('/api/adv/session/thinking?ompThreadId=t1');
    expect(endedSessionStreamUrl(endedRow({ id: 42, agent: 'codex' }))).toBe(
      '/api/adv/session/thinking?codexSessionKey=42',
    );
    expect(endedSessionStreamUrl(endedRow({ agent: 'claude' }))).toBeNull();
  });
});

describe('headlineToSafeHtml', () => {
  it('escapes transcript HTML but restores the engine <mark> tags', () => {
    expect(headlineToSafeHtml('run <mark>deploy</mark> & <script>alert(1)</script>')).toBe(
      'run <mark>deploy</mark> &amp; &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('does not let a transcript smuggle a fake mark attribute through', () => {
    // Only the engine's bare `<mark>` survives; `<mark onx=...>` stays escaped.
    expect(headlineToSafeHtml('<mark onmouseover=alert(1)>x</mark>')).toBe(
      '&lt;mark onmouseover=alert(1)&gt;x</mark>',
    );
  });
});

describe('endedDisplayName', () => {
  it('label → short owner id → agent #id', () => {
    expect(endedDisplayName(endedRow({ label: ' builder-3 ', coordOwnerId: 'su-x' }))).toBe('builder-3');
    expect(endedDisplayName(endedRow({ coordOwnerId: 'su-ba914b41-b03b-4fdd' }))).toBe('su-ba914b4');
    expect(endedDisplayName(endedRow({ id: 12, agent: 'omp' }))).toBe('omp #12');
    expect(endedDisplayName(endedRow({ id: 12 }))).toBe('session #12');
  });
});

describe('appendEndedPage', () => {
  it('appends in order and drops ids already present (keyset shifted by a fresh ender)', () => {
    const prev = [endedRow({ id: 1 }), endedRow({ id: 2 })];
    const next = appendEndedPage(prev, [endedRow({ id: 2 }), endedRow({ id: 3 })]);
    expect(next.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(appendEndedPage([], [])).toEqual([]);
  });
});
