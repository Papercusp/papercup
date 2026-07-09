import { describe, expect, it } from 'vitest';
import {
  applyNetnsPortFilter,
  decideEgressAllowed,
  DEFAULT_LOOPBACK_DENYLIST,
  renderNftRuleset,
} from './network-egress';

describe('decideEgressAllowed', () => {
  it('denies everything against an empty allowlist (fail-closed)', () => {
    const d = decideEgressAllowed({ host: '1.2.3.4', port: 443 }, []);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('not_allowlisted');
  });

  it('allows an explicitly allowlisted destination', () => {
    const d = decideEgressAllowed({ host: '1.2.3.4', port: 443 }, [{ host: '1.2.3.4', port: 443 }]);
    expect(d).toEqual({ allow: true });
  });

  it('denylist wins even if the same entry is (accidentally) allowlisted', () => {
    const gw = { host: '127.0.0.1', port: 8788 };
    const d = decideEgressAllowed(gw, [gw]);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('denylisted');
  });

  it('the default denylist covers gateway, PG, and both operator ports', () => {
    const ports = DEFAULT_LOOPBACK_DENYLIST.map((e) => e.port).sort();
    expect(ports).toEqual([3070, 3170, 5432, 8788]);
  });
});

describe('renderNftRuleset', () => {
  it('renders a default-drop table with one accept rule per allowlist entry and one logged drop per denylist entry', () => {
    const text = renderNftRuleset({
      netnsName: 'foreign-1',
      allowlist: [{ host: '8.8.8.8', port: 443 }],
    });
    expect(text).toContain('policy drop');
    expect(text).toContain('ip daddr 8.8.8.8 tcp dport 443 accept');
    expect(text).toContain('ip daddr 127.0.0.1 tcp dport 8788');
    expect(text).toContain('log prefix "p105-deny-foreign-1: "');
  });
});

describe('applyNetnsPortFilter', () => {
  it('treats an "already exists" netns-add failure as idempotent success, then applies nft', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'netns' && args[1] === 'add') return { code: 1, stderr: 'File exists' };
      return { code: 0, stderr: '' };
    };
    const r = await applyNetnsPortFilter({ netnsName: 'ns1', allowlist: [] }, { run });
    expect(r).toEqual({ ok: true });
    expect(calls[0]).toEqual(['ip', 'netns', 'add', 'ns1']);
  });

  it('surfaces a genuine netns-create failure as a typed refusal', async () => {
    const run = async () => ({ code: 1, stderr: 'Operation not permitted' });
    const r = await applyNetnsPortFilter({ netnsName: 'ns1', allowlist: [] }, { run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('netns-create-failed');
  });

  it('surfaces an nft-apply failure as a typed refusal (netns create succeeds)', async () => {
    const run = async (_cmd: string, args: string[]) => {
      if (args[0] === 'netns' && args[1] === 'add') return { code: 0, stderr: '' };
      return { code: 1, stderr: 'nft: parse error' };
    };
    const r = await applyNetnsPortFilter({ netnsName: 'ns1', allowlist: [] }, { run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('nft-apply-failed');
  });
});
