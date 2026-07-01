import { describe, expect, it, vi } from 'vitest';
import {
  composeDeepAnswerLine,
  injectDeepAnswerIfTracked,
  DEEP_ANSWER_PREFIX,
} from './sentinel-deep-watch';

describe('composeDeepAnswerLine', () => {
  it('formats the deep answer with the work item id prefix', () => {
    expect(
      composeDeepAnswerLine({
        id: 'WI-301',
        title: 'Deep dive: safer migration path',
        state: 'passed',
        terminalCompletionRef: 'Pick the online path; rollback is cleaner.',
      }),
    ).toBe('[deep-answer WI-301] Pick the online path; rollback is cleaner.');
  });

  it('falls back when the item settled without a completion summary', () => {
    expect(
      composeDeepAnswerLine({
        id: 'WI-302',
        title: 'Deep dive: missing summary',
        state: 'passed',
        terminalCompletionRef: null,
      }),
    ).toContain('settled (passed) without a recorded answer summary');
  });
});

describe('injectDeepAnswerIfTracked', () => {
  it('injects only tracked deep-delegation items', async () => {
    const inject = vi.fn(async () => ({ ok: true }));
    await injectDeepAnswerIfTracked(
      {
        id: 'WI-301',
        title: 'Deep dive',
        state: 'passed',
        terminalCompletionRef: 'Answer goes here.',
        topics: ['deep-delegation'],
      },
      undefined,
      inject,
    );

    expect(inject).toHaveBeenCalledWith(`${DEEP_ANSWER_PREFIX} WI-301] Answer goes here.`);
  });

  it('skips non-deep items', async () => {
    const inject = vi.fn(async () => ({ ok: true }));
    await injectDeepAnswerIfTracked(
      {
        id: 'WI-301',
        title: 'Other item',
        state: 'passed',
        terminalCompletionRef: 'Answer goes here.',
        topics: ['user-requested'],
      },
      undefined,
      inject,
    );
    expect(inject).not.toHaveBeenCalled();
  });

  it('loads topics lazily when the caller did not pass them', async () => {
    const inject = vi.fn(async () => ({ ok: true }));
    const getTopics = vi.fn(async () => ['deep-delegation']);
    await injectDeepAnswerIfTracked(
      {
        id: 'WI-301',
        title: 'Deep dive',
        state: 'passed',
        terminalCompletionRef: 'Answer goes here.',
      },
      getTopics,
      inject,
    );

    expect(getTopics).toHaveBeenCalledWith('WI-301', null);
    expect(inject).toHaveBeenCalledTimes(1);
  });
});
