import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetChatActionsForTests,
  getChatAction,
  listAllChatActionIds,
  listChatActions,
  registerChatAction,
} from './registry';
import type { ChatAction, ChatActionContext } from './types';

const ctx: ChatActionContext = { sessionOwnerId: 'su-1' };

function stub(overrides: Partial<ChatAction> = {}): ChatAction {
  return {
    id: 'stub',
    label: 'Stub',
    available: () => true,
    run: vi.fn(),
    ...overrides,
  };
}

beforeAll(() => {
  // Reproduce the affected-lane shape: a concrete action module can populate
  // this module-global registry before this file's first spec runs.
  registerChatAction(stub({ id: 'preloaded' }));
});

beforeEach(() => {
  // The full affected-test lane can load the concrete action modules before
  // this file's first spec. Reset up front so the first assertion is just as
  // hermetic as every later assertion, not only focused-run hermetic.
  _resetChatActionsForTests();
});

afterEach(() => {
  _resetChatActionsForTests();
});

describe('chat-actions registry', () => {
  it('registers and looks up by id', () => {
    const action = stub();
    registerChatAction(action);
    expect(getChatAction('stub')).toBe(action);
    expect(listAllChatActionIds()).toEqual(['stub']);
  });

  it('re-registering the same id replaces the descriptor', () => {
    registerChatAction(stub({ label: 'First' }));
    registerChatAction(stub({ label: 'Second' }));
    expect(listAllChatActionIds()).toEqual(['stub']);
    expect(getChatAction('stub')?.label).toBe('Second');
  });

  it('listChatActions filters by available(ctx)', () => {
    registerChatAction(stub({ id: 'yes', available: () => true }));
    registerChatAction(stub({ id: 'no', available: () => false }));
    expect(listChatActions(ctx).map((a) => a.id)).toEqual(['yes']);
  });

  it('a throwing available() is excluded, not fatal to the whole list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerChatAction(
      stub({
        id: 'broken',
        available: () => {
          throw new Error('boom');
        },
      }),
    );
    registerChatAction(stub({ id: 'fine', available: () => true }));
    expect(listChatActions(ctx).map((a) => a.id)).toEqual(['fine']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('_resetChatActionsForTests clears the registry', () => {
    registerChatAction(stub());
    _resetChatActionsForTests();
    expect(listAllChatActionIds()).toEqual([]);
  });
});
