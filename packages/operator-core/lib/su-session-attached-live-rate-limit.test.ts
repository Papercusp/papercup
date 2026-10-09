import { describe, expect, it } from 'vitest';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionEvent,
  type SuSessionIdentity,
} from '@papercusp/chat-protocol';
import { confirmedProviderRateLimit, throwIfProviderRateLimited } from './su-session-attached-live-rate-limit';
import { pollUntil } from './pui-e2e/poll-until';

const session: SuSessionIdentity<'claude'> = {
  agentChatId: 'fixture-chat',
  advSessionId: 1,
  backend: 'claude',
  nativeSessionId: 'fixture-native',
  ownerId: 'fixture-owner',
  workspaceId: 'fixture-ws',
  harnessSlug: null,
};
let sequence = 0;

function base() {
  sequence += 1;
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    session,
    eventId: `evt-${sequence}`,
    sequence,
    at: new Date().toISOString(),
  };
}

function errorEvent(message: string): SuSessionEvent {
  return {
    ...base(),
    type: 'error',
    scope: 'turn',
    code: 'claude_runtime_error',
    message,
    recoverable: true,
  } as SuSessionEvent;
}

function transcript(role: 'system' | 'assistant', content: string): SuSessionEvent {
  return {
    ...base(),
    type: 'transcript',
    phase: 'delta',
    turnId: 'turn-1',
    role,
    channel: 'text',
    content,
  } as SuSessionEvent;
}

describe('attached live provider-limit classifier', () => {
  it('does not classify missing evidence as a provider limit', () => {
    expect(confirmedProviderRateLimit([]).confirmed).toBe(false);
  });

  it('confirms a structured 429', () => {
    expect(confirmedProviderRateLimit([errorEvent('API Error: 429')]).confirmed).toBe(true);
  });

  it('confirms an explicit weekly usage wall', () => {
    expect(confirmedProviderRateLimit([errorEvent("You've hit your weekly limit")]).confirmed).toBe(true);
  });

  it('confirms structured rate-limit prose', () => {
    expect(confirmedProviderRateLimit([errorEvent('temporarily limiting requests')]).confirmed).toBe(true);
  });

  it('does not confirm an unrelated structured error', () => {
    expect(confirmedProviderRateLimit([errorEvent('invalid model configuration')]).confirmed).toBe(false);
  });

  it('requires repeated system transcript mentions without a structured error', () => {
    expect(confirmedProviderRateLimit([transcript('system', 'upstream 429, retrying')]).confirmed).toBe(false);
    expect(confirmedProviderRateLimit([
      transcript('system', 'upstream 429, retrying'),
      transcript('system', 'still rate limited, retrying'),
    ]).confirmed).toBe(true);
  });

  it('does not count assistant explanations as provider evidence', () => {
    expect(confirmedProviderRateLimit([
      transcript('assistant', 'A 429 is a rate limit response.'),
      transcript('assistant', 'If we hit a rate limit again I will back off.'),
    ]).confirmed).toBe(false);
  });
});

describe('live acceptance provider-capacity guard', () => {
  it('aborts an approval wait at the first confirmed refusal instead of consuming its timeout', async () => {
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([errorEvent('API Error: 429 request would exceed your rate limit')], 'Native tool approval');
      return false;
    }, { timeoutMs: 120_000, intervalMs: 100 })).rejects.toThrow(
      'Native tool approval cannot run: confirmed provider rate limit',
    );
    expect(checks).toBe(1);
  });

  it('allows a transient retry note to recover and reach the expected condition', async () => {
    let checks = 0;
    const outcome = await pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([transcript('system', 'upstream 429, retrying')], 'P-005 greeting');
      return checks === 2;
    }, { timeoutMs: 1_000, intervalMs: 1 });
    expect(outcome.ok).toBe(true);
    expect(checks).toBe(2);
  });

  it('keeps assistant explanations and unrelated errors available to their own acceptance assertions', () => {
    expect(() => throwIfProviderRateLimited([
      transcript('assistant', 'A 429 is a rate limit response.'),
      errorEvent('invalid model configuration'),
    ], 'P-005 read-explain')).not.toThrow();
  });
});
