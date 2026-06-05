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
