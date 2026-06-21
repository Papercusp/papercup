// @vitest-environment jsdom
//
// WorkspacePicker — the "all vs specific workspaces" multi-select. The genuine
// logic is the null-sentinel toggle transition (all → everything-but-clicked,
// add/remove, empty → back to all/null), extracted as the pure `nextSelection`
// and pinned branch-by-branch. A render-smoke drives the fetched list, the
// "All workspaces" master checkbox, and a per-row toggle with fetch stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

import WorkspacePicker, { nextSelection } from './WorkspacePicker';

describe('nextSelection', () => {
  it('from "all" (null), clicking an id selects everything except it', () => {
    expect(nextSelection(null, ['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('adds an id not already in the explicit selection', () => {
    expect(nextSelection(['a'], ['a', 'b'], 'b')).toEqual(['a', 'b']);
  });
  it('removes an id present in the selection', () => {
    expect(nextSelection(['a', 'b'], ['a', 'b'], 'a')).toEqual(['b']);
  });
  it('reverts to "all" (null) when removing the last selected id', () => {
    expect(nextSelection(['a'], ['a', 'b'], 'a')).toBeNull();
  });
});

describe('<WorkspacePicker /> smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ workspaces: [{ id: 'w1', name: 'One' }, { id: 'w2', name: 'Two' }] }),
    })) as unknown as typeof fetch);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('checks every box and disables nothing when selected is null (all)', async () => {
    render(<WorkspacePicker selected={null} onChange={() => {}} />);
    const boxes = await screen.findAllByRole('checkbox');
    // master + 2 rows, all checked under "all".
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.getAttribute('aria-checked') === 'true')).toBe(true);
  });

  it('toggling a row from "all" emits everything-except-that-row', async () => {
    const onChange = vi.fn();
    render(<WorkspacePicker selected={null} onChange={onChange} />);
    await screen.findByText('One');
    fireEvent.click(screen.getByText('One'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['w2']));
  });

  it('only the selected rows are checked when a specific list is passed', async () => {
    render(<WorkspacePicker selected={['w1']} onChange={() => {}} />);
    await screen.findByText('One');
    const boxes = screen.getAllByRole('checkbox');
    // [master(all=false), w1(true), w2(false)]
    expect(boxes.map((b) => b.getAttribute('aria-checked') === 'true')).toEqual([false, true, false]);
  });
});
