// @vitest-environment jsdom
/**
 * DiscussPanel — the single "Discuss" action routes to the right target
 * (queue-pending-accuracy P-004 ext-2 (A)). PlanChat + MessageOwnerThread are
 * mocked to identifiable markers so we assert WHICH path it picks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('./PlanChat', () => ({
  default: ({ harnessSlug }: { harnessSlug: string | null }) => (
    <div data-testid="plan-chat" data-harness={String(harnessSlug)} />
  ),
}));
vi.mock('./MessageOwnerThread', () => ({ default: () => <div data-testid="message-owner" /> }));

import DiscussPanel from './DiscussPanel';
import type { AttentionItem } from './plans-api';

const item = (over: Partial<AttentionItem>): AttentionItem =>
  ({ ownerAgentId: null, ownerLabel: null, harnessSlug: null, ...over }) as unknown as AttentionItem;

afterEach(cleanup);

describe('DiscussPanel routing', () => {
  it('SYSTEM owner → fresh harness chat (not a dead-end reply thread)', () => {
    render(
      <DiscussPanel item={item({ ownerAgentId: 'system:hive-placement-watchdog', harnessSlug: 'h' })} chatLabel="x" />,
    );
    expect(screen.getByTestId('plan-chat')).toBeTruthy();
    expect(screen.queryByTestId('message-owner')).toBeNull();
    // no toggle — there's no addressable owner to switch to
    expect(screen.queryByRole('button', { name: /Reply to/ })).toBeNull();
  });

  it('LIVE (non-system) owner + harness → defaults to the reply thread, with a toggle to a fresh agent', () => {
    render(
      <DiscussPanel item={item({ ownerAgentId: 'bee-7', ownerLabel: 'Backend Bee', harnessSlug: 'h' })} chatLabel="x" />,
    );
    expect(screen.getByTestId('message-owner')).toBeTruthy();
    expect(screen.queryByTestId('plan-chat')).toBeNull();
    expect(screen.getByRole('button', { name: /Reply to Backend Bee/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fresh h agent/ })).toBeTruthy();
  });

  it('non-system owner, NO harness → reply thread only (no toggle)', () => {
    render(<DiscussPanel item={item({ ownerAgentId: 'bee-7', harnessSlug: null })} chatLabel="x" />);
    expect(screen.getByTestId('message-owner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fresh/ })).toBeNull();
  });

  it('no owner, no harness → an explicit empty state (no dead button)', () => {
    render(<DiscussPanel item={item({})} chatLabel="x" />);
    expect(screen.getByTestId('discuss-empty')).toBeTruthy();
    expect(screen.queryByTestId('plan-chat')).toBeNull();
    expect(screen.queryByTestId('message-owner')).toBeNull();
  });
});
