// @vitest-environment jsdom
/**
 * Tests for useServerCapabilityCommands — the CommandPalette's server-tool
 * loader (P-004 client half).
 *
 * Covers:
 *  - the fetch → capability-flags derivation: GET /api/agent-mcp/capabilities
 *    rows become palette Commands (id/title/subtitle/section/keywords/icon),
 *    with the eligibility → icon mapping ('confirm' → ⚠, else ⚙);
 *  - the gated fetch: nothing loads while closed; it loads once on open and
 *    does NOT re-fetch on subsequent opens (the `loaded` latch);
 *  - the error / default fallback: a rejected fetch or a non-ok response
 *    yields no commands and does not crash;
 *  - the command `perform` → runServerCapability path (POST run-tool):
 *    success toast, the 409 confirmation_required re-prompt, and an error toast.
 *
 * fetch is stubbed via vi.stubGlobal; sonner.toast is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useServerCapabilityCommands } from './use-server-capabilities';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toast };
});
import { toast } from 'sonner';

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  (toast as unknown as ReturnType<typeof vi.fn>).mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function okJson(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, statusText: 'OK' } as unknown as Response;
}
function notOk(status: number, body: unknown = {}): Response {
  return { ok: false, status, json: async () => body, statusText: 'Err' } as unknown as Response;
}

const CAPS = [
  {
    id: 'goals:list',
    title: 'Goals: List',
    description: 'List all goals',
    eligibility: 'fire-and-toast' as const,
  },
  {
    id: 'plans:delete',
    title: 'Plans: Delete',
    description: 'Delete a plan',
    eligibility: 'confirm' as const,
  },
];

/** Route capabilities GET + run-tool POST. */
function routeFetch(opts: {
  caps?: () => Response | Promise<Response>;
  run?: () => Response | Promise<Response>;
}) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/agent-mcp/capabilities')) {
      return opts.caps ? opts.caps() : okJson({ capabilities: CAPS });
    }
    if (url.includes('/api/agent-mcp/run-tool')) {
      return opts.run ? opts.run() : okJson({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('useServerCapabilityCommands — gating', () => {
  it('does not fetch while closed', () => {
    routeFetch({});
    const { result } = renderHook(() => useServerCapabilityCommands(false));
    expect(result.current).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches once on open and reuses the result across re-opens', async () => {
    routeFetch({});
    const { result, rerender } = renderHook(
      ({ open }) => useServerCapabilityCommands(open),
      { initialProps: { open: true } },
    );

    await waitFor(() => expect(result.current.length).toBe(2));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Close then re-open → the `loaded` latch prevents a refetch.
    rerender({ open: false });
    rerender({ open: true });
    await act(async () => { await Promise.resolve(); });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('useServerCapabilityCommands — capability derivation', () => {
  it('maps rows into palette Commands with the eligibility → icon rule', async () => {
    routeFetch({});
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(result.current.length).toBe(2));

    const [list, del] = result.current;
    expect(list).toMatchObject({
      id: 'goals:list',
      title: 'Goals: List',
      subtitle: 'List all goals',
      section: 'Agent tools',
      keywords: 'goals:list List all goals',
      icon: '⚙', // fire-and-toast
    });
    expect(typeof list.perform).toBe('function');

    expect(del).toMatchObject({
      id: 'plans:delete',
      icon: '⚠', // confirm
      section: 'Agent tools',
    });
  });

  it('treats a missing capabilities key as an empty list', async () => {
    routeFetch({ caps: () => okJson({}) });
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    // Wait for the fetch to settle, then assert it stayed empty.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toEqual([]);
  });
});

describe('useServerCapabilityCommands — error / default fallback', () => {
  it('degrades to no commands on a non-ok capabilities response', async () => {
    routeFetch({ caps: () => notOk(403) });
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual([]);
  });

  it('degrades to no commands when the fetch rejects (no crash)', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual([]);
  });
});

describe('useServerCapabilityCommands — perform() → run-tool', () => {
  it('fires the tool and toasts success on a 200', async () => {
    let runBody: unknown;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/agent-mcp/capabilities')) return okJson({ capabilities: CAPS });
      if (url.includes('/api/agent-mcp/run-tool')) {
        runBody = JSON.parse(init!.body as string);
        return okJson({ ok: true });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(result.current.length).toBe(2));

    await act(async () => {
      result.current[0].perform();
      await Promise.resolve();
    });

    expect(runBody).toEqual({ name: 'goals:list', args: {}, confirmed: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ran goals:list'));
  });

  it('re-prompts with a confirm action on 409 confirmation_required', async () => {
    routeFetch({ run: () => notOk(409, { error: 'confirmation_required' }) });
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(result.current.length).toBe(2));

    await act(async () => {
      result.current[1].perform(); // the confirm-eligibility tool
      await Promise.resolve();
    });

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [msg, opts] = (toast as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain('plans:delete');
    expect((opts as { action?: { label?: string } }).action?.label).toBe('Run anyway');
  });

  it('toasts an error when run-tool returns non-ok', async () => {
    routeFetch({ run: () => notOk(500, { message: 'boom' }) });
    const { result } = renderHook(() => useServerCapabilityCommands(true));
    await waitFor(() => expect(result.current.length).toBe(2));

    await act(async () => {
      result.current[0].perform();
      await Promise.resolve();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('goals:list: boom'));
  });
});
