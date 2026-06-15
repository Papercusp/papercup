// @vitest-environment jsdom
//
// SettingsMarkdownEditor — a thin preset over <MarkdownEditor>. Its real logic
// is the toolbar selection: an EMPTY toolbar when readOnly, the curated
// settings toolbar otherwise, with outline always off. A render-smoke stubs
// MarkdownEditor to capture the props and asserts both branches.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { captured } = vi.hoisted(() => ({ captured: { current: null as Record<string, unknown> | null } }));

vi.mock('../_components/MarkdownEditor', () => ({
  MarkdownEditor: (props: Record<string, unknown>) => {
    captured.current = props;
    return <div data-testid="md-editor" />;
  },
}));

import { SettingsMarkdownEditor } from './SettingsMarkdownEditor';

afterEach(() => {
  cleanup();
  captured.current = null;
});

describe('<SettingsMarkdownEditor />', () => {
  it('passes the curated toolbar (and outline off) when editable', () => {
    render(<SettingsMarkdownEditor value="" onChange={() => {}} />);
    const props = captured.current!;
    expect(props.outline).toBe(false);
    const toolbar = props.toolbar as string[];
    expect(toolbar).toContain('bold');
    expect(toolbar).toContain('preview');
    expect(toolbar.length).toBeGreaterThan(0);
  });

  it('passes an empty toolbar when readOnly', () => {
    render(<SettingsMarkdownEditor value="" onChange={() => {}} readOnly />);
    const props = captured.current!;
    expect(props.outline).toBe(false);
    expect(props.toolbar).toEqual([]);
    expect(props.readOnly).toBe(true);
  });

  it('forwards through other props (e.g. value)', () => {
    render(<SettingsMarkdownEditor value="hello world" onChange={() => {}} />);
    expect(captured.current!.value).toBe('hello world');
  });
});
