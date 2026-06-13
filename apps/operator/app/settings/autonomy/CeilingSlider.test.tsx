// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CeilingSlider, CEILING_LEVELS } from './CeilingSlider';

afterEach(cleanup);

describe('CeilingSlider', () => {
  it('renders one radio per ceiling level with the current value checked', () => {
    render(<CeilingSlider value="low" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(CEILING_LEVELS.length);
    expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Never' }).getAttribute('aria-checked')).toBe('false');
  });

  it('calls onChange with the clicked level', () => {
    const onChange = vi.fn();
    render(<CeilingSlider value="never-auto" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Moderate' }));
    expect(onChange).toHaveBeenCalledWith('moderate');
  });

  it('does not call onChange when the current level is re-clicked', () => {
    const onChange = vi.fn();
    render(<CeilingSlider value="high" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves up one tier on ArrowRight', () => {
    const onChange = vi.fn();
    render(<CeilingSlider value="low" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('moderate');
  });

  it('moves down one tier on ArrowLeft and clamps at never-auto', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CeilingSlider value="trivial" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('never-auto');

    onChange.mockClear();
    rerender(<CeilingSlider value="never-auto" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is inert when disabled', () => {
    const onChange = vi.fn();
    render(<CeilingSlider value="low" onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
