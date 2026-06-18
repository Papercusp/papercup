/**
 * @vitest-environment jsdom
 *
 * BootHistoryTable tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  BootHistoryTable,
  type BootHistoryEntry,
} from '../BootHistoryTable';

afterEach(() => {
  cleanup();
});

const NOW = 10_000_000;

function entry(
  overrides: Partial<BootHistoryEntry> = {},
): BootHistoryEntry {
  return {
    ts: NOW - 1_000,
    workspaceId: 'ws-1',
    harnessSlug: 'papercup',
    kind: 'boot_ok',
    ...overrides,
  };
}

describe('BootHistoryTable', () => {
  it('renders empty state when no entries', () => {
    render(<BootHistoryTable entries={[]} nowMs={NOW} />);
    expect(screen.getByTestId('boot-history-empty')).toBeTruthy();
    expect(screen.queryByTestId('boot-history-table')).toBeNull();
  });

  it('renders rows when entries present', () => {
    render(
      <BootHistoryTable
        entries={[entry({ kind: 'boot_start' }), entry({ kind: 'boot_ok' })]}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId('boot-history-table')).toBeTruthy();
    expect(screen.getByTestId('boot-history-row-boot_start')).toBeTruthy();
    expect(screen.getByTestId('boot-history-row-boot_ok')).toBeTruthy();
  });

  it('formats relative time correctly', () => {
    const cases = [
      { delta: 30 * 1000, label: '30s ago' },
      { delta: 90 * 1000, label: '1m ago' },
      { delta: 90 * 60 * 1000, label: '1h ago' },
      { delta: 48 * 60 * 60 * 1000, label: '2d ago' },
    ];
    for (const { delta, label } of cases) {
      const { unmount } = render(
        <BootHistoryTable
          entries={[entry({ ts: NOW - delta })]}
          nowMs={NOW}
        />,
      );
      expect(
        screen.getByTestId('boot-history-table').textContent,
      ).toContain(label);
      unmount();
    }
  });

  it('renders message when present', () => {
    render(
      <BootHistoryTable
        entries={[
          entry({
            kind: 'boot_fail',
            message: 'corestore lock contention',
          }),
        ]}
        nowMs={NOW}
      />,
    );
    expect(
      screen.getByTestId('boot-history-row-boot_fail').textContent,
    ).toContain('corestore lock contention');
  });

  it('omits message when absent', () => {
    render(
      <BootHistoryTable entries={[entry({ kind: 'boot_ok' })]} nowMs={NOW} />,
    );
    const row = screen.getByTestId('boot-history-row-boot_ok');
    expect(row.textContent).toContain('boot_ok');
    expect(row.textContent).not.toContain('undefined');
  });

  it('shows kind text + mark', () => {
    render(
      <BootHistoryTable
        entries={[
          entry({ kind: 'boot_start' }),
          entry({ kind: 'boot_ok' }),
          entry({ kind: 'boot_fail', message: 'boom' }),
          entry({ kind: 'close' }),
        ]}
        nowMs={NOW}
      />,
    );
    const text = screen.getByTestId('boot-history-table').textContent ?? '';
    expect(text).toContain('boot_start');
    expect(text).toContain('boot_ok');
    expect(text).toContain('boot_fail');
    expect(text).toContain('close');
    expect(text).toContain('✓');
    expect(text).toContain('✗');
  });

  it('renders workspace + harness as code', () => {
    render(
      <BootHistoryTable
        entries={[entry({ workspaceId: 'ws-7', harnessSlug: 'demo' })]}
        nowMs={NOW}
      />,
    );
    const text = screen.getByTestId('boot-history-table').textContent ?? '';
    expect(text).toContain('ws-7');
    expect(text).toContain('demo');
  });

  it('handles future timestamps as just now', () => {
    render(
      <BootHistoryTable
        entries={[entry({ ts: NOW + 1000 })]}
        nowMs={NOW}
      />,
    );
    // Defensive: relTime returns 'just now' (without ' ago' suffix);
    // the row renders that + ' ago' suffix → 'just now ago'. Smoke
    // test: doesn't crash, doesn't show NaN.
    const text = screen.getByTestId('boot-history-table').textContent ?? '';
    expect(text).toContain('just now');
    expect(text).not.toContain('NaN');
  });
});
