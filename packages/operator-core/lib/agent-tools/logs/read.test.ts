/**
 * logs:read handler wiring — plan `bash-to-tool-substitution-2026-07-26`, P-023
 * (D-027).
 *
 * The parsing and journalctl semantics are unit-tested in `journal-read.test.ts`;
 * this pins the ENVELOPE decisions the tool itself owns: unit-name resolution,
 * the unscoped-read guard, and that `ok` tracks the READ succeeding rather than
 * any lines being found (an empty clean window is a successful read).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { readJournalMock } = vi.hoisted(() => ({ readJournalMock: vi.fn() }));

vi.mock('../../journal-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readJournal: readJournalMock,
}));

import logsReadTool from './read';

const CLEAN = {
  entries: [],
  matched: 0,
  collapsed: 0,
  truncated: false,
  window: { since: '-30 min', until: null },
  units: [],
  journalAvailable: true,
  backend: 'systemd',
  journalError: null,
  command: 'journalctl …',
};

/** The handler returns the structured `{ data }` envelope; the MCP projection
 *  happens above it, so tests read `data` directly. */
function payloadOf(res: { data: Record<string, unknown> }): Record<string, unknown> {
  return res.data;
}

const call = (args: Record<string, unknown>) =>
  logsReadTool.handler(args as never, {} as never) as Promise<{ data: Record<string, unknown> }>;

beforeEach(() => {
  readJournalMock.mockReset().mockResolvedValue(CLEAN);
});

describe('logs:read — dispatch transaction boundary', () => {
  it('does not retain an ambient workspace transaction during journalctl host I/O', () => {
    expect((logsReadTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('logs:read — unit resolution', () => {
  it('suffixes a bare unit name with .service', async () => {
    await call({ unit: 'papercup-bg-host' });
    expect(readJournalMock.mock.calls[0][0].units).toEqual(['papercup-bg-host.service']);
  });

  it('leaves a non-.service unit type alone (the .timer mangling bug)', async () => {
    await call({ unit: 'papercup-live-federation-gate.timer' });
    expect(readJournalMock.mock.calls[0][0].units).toEqual(['papercup-live-federation-gate.timer']);
  });

  it('accepts several units as one merged stream', async () => {
    await call({ unit: ['papercup-dev-api', 'papercup-staging-api.service'] });
    expect(readJournalMock.mock.calls[0][0].units).toEqual([
      'papercup-dev-api.service',
      'papercup-staging-api.service',
    ]);
  });
});

describe('logs:read — the unscoped-read guard', () => {
  it('refuses a host-wide scan with no window, and never reaches the journal', async () => {
    const out = payloadOf(await call({}));
    expect(out).toMatchObject({ ok: false, error: 'unscoped_read_needs_since' });
    expect(readJournalMock).not.toHaveBeenCalled();
  });

  it('ALLOWS a host-wide scan once an explicit window is given', async () => {
    const out = payloadOf(await call({ since: '-60 min' }));
    expect(out.ok).toBe(true);
    expect(readJournalMock.mock.calls[0][0]).toMatchObject({ since: '-60 min', units: [] });
  });

  it('does not require `since` when an identifier scopes the read', async () => {
    const out = payloadOf(await call({ identifier: 'oddsmith-alert' }));
    expect(out.ok).toBe(true);
    expect(readJournalMock).toHaveBeenCalled();
  });

  it('does not require `since` when a unit scopes the read', async () => {
    expect(payloadOf(await call({ unit: 'papercup-bg-host' })).ok).toBe(true);
  });
});

describe('logs:read — ok reflects the READ, not the line count', () => {
  it('is ok for an empty but genuinely clean window', async () => {
    const out = payloadOf(await call({ unit: 'a', grep: 'never-appears' }));
    expect(out).toMatchObject({ ok: true, journalAvailable: true, journalError: null });
    expect(out.entries).toEqual([]);
  });

  it('is NOT ok when the read failed — so empty entries cannot read as clean', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, journalError: 'Failed to add match' });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out.ok).toBe(false);
    expect(out.journalError).toBe('Failed to add match');
  });

  it('is ok on a host with NO journal, but says so rather than reporting an empty log', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, journalAvailable: false });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out).toMatchObject({ ok: true, journalAvailable: false, journalError: null });
  });

  it('projects the selected macOS backend so callers can distinguish native unified logs', async () => {
    readJournalMock.mockResolvedValue({ ...CLEAN, backend: 'macos-unified' });
    const out = payloadOf(await call({ unit: 'a' }));
    expect(out).toMatchObject({ ok: true, backend: 'macos-unified' });
  });
});

describe('logs:read — arguments reach journalctl unchanged', () => {
  it('forwards grep, level, window, limit and scope verbatim', async () => {
    await call({
      unit: 'papercup-bg-host',
      grep: 'oom|killed process',
      level: 'err',
      since: '-2 hours',
      until: '09:40:00',
      limit: 50,
      scope: 'system',
    });
    expect(readJournalMock.mock.calls[0][0]).toMatchObject({
      grep: 'oom|killed process',
      level: 'err',
      since: '-2 hours',
      until: '09:40:00',
      limit: 50,
      scope: 'system',
    });
  });

  it("accepts scope 'all' — the read that spans both journals", async () => {
    expect(payloadOf(await call({ unit: 'systemd-oomd', scope: 'all' })).ok).toBe(true);
    expect(readJournalMock.mock.calls[0][0].scope).toBe('all');
  });
});
