import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), authority: vi.fn(), mint: vi.fn(), options: vi.fn() }));
vi.mock('../../operator-chat-store', () => ({
  OperatorChatStore: class {
    constructor(options: unknown) { mocks.options(options); }
    beginTurn = mocks.begin;
    finalizeTurn = mocks.finish;
  },
  operatorChatSessionAuthority: mocks.authority,
}));
vi.mock('./converse-chat-binding', () => ({ mintConverseChatBinding: mocks.mint }));
import { admitConverseTurn } from './converse-turn';

const input = () => ({
  options: { sql: {} as never, workspaceId: 'ws-a', turn: { conversationId: 'conv-a', turnId: 'turn-a' },
    scope: { principalId: 'system:operator', tenantId: 'ws-a', customerId: 'ws-a', publicOwnerId: 'system:operator' } },
  credential: { kind: 'system' as const, name: 'operator', bearer: 'original-parent' },
  capability: 'operator:converse', toolName: 'operator:converse', runId: 'parent-run', source: 'text_typed' as const,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue(true); mocks.finish.mockResolvedValue(undefined);
  mocks.authority.mockReturnValue('current-authority-fence'); mocks.mint.mockResolvedValue('signed-association');
});
describe('P010 scoped converse lifecycle admission adapter', () => {
  it('reserves before binding and keeps the original parent separate from a child PI bearer', async () => {
    const turn = await admitConverseTurn(input());
    expect(mocks.begin).toHaveBeenCalledWith('parent-run', 'text_typed', {
      kind: 'system', principalId: 'system:operator',
      credentialSha256: createHash('sha256').update('original-parent').digest('hex'),
    });
    expect(mocks.mint).not.toHaveBeenCalled();
    const mount = await turn.bindMount({ url: 'https://host/api/mcp?principal=pi&run=child-run', bearer: 'child-bearer' });
    const url = new URL(mount.url);
    expect(url.searchParams.get('run')).toBe('child-run');
    expect(url.searchParams.get('chat_binding')).toBe('signed-association');
    expect(mocks.mint).toHaveBeenCalledWith({ workspaceId: 'ws-a', conversationId: 'conv-a', turnId: 'turn-a', runId: 'parent-run',
      authority: { kind: 'system', principalId: 'system:operator', credentialSha256: createHash('sha256').update('original-parent').digest('hex') } }, 'child-bearer');
    expect(mount.bearer).toBe('child-bearer'); expect(mount.url).not.toContain('original-parent');
    expect(mocks.options.mock.calls[0][0].authorize).toBe('current-authority-fence');
  });
  it.each([false, new Error('storage-unavailable')])('never grants a mount after duplicate or failed admission (%s)', async result => {
    if (result === false) mocks.begin.mockResolvedValue(false); else mocks.begin.mockRejectedValue(result);
    await expect(admitConverseTurn(input())).rejects.toThrow(result === false ? 'needs-reconciliation' : 'storage-unavailable');
    expect(mocks.mint).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('rejects a mismatched authenticated principal before storage', async () => {
    const args = input(); args.options.scope.principalId = 'pi:another';
    await expect(admitConverseTurn(args)).rejects.toThrow('unauthorized');
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it('pins admission identity and run despite later caller mutation and propagates a failed final write', async () => {
    const args = input(); const turn = await admitConverseTurn(args);
    args.options.turn.turnId = 'replacement'; args.runId = 'replacement'; args.credential.bearer = 'replacement';
    expect(turn.identity).toEqual({ conversationId: 'conv-a', turnId: 'turn-a' });
    await turn.finalize({ status: 'cancelled', text: 'Partial', tools: [{ name: 'read', callId: 'call-a' }] });
    expect(mocks.finish).toHaveBeenCalledWith({ runId: 'parent-run', status: 'cancelled', text: 'Partial', tools: [{ name: 'read', callId: 'call-a' }] });
    mocks.finish.mockRejectedValue(new Error('ack-lost'));
    await expect(turn.finalize({ status: 'completed', text: 'Done' })).rejects.toThrow('ack-lost');
  });
  it('uses the exact public PI identity and credential at the existing authority fence', async () => {
    const args = input();
    const turn = await admitConverseTurn({ ...args, credential: { kind: 'pi', sessionId: 'public-a', bearer: 'public-parent' },
      options: { ...args.options, scope: { ...args.options.scope, principalId: 'pi:public-a' } } });
    await turn.bindMount({ url: 'https://host/api/mcp?principal=pi', bearer: 'public-child' });
    expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'pi:public-a',
      credential: { kind: 'pi', sessionId: 'public-a', bearer: 'public-parent' } }));
    expect(mocks.mint.mock.calls[0][0].authority).toMatchObject({ kind: 'pi', principalId: 'pi:public-a' });
  });
});
