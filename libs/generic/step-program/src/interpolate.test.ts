/**
 * `{{ path }}` arg interpolation. Pins type-preservation for a whole-string
 * placeholder, mixed-string substitution, and recursion.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { interpolate, interpolateArgs } from './interpolate.js';

const scope = {
  payload: { question: 'Ship it?', quorum: 3, options: ['yes', 'no'], lenses: ['risk', 'cost'] },
  thread: { conversation_id: 'conv-1', thread_id: 'thr-1' },
  tally: { winner: 'yes', margin: 0.8 },
};

test('whole-string placeholder preserves type', () => {
  assert.equal(interpolate('{{ payload.quorum }}', scope), 3); // number, not "3"
  assert.deepEqual(interpolate('{{ payload.options }}', scope), ['yes', 'no']); // array
  assert.equal(interpolate('{{ thread.conversation_id }}', scope), 'conv-1');
  assert.equal(interpolate('{{ tally.winner }}', scope), 'yes');
});

test('mixed string substitutes inline (stringified)', () => {
  assert.equal(interpolate('Vote split on: {{ payload.question }}', scope), 'Vote split on: Ship it?');
  assert.equal(interpolate('quorum={{ payload.quorum }} winner={{ tally.winner }}', scope), 'quorum=3 winner=yes');
  // object placeholder inline → JSON
  assert.equal(interpolate('opts={{ payload.options }}', scope), 'opts=["yes","no"]');
});

test('missing path: whole → undefined, mixed → empty string', () => {
  assert.equal(interpolate('{{ nope.gone }}', scope), undefined);
  assert.equal(interpolate('x={{ nope.gone }}', scope), 'x=');
});

test('recurses through arrays and objects', () => {
  const args = {
    title: '{{ payload.question }}',
    quorum: '{{ payload.quorum }}',
    nested: { id: '{{ thread.conversation_id }}', list: ['{{ tally.winner }}', 'literal'] },
  };
  assert.deepEqual(interpolateArgs(args, scope), {
    title: 'Ship it?',
    quorum: 3,
    nested: { id: 'conv-1', list: ['yes', 'literal'] },
  });
});

test('non-template values pass through unchanged', () => {
  assert.equal(interpolate(42, scope), 42);
  assert.equal(interpolate(true, scope), true);
  assert.equal(interpolate('plain text', scope), 'plain text');
  assert.equal(interpolate(null, scope), null);
});

test('does not mutate the input', () => {
  const args = { a: '{{ tally.winner }}' };
  const out = interpolateArgs(args, scope);
  assert.equal(args.a, '{{ tally.winner }}');
  assert.equal(out.a, 'yes');
});

test('whole-string placeholder preserves FALSY values (0, false, empty string)', () => {
  // A naive `value ?? ''` / falsy-check would corrupt these — pin that 0 stays 0.
  assert.equal(interpolate('{{ a }}', { a: 0 }), 0);
  assert.equal(interpolate('{{ a }}', { a: false }), false);
  assert.equal(interpolate('{{ a }}', { a: '' }), '');
});

test('bracket-index paths resolve in interpolation', () => {
  assert.equal(interpolate('{{ items[1] }}', { items: ['a', 'b', 'c'] }), 'b');
  assert.deepEqual(interpolate('{{ rows[0].cells }}', { rows: [{ cells: [1, 2] }] }), [1, 2]);
});

test('mixed string JSON-stringifies object/array placeholder values', () => {
  assert.equal(interpolate('opts: {{ o }}', { o: { a: 1 } }), 'opts: {"a":1}');
  assert.equal(interpolate('list: {{ xs }}', { xs: [1, 2] }), 'list: [1,2]');
});

test('mixed string substitutes MULTIPLE placeholders (missing → empty)', () => {
  assert.equal(interpolate('{{ a }} vs {{ b }}', { a: 'X', b: 'Y' }), 'X vs Y');
  assert.equal(interpolate('{{ a }}/{{ missing }}', { a: 'X' }), 'X/');
});
