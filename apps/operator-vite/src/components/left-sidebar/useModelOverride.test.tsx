// @vitest-environment jsdom
/**
 * useModelOverride — read/write hook behind the Sentinel + Overwatch model pickers
 * (model-override-sidebar-2026-06-23). The load-bearing case is the REGRESSION
 * guard: the write MUST carry `hive: <home>` — `hive:set-steering` defaults to
 * hive '*' (not a real Hive) and silently rejects otherwise (caught live
 * 2026-06-25, after 99 green unit tests missed it because they passed the hive
 * explicitly). Also covers the home-hive-scoped read and the merge-preserves-peer
 * write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';

// Mock the sync layer: one call per queryName, in hook-call order.
const syncData: Record<string, unknown[]> = {};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({ data: syncData[queryName] ?? [] }),
}));
// QueenTab pulls in heavy deps; the hook only needs resolveHomeHive — stub it.
vi.mock('./QueenTab', () => ({
  resolveHomeHive: (projects: Array<{ slug: string; harness_kind?: string | null }>, rows: Array<{ slug: string }>) =>
    projects.find((p) => p.harness_kind === 'hive')?.slug || rows[0]?.slug || '',
}));

import { useModelOverride } from './useModelOverride';

function Harness({ role, write }: { role: string; write: string | null }) {
  const { override, setOverride } = useModelOverride(role);
  return (
    <div>
      <span data-testid="override">{override ?? 'none'}</span>
      <button onClick={() => setOverride(write)}>go</button>
    </div>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const k of Object.keys(syncData)) delete syncData[k];
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function lastBody() {
  const call = fetchMock.mock.calls.at(-1)!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('useModelOverride', () => {
  it('reads the HOME hive row (first kind:hive project), not row[0]', () => {
    syncData['hive.steering'] = [
      { slug: 'sub', modelOverrides: { sentinel: 'haiku' } },
      { slug: 'home', modelOverrides: { sentinel: 'opus:high' } },
    ];
    syncData['harnessProjects.lite'] = [
      { slug: 'sub', harness_kind: 'project' },
      { slug: 'home', harness_kind: 'hive' },
    ];
    const { getByTestId } = render(<Harness role="sentinel" write="opus" />);
    expect(getByTestId('override').textContent).toBe('opus:high');
  });

  it('writes hive:set-steering WITH hive: <home> (regression: must not default to *)', () => {
    syncData['hive.steering'] = [{ slug: 'home', modelOverrides: null }];
    syncData['harnessProjects.lite'] = [{ slug: 'home', harness_kind: 'hive' }];
    const { getByText } = render(<Harness role="overwatch" write="sonnet" />);
    fireEvent.click(getByText('go'));
    const body = lastBody();
    expect(body.name).toBe('hive:set-steering');
    expect(body.confirmed).toBe(true);
    expect(body.args.hive).toBe('home');
    expect(body.args.modelOverrides).toEqual({ overwatch: 'sonnet' });
  });

  it('merges so a peer role override survives', () => {
    syncData['hive.steering'] = [{ slug: 'home', modelOverrides: { sentinel: 'opus:high' } }];
    syncData['harnessProjects.lite'] = [{ slug: 'home', harness_kind: 'hive' }];
    const { getByText } = render(<Harness role="overwatch" write="sonnet" />);
    fireEvent.click(getByText('go'));
    expect(lastBody().args.modelOverrides).toEqual({ sentinel: 'opus:high', overwatch: 'sonnet' });
  });

  it('clearing the last override sends modelOverrides: null', () => {
    syncData['hive.steering'] = [{ slug: 'home', modelOverrides: { sentinel: 'opus:high' } }];
    syncData['harnessProjects.lite'] = [{ slug: 'home', harness_kind: 'hive' }];
    const { getByText } = render(<Harness role="sentinel" write={null} />);
    fireEvent.click(getByText('go'));
    expect(lastBody().args.modelOverrides).toBeNull();
  });
});
