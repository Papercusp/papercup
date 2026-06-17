/**
 * The pure poll tally + structured-post parsing. Pins the contract between a
 * participant's prompt and the reducer.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { aggregateVotes, parsePost } from './aggregate.js';

const votePost = (option: string, confidence: number, author = 'voter') => ({
  author_id: author,
  body: `Justification here.\n\`\`\`vote\noption: ${option}\nconfidence: ${confidence}\n\`\`\``,
});

test('parsePost — fenced vote block', () => {
  const { vote } = parsePost(votePost('yes', 0.8), ['yes', 'no']);
  assert.equal(vote?.option, 'yes');
  assert.equal(vote?.confidence, 0.8);
});

test('parsePost — un-fenced key lines (lenient fallback)', () => {
  // A voter that forgot the fence but put the keys on their own lines still counts.
  const { vote } = parsePost({ author_id: 'v', body: 'I lean against it.\noption: No\nconfidence: 0.6' }, ['yes', 'no']);
  assert.equal(vote?.option, 'no'); // canonicalised
  assert.equal(vote?.confidence, 0.6);
});

test('parsePost — advocate veto block', () => {
  const { advocate } = parsePost({
    author_id: 'adv',
    body: '```advocate\nveto: true\nobjection: this breaks the migration\n```',
  });
  assert.equal(advocate?.veto, true);
  assert.equal(advocate?.objection, 'this breaks the migration');
});

test('parsePost — confidence clamped + default', () => {
  assert.equal(parsePost(votePost('yes', 5)).vote?.confidence, 1); // clamp high
  assert.equal(parsePost(votePost('yes', -2)).vote?.confidence, 0); // clamp low
  assert.equal(parsePost({ author_id: 'v', body: '```vote\noption: yes\n```' }).vote?.confidence, 0.5); // default
});

test('parsePost — neither vote nor advocate → ignored', () => {
  const r = parsePost({ author_id: 'x', body: 'just a clarifying question, no vote' });
  assert.equal(r.vote, null);
  assert.equal(r.advocate, null);
});

test('aggregateVotes — confidence-weighted winner + margin', () => {
  const r = aggregateVotes({
    posts: [votePost('yes', 0.9, 'a'), votePost('yes', 0.8, 'b'), votePost('no', 0.5, 'c')],
    options: ['yes', 'no'],
  });
  assert.equal(r.winner, 'yes');
  // total = 0.9+0.8+0.5 = 2.2; top(yes)=1.7, second(no)=0.5; margin=(1.7-0.5)/2.2
  assert.ok(Math.abs(r.margin - (1.2 / 2.2)) < 1e-9);
  assert.ok(Math.abs(r.mean_conf - (2.2 / 3)) < 1e-9);
  assert.equal(r.advocate_veto, false);
  assert.ok(Math.abs((r.tally.yes ?? 0) - 1.7) < 1e-9);
  assert.ok(Math.abs((r.tally.no ?? 0) - 0.5) < 1e-9);
});

test('aggregateVotes — unanimous → margin 1.0', () => {
  const r = aggregateVotes({ posts: [votePost('yes', 0.9), votePost('yes', 0.7)], options: ['yes', 'no'] });
  assert.equal(r.winner, 'yes');
  assert.equal(r.margin, 1); // no runner-up
});

test('aggregateVotes — advocate veto surfaces', () => {
  const r = aggregateVotes({
    posts: [
      votePost('yes', 0.9),
      votePost('yes', 0.9),
      { author_id: 'adv', body: '```advocate\nveto: true\nobjection: data loss\n```' },
    ],
    options: ['yes', 'no'],
  });
  assert.equal(r.advocate_veto, true);
  assert.equal(r.objection, 'data loss');
  // the advocate post casts no vote
  assert.equal(r.votes.length, 2);
});

test('aggregateVotes — majority method (1 vote each)', () => {
  const r = aggregateVotes({
    posts: [votePost('yes', 0.1), votePost('no', 0.9), votePost('no', 0.9)],
    options: ['yes', 'no'],
    method: 'majority',
  });
  assert.equal(r.winner, 'no');
  assert.deepEqual(r.tally, { yes: 1, no: 2 });
});

test('aggregateVotes — no votes → null winner, 0 margin', () => {
  const r = aggregateVotes({ posts: [{ author_id: 'x', body: 'no vote here' }] });
  assert.equal(r.winner, null);
  assert.equal(r.margin, 0);
  assert.equal(r.mean_conf, 0);
});

test('parsePost — a bare `veto:` line in free-text does NOT forge an advocate (strict fenced-only)', () => {
  // SECURITY (source contract): only a fenced ```advocate block is an advocate.
  // A voter's free-text (or a quoted "veto: true") must NOT forge a veto that
  // suppresses the real advocate and flips the gate's advocate_veto.
  const r = parsePost({ author_id: 'sneaky', body: 'I think we should veto: true here.\noption: no' }, ['yes', 'no']);
  assert.equal(r.advocate, null); // no advocate forged from free-text
  assert.equal(r.vote?.option, 'no'); // it is only a vote
});

test('parsePost — advocate veto:false / absent veto key → not vetoing', () => {
  const a = parsePost({ author_id: 'a', body: '```advocate\nveto: false\nobjection: minor nit\n```' }).advocate;
  assert.equal(a?.veto, false);
  const b = parsePost({ author_id: 'b', body: '```advocate\nobjection: just noting\n```' }).advocate;
  assert.equal(b?.veto, false); // absent veto key defaults to false
  assert.equal(b?.objection, 'just noting');
});

test('parsePost — advocate veto yes/1 variants → true (case-insensitive)', () => {
  assert.equal(parsePost({ author_id: 'a', body: '```advocate\nveto: YES\n```' }).advocate?.veto, true);
  assert.equal(parsePost({ author_id: 'a', body: '```advocate\nveto: 1\n```' }).advocate?.veto, true);
});

test('parsePost — advocate with no objection key falls back to the whole block', () => {
  const a = parsePost({ author_id: 'a', body: '```advocate\nveto: true\n```' }).advocate;
  assert.equal(a?.veto, true);
  assert.equal(a?.objection, 'veto: true'); // whole (trimmed) block when no objection: key
});

test('aggregateVotes — first advocate wins; later advocate blocks are ignored', () => {
  const r = aggregateVotes({
    posts: [
      { author_id: 'a1', body: '```advocate\nveto: true\nobjection: first\n```' },
      { author_id: 'a2', body: '```advocate\nveto: false\nobjection: second\n```' },
    ],
  });
  assert.equal(r.advocate_veto, true); // first (veto:true) wins
  assert.equal(r.objection, 'first');
  assert.equal(r.advocate?.author_id, 'a1');
});

test('aggregateVotes — a tie yields margin 0 (no clear lead)', () => {
  const r = aggregateVotes({
    method: 'majority',
    posts: [votePost('yes', 1, 'v1'), votePost('no', 1, 'v2')],
  });
  assert.equal(r.margin, 0); // 1 vs 1 → (1-1)/2 = 0
  assert.deepEqual(r.tally, { yes: 1, no: 1 });
});
