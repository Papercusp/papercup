/**
 * The deliverability rail lives in the capability VERBS, and the verb-level
 * behaviour (which statuses block, which never do) is covered by
 * `capability-verbs/deliverability.test.ts`. What that suite cannot see is the
 * hop between the MCP tool and the verb: if a wrapper stops forwarding
 * `allowUndeliverable`, every verb-level test still passes while the owner's
 * documented override silently stops working from the tool surface.
 *
 * These tests pin that hop, and deliberately assert BOTH polarities. A test
 * that only asserts `true` is satisfied by a wrapper that hardcodes
 * `allowUndeliverable: true` — which would disable the bounce guard outright,
 * the worst failure this rail has. Asserting `false` and omitted is what makes
 * the check falsifiable in the direction that actually matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verbs = vi.hoisted(() => ({
  sendNewMail: vi.fn(),
  draftNewMail: vi.fn(),
  sendMailDraft: vi.fn(),
}));

vi.mock('../../capability-verbs/mail', () => verbs);
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('../../personal-vault/authorization', () => ({
  authorizePersonalAccess: vi.fn(async () => ({ allowed: true })),
}));

import mailDraft from './draft';
import mailSend from './send';
import mailSendDraft from './send-draft';

type ToolHandler = (args: never, ctx: never) => Promise<{ data: Record<string, unknown> }>;

function invoke(tool: unknown, args: Record<string, unknown>) {
  return (tool as { handler: ToolHandler }).handler(args as never, {
    workspaceId: 'ws-1',
    tx: {},
  } as never);
}

const addressee = { from: 'owner-instruction' as const };

/**
 * One row per tool: the verb spy it must reach, and a minimal valid arg set.
 * `allowUndeliverable` is added per-case so the base args stay honest about
 * what the wrapper receives when the caller omits the override entirely.
 */
const CASES = [
  {
    tool: 'mail:send',
    subject: mailSend,
    verb: verbs.sendNewMail,
    args: { to: ['someone@example.com'], subject: 'subject', text: 'body', addressee },
  },
  {
    tool: 'mail:draft',
    subject: mailDraft,
    verb: verbs.draftNewMail,
    args: { to: ['someone@example.com'], subject: 'subject', text: 'body', addressee },
  },
  {
    tool: 'mail:send-draft',
    subject: mailSendDraft,
    verb: verbs.sendMailDraft,
    args: { draftId: 'draft-1', expectedTo: ['someone@example.com'], addressee },
  },
] as const;

describe('mail tools forward allowUndeliverable to the capability verb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const { verb } of CASES) verb.mockResolvedValue({ messageId: 'm-1' });
  });

  for (const { tool, subject, verb, args } of CASES) {
    describe(tool, () => {
      it('declares the override on its arg schema', () => {
        const shape = (subject.args as unknown as { shape: Record<string, unknown> }).shape;
        expect(Object.keys(shape)).toContain('allowUndeliverable');
      });

      it('forwards allowUndeliverable: true', async () => {
        await invoke(subject, { ...args, allowUndeliverable: true });
        expect(verb).toHaveBeenCalledTimes(1);
        expect(verb.mock.calls[0][1]).toMatchObject({ allowUndeliverable: true });
      });

      // The polarity that catches a hardcoded `true` — a wrapper that always
      // opts out of the guard passes the case above and fails this one.
      it('forwards allowUndeliverable: false rather than substituting true', async () => {
        await invoke(subject, { ...args, allowUndeliverable: false });
        expect(verb).toHaveBeenCalledTimes(1);
        expect(verb.mock.calls[0][1]).toMatchObject({ allowUndeliverable: false });
      });

      it('leaves allowUndeliverable undefined when the caller omits it, so the verb default governs', async () => {
        await invoke(subject, { ...args });
        expect(verb).toHaveBeenCalledTimes(1);
        const passed = verb.mock.calls[0][1] as { allowUndeliverable?: boolean };
        expect(passed.allowUndeliverable).toBeUndefined();
      });
    });
  }
});
