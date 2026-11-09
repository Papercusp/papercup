import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../../../agent-tools/coordination/read-cursors';
import { collectMemoryEmission, confirmMemoryEmission, memoryFragmentOffer, _resetSessionEpochLedgerForTests } from '../../../memory/session-epoch-ledger';

const { sql, reprime } = vi.hoisted(() => ({
  sql: vi.fn(async (chunks: TemplateStringsArray) => chunks.join('?').includes('RETURNING memory_id')
    ? [{ memory_id: 'inserted' }] : []),
  reprime: vi.fn(),
}));
vi.mock('@papercusp/db-org', async orig => ({ ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql }) }));
vi.mock('../../../carry-brief', () => ({
  buildCarryBrief: vi.fn(async () => ({ heldItems: [], fleet: null, awaits: [], facts: [] })),
  renderCarryBriefText: () => 'Carry brief',
}));
vi.mock('../../../memory/compact-reprime', () => ({ buildCompactReprimeBlock: reprime }));
import endpoints from './session-recovery-brief';

const owner = 'su-compact-receipt';
const a = memoryFragmentOffer('memory', '11111111-1111-1111-1111-111111111111', 9, 'compact', '- complete condition ☃');
const b = memoryFragmentOffer('corpus', 'WI-42', 9, 'compact', '- condition\n  approval is mandatory');
const get = async (receiptMode = true) => (await endpoints[0].handler(new Request(
  `http://localhost/agent-mcp/session-recovery-brief?owner=${owner}${receiptMode ? '&memoryReceiptMode=1' : ''}`,
), { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal })).json();
const inserts = () => sql.mock.calls.filter(([chunks]) => chunks.join('?').includes('INSERT INTO harness_shared.memory_session_surfaced'));

beforeEach(() => {
  configureReadCursorStore(new InMemoryReadCursorStore());
  _resetSessionEpochLedgerForTests();
  sql.mockClear();
  reprime.mockReset().mockImplementation(async () => {
    collectMemoryEmission(owner, [a, b]);
    return a.rendered + '\n' + b.rendered.slice(0, -3);
  });
});
afterEach(() => resetReadCursorStore());

describe('compact recovery receipt', () => {
  it('offers only whole final fragments; preparation cannot suppress the next port', async () => {
    const out = await get();
    expect(out.text).toBe('Carry brief\n\n' + a.rendered + '\n' + b.rendered.slice(0, -3));
    const receipt = out._meta?.['papercusp/memoryEmission'];
    expect(receipt).toMatchObject({ owner, fragments: [a] });
    expect(inserts()).toHaveLength(0);
    const { rendered: _text, ...manifest } = a;
    await confirmMemoryEmission(sql as never, 'su-other', { token: receipt.token, fragments: [manifest] });
    expect(inserts()).toHaveLength(0);
    await confirmMemoryEmission(sql as never, owner, { token: receipt.token, fragments: [manifest] });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toContain(9);
  });

  it('keeps legacy callers receipt-free', async () => {
    const out = await get(false);
    expect(out.text).toContain(a.rendered);
    expect(out).not.toHaveProperty('_meta');
    expect(inserts()).toHaveLength(0);
  });

  it('discards a deadline loser, including its late offer', async () => {
    let finish!: (value: string) => void;
    reprime.mockImplementation(async () => {
      const text = await new Promise<string>(resolve => { finish = resolve; });
      collectMemoryEmission(owner, [a]);
      return text;
    });
    const out = await get();
    expect(out).toEqual({ ok: true, text: 'Carry brief' });
    finish(a.rendered);
    await Promise.resolve();
    expect(inserts()).toHaveLength(0);
  });
});
