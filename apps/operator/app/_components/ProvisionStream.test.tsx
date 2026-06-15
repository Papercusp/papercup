// @vitest-environment jsdom
//
// ProvisionStream — the (harness, plugin) provision audit-log viewer. The step
// projection / ANSI rendering live in provision-stream-steps.ts (already
// unit-tested); this component is the wiring around <StructuredStreamView>. The
// only logic it owns is the `!harness || !plugin → null` guard and the SSE URL
// it builds from harness/plugin/runId/since. A render-smoke with a stubbed
// StructuredStreamView asserts both.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Capture the props the component hands to the shared stream view so we can
// assert the URL it composes without standing up a real EventSource.
const { lastProps } = vi.hoisted(() => ({ lastProps: { current: null as Record<string, unknown> | null } }));

vi.mock('./StructuredStreamView', () => ({
  StructuredStreamView: (props: Record<string, unknown>) => {
    lastProps.current = props;
    return <div data-testid="stream-view">{String(props.url)}</div>;
  },
}));

import { ProvisionStream } from './ProvisionStream';

afterEach(() => {
  cleanup();
  lastProps.current = null;
});

describe('<ProvisionStream />', () => {
  it('renders nothing when harness is empty', () => {
    const { container } = render(<ProvisionStream harness="" plugin="p" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when plugin is empty', () => {
    const { container } = render(<ProvisionStream harness="h" plugin="" />);
    expect(container.firstChild).toBeNull();
  });

  it('builds the base stream URL from harness + plugin', () => {
    render(<ProvisionStream harness="my-harness" plugin="@papercupai/cf" />);
    const url = new URL(String(lastProps.current!.url), 'http://localhost');
    expect(url.pathname).toBe('/api/provision/stream');
    expect(url.searchParams.get('harness')).toBe('my-harness');
    expect(url.searchParams.get('plugin')).toBe('@papercupai/cf');
    expect(url.searchParams.get('runId')).toBeNull();
    expect(url.searchParams.get('since')).toBeNull();
  });

  it('threads runId and since into the URL when supplied', () => {
    render(<ProvisionStream harness="h" plugin="p" runId="run-7" since="2026-01-01T00:00:00Z" />);
    const url = new URL(String(lastProps.current!.url), 'http://localhost');
    expect(url.searchParams.get('runId')).toBe('run-7');
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00Z');
  });

  it('passes a caption that names the plugin and harness', () => {
    render(<ProvisionStream harness="h" plugin="p" runId="r1" />);
    expect(String(lastProps.current!.caption)).toContain('p @ h');
    expect(String(lastProps.current!.caption)).toContain('r1');
    expect(screen.getByTestId('stream-view')).toBeTruthy();
  });
});
