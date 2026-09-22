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
  isOwnerVisiblePrompt,
  OWNER_CHAT_NOTE_TAG,
  OWNER_CHAT_TEXT_FIELD,
  OWNER_CHAT_TURN_MARKER,
  ownerChatTurnText,
  ownerChatWakePayloadFields,
  ownerVisiblePromptText,
  ownerVisibilityVerdict,
  OWNER_CHAT_TURN_ORIGIN,
  OWNER_VISIBILITY_DECIDING_PREFIX_CHARS,
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

  it('HIDES a legacy envelope-less wake delivery from session_turns', () => {
    // Verbatim shape measured in the live corpus: old wake rows begin directly
    // with the canonical await-event prefix because they predate seam tagging.
    const real =
      '[await-event] coord:inbox-wake:su-4bab8522 fired — rate limit recovered on avis.';
    expect(ownerVisiblePromptText(real)).toBe('');
  });

  it('keeps an owner turn that merely mentions the await-event label', () => {
    const typed = '[await-event] is the protocol name I am investigating';
    expect(ownerVisiblePromptText(typed)).toBe(typed);
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

  // WI-10002461: PTY injectors now arrive as ONE Claude Code paste block. The bytes
  // below are the shape of owner directive #170, a wake captured as an owner order.
  it('HIDES a wake-pump delivery that arrived wrapped in a whole-prompt paste block', () => {
    const real =
      '\n\n<pasted_content id="4e03">\n⟦turn-origin:wake-pump nonce:cf7033781a55ad74⟧\n' +
      '[await-event] work-item:done:WI-10002459 fired — WI-10002459 settled → done.\n' +
      '</pasted_content id="4e03">\n';
    expect(ownerVisiblePromptText(real)).toBe('');
  });

  it('SHOWS an owner turn that quotes a pasted wake inside their own words', () => {
    const typed =
      'why did this fire?\n\n<pasted_content id="19fa">\n⟦turn-origin:wake-pump nonce:cf7033781a55ad74⟧\n' +
      '[await-event] x fired — y\n</pasted_content id="19fa">';
    expect(ownerVisiblePromptText(typed)).not.toBe('');
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

/**
 * P-001 · THE FALSIFYING FIXTURE — `owner-visibility-provenance-2026-08-11`.
 *
 * Every fixture ABOVE feeds text that CARRIES an envelope, so the suite exercises
 * the branches that work and never feeds the case that walks through the default.
 * That is why three fixes went `done` here and failed live within hours (WI-37883,
 * WI-37908, EI-20135573616431912): a suite built from the same assumption as the
 * code cannot falsify it. These are the missing rows.
 *
 * MEASURED, not invented — `harness_shared.session_turns` where speaker='user' and
 * the text carries NO `⟦turn-origin:…⟧` envelope, 7 days to 2026-08-11:
 *
 *     1844  un-enveloped user turns in total
 *       50  hidden by today's two un-enveloped rules (2.7%)
 *      367  compaction preamble          <- shown as the owner's own speech
 *      107  [Request interrupted by user] <-        "
 *       86  injected role prompts         <-        " (# Mug 43 · # AGENTS.md 31
 *                                                     · # Kettle 21 · # Autonomous
 *                                                     loop check 15, 14d window)
 *
 * A second agent censused the same population independently and agrees: 1,809 shown
 * / ≥1,051 machine (58%), compaction preamble 368. Full table on WI-37953 — read it
 * before adding a fourth shape here, so the next one added is the next BIGGEST one.
 *
 * The direct red evidence (WI-37953): calling the predicate on all three returns the
 * text UNCHANGED — 247 / 29 / 186 chars, `isOwnerVisiblePrompt === true` for each.
 * Nothing about these is hidden today; they are shown to the owner as their own words.
 *
 * ⚠ WHY THESE ARE `it.fails` AND NOT PLAIN RED TESTS. The assertions below are the
 * real ones and they DO fail on today's predicate — the red run is recorded on
 * WI-37953. Committing them plain would red the green-checkpoint gate for the whole
 * fleet until P-002/P-003 land, which buys nothing the marker does not already give:
 * `it.fails` PASSES only while the leak exists and turns RED the moment a fix closes
 * it, per shape, forcing whoever lands the fix to flip that line to a plain `it`.
 * So this is a live guard from the first commit rather than a broken build, and it
 * cannot be satisfied by a partial fix — each shape is asserted on its own.
 *
 * ⛔ It is NOT an invitation to add a third matcher (plan D-002/D-003). A display-side
 * deny-list cannot separate machine `"Continue from where you left off."` from
 * owner-typed `"continue where you left off"`; that residue is P-004's job. These
 * three shapes are structurally separable, which is exactly why they are the ones
 * pinned here.
 */
describe('ownerVisiblePromptText — UN-ENVELOPED machine text walks through the fallthrough (P-001)', () => {
  /** Verbatim head of the CLI's own compaction continuation — the single largest
   *  un-enveloped machine shape in the corpus. `turn-ref.ts:174` already records
   *  this population as "unenrollable — no injector". */
  const COMPACTION_PREAMBLE =
    'This session is being continued from a previous conversation that ran out of context. ' +
    'The summary below covers the earlier portion of the conversation.\n\n' +
    '<analysis>\nChronologically:\n\n1. Prior turns (su-e0359276) established the carry-note protocol…';

  /** The CLI writes this as a `user` turn when the human presses Escape. The owner
   *  did not type it — the harness authored it ABOUT them. */
  const REQUEST_INTERRUPTED = '[Request interrupted by user]';

  /** A role prompt injected as the first user turn of a spawned agent. The owner
   *  reads their whole persona doc rendered as something they apparently said. */
  const INJECTED_ROLE_PROMPT =
    '# Mug — pot placement decider\n\n' +
    'You are the Mug of this Pot: the placement and priority decider for the cup\n' +
    'fleet. Each wake is fresh. Re-derive state from durable substrate, act, record.';

  /* CLOSED by V-003 (P-003): the un-enveloped branch now routes through the ONE
     curated list in `turn-provenance/machine-surface-catalogue.ts`. These two flipped
     from `it.fails` to `it` — which is exactly the mechanism the header describes. */
  it('HIDES the CLI compaction preamble (367 rows/7d — the biggest single leak)', () => {
    expect(ownerVisiblePromptText(COMPACTION_PREAMBLE)).toBe('');
  });

  it('HIDES `[Request interrupted by user]` (107 rows/7d — the harness narrating the owner)', () => {
    expect(ownerVisiblePromptText(REQUEST_INTERRUPTED)).toBe('');
  });

  /* STILL OPEN, deliberately. Nothing structurally separates '# Mug — pot placement
     decider' from an owner's own '# my notes', so closing this one display-side needs
     exactly the matcher D-002/D-003 forbid. It is P-004's (provenance at ingest) —
     do NOT close it by adding a pattern. The census below stays red with it. */
  it.fails('HIDES an injected role prompt (86 rows/14d — a persona doc attributed to the owner)', () => {
    expect(ownerVisiblePromptText(INJECTED_ROLE_PROMPT)).toBe('');
  });

  it.fails('HIDES every un-enveloped machine shape, not just the one that was fixed last', () => {
    /* The census assertion. A fix that closes one shape and leaves the siblings is
       the failure mode this plan exists to stop, so the set is asserted together —
       and it stays `it.fails` until ALL of them are closed. */
    for (const machine of [COMPACTION_PREAMBLE, REQUEST_INTERRUPTED, INJECTED_ROLE_PROMPT]) {
      expect(ownerVisiblePromptText(machine)).toBe('');
    }
  });

  /* ── The rails below are GREEN TODAY and must STAY green through the fix. ──
     They are the other half of the instrument: the danger of any change here is
     over-hiding, and hiding what the human actually wrote is the unrecoverable
     direction (see OWNER_CHAT_TURN_ORIGIN's note). A fix that turns the four
     assertions above green while reddening these has made the surface worse. */

  it('SHOWS the owner ASKING about the machine text they are seeing', () => {
    const typed = 'why does [Request interrupted by user] keep appearing in my chat as if I wrote it?';
    expect(ownerVisiblePromptText(typed)).toBe(typed);
  });

  it('SHOWS an owner turn that merely OPENS with a markdown heading', () => {
    // The role-prompt shape starts with `# `, and so does plenty of owner prose.
    // A matcher keyed on the leading `#` would eat this; a curated-prefix one will not.
    const typed = '# my notes\n\nship the pane fix, then re-run the stranger pass';
    expect(ownerVisiblePromptText(typed)).toBe(typed);
  });

  it('SHOWS an owner turn that QUOTES the compaction preamble mid-sentence', () => {
    const typed =
      'the pane shows "This session is being continued from a previous conversation" as my own message — fix that';
    expect(ownerVisiblePromptText(typed)).toBe(typed);
  });

  it('DERIVATION RAIL: the boolean form agrees with the text form on all three shapes', () => {
    // Holds before and after the fix. It is what stops the search path (WI-37883)
    // and the pane from drifting into two different answers about the same turn.
    for (const text of [COMPACTION_PREAMBLE, REQUEST_INTERRUPTED, INJECTED_ROLE_PROMPT]) {
      expect(isOwnerVisiblePrompt(text)).toBe(ownerVisiblePromptText(text) !== '');
    }
  });

  it('PREFIX RAIL: the bounded head decides these shapes identically to the whole turn', () => {
    // The search path hydrates only OWNER_VISIBILITY_DECIDING_PREFIX_CHARS. Each of
    // these shapes is identified by its FIRST LINE, so the property must survive the
    // fix — a fix keyed on something deeper in the body would silently break search.
    for (const head of [COMPACTION_PREAMBLE, REQUEST_INTERRUPTED, INJECTED_ROLE_PROMPT]) {
      const whole = `${head}\n${'x'.repeat(4096)}`;
      expect(isOwnerVisiblePrompt(whole.slice(0, OWNER_VISIBILITY_DECIDING_PREFIX_CHARS))).toBe(
        isOwnerVisiblePrompt(whole),
      );
    }
  });
});

/**
 * WI-37883 — the boolean form, and the property the SEARCH path depends on.
 *
 * The chat pane calls `ownerVisiblePromptText` with the whole turn because it is
 * about to render the result. The transcript search only needs the VERDICT, for a
 * page of hits at a time, so it hydrates a bounded head instead of whole
 * transcripts. These tests pin the two things that makes safe: the boolean agrees
 * with the text function, and the verdict is decided by the head.
 */
describe('isOwnerVisiblePrompt', () => {
  const OWNER_ENVELOPE = `⟦turn-origin:${OWNER_CHAT_TURN_ORIGIN} nonce:deadbeefcafe1234⟧\n`;
  const MACHINE_ENVELOPE = '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\n';

  it('agrees with ownerVisiblePromptText on every branch of the allow-list', () => {
    // Derived from it rather than re-stating the rule — this asserts the
    // derivation, so a future edit to one cannot quietly disagree with the other.
    for (const text of [
      '',
      'plain typed message',
      `${OWNER_ENVELOPE}hi`,
      `${MACHINE_ENVELOPE}🔁 Loop wake (every ~300s)`,
      '⟦turn-origin:wake-pump nonce:0123456789ab⟧\n[await-event] coord:inbox-wake fired',
      '⟦turn-origin:some-future-kind nonce:0123456789ab⟧\nmachine noise',
      'Stop hook feedback:\nThis turn ends by handing the next move back to the owner',
    ]) {
      expect(isOwnerVisiblePrompt(text)).toBe(ownerVisiblePromptText(text) !== '');
    }
  });

  it('HIDES a machine wake and SHOWS the owner\'s own turn', () => {
    expect(isOwnerVisiblePrompt(`${MACHINE_ENVELOPE}loop wake`)).toBe(false);
    expect(isOwnerVisiblePrompt(`${OWNER_ENVELOPE}hi`)).toBe(true);
    expect(isOwnerVisiblePrompt('hi')).toBe(true);
  });

  it('PREFIX-SAFE for a DECISIVE head: the verdict off a truncated head matches the whole turn', () => {
    /* The property the search path rests on, stated with the precondition it
       actually needs. Every branch keys on a LEADING marker, so hydrating
       `left(text, N)` must not change the answer — PROVIDED the head is
       decisive, i.e. it carries a marker or visible content. A 4KB body is far
       past the bound.

       ⚠ WI-37910: this test used to be named plain `PREFIX-SAFE` and to assert
       a GENERAL equivalence. A body of solid `x` can never produce a
       whitespace-only head, so it could not reach the region where the
       equivalence fails, and the name certified a guarantee the code does not
       have. The counterexamples now live in their own test below; keep both —
       the pair is the honest statement. */
    const body = 'x'.repeat(4096);
    for (const whole of [
      `${MACHINE_ENVELOPE}${body}`,
      `${OWNER_ENVELOPE}${body}`,
      `Stop hook feedback:\n${body}`,
      body,
    ]) {
      const head = whole.slice(0, OWNER_VISIBILITY_DECIDING_PREFIX_CHARS);
      expect(isOwnerVisiblePrompt(head)).toBe(isOwnerVisiblePrompt(whole));
    }
  });

  it('DIVERGES on a CONTENT-FREE head — pinned in the direction that hides a human turn (WI-37910)', () => {
    /* The region the old PREFIX-SAFE body could not reach. When the first
       OWNER_VISIBILITY_DECIDING_PREFIX_CHARS characters are all whitespace, the
       head strips to '' and reads HIDE while the whole turn reads SHOW — the
       predicate answering `false` about text a human wrote.

       This is pinned as a KNOWN divergence rather than fixed in the predicate:
       `ownerVisiblePromptText` cannot tell a head from a whole turn, so making
       a content-free window mean "inconclusive" here would render a blank row
       for a genuinely whitespace-only turn. It is closed at the consumer —
       see the fail-open test in adv-session-search.test.ts. If a future change
       makes these agree, DELETE this test rather than weakening it; if it makes
       them diverge somewhere new, this is the test that should tell you. */
    const blankHead = ' '.repeat(OWNER_VISIBILITY_DECIDING_PREFIX_CHARS + 8);
    for (const whole of [
      `${blankHead}a genuinely typed message that starts past the bound`,
      // The enveloped variant is divergent for a DIFFERENT reason and a
      // `head.trim() === ''` test cannot see it: the head is not content-free —
      // it carries the owner envelope — it just strips to nothing. That is
      // precisely why the consumer guard is a tri-state and not a trim check.
      `${OWNER_ENVELOPE}${blankHead}a genuinely typed message that starts past the bound`,
    ]) {
      const head = whole.slice(0, OWNER_VISIBILITY_DECIDING_PREFIX_CHARS);
      expect(
        ownerVisibilityVerdict(head),
        'the head must carry no VISIBLE content for this to be the divergent case',
      ).toBe('inconclusive');
      expect(isOwnerVisiblePrompt(whole), 'the whole turn is the human\'s and must SHOW').toBe(true);
      expect(isOwnerVisiblePrompt(head), 'the boolean form still reads HIDE off the head — the divergence').toBe(false);
    }
  });

  it('the tri-state separates a MATCHED hide rule from an undecidable window (WI-37910)', () => {
    /* The property the consumer's fail-open rests on. `isOwnerVisiblePrompt`
       answers false for both of these; only the tri-state can tell them apart,
       and the difference is whether dropping the row is safe. */
    expect(ownerVisibilityVerdict(`${MACHINE_ENVELOPE}loop wake`)).toBe('hide');
    expect(ownerVisibilityVerdict('Stop hook feedback:\nharness coaching')).toBe('hide');
    expect(ownerVisibilityVerdict(`${OWNER_ENVELOPE}hi`)).toBe('show');
    expect(ownerVisibilityVerdict('a genuinely typed message')).toBe('show');
    expect(ownerVisibilityVerdict('   \n\t ')).toBe('inconclusive');
    expect(ownerVisibilityVerdict(`${OWNER_ENVELOPE}   `)).toBe('inconclusive');
    expect(ownerVisibilityVerdict('')).toBe('inconclusive');
  });

  it('DERIVATION RAIL: the text form shows exactly what the tri-state calls show (WI-37910)', () => {
    /* Both public forms come off ONE classifier; this pins that they cannot
       drift, the same way the boolean form is pinned against the text form. */
    for (const text of [
      '',
      '   ',
      'plain typed message',
      `${OWNER_ENVELOPE}hi`,
      `${OWNER_ENVELOPE}   `,
      `${MACHINE_ENVELOPE}🔁 Loop wake (every ~300s)`,
      'Stop hook feedback:\nthis turn ends by handing the next move back',
      '⟦turn-origin:wake-pump nonce:0123456789ab⟧\n[await-event] coord:inbox-wake fired',
    ]) {
      expect(ownerVisiblePromptText(text) !== '').toBe(ownerVisibilityVerdict(text) === 'show');
      expect(isOwnerVisiblePrompt(text)).toBe(ownerVisibilityVerdict(text) === 'show');
    }
  });

  it('the bound is comfortably longer than the envelope that has to fit inside it', () => {
    /* The one way prefix-safety breaks is a marker that no longer fits: a
       truncated envelope stops matching and reads as unmarked prose, i.e. as the
       OWNER'S — the leak direction. Asserted as headroom, not as an exact width,
       so the envelope can grow without this test dictating the constant. */
    expect(OWNER_VISIBILITY_DECIDING_PREFIX_CHARS).toBeGreaterThan(MACHINE_ENVELOPE.length * 3);
  });

  it('an unmarked head reads SHOW — the safe direction', () => {
    /* ⚠ WI-37910, and read this before "strengthening" the test. It used to be
       named `fails toward SHOWING when the head is unmarked (the safe
       direction)` and to assert only `isOwnerVisiblePrompt('a genuinely typed
       message') === true` — true of any plain string, exercising no divergence
       at all. The name promised a property the body never built.

       I tried to build it and could NOT. "Divergence 1" (head SHOWS, whole
       HIDES) needs a turn whose head is unmarked but whose FULL text strips to
       empty. Every HIDE rule keys on the TRIMMED START, so an unmarked head
       implies an unmarked whole, which takes the fallthrough and returns
       `stripMachineTurnAnnotations(text)` — non-empty whenever the head carried
       visible content. I could not find a shape that satisfies both halves.

       So divergence 1 may not be reachable at all, which would mean the
       original comment documented an unconstructible divergence while missing
       the reachable one (divergence 2, pinned above). I am NOT asserting that
       — absence of a construction is not proof of impossibility, and I did not
       run a property search. It is recorded on WI-37910 as an open question.

       This test therefore asserts only what is demonstrated: an unmarked head
       is SHOWN, which is the safe direction whether or not the whole agrees. */
    expect(isOwnerVisiblePrompt('a genuinely typed message')).toBe(true);
    const head = 'y'.repeat(OWNER_VISIBILITY_DECIDING_PREFIX_CHARS);
    expect(isOwnerVisiblePrompt(head), 'an unmarked head reads SHOW').toBe(true);
    expect(ownerVisibilityVerdict(head)).toBe('show');
  });
});
