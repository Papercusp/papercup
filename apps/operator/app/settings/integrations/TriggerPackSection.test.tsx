// @vitest-environment jsdom
/**
 * A trigger pack's section on Settings → Integrations (cupboard-distributable-integrations-2026-10-10
 * P-005) re-reads the page after its OWN successful save or arm. It must not wait on the server's
 * push: the sync bus drops a repeat of the same invalidation inside its dedupe window, so a save
 * shortly after another integrations write left the form dirty and Save enabled (headless P-005
 * attempt 3, run 20261011T103518Z-4079039, "pack settings did not save").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TriggerPackSettings } from '@papercusp/operator-core/lib/cupboard/trigger-pack-lifecycle';

const H = vi.hoisted(() => ({
  save: vi.fn(),
  arm: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./ticket-integrations-client', () => ({
  saveTriggerPackInputs: H.save,
  armTriggerPackRequest: H.arm,
  IntegrationRequestError: class IntegrationRequestError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { TriggerPackSection } from './TriggerPackSection';

function pack(overrides: Partial<TriggerPackSettings> = {}): TriggerPackSettings {
  return {
    installationId: 'inst-1',
    harnessSlug: 'pack-home',
    pluginName: 'fixture-pack',
    pluginVersion: '0.1.0',
    status: 'configured',
    inputsSchema: { type: 'object', properties: { note: { type: 'string', title: 'Note' } } },
    inputs: {},
    state: {
      fingerprint: 'f'.repeat(64),
      current: false,
      bindingCount: 1,
      armedBindingCount: 0,
      review: { unmet: [], bindings: [], recipients: [] },
    },
    ...overrides,
  } as unknown as TriggerPackSettings;
}

afterEach(() => {
  cleanup();
  H.save.mockReset();
  H.arm.mockReset();
});

describe('TriggerPackSection refreshes the page after its own write', () => {
  it('a successful save re-reads the page once, with the values that were saved', async () => {
    H.save.mockResolvedValue({ installationId: 'inst-1', status: 'configured', unmet: [], armed: false });
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(H.save).toHaveBeenCalledWith('inst-1', { note: 'hello' });
  });

  it('a refused save does not re-read the page', async () => {
    H.save.mockRejectedValue(new Error('trigger_pack_invalid'));
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(H.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a successful arm re-reads the page once', async () => {
    H.arm.mockResolvedValue({ armedBindingIds: ['b1'] });
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Arm fixture-pack' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(H.arm).toHaveBeenCalledWith('inst-1', 'f'.repeat(64));
  });
});
