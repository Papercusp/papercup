// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SelectEntry } from '../../harness/Select';
import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

const h = vi.hoisted(() => ({
  prefs: { fullAgentEngine: 'off', sttEngine: 'voicemode', ttsEngine: 'kokoro' } as VoicePrefs,
  invalidate: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [h.prefs], invalidate: h.invalidate }),
}));
vi.mock('@/app/_components/voice/voice-mode', () => ({
  initVoiceMode: vi.fn(),
  getVoiceConfig: () => ({ wakeWord: 'hey papercup', rate: 1, roleVoices: {} }),
  listAvailableVoices: () => [{ name: 'Alice', lang: 'en-US' }],
  updateVoiceConfig: vi.fn(),
  speak: vi.fn(),
}));
vi.mock('@/app/_components/voice/voice-prefs-client', () => ({ setVoicePrefsClient: vi.fn() }));
vi.mock('../../_components/RouteLink', () => ({ default: ({ children }: React.PropsWithChildren) => <span>{children}</span> }));
vi.mock('../../harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ askConfirm: vi.fn(), confirmEl: null }) }));
// Use a native select to exercise the page's actual options, disabled values,
// stored-value rendering, and preference writes without Radix portal plumbing.
vi.mock('../../harness/Select', () => ({
  Select: ({ value, options, ariaLabel, onChange, disabled }: {
    value: string; options: SelectEntry[]; ariaLabel: string;
    onChange: (value: string) => void; disabled?: boolean;
  }) => <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    {options.flatMap((entry) => 'kind' in entry ? entry.options : [entry]).map((option) =>
      <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import VoiceSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.prefs = { fullAgentEngine: 'off', sttEngine: 'voicemode', ttsEngine: 'kokoro' } as VoicePrefs;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => ({
    ok: true,
    json: async () => options?.method === 'PUT'
      ? { ...h.prefs, ...JSON.parse(String(options.body)) }
      : { google: { configured: true }, openai: { configured: true }, elevenlabs: { configured: true } },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('full-agent engine capabilities', () => {
  it('disables Gemini even with a configured Google key, while supported engines remain selectable', async () => {
    render(<VoiceSettingsPage />);
    const select = await screen.findByRole('combobox', { name: 'Full-agent engine' });
    const gemini = screen.getByRole('option', { name: /Gemini Live/ }) as HTMLOptionElement;
    expect(gemini.disabled).toBe(true);
    expect(gemini.textContent).toMatch(/not supported/i);
    fireEvent.change(select, { target: { value: 'openai-realtime' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/agent-mcp/operator-voice-prefs', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ fullAgentEngine: 'openai-realtime' }),
    })));
  });

  it('preserves a saved Gemini value, explains the unsupported state, and lets the user choose Off', async () => {
    h.prefs.fullAgentEngine = 'gemini-live';
    render(<VoiceSettingsPage />);
    const select = await screen.findByRole('combobox', { name: 'Full-agent engine' }) as HTMLSelectElement;
    expect(select.value).toBe('gemini-live');
    expect(screen.getByRole('alert').textContent).toMatch(/Gemini Live is not supported/);
    expect(fetch).not.toHaveBeenCalledWith('/api/agent-mcp/operator-voice-prefs', expect.anything());
    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => expect(select.value).toBe('off'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
