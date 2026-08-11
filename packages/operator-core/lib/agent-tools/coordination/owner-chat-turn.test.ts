/**
 * Owner chat-pane turns (EI-20130618357432548 / EI-20130675657060052).
 *
 * The owner types in the session chat popup; the recipient is parked, so the wake
 * pump delivers. Before this module the pump's own `[await-event] …` envelope WAS
 * the transcript's user turn, which (a) the pane rendered back to the owner in
 * place of their message and (b) read as agent-to-agent mail, so the agent replied
 * over coord to a UI pseudo-agent and got `recipients_gone`.
 *
 * The security property in the last describe() is the load-bearing one: this must
 * stay an ENROLLED injection, because the surface that triggers it is reachable by
 * anything on loopback.
 */
import { describe, expect, it } from 'vitest';
import {
  OWNER_CHAT_NOTE_TAG,
  OWNER_CHAT_TEXT_FIELD,
  OWNER_CHAT_TURN_MARKER,
  ownerChatTurnText,
  ownerChatWakePayloadFields,
  readOwnerChatTurnText,
  stripMachineTurnAnnotations,
} from './owner-chat-turn';

describe('ownerChatWakePayloadFields', () => {
  it('carries the owner text VERBATIM — the summary is truncated at 80 chars, so it cannot be the source', () => {
    const long = 'x'.repeat(200);
    expect(ownerChatWakePayloadFields(long)).toEqual({
      [OWNER_CHAT_TURN_MARKER]: true,
      [OWNER_CHAT_TEXT_FIELD]: long,
    });
  });

  it('degrades to the ORDINARY wake shape for an empty body rather than delivering an empty turn', () => {
    expect(ownerChatWakePayloadFields('')).toEqual({});
    expect(ownerChatWakePayloadFields('   \n ')).toEqual({});
  });
});

describe('readOwnerChatTurnText', () => {
  it('reads back what the send path stamped', () => {
    expect(readOwnerChatTurnText(ownerChatWakePayloadFields('hi'))).toBe('hi');
  });

  it('is null for every ordinary wake payload — the default path must be untouched', () => {
    expect(readOwnerChatTurnText({ msg_id: 'm1' })).toBeNull();
    expect(readOwnerChatTurnText({ inboxOwnerReply: true })).toBeNull();
  });

  it('never throws on a malformed payload — it runs on the wake executor hot path against `unknown`', () => {
    for (const bad of [null, undefined, 'str', 42, [], { [OWNER_CHAT_TURN_MARKER]: true }]) {
      expect(readOwnerChatTurnText(bad)).toBeNull();
    }
    // A marker present but the text of the wrong type must fall through, not crash.
    expect(
      readOwnerChatTurnText({ [OWNER_CHAT_TURN_MARKER]: true, [OWNER_CHAT_TEXT_FIELD]: 12 }),
    ).toBeNull();
  });

  it('does NOT fire on the marker alone — the payload is only owner-chat WITH text', () => {
    expect(readOwnerChatTurnText({ [OWNER_CHAT_TEXT_FIELD]: 'hi' })).toBeNull();
  });
});

describe('ownerChatTurnText', () => {
  it('leads with the owner’s words, so the agent reads the message before the plumbing', () => {
    expect(ownerChatTurnText('hi')).toMatch(/^hi\n\n⟦owner-chat⟧/);
  });

  it('tells the agent to answer IN THE TURN and not to coord:send — the second reported bug', () => {
    const text = ownerChatTurnText('hi');
    expect(text).toContain('THIS TURN');
    expect(text).toMatch(/do not coord:send/i);
    // Naming the concrete failure is the point: an agent that has only been told
    // "reply to the sender" cannot otherwise know this sender has no session.
    expect(text).toContain('recipients_gone');
  });
});

describe('stripMachineTurnAnnotations', () => {
  it('strips the provenance envelope the owner never typed', () => {
    expect(stripMachineTurnAnnotations('⟦turn-origin:coord-inject:owner nonce:abc123ef⟧\nhi')).toBe(
      'hi',
    );
  });

  it('strips the trailing owner-chat note, leaving exactly what the owner typed', () => {
    expect(stripMachineTurnAnnotations(ownerChatTurnText('hi there'))).toBe('hi there');
  });

  it('strips BOTH at once — the real delivered shape', () => {
    const delivered = `⟦turn-origin:coord-inject:owner nonce:deadbeef⟧\n${ownerChatTurnText('hi')}`;
    expect(stripMachineTurnAnnotations(delivered)).toBe('hi');
  });

  it('round-trips a MULTI-LINE owner message unchanged — only the annotations come off', () => {
    const typed = 'line one\n\nline two\n  indented';
    const delivered = `⟦turn-origin:coord-inject:owner nonce:deadbeef⟧\n${ownerChatTurnText(typed)}`;
    expect(stripMachineTurnAnnotations(delivered)).toBe(typed);
  });

  it('leaves an ordinary turn byte-identical', () => {
    for (const plain of ['hi', 'a ⟦ bracket that is not an envelope', '']) {
      expect(stripMachineTurnAnnotations(plain)).toBe(plain);
    }
  });

  it('does NOT strip a wake-pump body — hiding genuinely delivered content is the worse failure', () => {
    // Only the envelope comes off; the wake text itself still shows, so nothing an
    // agent was actually sent silently disappears from the transcript.
    const wake = '⟦turn-origin:wake-pump nonce:abc123ef⟧\n[await-event] coord:inbox-wake:su-1 fired.';
    expect(stripMachineTurnAnnotations(wake)).toBe('[await-event] coord:inbox-wake:su-1 fired.');
  });

  it('only strips an envelope at the START — a quoted one mid-body is content', () => {
    const quoted = 'look at this: ⟦turn-origin:wake-pump nonce:abc123ef⟧ weird';
    expect(stripMachineTurnAnnotations(quoted)).toBe(quoted);
  });
});

describe('SECURITY — the shape this fix deliberately does NOT take', () => {
  it('the note tag is a distinct delimiter, so stripping it can never eat owner text', () => {
    // The strip cuts at the tag; anything the owner typed sits before it.
    expect(stripMachineTurnAnnotations(ownerChatTurnText('ship it'))).toBe('ship it');
    expect(OWNER_CHAT_NOTE_TAG.startsWith('⟦')).toBe(true);
  });

  it('carries NO field that would make the turn look unenrolled/owner-typed', () => {
    // Regression rail for the rejected route: delivering this turn WITHOUT a
    // turn-origin envelope would classify it OWNER (interactive), and the provenance
    // hook auto-registers AUTO/DRAIN mode grants on that branch alone. Since
    // /api/admin/coord/send accepts a no-Origin loopback POST, that would let any
    // agent curl an owner-stamped directive — and a mode grant — into a peer's
    // session. The payload must therefore never carry an origin/provenance hint of
    // its own; enrollment stays wake-executor's job.
    const fields = ownerChatWakePayloadFields('hi');
    expect(Object.keys(fields).sort()).toEqual([OWNER_CHAT_TEXT_FIELD, OWNER_CHAT_TURN_MARKER].sort());
  });
});
