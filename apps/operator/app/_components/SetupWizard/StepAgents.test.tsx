// @vitest-environment jsdom
/**
 * StepAgents.test.tsx — render-tier coverage for the SetupWizard "Agent backend"
 * step. Seeds agentRuntime from /api/desktop/setup-status and asserts the
 * ready/missing summary, the per-runtime breakdown rows (incl. the omp-half
 * detail), the Tauri-only install button vs the browser fallback, the
 * manual-commands toggle, and the install-command fetch failure path. The pty
 * tauri detector + InlinePtyTerminal are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let tauriNative = false;
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({ isTauriNative: () => tauriNative }));
// Stub the pty terminal — when installSpec is set we just want to know it mounted.
vi.mock('./InlinePtyTerminal', () => ({
  InlinePtyTerminal: () => <div data-testid="pty-terminal" />,
}));

import { StepAgents } from './StepAgents';

/* fetch router. statusBody → setup-status.agentRuntime; setup-pty-commands →
 * ptyCommands (or a non-ok when ptyFails). */
let agentRuntime: Record<string, boolean>;
let ptyFails: boolean;
function installFetch() {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/desktop/setup-status')) {
      return new Response(JSON.stringify({ agentRuntime }), { status: 200 });
    }
    if (u.includes('/api/desktop/setup-pty-commands')) {
      if (ptyFails) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ installRuntime: { command: 'bash', args: ['-c', 'x'], cwd: '/', env: {} } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  tauriNative = false;
  agentRuntime = { claude: false, codex: false, omp: false, meridian: false };
  ptyFails = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepAgents (SetupWizard agent-backend step)', () => {
  it('renders the lead copy and, with nothing installed, the "No agent backend yet" summary', async () => {
    installFetch();
    render(<StepAgents />);
    expect(screen.getByText(/Papercusp needs an/i)).toBeTruthy();
    expect(await screen.findByText('No agent backend yet.')).toBeTruthy();
  });

  it('shows "Ready." with Claude Code named when claude is installed', async () => {
    agentRuntime = { claude: true, codex: false, omp: false, meridian: false };
    installFetch();
    render(<StepAgents />);
    expect(await screen.findByText('Ready.')).toBeTruthy();
    expect(screen.getByText(/Claude Code installed\./i)).toBeTruthy();
  });

  it('renders the per-runtime breakdown rows with the omp half-missing detail', async () => {
    agentRuntime = { claude: false, codex: false, omp: true, meridian: false };
    installFetch();
    render(<StepAgents />);
    expect(await screen.findByText('oh-my-pi + Meridian')).toBeTruthy();
    // omp installed but meridian missing → the row names the missing half.
    expect(screen.getByText(/oh-my-pi installed — Meridian missing\./i)).toBeTruthy();
    // Still "no backend" overall (omp path needs both halves).
    expect(screen.getByText('No agent backend yet.')).toBeTruthy();
  });

  it('treats omp + meridian together as a complete backend (Ready)', async () => {
    agentRuntime = { claude: false, codex: false, omp: true, meridian: true };
    installFetch();
    render(<StepAgents />);
    expect(await screen.findByText('Ready.')).toBeTruthy();
    expect(screen.getByText(/oh-my-pi \+ Meridian installed\./i)).toBeTruthy();
  });

  it('outside Tauri: hides the install button and shows the desktop-app hint', async () => {
    installFetch();
    render(<StepAgents />);
    await screen.findByText('No agent backend yet.');
    expect(screen.queryByRole('button', { name: /Install Agent Runtime/i })).toBeNull();
    expect(screen.getByText(/Open this in the desktop app to install\./i)).toBeTruthy();
  });

  it('inside Tauri: shows the install button and mounts the pty terminal once install starts', async () => {
    tauriNative = true;
    installFetch();
    render(<StepAgents />);
    const installBtn = await screen.findByRole('button', { name: /Install Agent Runtime/i });
    expect((installBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(installBtn);
    expect(await screen.findByTestId('pty-terminal')).toBeTruthy();
  });

  it('inside Tauri: a failed install-command fetch surfaces the start error', async () => {
    tauriNative = true;
    ptyFails = true;
    installFetch();
    render(<StepAgents />);
    fireEvent.click(await screen.findByRole('button', { name: /Install Agent Runtime/i }));
    expect(await screen.findByText(/Couldn't start the installer/i)).toBeTruthy();
    expect(screen.queryByTestId('pty-terminal')).toBeNull();
  });

  it('toggles the manual-install commands block', async () => {
    installFetch();
    render(<StepAgents />);
    await screen.findByText('No agent backend yet.');
    expect(screen.queryByText(/From a terminal:/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Or install manually/i }));
    expect(screen.getByText(/From a terminal:/i)).toBeTruthy();
    expect(screen.getByText(/Claude Code docs/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Hide manual install commands/i }));
    expect(screen.queryByText(/From a terminal:/i)).toBeNull();
  });
});
