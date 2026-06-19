// @vitest-environment jsdom
/**
 * StepWorkspace.test.tsx — render-tier coverage for the SetupWizard "Workspace"
 * step. Drives the /api/profile seed, the debounced /api/desktop/workspace-validate
 * ping (fake timers), and the Save POST. isTauri is mocked so the "Choose folder…"
 * branch and the browser-only hint are both reachable; the @tauri-apps invoke is
 * stubbed; Tooltip is passthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let tauri = false;
vi.mock('./tauri-detect', () => ({ isTauri: () => tauri }));
const invokeMock = vi.fn(async () => '/picked/dir');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { StepWorkspace } from './StepWorkspace';

/* fetch router: GET /api/profile → profileBody; POST /api/profile records;
 * POST /api/desktop/workspace-validate → validateBody. */
let profileBody: unknown;
let validateBody: unknown;
let profilePosts: unknown[];
function installFetch() {
  profilePosts = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/desktop/workspace-validate')) {
      return new Response(JSON.stringify(validateBody), { status: 200 });
    }
    if (u.includes('/api/profile')) {
      if (init?.method === 'POST') {
        profilePosts.push(JSON.parse(String(init.body)));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify(profileBody), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  tauri = false;
  profileBody = { default_project_dir: '' };
  validateBody = { ok: true, normalized: '/home/u/projects', exists: false, writable: true };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('StepWorkspace (SetupWizard workspace step)', () => {
  it('renders the lead copy and the directory input', async () => {
    installFetch();
    render(<StepWorkspace />);
    expect(screen.getByText(/This is where Papercusp creates new project folders/i)).toBeTruthy();
    expect(await screen.findByPlaceholderText('~/papercusp-projects')).toBeTruthy();
  });

  it('seeds the input from /api/profile.default_project_dir', async () => {
    profileBody = { default_project_dir: '/seed/path' };
    installFetch();
    render(<StepWorkspace />);
    await waitFor(() => {
      const input = screen.getByPlaceholderText('~/papercusp-projects') as HTMLInputElement;
      expect(input.value).toBe('/seed/path');
    });
  });

  it('hides the folder-picker button and shows the browser hint when not in Tauri', async () => {
    installFetch();
    render(<StepWorkspace />);
    await screen.findByPlaceholderText('~/papercusp-projects');
    expect(screen.queryByRole('button', { name: /Choose folder/i })).toBeNull();
    expect(screen.getByText(/A native folder picker appears here/i)).toBeTruthy();
  });

  it('shows the folder-picker button in Tauri and fills the input from invoke()', async () => {
    tauri = true;
    installFetch();
    render(<StepWorkspace />);
    const pick = await screen.findByRole('button', { name: /Choose folder/i });
    fireEvent.click(pick);
    await waitFor(() => {
      const input = screen.getByPlaceholderText('~/papercusp-projects') as HTMLInputElement;
      expect(input.value).toBe('/picked/dir');
    });
    expect(invokeMock).toHaveBeenCalled();
  });

  it('debounced validation: shows the ok hint after typing settles (real 350ms debounce)', async () => {
    installFetch();
    render(<StepWorkspace />);
    const input = (await screen.findByPlaceholderText('~/papercusp-projects')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/home/u/projects' } });
    // waitFor polls past the real 350ms debounce until the validate hint lands.
    await waitFor(() => expect(screen.getByText(/Will be created/i)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText('/home/u/projects')).toBeTruthy();
  });

  it('debounced validation: shows the error hint when validate replies not-ok', async () => {
    validateBody = { ok: false, reason: 'not an absolute path' };
    installFetch();
    render(<StepWorkspace />);
    const input = (await screen.findByPlaceholderText('~/papercusp-projects')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/x' } });
    await waitFor(() => expect(screen.getByText(/not an absolute path/i)).toBeTruthy(), { timeout: 2000 });
  });

  it('Save POSTs the directory to /api/profile and shows "Saved."', async () => {
    installFetch();
    render(<StepWorkspace />);
    const input = (await screen.findByPlaceholderText('~/papercusp-projects')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/save/me' } });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    await waitFor(() => expect(profilePosts.length).toBe(1));
    expect((profilePosts[0] as { default_project_dir: string }).default_project_dir).toBe('/save/me');
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  });
});
