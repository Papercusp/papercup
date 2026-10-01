// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HumanWorkSection } from './HumanWorkSection';

const available = { offer: { id: 'WI-job', brief: 'Review public onboarding.', rubricRef: 'review@1',
  amountCents: 500, currency: 'USD', status: 'available' }, version: 0, mine: false, submission: null };
const fetchMock = vi.fn();
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response(available));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<HumanWorkSection slug="pilot" id="WI-job" refreshKey="1" />);

describe('HumanWorkSection', () => {
  it('shows sign-in guidance when no real human session exists', async () => {
    fetchMock.mockResolvedValue(response({ error: 'human_session_required' }, 401));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('Sign in to claim work.');
    expect(screen.queryByRole('button', { name: 'Claim this work' })).toBeNull();
  });

  it('lets the signed-in claimant submit once, with displayed version and no asserted identity', async () => {
    mount();
    expect(await screen.findByText('Review public onboarding.')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(response({ ...available, offer: { ...available.offer, status: 'claimed' }, mine: true, version: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Claim this work' }));
    const result = await screen.findByLabelText('Your result');
    const claimCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(claimCall![1].body)).toEqual({ action: 'claim', version: 0 });
    expect((screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(result, { target: { value: 'Reviewed.' } });
    fetchMock.mockResolvedValueOnce(response({ ...available, offer: { ...available.offer, status: 'submitted' },
      mine: true, version: 2, submission: 'Reviewed.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Submitted for independent review.')).toBeTruthy();
    expect(screen.queryByLabelText('Your result')).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ action: 'submit', version: 1, result: 'Reviewed.' });
  });

  it('handles a losing claim without leaving stale claim/submit controls', async () => {
    mount();
    await screen.findByRole('button', { name: 'Claim this work' });
    fetchMock.mockResolvedValueOnce(response({ error: 'market_offer_changed' }, 409));
    fireEvent.click(screen.getByRole('button', { name: 'Claim this work' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already claimed');
    expect(screen.queryByRole('button', { name: 'Claim this work' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Refresh human work' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('refreshes with the existing detail query invalidation and ignores a late previous-item response', async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pane = mount();
    pane.rerender(<HumanWorkSection slug="pilot" id="WI-other" refreshKey="2" />);
    await screen.findByRole('button', { name: 'Claim this work' });
    finish(response({ ...available, offer: { ...available.offer, brief: 'Stale previous item' } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Stale previous item')).toBeNull();
    pane.rerender(<HumanWorkSection slug="pilot" id="WI-other" refreshKey="3" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
