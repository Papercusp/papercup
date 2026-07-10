/**
 * pot:beacon_consent handler tests (hive-network-surface-2026-06-11 P-005 / B-07).
 * The PG-backed consent accessor (beacon-consent.ts) is round-tripped against real
 * PG in ../../beacon-consent.integration.test.ts; THIS file pins the tool-handler
 * orchestration the dispatcher runs — get vs set routing, the workspace default,
 * and the pot-not-found error surface — with the accessor mocked at its seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBeaconPublishConsent = vi.fn<(ws: string, pot: string) => Promise<boolean>>();
const setBeaconPublishConsent = vi.fn<(ws: string, pot: string, consent: boolean) => Promise<void>>();

vi.mock('../../beacon-consent', () => ({
  getBeaconPublishConsent: (...a: [string, string]) => getBeaconPublishConsent(...a),
  setBeaconPublishConsent: (...a: [string, string, boolean]) => setBeaconPublishConsent(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

import beaconConsentTool from './beacon_consent';

type Tool = {
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const tool = beaconConsentTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
const ctx = (): never => ({}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  getBeaconPublishConsent.mockResolvedValue(false);
  setBeaconPublishConsent.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('pot:beacon_consent', () => {
  it('omitting consent READS the current value (no write)', async () => {
    getBeaconPublishConsent.mockResolvedValueOnce(true);
    const res = parse(await tool.handler({ pot: 'acme-pot' }, ctx()));
    expect(res).toMatchObject({ ok: true, action: 'get', pot: 'acme-pot', consent: true });
    expect(getBeaconPublishConsent).toHaveBeenCalledWith('ws-active', 'acme-pot');
    expect(setBeaconPublishConsent).not.toHaveBeenCalled();
  });

  it('consent:true SETS publish on and echoes the new state', async () => {
    const res = parse(await tool.handler({ pot: 'acme-pot', consent: true }, ctx()));
    expect(res).toMatchObject({ ok: true, action: 'set', pot: 'acme-pot', consent: true });
    expect(setBeaconPublishConsent).toHaveBeenCalledWith('ws-active', 'acme-pot', true);
  });

  it('consent:false SETS publish off', async () => {
    const res = parse(await tool.handler({ pot: 'acme-pot', consent: false }, ctx()));
    expect(res).toMatchObject({ ok: true, action: 'set', consent: false });
    expect(setBeaconPublishConsent).toHaveBeenCalledWith('ws-active', 'acme-pot', false);
  });

  it('honors an explicit workspace override', async () => {
    await tool.handler({ pot: 'acme-pot', consent: true, workspace: 'ws-other' }, ctx());
    expect(setBeaconPublishConsent).toHaveBeenCalledWith('ws-other', 'acme-pot', true);
  });

  it('a set failure (e.g. pot not found) surfaces ok:false with the reason', async () => {
    setBeaconPublishConsent.mockRejectedValueOnce(new Error("no Pot 'ghost' in workspace 'ws-active'"));
    const res = parse(await tool.handler({ pot: 'ghost', consent: true }, ctx()));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/no Pot/);
    expect(res.pot).toBe('ghost');
  });
});
