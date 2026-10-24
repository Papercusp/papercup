import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coordEscalationToAttention, conversationToAttention } from '../../../packages/operator-core/lib/attention/adapters';
import { deriveAttentionRefs } from '../../../packages/operator-core/lib/sync-resolver/attention-counts';
import { ownerQuestionDelivery } from './owner-question-native-contract.mts';

const choice = coordEscalationToAttention({ msgId: 'choice-1', from: 'su-fixture', summary: 'Choose', severity: 'question' });
const linkedQuestion = coordEscalationToAttention({ msgId: 'ask-1', from: 'su-fixture', summary: 'Answer', severity: 'question', conversationId: 'conv-1' });
const groups = [{ items: [choice, linkedQuestion] }];

describe('native owner-question delivery feed contract', () => {
  it('collects the native spec through the real Playwright ESM loader', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const result = spawnSync(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test',
      '--config', 'apps/operator/playwright.config.mts', '--list',
      'owner-question-delivery.native.spec.mts',
    ], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Total: 1 test in 1 file');
  }, 35_000);

  it.each([groups, { groups }, { data: { groups } }])('matches the exact requests in a supported full feed envelope', (feed) => {
    expect(ownerQuestionDelivery(feed, 'choice-1', 'conv-1')).toEqual({ choice, question: linkedQuestion });
  });

  it('accepts the standalone conversation representation too', () => {
    const question = conversationToAttention({ conversationId: 'conv-1', title: 'Answer' });
    expect(ownerQuestionDelivery({ groups: [{ items: [choice, question] }] }, 'choice-1', 'conv-1').question).toEqual(question);
  });

  it('reports a missing request without substituting a neighbour', () => {
    expect(ownerQuestionDelivery({ groups }, 'missing-choice', 'missing-conversation')).toEqual({ choice: null, question: null });
  });

  it('rejects the real compact refs projection instead of asserting false non-delivery', () => {
    const refs = deriveAttentionRefs(groups);
    expect(refs.map((row) => row.id)).toContain(choice.id);
    expect(() => ownerQuestionDelivery({ refs }, 'choice-1', 'conv-1')).toThrow('full plans:attention feed');
    expect(() => ownerQuestionDelivery({ data: { refs } }, 'choice-1', 'conv-1')).toThrow('compact refs omit kind/ref');
  });

  it('distinguishes an empty full feed from a malformed response', () => {
    expect(ownerQuestionDelivery({ groups: [] }, 'choice-1', 'conv-1')).toEqual({ choice: null, question: null });
    expect(() => ownerQuestionDelivery({}, 'choice-1', 'conv-1')).toThrow('full plans:attention feed');
  });
});
