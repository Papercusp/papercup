// @vitest-environment jsdom
/**
 * BrainstormChat.test.tsx — the brainstorm partner pane is a thin wrapper that
 * configures `<HarnessChat>` (endpoint, storageKey, placeholder, emptyHint) and
 * supplies a `renderActionBlock` callback. The real logic under test is that
 * callback's fork:
 *   - a `promote:*` tag → <PromoteBlock>;
 *   - any other tag → a fenced <pre> echo of the raw block.
 *
 * We mock `@papercusp/agent-chat` so HarnessChat captures the props it was
 * given (rather than mounting the real chat runtime), then invoke the captured
 * `renderActionBlock` against both block kinds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

type ActionBlock = { kind: 'action'; tag: string; content: string; blockKey: string };

/** Props HarnessChat is configured with — captured by the mock for assertion. */
let captured: {
  slug?: string;
  endpoint?: string;
  storageKey?: string;
  placeholder?: string;
  emptyHint?: string;
  renderActionBlock?: (b: ActionBlock) => ReactNode;
} = {};

vi.mock('@papercusp/agent-chat', () => ({
  HarnessChat: (props: typeof captured) => {
    captured = props;
    return <div data-testid="harness-chat" data-endpoint={props.endpoint} data-storagekey={props.storageKey} />;
  },
  PromoteBlock: ({ slug, block }: { slug: string; block: ActionBlock }) => (
    <div data-testid="promote-block" data-slug={slug} data-tag={block.tag}>{block.content}</div>
  ),
}));

import BrainstormChat from './BrainstormChat';

function block(tag: string, content = 'body'): ActionBlock {
  return { kind: 'action', tag, content, blockKey: 'k' };
}

afterEach(() => { cleanup(); captured = {}; });

describe('BrainstormChat (brainstorm partner pane)', () => {
  it('configures HarnessChat with the brainstorm endpoint + per-slug storage key', () => {
    render(<BrainstormChat slug="my-harness" />);
    const chat = screen.getByTestId('harness-chat');
    expect(chat.getAttribute('data-endpoint')).toBe('brainstorm/chat');
    expect(chat.getAttribute('data-storagekey')).toBe('harness.brainstorm-chat.my-harness');
    expect(captured.slug).toBe('my-harness');
    expect(captured.placeholder).toBeTruthy();
    expect(captured.emptyHint).toBeTruthy();
  });

  it('renderActionBlock: a promote:* tag renders a PromoteBlock bound to the slug', () => {
    render(<BrainstormChat slug="hh" />);
    const out = render(<>{captured.renderActionBlock!(block('promote:feature', 'ship it'))}</>);
    const pb = out.getByTestId('promote-block');
    expect(pb.getAttribute('data-slug')).toBe('hh');
    expect(pb.getAttribute('data-tag')).toBe('promote:feature');
    expect(pb.textContent).toBe('ship it');
    out.unmount();
  });

  it('renderActionBlock: a non-promote tag renders the raw fenced <pre> echo', () => {
    render(<BrainstormChat slug="hh" />);
    const out = render(<>{captured.renderActionBlock!(block('patch:SPEC.md', 'diff here'))}</>);
    // Falls through to the <pre> branch (no PromoteBlock).
    expect(out.queryByTestId('promote-block')).toBeNull();
    const pre = out.container.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain('patch:SPEC.md');
    expect(pre!.textContent).toContain('diff here');
    out.unmount();
  });
});
