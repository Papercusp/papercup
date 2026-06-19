// @vitest-environment jsdom
/**
 * BranchActionRunner — modal that POSTs to start a per-branch action run, then
 * streams it via <StructuredStreamView>. Lives in the esbuild-stripped
 * _components tier, so wiring bugs only surface under a render+interaction test.
 * We drive: the start-run POST (success → streaming + the stream view mounts),
 * the 412 missing-keys branch (key list + configure link), a non-ok error, the
 * existingRunId attach path (skips the POST), and the Close handler. The Modal,
 * lexicon, and StructuredStreamView are stubbed; fetch is stubbed per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Modal → a plain div so the content renders without Radix portal scaffolding.
vi.mock('../harness/Modal', () => ({
  Modal: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div role="dialog" aria-label={title ?? 'modal'}>{children}</div>
  ),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (term: string) => term }));
// The stream view is the heavy SSE child — stub to a marker that echoes the url.
vi.mock('./StructuredStreamView', () => ({
  StructuredStreamView: ({ url }: { url: string }) => <div data-testid="stream" data-url={url} />,
}));
// The step-projection helpers are pure; stub to inert values so the import resolves.
vi.mock('./branch-action-stream-steps', () => ({
  BRANCH_ACTION_EVENT_KINDS: ['output'],
  classifyBranchActionTerminal: () => ({ kind: 'success' }),
  deriveBranchActionSteps: () => [],
  renderBranchActionRawLine: (l: string) => l,
}));

import BranchActionRunner from './BranchActionRunner';

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('BranchActionRunner (per-branch action modal)', () => {
  it('starts a run via POST, then mounts the stream view with the run id', async () => {
    stubFetch(async () => new Response(JSON.stringify({ runId: 'run-42' }), { status: 200 }));
    render(<BranchActionRunner slug="my-pot" branch="staging" name="deploy" onClose={vi.fn()} />);

    const stream = await screen.findByTestId('stream');
    const url = stream.getAttribute('data-url') ?? '';
    expect(url).toContain('runId=run-42');
    expect(url).toContain('/api/harness/my-pot/branch/staging/action-stream');
  });

  it('renders the missing-keys panel on a 412 response', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ missing: [{ name: 'OPENAI_KEY', plugin: 'openai' }] }), { status: 412 }),
    );
    render(<BranchActionRunner slug="my-pot" branch="production" name="release" onClose={vi.fn()} />);

    expect(await screen.findByText('Required keys missing')).toBeTruthy();
    expect(screen.getByText('OPENAI_KEY')).toBeTruthy();
    // The configure CTA links to the plugin panel.
    const link = screen.getByText(/Configure openai/);
    expect(link.getAttribute('href')).toContain('panel=plugins');
  });

  it('surfaces the error row when the start POST is not ok', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    render(<BranchActionRunner slug="my-pot" branch="testing" name="check" onClose={vi.fn()} />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });

  it('attaches to an existing run id without POSTing, mounting the stream directly', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <BranchActionRunner slug="my-pot" branch="staging" name="deploy" existingRunId="run-9" onClose={vi.fn()} />,
    );
    const stream = await screen.findByTestId('stream');
    expect(stream.getAttribute('data-url')).toContain('runId=run-9');
    // The start-run POST is skipped when an existing run id is supplied.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls onClose when the header Close button is clicked', async () => {
    const onClose = vi.fn();
    render(<BranchActionRunner slug="my-pot" branch="staging" name="deploy" existingRunId="run-1" onClose={onClose} />);
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
