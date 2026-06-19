// @vitest-environment jsdom
/**
 * StepMobilePairing.test.tsx — render-tier coverage for the SetupWizard mobile
 * pairing step. Drives the mint flow against a per-URL fetch router: the
 * pre-mint instructions + button, the success branch (QR img + remaining-seconds
 * caption), the expired branch (when the minted token's expiresAt is in the
 * past), and the error branch (non-ok mint). RouteLink is stubbed to a plain
 * anchor; the 1s clock interval is real but the assertions key off findBy*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../RouteLink', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { StepMobilePairing } from './StepMobilePairing';

let mintOk: boolean;
let expiresAt: number;
let posts: number;
function installFetch() {
  posts = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/device/desktop/mint-pair-token')) {
      posts += 1;
      if (!mintOk) return new Response('{}', { status: 500 });
      return new Response(
        JSON.stringify({
          qrPayload: { server: 'https://x', pairToken: 'tok-1', workspaceId: 'default' },
          expiresAt,
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  mintOk = true;
  expiresAt = Date.now() + 120_000; // 2 min in the future
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepMobilePairing (SetupWizard mobile-pairing step)', () => {
  it('renders the lead copy + instructions + the generate button before minting', () => {
    installFetch();
    render(<StepMobilePairing />);
    expect(screen.getByText(/Pair the Papercusp companion app/i)).toBeTruthy();
    expect(screen.getByText(/Install the Papercusp companion app/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Generate pairing QR code/i })).toBeTruthy();
  });

  it('mints a token on click and shows the QR image + a live remaining-seconds caption', async () => {
    installFetch();
    render(<StepMobilePairing />);
    fireEvent.click(screen.getByRole('button', { name: /Generate pairing QR code/i }));
    const img = (await screen.findByAltText('Pairing QR code')) as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('/api/device/qr.svg?payload=');
    expect(screen.getByText(/Scan from the companion app\./i)).toBeTruthy();
    // The pre-mint instructions list is gone once a QR is showing.
    expect(screen.queryByText(/Install the Papercusp companion app/i)).toBeNull();
  });

  it('shows the Expired branch with a regenerate link when the token is already expired', async () => {
    expiresAt = Date.now() - 1000; // already in the past
    installFetch();
    render(<StepMobilePairing />);
    fireEvent.click(screen.getByRole('button', { name: /Generate pairing QR code/i }));
    expect(await screen.findByText('Expired.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Generate a new one/i })).toBeTruthy();
  });

  it('surfaces the error branch when minting fails (non-ok response)', async () => {
    mintOk = false;
    installFetch();
    render(<StepMobilePairing />);
    fireEvent.click(screen.getByRole('button', { name: /Generate pairing QR code/i }));
    expect(await screen.findByText(/Couldn.t generate\./i)).toBeTruthy();
    expect(screen.getByText(/HTTP 500/i)).toBeTruthy();
  });

  it('the generate button shows "Generating…" while the mint is in flight', async () => {
    // Slow the mint so the busy state is observable.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = () => r(); });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('mint-pair-token')) {
        await gate;
        return new Response(
          JSON.stringify({ qrPayload: { server: 's', pairToken: 't', workspaceId: 'default' }, expiresAt: Date.now() + 60_000 }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    render(<StepMobilePairing />);
    fireEvent.click(screen.getByRole('button', { name: /Generate pairing QR code/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Generating…/i })).toBeTruthy());
    release!();
    await screen.findByAltText('Pairing QR code');
  });
});
