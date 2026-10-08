// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import DaoWorkspaceDetails from './DaoWorkspaceDetails';
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(cleanup);
const view: DaoWorkspaceView = { directoryId: 'published-id', localHomeSlug: 'installed-home', status: 'connected' };

describe('DAO workspace record presentation', () => {
  it('retains integrity failures in the voting view', () => {
    render(<DaoWorkspaceDetails section="vote" view={{ ...view, governance: { status: 'ready', value: { events: [], integrityErrors: ['invalid signature'], conflictedRoundIds: [] } } }} loading={false} error="" />);
    expect(screen.getByRole('alert').textContent).toContain('invalid signature');
    expect(screen.getByRole('link', { name: 'Open proposal and plan workspace' }).getAttribute('href')).toContain('slug=installed-home');
  });
  it('keeps finance account prerequisites explicit and invents no balance', () => {
    render(<DaoWorkspaceDetails section="treasury" view={view} loading={false} error="" />);
    expect(screen.getByText('Finance and ownership records require an explicit verified account binding.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open organization launch preparation' }).getAttribute('href')).toBe('/dao');
    expect(screen.queryByText('$0')).toBeNull();
  });
  it('renders scoped project and plan records', () => {
    render(<DaoWorkspaceDetails section="work" view={{ ...view, projects: { status: 'ready', value: [{ slug: 'project-home', title: 'Project', plans: [{ slug: 'proposal', title: 'Build a thing', status: 'active', owner: null, itemCount: 3 }] }] } }} loading={false} error="" />);
    expect(screen.getByRole('link', { name: 'Build a thing' }).getAttribute('href')).toContain('slug=project-home');
    expect(screen.getByText('active · 3 authored work items')).toBeTruthy();
  });
  it('keeps an unreadable policy distinct from a policy that does not exist', () => {
    render(<DaoWorkspaceDetails section="vote" view={{ ...view, policy: { status: 'error', message: 'Policy read failed' } }} loading={false} error="" />);
    expect(screen.getByRole('alert').textContent).toBe('Policy read failed');
    expect(screen.getByText('Policy unavailable')).toBeTruthy();
    expect(screen.queryByText('No policy recorded')).toBeNull();
    expect(screen.queryByText('Review admission thresholds')).toBeNull();
  });
});
