import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), authority: vi.fn(), mint: vi.fn(), options: vi.fn(),
  readBinding: vi.fn(), verifyBinding: vi.fn(), associate: vi.fn() }));
vi.mock('../../operator-chat-store', () => ({
  OperatorChatStore: class {
    constructor(options: unknown) { mocks.options(options); }
    beginTurn = mocks.begin;
    finalizeTurn = mocks.finish;
    associateInteractionCall = mocks.associate;
  },
  operatorChatSessionAuthority: mocks.authority,
}));
vi.mock('./converse-chat-binding', () => ({ mintConverseChatBinding: mocks.mint,
  readConverseCardBinding: mocks.readBinding, verifyConverseCardBinding: mocks.verifyBinding }));
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
  mocks.readBinding.mockReturnValue(null); mocks.verifyBinding.mockResolvedValue(null); mocks.associate.mockResolvedValue(true);
});
describe('P010 scoped converse lifecycle admission adapter', () => {
  const result = { name: 'mcp__agentmcp__chat_ask_choice', output: 'native-result', isError: false, callId: 'native-a' };
  const binding = { dispatchCallId: 'dispatch-a', childRunId: 'child-a', credentialSha256: 'b'.repeat(64), correlationId: 'card-a' };

  it('awaits the exact signed native result association before finalizing canonical raw arguments', async () => {
    const turn = await admitConverseTurn(input());
    await turn.bindMount({ url: 'https://host/api/mcp', bearer: 'child-bearer' });
    mocks.readBinding.mockReturnValue('signed-receipt'); mocks.verifyBinding.mockResolvedValue(binding);
    let finish!: () => void;
    mocks.associate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    turn.observeToolResult(result);
    const running = turn.finalize({ status: 'completed', text: 'Done', tools: [{ name: 'chat:ask_choice', callId: 'native-a',
      input: { question: 'Choose', options: '[{"id":"YES","label":"Proceed","ignored":true}]', ignored: true } }] });
    await vi.waitFor(() => expect(mocks.associate).toHaveBeenCalledOnce());
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.associate).toHaveBeenCalledWith({ ...binding, parent: expect.objectContaining({ runId: 'parent-run' }), nativeCallId: 'native-a' });
    expect(mocks.verifyBinding).toHaveBeenCalledWith('signed-receipt', { parent: expect.objectContaining({ turnId: 'turn-a' }), childBearer: 'child-bearer' });
    finish(); await running;
    expect(mocks.finish.mock.calls[0][0].tools[0].input).toEqual({ question: 'Choose', options: [{ id: 'yes', label: 'Proceed' }] });
  });

  it.each(['missing-native', 'invalid-signature', 'association-ack-lost'])('refuses final success after %s without replaying a write', async failure => {
    const turn = await admitConverseTurn(input());
    await turn.bindMount({ url: 'https://host/api/mcp', bearer: 'child-bearer' });
    mocks.readBinding.mockReturnValue('signed-receipt'); mocks.verifyBinding.mockResolvedValue(binding);
    if (failure === 'invalid-signature') mocks.verifyBinding.mockResolvedValue(null);
    if (failure === 'association-ack-lost') mocks.associate.mockRejectedValue(new Error(failure));
    turn.observeToolResult({ ...result, ...(failure === 'missing-native' ? { callId: undefined } : {}) });
    await expect(turn.finalize({ status: 'completed', text: 'Done' })).rejects.toThrow(
      failure === 'association-ack-lost' ? failure : 'invalid-card-binding');
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.associate).toHaveBeenCalledTimes(failure === 'association-ack-lost' ? 1 : 0);
  });

  it('ignores unrelated tool results and does not invent an association from name or arguments', async () => {
    const turn = await admitConverseTurn(input());
    turn.observeToolResult({ ...result, name: 'reports:get' });
    turn.observeToolResult(result);
    await turn.finalize({ status: 'completed', text: 'Done' });
    expect(mocks.readBinding).toHaveBeenCalledOnce();
    expect(mocks.verifyBinding).not.toHaveBeenCalled();
    expect(mocks.associate).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

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
