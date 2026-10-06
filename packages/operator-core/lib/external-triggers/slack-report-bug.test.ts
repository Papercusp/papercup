/**
 * slack-messages-to-bug-reports-2026-10-05 P-002 (R-2): each Slack report gesture, fed as a
 * recorded Socket Mode envelope, yields exactly one report-bug chat signal, and none
 * while its channel rule is off.
 */
import { describe, expect, it } from 'vitest';
import {
  classifySlackReportBugEnvelope,
  slackMentionHasBugIntent,
  slackReportBugConfig,
  slackReportBugModalView,
  SLACK_REPORT_BUG_ATTACHMENT_CONSENT,
  SLACK_REPORT_BUG_MODAL_CALLBACK_ID,
  SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID,
  type SlackReportBugClassification,
  type SlackReportBugConfig,
} from './slack-report-bug';
import type { SlackSocketEnvelope } from './slack';

const ALL_ON = { reaction: true, shortcut: true, mention: true, bugChannel: false };

function config(reportBug: unknown, extra: Record<string, unknown> = {}): SlackReportBugConfig {
  return slackReportBugConfig({ installSlug: 'papercusp', botUserId: 'UPAPER', reportBug, ...extra });
}

const ON_IN_C1 = config({ channels: { C1: ALL_ON, CBUGS: { bugChannel: true, mention: true } } });

function events(event: Record<string, unknown>, eventId = 'Ev1'): SlackSocketEnvelope {
  return { envelope_id: `env-${eventId}`, type: 'events_api', payload: { event_id: eventId, event_time: 1_777_000_000, event } };
}

function interactive(payload: Record<string, unknown>): SlackSocketEnvelope {
  return { envelope_id: 'env-int', type: 'interactive', accepts_response_payload: false, payload };
}

const REACTION = { type: 'reaction_added', user: 'U1', reaction: 'bug', item_user: 'U2', item: { type: 'message', channel: 'C1', ts: '1777000000.000100' }, event_ts: '1777000001.000200' };
const THREAD_MENTION = { type: 'app_mention', channel: 'C1', user: 'U3', text: '<@UPAPER> bug: the export button does nothing', ts: '1777000005.000500', thread_ts: '1777000000.000100' };
const SHORTCUT = {
  type: 'message_action', callback_id: SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID, trigger_id: 'trig-1',
  user: { id: 'U4' }, channel: { id: 'C1' }, team: { id: 'T1' },
  message: { ts: '1777000003.000300', thread_ts: '1777000000.000100', text: 'export broke again', user: 'U2' },
};

function submission(meta: Record<string, unknown>, values: Record<string, unknown>, viewId = 'V1'): SlackSocketEnvelope {
  return interactive({
    type: 'view_submission', user: { id: 'U4' },
    view: { id: viewId, callback_id: SLACK_REPORT_BUG_MODAL_CALLBACK_ID, private_metadata: JSON.stringify(meta), state: { values } },
  });
}

const CONSENTED = {
  note: { note: { type: 'plain_text_input', value: '  Happens on every export since Monday  ' } },
  consent: { consent: { type: 'checkboxes', selected_options: [{ value: SLACK_REPORT_BUG_ATTACHMENT_CONSENT }] } },
};

function signalOf(result: SlackReportBugClassification) {
  expect(result?.kind).toBe('signal');
  return result?.kind === 'signal' ? result.event : (undefined as never);
}

describe('Slack report-bug gestures', () => {
  it('a bug-emoji reaction is one report-bug signal pointing at the reacted message', () => {
    const event = signalOf(classifySlackReportBugEnvelope(events(REACTION), ON_IN_C1));
    expect(event).toMatchObject({ event: 'report-bug', externalId: 'Ev1', dedupeKey: 'slack:Ev1', channelId: 'C1' });
    expect(event.payload).toMatchObject({
      id: 'Ev1', signal: 'report-bug', gesture: 'reaction', channelId: 'C1', threadId: '1777000000.000100',
      sender: 'U1', text: '',
      reporter: { kind: 'chat', provider: 'slack', externalUserId: 'U1' },
      target: { channelId: 'C1', ts: '1777000000.000100' },
    });
    // The reactor is provenance only: nothing resolves it to a local principal.
    expect(JSON.stringify(event.payload)).not.toMatch(/principal|userId"/);
  });

  it('honours a configured emoji, with or without colons, and ignores other reactions', () => {
    const party = config({ emoji: ':beetle:', channels: { C1: ALL_ON } });
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, reaction: 'beetle' }), party)?.kind).toBe('signal');
    expect(classifySlackReportBugEnvelope(events(REACTION), party)).toBeNull();
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, reaction: 'thumbsup' }), ON_IN_C1)).toBeNull();
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, reaction: 'bug::skin-tone-2' }), ON_IN_C1)?.kind).toBe('signal');
  });

  it('never reports the bot’s own reaction or a reaction on a non-message item', () => {
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, user: 'UPAPER' }), ON_IN_C1)).toEqual({ kind: 'consumed', reason: 'own-reaction' });
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, item: { type: 'file', file: 'F1' } }), ON_IN_C1)).toBeNull();
  });

  it('"@Papercusp bug" in a thread is one signal that reports the thread’s root message', () => {
    const event = signalOf(classifySlackReportBugEnvelope(events(THREAD_MENTION, 'Ev3'), ON_IN_C1));
    expect(event.payload).toMatchObject({
      gesture: 'mention', sender: 'U3', text: THREAD_MENTION.text, mentions: ['UPAPER'],
      target: { channelId: 'C1', ts: '1777000000.000100', threadTs: '1777000000.000100' },
    });
    const topLevel = signalOf(classifySlackReportBugEnvelope(events({ ...THREAD_MENTION, thread_ts: undefined }, 'Ev4'), ON_IN_C1));
    expect(topLevel.payload).toMatchObject({ target: { channelId: 'C1', ts: '1777000005.000500' } });
  });

  it('a mention without a bug intent is not a report and falls through to the ordinary trigger path', () => {
    expect(classifySlackReportBugEnvelope(events({ ...THREAD_MENTION, text: '<@UPAPER> summarize this thread' }), ON_IN_C1)).toBeNull();
    for (const yes of ['<@UPAPER> bug', '<@UPAPER> :bug: crash', '<@UPAPER> 🐛', '<@UPAPER|papercusp> report a bug', '<@UPAPER> Report this bug please', '<@UPAPER> bugs everywhere']) {
      expect(slackMentionHasBugIntent(yes), yes).toBe(true);
    }
    for (const no of ['<@UPAPER> debug the build', '<@UPAPER> is this a bug?', '<@UPAPER> report the weekly numbers', 'bugfix shipped']) {
      expect(slackMentionHasBugIntent(no), no).toBe(false);
    }
  });

  it('the shortcut opens a form, and only the form’s submission is the signal (with note and consent)', () => {
    expect(classifySlackReportBugEnvelope(interactive(SHORTCUT), ON_IN_C1)).toEqual({
      kind: 'open-modal',
      request: { triggerId: 'trig-1', channelId: 'C1', messageTs: '1777000003.000300', threadTs: '1777000000.000100', reporterUserId: 'U4' },
    });
    const view = slackReportBugModalView({ triggerId: 'trig-1', channelId: 'C1', messageTs: '1777000003.000300', threadTs: '1777000000.000100', reporterUserId: 'U4' });
    expect(view).toMatchObject({ type: 'modal', callback_id: SLACK_REPORT_BUG_MODAL_CALLBACK_ID });
    const meta = JSON.parse(String(view.private_metadata));
    expect(meta).toEqual({ channelId: 'C1', messageTs: '1777000003.000300', threadTs: '1777000000.000100' });

    const event = signalOf(classifySlackReportBugEnvelope(submission(meta, CONSENTED), ON_IN_C1));
    expect(event).toMatchObject({ event: 'report-bug', externalId: 'view:V1', dedupeKey: 'slack:view:V1' });
    expect(event.payload).toMatchObject({
      gesture: 'shortcut', sender: 'U4', note: 'Happens on every export since Monday', text: 'Happens on every export since Monday',
      attachmentConsent: true, target: { channelId: 'C1', ts: '1777000003.000300', threadTs: '1777000000.000100' },
    });
  });

  it('a submission without the tick box records no attachment consent, and an empty note is omitted', () => {
    const event = signalOf(classifySlackReportBugEnvelope(
      submission({ channelId: 'C1', messageTs: '1777000003.000300' }, { note: { note: { value: '' } }, consent: { consent: { selected_options: [] } } }, 'V2'),
      ON_IN_C1,
    ));
    expect(event.payload.attachmentConsent).toBe(false);
    expect(event.payload).not.toHaveProperty('note');
    expect(event.payload).toMatchObject({ target: { channelId: 'C1', ts: '1777000003.000300' } });
  });

  it('target.text carries the reported message’s own text only when the gesture event IS that message (D-009)', () => {
    // Only these two may be stored as the reported message's body by the chat admission sink.
    const post = { type: 'message', channel: 'CBUGS', channel_type: 'channel', user: 'U5', text: 'login loops forever', ts: '1777000010.000100' };
    const bugChannel = signalOf(classifySlackReportBugEnvelope(events(post, 'Ev20'), ON_IN_C1));
    expect((bugChannel.payload.target as Record<string, unknown>).text).toBe('login loops forever');
    const topMention = signalOf(classifySlackReportBugEnvelope(events({ ...THREAD_MENTION, thread_ts: undefined }, 'Ev21'), ON_IN_C1));
    expect((topMention.payload.target as Record<string, unknown>).text).toBe(THREAD_MENTION.text);
    // The reaction carries no text, the in-thread mention reports the ROOT (its text is the
    // mention's), and the shortcut's text is the reporter's note: none of them names the subject.
    const reaction = signalOf(classifySlackReportBugEnvelope(events(REACTION, 'Ev22'), ON_IN_C1));
    const threadMention = signalOf(classifySlackReportBugEnvelope(events(THREAD_MENTION, 'Ev23'), ON_IN_C1));
    const shortcut = signalOf(classifySlackReportBugEnvelope(
      submission({ channelId: 'C1', messageTs: '1777000003.000300' }, { note: { note: { value: 'every export' } } }, 'V20'),
      ON_IN_C1,
    ));
    for (const signal of [reaction, threadMention, shortcut]) {
      expect(signal.payload.target).not.toHaveProperty('text');
    }
  });

  it('a new top-level post in a bug channel is exactly one signal, even though Slack also sends app_mention', () => {
    const post = { type: 'message', channel: 'CBUGS', channel_type: 'channel', user: 'U5', text: '<@UPAPER> login loops forever', ts: '1777000010.000100' };
    const fromMessage = signalOf(classifySlackReportBugEnvelope(events(post, 'Ev10'), ON_IN_C1));
    expect(fromMessage.payload).toMatchObject({ gesture: 'bug-channel', sender: 'U5', target: { channelId: 'CBUGS', ts: '1777000010.000100' } });
    const fromMention = classifySlackReportBugEnvelope(events({ ...post, type: 'app_mention' }, 'Ev11'), ON_IN_C1);
    expect(fromMention).toEqual({ kind: 'consumed', reason: 'bug-channel-post-reported-by-message-event' });
    // Replies inside a report thread are conversation, not new reports.
    expect(classifySlackReportBugEnvelope(events({ ...post, ts: '1777000011.0', thread_ts: '1777000010.000100' }, 'Ev12'), ON_IN_C1)).toBeNull();
    // Bot posts and edits never file.
    expect(classifySlackReportBugEnvelope(events({ ...post, bot_id: 'B1' }, 'Ev13'), ON_IN_C1)).toBeNull();
    expect(classifySlackReportBugEnvelope(events({ ...post, subtype: 'message_changed' }, 'Ev14'), ON_IN_C1)).toBeNull();
  });

  it('every gesture is off until a channel rule turns it on; `*` is the default rule', () => {
    const none = config(undefined);
    const shortcutOff = classifySlackReportBugEnvelope(interactive(SHORTCUT), none);
    expect(shortcutOff).toEqual({ kind: 'consumed', reason: 'shortcut-off-in-channel' });
    for (const envelope of [events(REACTION), events(THREAD_MENTION), events({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U5', text: 'x', ts: '1.0' })]) {
      expect(classifySlackReportBugEnvelope(envelope, none)).toBeNull();
    }
    const otherChannel = classifySlackReportBugEnvelope(events({ ...REACTION, item: { ...REACTION.item, channel: 'C9' } }), ON_IN_C1);
    expect(otherChannel).toBeNull();
    const wildcard = config({ channels: { '*': { reaction: true } } });
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, item: { ...REACTION.item, channel: 'C9' } }), wildcard)?.kind).toBe('signal');
    // A channel's own rule beats the wildcard, even when it switches everything off.
    const override = config({ channels: { '*': { reaction: true }, C9: { reaction: false } } });
    expect(classifySlackReportBugEnvelope(events({ ...REACTION, item: { ...REACTION.item, channel: 'C9' } }), override)).toBeNull();
    // A channel switched off while the form was open files nothing at submit.
    expect(classifySlackReportBugEnvelope(submission({ channelId: 'C1', messageTs: '1.0' }, CONSENTED), none))
      .toEqual({ kind: 'consumed', reason: 'shortcut-off-in-channel' });
  });

  it('malformed rules read as off, never on', () => {
    const parsed = slackReportBugConfig({ reportBug: { emoji: 42, channels: { C1: { reaction: 'yes', mention: 1 }, '': { reaction: true }, C2: 'all' } } });
    expect(parsed).toEqual({
      emoji: 'bug', botUserId: null,
      channels: { C1: { reaction: false, shortcut: false, mention: false, bugChannel: false } },
    });
  });

  it('counts: four gestures in, four signals out, one each', () => {
    const cfg = config({ channels: { C1: ALL_ON, CBUGS: { bugChannel: true } } });
    const meta = { channelId: 'C1', messageTs: '1777000003.000300' };
    const envelopes: SlackSocketEnvelope[] = [
      events(REACTION, 'EvA'),
      events(THREAD_MENTION, 'EvB'),
      interactive(SHORTCUT),
      submission(meta, CONSENTED, 'VC'),
      events({ type: 'message', channel: 'CBUGS', channel_type: 'channel', user: 'U5', text: 'crash on save', ts: '1777000020.0' }, 'EvD'),
      events({ type: 'app_mention', channel: 'CBUGS', user: 'U5', text: '<@UPAPER> crash on save', ts: '1777000020.0' }, 'EvE'),
    ];
    const signals = envelopes
      .map((envelope) => classifySlackReportBugEnvelope(envelope, cfg))
      .filter((result) => result?.kind === 'signal')
      .map((result) => (result as { event: { payload: Record<string, unknown> } }).event.payload.gesture);
    expect(signals).toEqual(['reaction', 'mention', 'shortcut', 'bug-channel']);
  });
});
