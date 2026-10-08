// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { DaoDirectoryEntry } from './dao-navigation';
import DaoWorkspace from './DaoWorkspace';

let data: DaoDirectoryEntry[] | undefined;
let queryError: unknown = null;
let initialDao = '';
let initialSection = 'directory';
const invalidate = vi.fn();
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data, error: queryError, invalidate }) }));
vi.mock('nuqs', () => ({
  parseAsString: { withDefault: () => ({}) },
  useQueryState: (key: string) => useState(key === 'dao' ? initialDao : initialSection),
}));
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const community: DaoDirectoryEntry = { potId: 'builders', title: 'Builders DAO', description: 'Build public infrastructure', owner: 'Founder', visibility: 'public', memberLinks: ['papercusp://harness?topic=project'], memberTopics: ['project'], memberCount: 1 };

beforeEach(() => { data = [community]; initialDao = ''; initialSection = 'directory'; queryError = null; invalidate.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DAO Workbench journeys', () => {
  it('opens a discovered DAO and keeps all nineteen interface areas reachable', async () => {
    render(<DaoWorkspace />);
    expect(screen.getByRole('navigation', { name: 'DAO sections' }).querySelectorAll('button')).toHaveLength(19);
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace →' }));
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(screen.getByRole('combobox', { name: 'Choose a DAO' }).getAttribute('value') ?? (screen.getByRole('combobox') as HTMLSelectElement).value).toBe('builders');
    expect(screen.getByText('Build public infrastructure')).toBeTruthy();
  });
  it('searches published organization information', () => {
    render(<DaoWorkspace />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matches' } });
    expect(screen.getByRole('heading', { name: 'No matching organizations' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'infrastructure' } });
    expect(screen.getByRole('heading', { name: 'Builders DAO' })).toBeTruthy();
  });
  it('never treats a load failure as an empty successful directory', () => {
    data = undefined; queryError = new Error('offline');
    render(<DaoWorkspace />);
    expect(screen.getByRole('alert').textContent).toContain('Unable to load');
    expect(screen.queryByText('No DAOs discovered yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('requires explicit membership consent before invoking the composed join', async () => {
    initialDao = community.potId; initialSection = 'join';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, potSlug: 'builders', members: [{ ok: true }] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<DaoWorkspace />);
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/discovery/join-pot');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ potId: 'builders', title: 'Builders DAO', memberLinks: community.memberLinks });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Joined builders'));
  });
  it('keeps publisher entries without links ineligible for joining', () => {
    data = [{ ...community, memberLinks: [] }]; initialDao = community.potId; initialSection = 'join';
    render(<DaoWorkspace />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('surfaces a failed join and allows a deliberate retry', async () => {
    initialDao = community.potId; initialSection = 'join';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Admission rejected' }) }));
    render(<DaoWorkspace />); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Admission rejected'));
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
