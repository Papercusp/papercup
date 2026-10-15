// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { BlueprintOperationHandle, BlueprintOperationResult, PotAppSeam } from '@papercusp/pot-app-seam';
import WorkflowOperationResult from './WorkflowOperationResult';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const handle: BlueprintOperationHandle = { workspaceId: 'w', harnessSlug: 'support', receiptId: 12,
  operationId: 'prepare-handoff', specificationRevision: 'a'.repeat(64), target: { kind: 'work-item', id: 'WI-12' } };
const status = (receipt = handle) => ({ handle: receipt, phase: 'terminal' as const, outcome: 'succeeded' as const,
  items: [], planRun: null, cancellationRequested: false, wait: null });
const ready = (receipt = handle): BlueprintOperationResult<string> => ({ state: 'ready', status: status(receipt),
  output: 'Cited support summary', evidenceRef: 'evidence:output', acceptanceEvidenceRef: 'evidence:evaluation',
  businessReview: { state: 'pending', accountableOwner: 'support-owner', resultFingerprint: 'f'.repeat(64) } });
function host(result: BlueprintOperationResult<string> = ready()) {
  return {
    operationResult: vi.fn<NonNullable<ComponentProps<typeof WorkflowOperationResult>['seam']>['operationResult']>()
      .mockResolvedValue(result),
    cancelOperation: vi.fn<PotAppSeam['cancelOperation']>().mockResolvedValue({ eventId: 'cancel:1', replayed: false,
      accepted: true, wakeQueued: true, handled: false, effected: false }),
    reviewOperation: vi.fn<PotAppSeam['reviewOperation']>().mockResolvedValue({ eventId: 'review:1', replayed: false,
      accepted: true, wakeQueued: true, handled: false }),
  };
}

describe('existing Workflows operation receipt journey', () => {
  it('shows output and evaluation evidence without claiming business acceptance', async () => {
    const seam = host();
    render(<WorkflowOperationResult handle={handle} seam={seam} />);
    expect(await screen.findByText('Cited support summary')).toBeTruthy();
    expect(screen.getByText('Business outcome: pending')).toBeTruthy();
    expect(screen.getByText('evidence:output')).toBeTruthy();
    expect(screen.getByText('evidence:evaluation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept result' })).toBeNull();
    expect(seam.operationResult).toHaveBeenCalledWith(handle, expect.any(Function), undefined);
  });

  it('reviews the exact fingerprint and reads the durable decision after the input receipt', async () => {
    const seam = host();
    const value = ready();
    if (value.state !== 'ready') throw new Error('fixture');
    seam.reviewOperation.mockImplementation(async () => {
      seam.operationResult.mockResolvedValue({ ...value, businessReview: { ...value.businessReview!, state: 'accepted',
        decision: { eventId: 'decision:1', reviewerPrincipal: 'reviewer:2', reason: 'Ready for engineering', at: '2026-10-15T00:00:00Z' } } });
      return { eventId: 'review:1', accepted: true, replayed: false, wakeQueued: true, handled: false };
    });
    render(<WorkflowOperationResult handle={handle} seam={seam} />);
    await screen.findByText('Cited support summary');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read as an authorized reviewer' }));
    const accept = await screen.findByRole('button', { name: 'Accept result' });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Review reason' }), { target: { value: 'Ready for engineering' } });
    fireEvent.click(accept);
    expect(await screen.findByText('Business outcome: accepted')).toBeTruthy();
    expect(screen.getByText('decision:1')).toBeTruthy();
    expect(seam.reviewOperation).toHaveBeenCalledWith(handle, expect.objectContaining({
      decision: 'accept', reason: 'Ready for engineering', resultFingerprint: 'f'.repeat(64),
    }));
    expect(seam.operationResult).toHaveBeenLastCalledWith(handle, expect.any(Function), { review: true });
  });

  it('keeps the outcome pending when a saved review request has no durable decision yet', async () => {
    const seam = host();
    render(<WorkflowOperationResult handle={handle} seam={seam} />);
    await screen.findByText('Cited support summary');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByRole('button', { name: 'Reject result' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Needs clearer evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject result' }));
    await screen.findByText(/Review request saved/);
    expect(screen.getByText('Business outcome: pending')).toBeTruthy();
    expect(screen.queryByText('Business outcome: rejected')).toBeNull();
  });

  it('surfaces server self-review refusal and preserves the prepared result', async () => {
    const seam = host();
    seam.reviewOperation.mockRejectedValue(new Error('distinct reviewer required'));
    render(<WorkflowOperationResult handle={handle} seam={seam} />);
    await screen.findByText('Cited support summary');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByRole('button', { name: 'Request rework' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Try again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request rework' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'distinct reviewer required');
    expect(screen.getByText('Business outcome: pending')).toBeTruthy();
  });

  it('reports cancellation as a request while the canonical result remains pending', async () => {
    const seam = host({ state: 'pending', status: { ...status(), phase: 'dispatched', outcome: null } });
    render(<WorkflowOperationResult handle={handle} seam={seam} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
    await screen.findByText(/Stop request saved/);
    expect(screen.getByText(/Preparation is dispatched/)).toBeTruthy();
    expect(seam.cancelOperation).toHaveBeenCalledWith(handle, expect.objectContaining({ requestKey: 'workflow-stop:12' }));
  });

  it('isolates an old late response when the selected receipt changes', async () => {
    const seam = host();
    let finish!: (value: BlueprintOperationResult<string>) => void;
    seam.operationResult.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<WorkflowOperationResult handle={handle} seam={seam} />);
    const second = { ...handle, receiptId: 13, target: { kind: 'work-item' as const, id: 'WI-13' } };
    seam.operationResult.mockResolvedValue({ ...ready(second), output: 'Second run' } as BlueprintOperationResult<string>);
    view.rerender(<WorkflowOperationResult handle={second} seam={seam} />);
    await screen.findByText('Second run');
    finish(ready());
    await waitFor(() => expect(screen.queryByText('Cited support summary')).toBeNull());
    expect(screen.getByText('Second run')).toBeTruthy();
  });

  it('uses the existing browser transport and seam parse gate for a real envelope', async () => {
    const value = ready();
    if (value.state !== 'ready') throw new Error('fixture');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true,
      result: { content: [{ text: JSON.stringify({ ...value, output: { summary: 'Transport result' } }) }] } }) }));
    render(<WorkflowOperationResult handle={handle} />);
    expect(await screen.findByText(/Transport result/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/agent-mcp/run-tool', expect.objectContaining({
      body: JSON.stringify({ name: 'blueprint:result', args: { handle }, confirmed: true }),
    }));
  });
});
