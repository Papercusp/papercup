// @vitest-environment jsdom
/**
 * StepEmbeddedPg.test.tsx — render-tier coverage for the SetupWizard "bundled
 * Postgres" step. A per-URL fetch router seeds /api/desktop/preflight; the step
 * polls it (3s interval) and renders the postgres check's status branch:
 * loading → Checking…, ok → Ready, missing → Starting up, error → Failed, and
 * the no-status / no-check fallbacks. The poll interval is real but we assert
 * the first tick via findBy*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StepEmbeddedPg } from './StepEmbeddedPg';

let checks: unknown[];
function installFetch() {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/desktop/preflight')) {
      return new Response(JSON.stringify({ checks }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  checks = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepEmbeddedPg (SetupWizard bundled-postgres step)', () => {
  it('renders the lead copy', () => {
    installFetch();
    render(<StepEmbeddedPg />);
    expect(screen.getByText(/bundles its own Postgres binary/i)).toBeTruthy();
  });

  it('shows the ok branch (Ready + detail) when postgres reports ok', async () => {
    checks = [{ name: 'postgres', status: 'ok', detail: 'pg 16 on :5544' }];
    installFetch();
    render(<StepEmbeddedPg />);
    expect(await screen.findByText('Ready.')).toBeTruthy();
    expect(screen.getByText('pg 16 on :5544')).toBeTruthy();
  });

  it('shows the missing branch (Starting up) when postgres is missing', async () => {
    checks = [{ name: 'postgres', status: 'missing', detail: 'waiting for socket' }];
    installFetch();
    render(<StepEmbeddedPg />);
    expect(await screen.findByText('Starting up.')).toBeTruthy();
    expect(screen.getByText('waiting for socket')).toBeTruthy();
  });

  it('shows the error branch (Failed to start) when postgres errors', async () => {
    checks = [{ name: 'postgres', status: 'error', detail: 'port in use' }];
    installFetch();
    render(<StepEmbeddedPg />);
    expect(await screen.findByText('Failed to start.')).toBeTruthy();
    expect(screen.getByText('port in use')).toBeTruthy();
  });

  it('shows the no-status fallback when no postgres check is present', async () => {
    checks = [{ name: 'gh', status: 'ok' }];
    installFetch();
    render(<StepEmbeddedPg />);
    expect(await screen.findByText('No status reported.')).toBeTruthy();
  });

  it('renders the hint when the postgres check supplies one', async () => {
    checks = [{ name: 'postgres', status: 'error', detail: 'boom', hint: 'try restarting the app' }];
    installFetch();
    render(<StepEmbeddedPg />);
    expect(await screen.findByText('try restarting the app')).toBeTruthy();
  });
});
