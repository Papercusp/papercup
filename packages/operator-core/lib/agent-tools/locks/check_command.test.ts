/**
 * check_command.test.ts — the locks:check_command HANDLER (checkBashCommand mocked; its
 * matcher logic is covered in resource-command-match.integration.test.ts). Thin, but pins
 * that the handler resolves identity and forwards the command + coordinationDomain + owner
 * to the verdict engine, then spreads { ok:true, ...verdict } (decision + matched). A
 * regression that drops the identity scoping or the verdict spread is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/check_command.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('./resource-command-match', () => ({ checkBashCommand: vi.fn() }));

import { checkBashCommand } from './resource-command-match';
const checkM = vi.mocked(checkBashCommand);
const tool = (await import('./check_command')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('locks:check_command handler', () => {
  it('forwards command + identity and spreads the verdict', async () => {
    checkM.mockResolvedValue({ decision: 'block', matched: ['dev-server'] } as never);
    const out = (await tool.handler({ command: 'systemctl restart papercup' } as never, {} as never)) as Out;
    expect(checkM).toHaveBeenCalledWith({ command: 'systemctl restart papercup', coordinationDomain: 'dom', ownerId: 'me' });
    expect(body(out)).toMatchObject({ ok: true, decision: 'block', matched: ['dev-server'] });
  });

  it('passes an allow verdict through', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    expect(body((await tool.handler({ command: 'ls' } as never, {} as never)) as Out)).toMatchObject({ ok: true, decision: 'allow' });
  });
});
