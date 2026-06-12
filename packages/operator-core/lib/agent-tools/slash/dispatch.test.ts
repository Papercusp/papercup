/**
 * dispatch.test.ts — slash:dispatch (WI-126): resolves the slash projection,
 * renders the SAME instruction prompts/get serves, and delivers it through
 * the deliver-and-wake seam. Delivery + identity + registry lookup are mocked
 * at the module seam; the render itself runs for real (it's pure tooldef).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupByMcpName = vi.fn<(name: string) => unknown>();
const sendMessage = vi.fn<(...a: unknown[]) => Promise<{ msg_id: string; ts: string; to: string[] }>>();
const wakeRecipients =
  vi.fn<(...a: unknown[]) => Promise<{ targets: string[]; keys: string[]; woken: number; staged: number }>>();
const sqlUnsafe = vi.fn(async () => []);

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookupByMcpName: (name: string) => lookupByMcpName(name),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-sender', workspaceId: 'ws' }),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
vi.mock('../coordination/inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: { unsafe: (...a: unknown[]) => sqlUnsafe(...(a as [])) } }),
}));

import dispatch from './dispatch';

const ctx = { uiClientId: 'su-sender', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = (x: unknown) => dispatch.args.parse(x) as never;
const out = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

/** A minimal ProjectedTool shape covering what renderSlashPrompt reads. */
const wakeModeTool = {
  expose: { mcp: { name: 'coord:wake-mode' } },
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent owner id.' },
      mode: { type: 'string', enum: ['auto', 'manual'], description: 'auto | manual.' },
    },
  },
  capabilities: ['coord:write'],
  description: "Read or set an agent's wake mode.",
  guidance: { when: 'Switching wake modes.' },
};

beforeEach(() => {
  lookupByMcpName.mockReturnValue(wakeModeTool);
  sendMessage.mockResolvedValue({ msg_id: 'm-1', ts: 't', to: ['su-queen'] });
  wakeRecipients.mockResolvedValue({ targets: ['su-queen'], keys: ['k'], woken: 1, staged: 0 });
});
afterEach(() => vi.clearAllMocks());

describe('slash:dispatch', () => {
  it('renders the slash instruction and delivers it to the target (woken)', async () => {
    const g = out(
      await dispatch.handler(
        parse({ tool: 'coord:wake-mode', args: { mode: 'auto' }, agent: 'su-queen' }),
        ctx,
      ),
    );
    expect(g).toMatchObject({ ok: true, msg_id: 'm-1', tool: 'coord:wake-mode', agent: 'su-queen', delivery: 'woken' });

    const sendOpts = sendMessage.mock.calls[0][1] as { to: string[]; body: string; extra?: unknown };
    expect(sendOpts.to).toEqual(['su-queen']);
    // The dispatched body is the REAL render: preamble + the prompts/get text.
    expect(sendOpts.body).toContain('[slash:dispatch] su-sender dispatched');
    expect(sendOpts.body).toContain('the slash command for the `coord:wake-mode` tool');
    expect(sendOpts.body).toContain('- mode: auto'); // supplied-arguments block
    expect(sendOpts.body).toContain('Invoke `coord:wake-mode` over this MCP session');
    expect(sendOpts.extra).toEqual({ wake: true }); // federation intent (EI-279)
    expect(wakeRecipients).toHaveBeenCalledWith(['su-queen'], expect.objectContaining({ source: 'su-sender' }));
  });

  it('a manual-mode target reports delivery=staged with the pause-gate note', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-queen'], keys: [], woken: 0, staged: 1 });
    const g = out(
      await dispatch.handler(parse({ tool: 'coord:wake-mode', agent: 'su-queen' }), ctx),
    );
    expect(g.delivery).toBe('staged');
    expect(g.note).toContain('STAGED for owner review');
  });

  it('no live wake-watch → delivery=injected with the next-turn note', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-queen'], keys: ['k'], woken: 0, staged: 0 });
    const g = out(
      await dispatch.handler(parse({ tool: 'coord:wake-mode', agent: 'su-queen' }), ctx),
    );
    expect(g.delivery).toBe('injected');
    expect(g.note).toContain('next natural turn');
  });

  it('unknown tool → ok:false, nothing sent', async () => {
    lookupByMcpName.mockReturnValue(undefined);
    const g = out(await dispatch.handler(parse({ tool: 'nope:nothing', agent: 'su-queen' }), ctx));
    expect(g.ok).toBe(false);
    expect(g.error).toContain('unknown_tool');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('slash-opted-out tool → not_dispatchable, nothing sent', async () => {
    lookupByMcpName.mockReturnValue({ ...wakeModeTool, expose: { mcp: { name: 'coord:wake-mode' }, slash: false } });
    const g = out(await dispatch.handler(parse({ tool: 'coord:wake-mode', agent: 'su-queen' }), ctx));
    expect(g.ok).toBe(false);
    expect(g.error).toContain('not_dispatchable');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('writes the slash.dispatch audit row (fire-and-forget)', async () => {
    out(await dispatch.handler(parse({ tool: 'coord:wake-mode', args: { mode: 'auto' }, agent: 'su-queen' }), ctx));
    await vi.waitFor(() => expect(sqlUnsafe).toHaveBeenCalled());
    const [sqlText, params] = sqlUnsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(sqlText).toContain('audit_log');
    expect(params).toContain('slash.dispatch');
    expect(params).toContain('coord:wake-mode');
  });
});
