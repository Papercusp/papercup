/**
 * selected_bee.test.ts — the fleet:selected_bee HANDLER (the in-memory store get/set
 * is mocked). This ephemeral UI relay has a load-bearing subtlety: it must NOT hard-
 * require a coord identity — a bare loopback (pui IPC) caller makes resolveAgentIdentity
 * THROW, and the handler must SOFTLY fall back to a null workspace rather than crash.
 * Also pinned: the publish (select present → setSelectedBee) vs read (absent →
 * getSelectedBee) branch, the workspace resolution (arg overrides actor), and clearing
 * (owner_id:null). A regression that lets the identity throw escape, or loses the
 * read/publish branch, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/selected_bee.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../fleet/selected-bee', () => ({ getSelectedBee: vi.fn(), setSelectedBee: vi.fn() }));

import { resolveAgentIdentity } from '../coordination/identity';
import { getSelectedBee, setSelectedBee } from '../../fleet/selected-bee';
const ident = vi.mocked(resolveAgentIdentity);
const getBee = vi.mocked(getSelectedBee);
const setBee = vi.mocked(setSelectedBee);
const tool = (await import('./selected_bee')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ workspaceId: 'ws-actor' } as never);
  getBee.mockReturnValue({ ownerId: 'bee-1', name: 'Bee One' } as never);
  setBee.mockReturnValue({ ownerId: 'bee-2', name: 'Bee Two' } as never);
});

describe('fleet:selected_bee', () => {
  it('READS the current selection when called with no select', async () => {
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, selected: { ownerId: 'bee-1' } });
    expect(getBee).toHaveBeenCalledWith('ws-actor');
    expect(setBee).not.toHaveBeenCalled();
  });

  it('PUBLISHES when select is present', async () => {
    const b = body(await call({ select: { owner_id: 'bee-2', name: 'Bee Two' } }));
    expect(b).toMatchObject({ ok: true, selected: { ownerId: 'bee-2' } });
    expect(setBee).toHaveBeenCalledWith('ws-actor', 'bee-2', 'Bee Two');
  });

  it('softly tolerates a loopback caller whose identity resolution THROWS (workspace → null)', async () => {
    ident.mockImplementation(() => { throw new Error('no coord identity'); });
    const b = body(await call());
    expect(b.ok).toBe(true); // did not crash
    expect(getBee).toHaveBeenCalledWith(null);
  });

  it('an explicit workspace arg overrides the actor workspace', async () => {
    await call({ select: { owner_id: 'bee-2' }, workspace: 'ws-override' });
    expect(setBee).toHaveBeenCalledWith('ws-override', 'bee-2', null);
  });

  it('clears the selection when owner_id is null', async () => {
    await call({ select: { owner_id: null } });
    expect(setBee).toHaveBeenCalledWith('ws-actor', null, null);
  });
});
