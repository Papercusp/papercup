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
  ownerVisiblePromptText,
  OWNER_CHAT_TURN_ORIGIN,
  readOwnerChatTurnText,
  stripMachineTurnAnnotations,
} from './owner-chat-turn';

describe('ownerChatWakePayloadFields', () => {
  /**
   * THE REGRESSION THAT SHIPPED BROKEN ONCE. The composer posts `body` as a
   * string, but `applyOwnerMessageDefaults` rewrites it to `[{ text, forYouBecause }]`
   * before the send tool ever sees it. The first cut of this guarded the call site
   * with `typeof body === 'string'`, so every REAL owner message normalised to ""
   * and the marker was never stamped — unit tests green, live delivery unchanged.
   * The section-array case below is the one that matters; the string case is the
   * one that used to be the only one tested.
   */
  it('reads the SECTION-ARRAY shape the GUI wrapper actually produces', () => {
    const guiBody = [{ text: 'hi', forYouBecause: { relation: 'other', note: 'addressed you' } }];
    expect(ownerChatWakePayloadFields(guiBody)).toEqual({
      [OWNER_CHAT_TURN_MARKER]: true,
      [OWNER_CHAT_TEXT_FIELD]: 'hi',
    });
  });

  it('joins multiple sections rather than dropping all but the first', () => {
    expect(
      ownerChatWakePayloadFields([{ text: 'first' }, { text: 'second' }])[OWNER_CHAT_TEXT_FIELD],
    ).toBe('first\n\nsecond');
  });

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
    expect(ownerChatWakePayloadFields([])).toEqual({});
    expect(ownerChatWakePayloadFields([{ forYouBecause: {} }])).toEqual({});
    // Nothing else is a body — a malformed shape must degrade, never throw.
    expect(ownerChatWakePayloadFields(undefined)).toEqual({});
    expect(ownerChatWakePayloadFields({ text: 'not a section array' })).toEqual({});
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

describe('ownerVisiblePromptText — what the OWNER sees in their chat pane (EI-20135573616431912)', () => {
  // Owner-reported: "All I said was hi ... Why did that agent then go on to say all
  // this?" — followed by a pasted Stop-hook wall. Every string below is REAL stored
  // text from harness_shared.session_turns (speaker='user'), not an invented shape.
  // That distinction already cost this feature once: the first live test of the
  // sibling item failed because the unit tests only exercised a hand-written shape
  // the real caller never sends.

  it('HIDES a loop-fire wake — the single biggest source of the leak', () => {
    const real =
      '⟦turn-origin:loop-fire nonce:5249104759324978⟧\n' +
      '[await-event] coord:inbox-wake:su-89beac53 fired — 🔁 Loop wake (every ~300s after each turn settles). ' +
      'You are continuing your OWN warm session toward: ...';
    expect(ownerVisiblePromptText(real)).toBe('');
  });

  it('HIDES a wake-pump delivery', () => {
    const real =
      '⟦turn-origin:wake-pump nonce:a86e21b122a13757⟧\n' +
      '[await-event] coord:inbox-wake:su-89beac53 fired — Your send.ts change red-gated operator-core.';
    expect(ownerVisiblePromptText(real)).toBe('');
  });

  it('HIDES a Stop-hook coaching wall — it is harness→agent, recorded as a user turn only because that is the injection channel', () => {
    const real =
      'Stop hook feedback:\nThis turn ends by handing the next move back to the owner WITHOUT asking ' +
      'anything answerable — a hand-back, not a question.';
    expect(ownerVisiblePromptText(real)).toBe('');
  });

  it("SHOWS the owner's own chat message, with the envelope and trailing note removed", () => {
    // The exact bytes captured off the live :3170 delivery for the sibling item.
    const real =
      '⟦turn-origin:coord-inject:owner nonce:fa2f7c5a6200e4ad⟧\n' +
      'take 2: does this arrive as my own turn?\n\n' +
      `${OWNER_CHAT_NOTE_TAG} Your owner typed the message above in their session chat pane...`;
    expect(ownerVisiblePromptText(real)).toBe('take 2: does this arrive as my own turn?');
  });

  it('SHOWS an ordinary typed turn unchanged (no envelope, no markers)', () => {
    const typed = 'All I said was hi in a new session with su-349bf in the gui';
    expect(ownerVisiblePromptText(typed)).toBe(typed);
  });

  it('DRIFT RAIL: the origin the display filter allows is the SAME constant wake-executor mints', () => {
    // The dangerous direction. wake-executor tags owner-authored deliveries with
    // OWNER_CHAT_TURN_ORIGIN and this filter hides every user turn whose origin is
    // not that exact string — so if the two ever diverge the owner's OWN messages
    // silently vanish from their pane. Both sides now read this one constant;
    // this asserts the envelope built from it survives the filter.
    const envelope = `⟦turn-origin:${OWNER_CHAT_TURN_ORIGIN} nonce:deadbeefcafe1234⟧\nhi`;
    expect(ownerVisiblePromptText(envelope)).toBe('hi');
  });

  it('fails CLOSED on an unrecognized future wake kind', () => {
    // A deny-list would leak a wake kind nobody has invented yet; keying on
    // provenance means the default for "enveloped but not owner-authored" is HIDE.
    expect(ownerVisiblePromptText('⟦turn-origin:some-future-kind nonce:0123456789ab⟧\nmachine noise')).toBe('');
  });
});
