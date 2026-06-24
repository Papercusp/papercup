// @vitest-environment jsdom
/**
 * ModelOverride — the session-only per-agent model override control shared by the
 * Sentinel + Overwatch tabs (model-override-sidebar-2026-06-23). Covers the pure
 * spec split/join and the override/default indicator + write wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import ModelOverride, { splitSpec, joinSpec } from './ModelOverride';

afterEach(cleanup);

describe('splitSpec / joinSpec', () => {
  it('splits model[:effort] and round-trips', () => {
    expect(splitSpec('opus:high')).toEqual({ model: 'opus', effort: 'high' });
    expect(splitSpec('sonnet')).toEqual({ model: 'sonnet', effort: '' });
    expect(splitSpec(null)).toEqual({ model: '', effort: '' });
    expect(joinSpec('opus', 'high')).toBe('opus:high');
    expect(joinSpec('sonnet', '')).toBe('sonnet');
    expect(joinSpec('', 'high')).toBeNull(); // no model ⇒ no override
  });
});

describe('ModelOverride control', () => {
  it('shows "workspace default" and an empty picker when not overridden', () => {
    render(<ModelOverride label="Sentinel model" override={null} onWrite={() => {}} busy={false} />);
    expect(screen.getByText('workspace default')).toBeTruthy();
    expect((screen.getByLabelText('Sentinel model — model') as HTMLSelectElement).value).toBe('');
    // No reset (OverridableSetting shows the reset only while overridden).
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('shows "session override" + the model/effort when overridden', () => {
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={() => {}} busy={false} />);
    expect(screen.getByText('session override')).toBeTruthy();
    expect((screen.getByLabelText('Sentinel model — model') as HTMLSelectElement).value).toBe('opus');
    expect((screen.getByLabelText('Sentinel model — effort') as HTMLSelectElement).value).toBe('high');
  });

  it('writes the joined spec when the model changes', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={null} onWrite={onWrite} busy={false} />);
    fireEvent.change(screen.getByLabelText('Sentinel model — model'), { target: { value: 'sonnet' } });
    expect(onWrite).toHaveBeenCalledWith('sonnet');
  });

  it('preserves the model when only the effort changes', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Overwatch model" override={'opus'} onWrite={onWrite} busy={false} />);
    fireEvent.change(screen.getByLabelText('Overwatch model — effort'), { target: { value: 'xhigh' } });
    expect(onWrite).toHaveBeenCalledWith('opus:xhigh');
  });

  it('clears the override via reset', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={onWrite} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /reset Sentinel model to default/i }));
    expect(onWrite).toHaveBeenCalledWith(null);
  });
});
