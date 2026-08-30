/**
 * The interrupt a backend adapter sends over the pty is a KEYSTROKE, not a
 * signal, so its meaning belongs to the receiving TUI. Codex binds Ctrl-C
 * (\x03) to QUIT — its own binary's footer string reads "Ctrl+C to exit" — so
 * sending 'sigint' there made the product's own interrupt command END the
 * session it was asked to interrupt, and every later command in that session's
 * lifecycle then ran against a dead runtime (EI-21908787009967815, the blocker
 * behind the P-012 real-backend matrix's BARE-PSU red).
 *
 * Measured, three arms through the SAME interruptViaPty call:
 *   - nothing injected  → adv 21328 alive 130.6s, adv 21333 alive 120.0s
 *   - \x03 into READY   → adv 21340 closed 6s later, ended_by='self',
 *                         exit_code=0, ended_signal=null, three
 *                         op.dispatch.shutdown lines in its codex-tui.log
 *   - \x1b into READY   → adv 21341 alive the full 90s watch, zero shutdown
 *                         lines
 * The ESC arm is what exonerates the injection path and pins the defect to the
 * payload: same call, same host, same socket — only the byte differed.
 *
 * This pins the key CODEX is sent, because that is the one measured against
 * this hazard. claude and omp still send 'sigint' and are deliberately NOT
 * pinned here: asserting an unmeasured choice would dress a guess as a
 * contract. Their exposure is tracked on EI-21908787009967815.
 */
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionCommand } from '@papercusp/chat-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const interruptViaPty = vi.fn(async (_ownerId: string, _key?: 'sigint' | 'esc') => true);
const findLiveHost = vi.fn(() => ({ sock: '/tmp/fake-psu-host.sock', pid: 4242 }));

vi.mock('./events/await/psu-pty-discovery', () => ({
  interruptViaPty: (ownerId: string, key?: 'sigint' | 'esc') => interruptViaPty(ownerId, key),
  findLiveHost: () => findLiveHost(),
  injectIntoHostWithConfirmation: vi.fn(async () => ({ ok: true, confirmation: 'acked' })),
  shutdownViaPty: vi.fn(async () => 'sent'),
}));

const { createCodexSuSessionAdapter } = await import('./su-session-codex-adapter');
type CodexAdapter = ReturnType<typeof createCodexSuSessionAdapter>;

const OWNER_ID = 'su-codex-interrupt-key';

function binding() {
  return {
    operation: 'created' as const,
    backend: 'codex' as const,
    advSessionId: 71,
    ownerId: OWNER_ID,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    planSlug: 'pui-plan',
    nativeSession: null,
  };
}

function runtime() {
  return {
    nativeSession: {
      backend: 'codex' as const,
      source: 'adv_sessions' as const,
      ownerId: OWNER_ID,
      codexHome: '/tmp/codex-home',
      rolloutId: '019f0000-1111-7222-8333-444444444444',
      exactResumeSupported: true,
      missingReason: null,
    },
    rolloutPath: null,
  };
}

function interruptCommand(adapter: CodexAdapter): SuSessionCommand<'codex'> {
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-30T21:00:00.000Z',
    target: adapter.host.descriptor().identity,
    type: 'interrupt',
    commandId: 'interrupt-key-pin',
    reason: 'interrupt-key regression pin',
  } as SuSessionCommand<'codex'>;
}

async function sendInterrupt(): Promise<CodexAdapter> {
  const adapter = createCodexSuSessionAdapter(binding() as never, runtime() as never, {
    agentChatId: 'agent-chat-codex-interrupt-key',
    register: false,
  });
  const dispatch = adapter.host.startCommand(interruptCommand(adapter));
  await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
  return adapter;
}

beforeEach(() => {
  interruptViaPty.mockClear();
  interruptViaPty.mockImplementation(async () => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The assertion itself, lifted out so the CONTROL below can prove it is
 * falsifiable. A guard that has never failed is a guard nobody has tested, and
 * the subject here is an imported module rather than a file read by path — so
 * the repo's prescribed proof is a deliberately-wrong implementation kept
 * permanently beside a calibration case, never an in-tree mutation the git-sync
 * sweep could commit.
 */
function assertCodexInterruptKey(calls: readonly (readonly [string, ('sigint' | 'esc') | undefined])[]): void {
  expect(calls).toHaveLength(1);
  const [ownerId, key] = calls[0]!;
  expect(ownerId).toBe(OWNER_ID);
  expect(
    key,
    "codex's interrupt must send Esc (\\x1b). Ctrl-C (\\x03) is codex's QUIT key — measured, it " +
      'closed adv 21340 six seconds after injection with a graceful TUI shutdown, while the ESC arm ' +
      'through the same call left adv 21341 alive for a full 90s watch.',
  ).toBe('esc');
}

describe('codex interrupt key (EI-21908787009967815)', () => {
  it("sends Esc, because Ctrl-C is codex's QUIT key and would end the session it was asked to interrupt", async () => {
    const adapter = await sendInterrupt();
    try {
      // CALIBRATION: the real subject must pass the same assertion the control
      // below proves can fail. Without this pair, a broken assertion and a
      // correct adapter are indistinguishable.
      assertCodexInterruptKey(interruptViaPty.mock.calls);
    } finally {
      adapter.dispose();
    }
  });

  it('CONTROL: the same assertion REJECTS the pre-fix sigint adapter (proves this guard can fail)', () => {
    // The exact call the adapter made before the fix. If this control ever
    // stops throwing, the pin above has gone blind and would wave the
    // regression straight back through.
    expect(() => assertCodexInterruptKey([[OWNER_ID, 'sigint']])).toThrow();
    // ...and it is the KEY that is being judged, not the owner or arity.
    expect(() => assertCodexInterruptKey([[OWNER_ID, 'esc']])).not.toThrow();
  });

  it('never sends sigint for codex — the exact regression that killed driven managed sessions', async () => {
    const adapter = await sendInterrupt();
    try {
      const keys = interruptViaPty.mock.calls.map(([, key]) => key);
      expect(
        keys,
        'a codex interrupt that carries \\x03 is a session kill, not an interrupt',
      ).not.toContain('sigint');
    } finally {
      adapter.dispose();
    }
  });

  it('still reports a refusal when the transport cannot deliver the key at all', async () => {
    interruptViaPty.mockImplementation(async () => false);
    const adapter = createCodexSuSessionAdapter(binding() as never, runtime() as never, {
      agentChatId: 'agent-chat-codex-interrupt-key-refused',
      register: false,
    });
    try {
      const dispatch = adapter.host.startCommand(interruptCommand(adapter));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'refused' });
      expect(interruptViaPty.mock.calls[0]?.[1]).toBe('esc');
    } finally {
      adapter.dispose();
    }
  });
});
