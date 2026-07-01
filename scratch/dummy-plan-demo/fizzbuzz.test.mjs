import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fizzbuzz } from './fizzbuzz.mjs';

// dummy-demo-plan-2026-06-29 P-002 — node:test + node:assert coverage of the
// four fizzbuzz cases: Fizz (÷3), Buzz (÷5), FizzBuzz (÷15), and plain numbers.

test('Fizz — multiples of 3 (not 5)', () => {
  assert.equal(fizzbuzz(3), 'Fizz');
  assert.equal(fizzbuzz(6), 'Fizz');
  assert.equal(fizzbuzz(9), 'Fizz');
});

test('Buzz — multiples of 5 (not 3)', () => {
  assert.equal(fizzbuzz(5), 'Buzz');
  assert.equal(fizzbuzz(10), 'Buzz');
  assert.equal(fizzbuzz(20), 'Buzz');
});

test('FizzBuzz — multiples of 15', () => {
  assert.equal(fizzbuzz(15), 'FizzBuzz');
  assert.equal(fizzbuzz(30), 'FizzBuzz');
  assert.equal(fizzbuzz(45), 'FizzBuzz');
});

test('plain number — otherwise the number as a string', () => {
  assert.equal(fizzbuzz(1), '1');
  assert.equal(fizzbuzz(2), '2');
  assert.equal(fizzbuzz(7), '7');
  assert.equal(fizzbuzz(0), 'FizzBuzz'); // 0 is divisible by 15
});
