// @vitest-environment jsdom
/**
 * AdminOps.test.tsx — render-tier coverage for the admin "Ops" command board.
 * It fetches /api/admin/commands, partitions the specs into Building / Running /
 * Simulators sections, and renders a CommandCard per spec (stubbed here to a
 * marker so we assert the partitioning + section states without the heavy
 * SSE-driven card). Covers: the loading state, the populated grid + correct
 * section bucketing, the per-section empty hint, and the fetch-error banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('./CommandCard', () => ({
  default: ({ spec }: { spec: { id: string; label: string } }) => (
    <div data-testid="cmd-card" data-id={spec.id}>{spec.label}</div>
  ),
}));

import AdminOps from './AdminOps';

let commandsBody: unknown;
let commandsOk: boolean;
function installFetch() {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes('/api/admin/commands')) {
      if (!commandsOk) return new Response('err', { status: 500 });
      return new Response(JSON.stringify(commandsBody), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

function spec(id: string, section: string) {
  return { id, label: `cmd-${id}`, section, command: 'echo', cwd: '/' };
}

beforeEach(() => {
  commandsBody = { commands: [] };
  commandsOk = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminOps (admin command board)', () => {
  it('renders the three section titles and the intro copy', async () => {
    installFetch();
    render(<AdminOps />);
    expect(screen.getByRole('heading', { name: 'Building' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Running' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Simulators' })).toBeTruthy();
    expect(screen.getByText(/Output streams via SSE/i)).toBeTruthy();
  });

  it('shows the loading state before the commands resolve', () => {
    // A never-resolving fetch keeps commands === null → "loading…".
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    render(<AdminOps />);
    expect(screen.getAllByText('loading…').length).toBe(3); // one per section
  });

  it('partitions the loaded commands into the right sections', async () => {
    commandsBody = {
      commands: [
        spec('b1', 'building'),
        spec('r1', 'running'),
        spec('r2', 'running'),
        spec('s1', 'simulators'),
      ],
    };
    installFetch();
    render(<AdminOps />);
    await waitFor(() => expect(screen.getAllByTestId('cmd-card').length).toBe(4));
    expect(screen.getByText('cmd-b1')).toBeTruthy();
    expect(screen.getByText('cmd-r1')).toBeTruthy();
    expect(screen.getByText('cmd-r2')).toBeTruthy();
    expect(screen.getByText('cmd-s1')).toBeTruthy();
  });

  it('shows a per-section empty hint when a section has no commands', async () => {
    commandsBody = { commands: [spec('b1', 'building')] };
    installFetch();
    render(<AdminOps />);
    // Building is populated; Running + Simulators are empty.
    await waitFor(() => expect(screen.getByText('cmd-b1')).toBeTruthy());
    expect(screen.getByText('No running commands registered.')).toBeTruthy();
    expect(screen.getByText('No simulator commands registered.')).toBeTruthy();
  });

  it('surfaces a fetch-error banner when /api/admin/commands fails', async () => {
    commandsOk = false;
    installFetch();
    render(<AdminOps />);
    expect(await screen.findByText(/Failed to load commands:/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 500/i)).toBeTruthy();
  });
});
