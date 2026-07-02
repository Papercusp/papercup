// @vitest-environment jsdom
/**
 * StepLocalModel.test.tsx — render-tier coverage for the SetupWizard "Local inference" step
 * (local-concurrent-inference-2026-07-02 P-009). Seeds /api/desktop/local-model-status and
 * asserts the recommendation summary, the blocked state, the config-only Install action, and —
 * the hard invariant for this task — that the GPU-touching "Start backend" action is (a) hidden
 * until config-only install has registered the backend, (b) disabled until the operator checks
 * the confirmation box, and (c) POSTs `{start:true}` only on explicit click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StepLocalModel } from './StepLocalModel';

let statusPlan: Record<string, unknown>;
let installBody: unknown;
let installResponse: Record<string, unknown>;

function installFetch() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/desktop/local-model-status')) {
      return new Response(JSON.stringify({ ok: true, plan: statusPlan }), { status: 200 });
    }
    if (u.includes('/api/desktop/local-model-install')) {
      installBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify(installResponse), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

const okEntry = {
  id: 'ornith-35b-iq3m-llama-server',
  displayName: 'ornith-35b (IQ3_M) via llama-server',
  backend: 'llama-server',
  status: 'provisional' as const,
  model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M', quant: 'IQ3_M', sizeGB: 15.5 },
};

beforeEach(() => {
  statusPlan = {
    hardware: { platform: 'linux', arch: 'x64', ramGB: 251.5, gpu: { vendor: 'nvidia', model: 'RTX 3090', vramGB: 24 }, notes: [] },
    recommendation: { entry: okEntry, tier: 'nvidia-24gb-plus', reason: 'best fit for 24GB VRAM' },
    weights: { needsDownload: false, weightsPath: '/blobs/sha256-x', detail: 'found locally' },
    backendId: 'provisioner-ornith-35b-iq3m-llama-server',
    unitFilePath: '/home/x/.config/systemd/user/provisioner-ornith-35b-iq3m-llama-server.service',
    blocked: null,
  };
  installResponse = { ok: true, result: { ok: true, wroteUnit: true, registered: true, started: false } };
  installBody = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepLocalModel (SetupWizard local-inference step)', () => {
  it('renders the recommendation with the provisional badge and reason', async () => {
    installFetch();
    render(<StepLocalModel />);
    expect(await screen.findByText('ornith-35b (IQ3_M) via llama-server')).toBeTruthy();
    expect(screen.getByText(/provisional — not yet certified/i)).toBeTruthy();
    expect(screen.getByText(/best fit for 24GB VRAM/i)).toBeTruthy();
  });

  it('shows the blocked reason and hides the install action when blocked', async () => {
    statusPlan = { ...statusPlan, blocked: 'weights not present locally — run `ollama pull …`' };
    installFetch();
    render(<StepLocalModel />);
    expect(await screen.findByText(/Blocked:/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install \(config only/i })).toBeNull();
  });

  it('shows "no combo fits" when there is no recommended entry', async () => {
    statusPlan = { ...statusPlan, recommendation: { entry: null, tier: 'cpu-only', reason: 'no GPU detected — use the cloud gateway' } };
    installFetch();
    render(<StepLocalModel />);
    expect(await screen.findByText('No local combo fits this hardware.')).toBeTruthy();
    expect(screen.getByText(/use the cloud gateway/i)).toBeTruthy();
  });

  it('config-only install POSTs {start:false} and does NOT reveal the start action by itself', async () => {
    installFetch();
    render(<StepLocalModel />);
    const installBtn = await screen.findByRole('button', { name: /Install \(config only, no GPU load\)/i });
    fireEvent.click(installBtn);
    await waitFor(() => expect(installBody).toEqual({ start: false }));
    // registered:true, started:false → the gated start action DOES become available (that's
    // the intended next step), but it must start disabled until confirmed.
    const startBtn = await screen.findByRole('button', { name: /Start backend \(loads model onto GPU\)/i });
    expect((startBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('the GPU-loading start action stays disabled until the confirmation checkbox is checked, and only then POSTs {start:true}', async () => {
    installFetch();
    render(<StepLocalModel />);
    fireEvent.click(await screen.findByRole('button', { name: /Install \(config only, no GPU load\)/i }));
    const startBtn = await screen.findByRole('button', { name: /Start backend \(loads model onto GPU\)/i });
    expect((startBtn as HTMLButtonElement).disabled).toBe(true);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect((startBtn as HTMLButtonElement).disabled).toBe(false);

    installResponse = { ok: true, result: { ok: true, wroteUnit: true, registered: true, started: true } };
    fireEvent.click(startBtn);
    await waitFor(() => expect(installBody).toEqual({ start: true }));
  });

  it('surfaces an install error without throwing', async () => {
    installResponse = { ok: false, error: 'systemd unit write failed' };
    installFetch();
    render(<StepLocalModel />);
    fireEvent.click(await screen.findByRole('button', { name: /Install \(config only, no GPU load\)/i }));
    expect(await screen.findByText(/systemd unit write failed/i)).toBeTruthy();
  });
});
