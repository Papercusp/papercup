import { describe, it, expect } from 'vitest';
import { classifyUtteranceMode } from './classify-utterance-mode';

describe('classifyUtteranceMode', () => {
  it.each([
    ['I was wrong — the test passed.', 'apologetic'],
    ['My mistake. Pulling the right one now.', 'apologetic'],
    ['Sorry, I confused the slugs.', 'apologetic'],
    ['That was on me — I read the wrong line.', 'apologetic'],
  ])('apologetic: %s', (text, mode) => {
    expect(classifyUtteranceMode(text)).toBe(mode);
  });

  it.each([
    ['Smoke test failed. The orchestrator can\'t reach the harness.', 'sober'],
    ['Provisioning failed: DNS timeout.', 'sober'],
    ['Validator caught a schema drift.', 'default'], // no sober keyword
    ['The build crashed at step 12.', 'sober'],
    ['Endpoint unreachable.', 'sober'],
    ['Timed out polling.', 'sober'],
  ])('sober: %s → %s', (text, mode) => {
    expect(classifyUtteranceMode(text)).toBe(mode);
  });

  it.each([
    ['Done. Six minutes. A new record I\'m not proud of.', 'wry'],
    ['First time anything finished on the first try.', 'wry'],
    ['Got it. Don\'t get used to it.', 'wry'],
  ])('wry: %s', (text, mode) => {
    expect(classifyUtteranceMode(text)).toBe(mode);
  });

  it.each([
    ['Heads up — that replan will overwrite the last hour of changes.', 'assertive'],
    ['You should know the validator is off.', 'assertive'],
    ['Fair warning: this is going to cost you ten minutes.', 'assertive'],
    ['That command will lose uncommitted work.', 'assertive'],
  ])('assertive: %s', (text, mode) => {
    expect(classifyUtteranceMode(text)).toBe(mode);
  });

  it.each([
    ['On it.', 'default'],
    ['3 features in progress.', 'default'],
    ['Sheets is at 28 of 88.', 'default'],
    ['', 'default'],
    ['   ', 'default'],
  ])('default: %s → %s', (text, mode) => {
    expect(classifyUtteranceMode(text)).toBe(mode);
  });

  it('apologetic wins over sober when both appear', () => {
    expect(classifyUtteranceMode('My mistake — the build failed.')).toBe('apologetic');
  });

  it('sober wins over assertive when both appear', () => {
    expect(classifyUtteranceMode('Heads up: smoke test failed.')).toBe('sober');
  });
});
