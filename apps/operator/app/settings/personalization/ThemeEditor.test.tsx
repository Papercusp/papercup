// @vitest-environment jsdom
//
// ThemeEditor — the custom-theme color editor. The colour-coercion helper
// `toHex` (used to seed the native <input type=color> from arbitrary CSS values)
// is extracted + tested across its branches: #rrggbb passthrough, #rgb
// expansion, rgb()/rgba() conversion (with clamping), and the fallback. A
// render-smoke drives the editor with a mocked @/lib/theme to confirm the name
// field, the token inputs, and the save validation surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { themeMod } = vi.hoisted(() => ({
  themeMod: {
    isSafe: (v: string) => /^#|rgb|hsl|^[a-z]+$/i.test(v),
    save: vi.fn(async (t: { id: string; label: string; tokens?: Record<string, string> }) => ({ ...t })),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/theme', () => ({
  isSafeCssValue: (v: string) => themeMod.isSafe(v),
  saveCustomTheme: (t: { id: string; label: string; tokens?: Record<string, string> }) => themeMod.save(t),
  slugifyThemeId: (label: string) => label.toLowerCase().replace(/\s+/g, '-'),
}));

import ThemeEditor, { toHex } from './ThemeEditor';

beforeEach(() => {
  themeMod.isSafe = (v: string) => /^#|rgb|hsl|^[a-z]+$/i.test(v);
  themeMod.save.mockClear();
});
afterEach(cleanup);

describe('toHex', () => {
  it('passes a #rrggbb value through (lowercased)', () => {
    expect(toHex('#AABBCC')).toBe('#aabbcc');
  });
  it('expands a #rgb shorthand to #rrggbb', () => {
    expect(toHex('#abc')).toBe('#aabbcc');
  });
  it('converts rgb() to hex', () => {
    expect(toHex('rgb(255, 0, 128)')).toBe('#ff0080');
  });
  it('converts rgba() (ignoring alpha) to hex', () => {
    expect(toHex('rgba(16, 32, 48, 0.5)')).toBe('#102030');
  });
  it('clamps over-255 channels down to ff', () => {
    expect(toHex('rgb(300, 0, 10)')).toBe('#ff000a');
  });
  it('falls back to a neutral grey for unparseable values', () => {
    expect(toHex('var(--accent)')).toBe('#888888');
    expect(toHex('')).toBe('#888888');
  });
});

describe('<ThemeEditor />', () => {
  it('prefills the name from an existing theme', () => {
    render(
      <ThemeEditor
        seedThemeId="dark"
        existing={{ id: 'sunset', label: 'Sunset', tokens: { accent: '#ff8800' } }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByPlaceholderText('My theme') as HTMLInputElement).value).toBe('Sunset');
    expect(screen.getByText('Save changes')).toBeTruthy();
  });

  it('renders a labelled color input for each editable token', () => {
    render(<ThemeEditor seedThemeId="dark" onSaved={() => {}} onCancel={() => {}} />);
    // "Accent" is one of the curated tokens; its text input is aria-labelled.
    expect(screen.getByLabelText('Accent')).toBeTruthy();
    expect(screen.getByLabelText('Background')).toBeTruthy();
    expect(screen.getByText('Save theme')).toBeTruthy();
  });

  it('blocks save with no name (does not call saveCustomTheme)', () => {
    render(<ThemeEditor seedThemeId="dark" onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText('Save theme'));
    expect(themeMod.save).not.toHaveBeenCalled();
  });

  it('invokes onCancel from the Cancel button', () => {
    const onCancel = vi.fn();
    render(<ThemeEditor seedThemeId="dark" onSaved={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('saves an installed theme as an independent local copy', async () => {
    render(
      <ThemeEditor
        seedThemeId="custom:installed:abc"
        copyOf={{
          id: 'installed:abc',
          label: 'Aurora',
          tokens: { accent: '#ff8800' },
          installed: true,
          packageRef: 'acme-aurora',
        }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );

    expect((screen.getByPlaceholderText('My theme') as HTMLInputElement).value).toBe('Aurora copy');
    fireEvent.click(screen.getByText('Save local copy'));

    await waitFor(() => expect(themeMod.save).toHaveBeenCalled());
    expect(themeMod.save.mock.calls[0][0]).toMatchObject({
      id: 'aurora-copy',
      label: 'Aurora copy',
      tokens: { accent: '#ff8800' },
    });
    expect(themeMod.save.mock.calls[0][0].id).not.toBe('installed:abc');
  });
});
