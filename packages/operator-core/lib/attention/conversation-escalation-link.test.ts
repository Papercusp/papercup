import { describe, expect, it } from 'vitest';
import {
  ANSWERED_QUESTION_CHOICE,
  ANSWERED_QUESTION_RESOLVER,
  CONVERSATION_LINK_META_KEY,
  conversationLinkMeta,
  selectEscalationsForConversation,
} from './conversation-escalation-link';

describe('conversationLinkMeta', () => {
  it('stamps the conversation id under the key the escalation envelope spreads flat', () => {
    expect(conversationLinkMeta('conv-abc')).toEqual({ conversationId: 'conv-abc' });
    expect(CONVERSATION_LINK_META_KEY).toBe('conversationId');
  });

  it('carries no other keys — an extra meta key must not perturb escalation dedup', () => {
    // escalationDedupIdentity reads ONLY subjectSignature/dedupKind. If this
    // stamp ever grew either of those names it would silently re-key dedup for
    // every ask-owner escalation.
    const keys = Object.keys(conversationLinkMeta('conv-abc'));
    expect(keys).toEqual(['conversationId']);
    expect(keys).not.toContain('subjectSignature');
    expect(keys).not.toContain('dedupKind');
  });
});

describe('selectEscalationsForConversation', () => {
  const linked = (msg_id: string, conversationId: string) => ({ msg_id, conversationId });

  it('selects the escalation twin stamped with the conversation id', () => {
    const opens = [
      linked('esc-1', 'conv-target'),
      linked('esc-2', 'conv-other'),
      { msg_id: 'esc-3' }, // an ordinary escalation, no link
    ];
    expect(selectEscalationsForConversation(opens, 'conv-target')).toEqual(['esc-1']);
  });

  it('selects every twin when an ask somehow opened more than one', () => {
    const opens = [linked('esc-1', 'conv-x'), linked('esc-2', 'conv-x')];
    expect(selectEscalationsForConversation(opens, 'conv-x')).toEqual(['esc-1', 'esc-2']);
  });

  it('returns nothing when no escalation is linked — the common case', () => {
    expect(selectEscalationsForConversation([{ msg_id: 'esc-1' }], 'conv-x')).toEqual([]);
  });

  it('NEVER matches on an id prefix — a near-miss must not close an unrelated decision', () => {
    // A conversation and its escalation are minted ~30ms apart, so their base36
    // ids share a long prefix. That similarity is how the existing zombies were
    // FOUND; resolving on it would silently close someone else's open owner
    // decision, which is strictly worse than leaving a zombie. Exact match only.
    const opens = [
      linked('msbkhojk-0000-aaaa', 'conv-msbkhoir-0000-bbbb'),
      linked('msbkhoxx-0000-cccc', 'conv-msbkhoir-0000-dddd'),
    ];
    expect(selectEscalationsForConversation(opens, 'conv-msbkhoir-0000-bbbb')).toEqual([
      'msbkhojk-0000-aaaa',
    ]);
    // The near-identical sibling is NOT swept in.
    expect(selectEscalationsForConversation(opens, 'conv-msbkho')).toEqual([]);
  });

  it('tolerates whitespace on either side without loosening the match', () => {
    const opens = [{ msg_id: 'esc-1', conversationId: ' conv-x ' }];
    expect(selectEscalationsForConversation(opens, 'conv-x')).toEqual(['esc-1']);
    expect(selectEscalationsForConversation(opens, 'conv')).toEqual([]);
  });

  it('ignores a blank conversation id rather than matching every blank stamp', () => {
    // A blank target must never select rows — otherwise one malformed resolve
    // would batch-close every escalation carrying an empty link.
    const opens = [{ msg_id: 'esc-1', conversationId: '' }, { msg_id: 'esc-2' }];
    expect(selectEscalationsForConversation(opens, '')).toEqual([]);
    expect(selectEscalationsForConversation(opens, '   ')).toEqual([]);
  });

  it('ignores rows with a missing or non-string msg_id / link', () => {
    const opens = [
      { msg_id: '', conversationId: 'conv-x' },
      { msg_id: 'esc-2', conversationId: 42 },
      { msg_id: 'esc-3', conversationId: null },
      { msg_id: 'esc-4', conversationId: 'conv-x' },
    ] as unknown as { msg_id: string }[];
    expect(selectEscalationsForConversation(opens, 'conv-x')).toEqual(['esc-4']);
  });

  it('exports a resolver identity and choice that name the mechanism, not a fake owner choice', () => {
    // The owner's real answer lives on the conversation; this resolve must not
    // masquerade as a decision the owner made on the escalation itself.
    expect(ANSWERED_QUESTION_RESOLVER.startsWith('system:')).toBe(true);
    expect(ANSWERED_QUESTION_CHOICE).toBe('answered-in-conversation');
  });
});
