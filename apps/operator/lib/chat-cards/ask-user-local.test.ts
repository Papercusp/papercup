/**
 * askUserLocal tests — client-side companion API.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.4
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  _resetAskUserLocalForTests,
  askUserLocal,
  subscribeAskUserLocal,
  type OpenLocalCard,
} from './ask-user-local';

const choiceSchema = z.object({ choice: z.enum(['yes', 'no']) });

describe('askUserLocal', () => {
  beforeEach(() => _resetAskUserLocalForTests());
  afterEach(() => _resetAskUserLocalForTests());

  it('with no host subscribed: resolves immediately with cancel', async () => {
    const r = await askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    expect(r).toEqual({ action: 'cancel' });
  });

  it('host subscriber receives the card; resolve() unblocks the promise', async () => {
    let captured: OpenLocalCard | null = null;
    subscribeAskUserLocal((card) => {
      captured = card;
    });
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    // Microtask for the subscriber fan-out.
    await new Promise((r) => setTimeout(r, 1));
    expect(captured).not.toBeNull();
    captured!.resolve({ action: 'submit', payload: { choice: 'yes' } });
    const r = await promise;
    expect(r).toEqual({ action: 'submit', payload: { choice: 'yes' } });
  });

  it('decline path resolves with the decline action', async () => {
    let captured: OpenLocalCard | null = null;
    subscribeAskUserLocal((card) => {
      captured = card;
    });
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    captured!.resolve({ action: 'decline', reason: 'no thanks' });
    expect(await promise).toEqual({ action: 'decline', reason: 'no thanks' });
  });

  it('multiple resolve calls: first wins (idempotent resolve)', async () => {
    let captured: OpenLocalCard | null = null;
    subscribeAskUserLocal((card) => {
      captured = card;
    });
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    captured!.resolve({ action: 'submit', payload: { choice: 'yes' } });
    captured!.resolve({ action: 'cancel' });
    expect(await promise).toEqual({ action: 'submit', payload: { choice: 'yes' } });
  });

  it('unsubscribe removes the host; next askUserLocal cancels', async () => {
    const off = subscribeAskUserLocal(() => {});
    off();
    const r = await askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    expect(r).toEqual({ action: 'cancel' });
  });

  it('subscriber throw does not block fan-out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeAskUserLocal(() => {
      throw new Error('boom');
    });
    let captured: OpenLocalCard | null = null;
    subscribeAskUserLocal((card) => {
      captured = card;
    });
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(captured).not.toBeNull();
    captured!.resolve({ action: 'cancel' });
    await promise;
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('each call gets a unique id (UUID)', async () => {
    const ids: string[] = [];
    subscribeAskUserLocal((card) => {
      ids.push(card.id);
      card.resolve({ action: 'cancel' });
    });
    await askUserLocal({ prompt: 'a', dataSchema: choiceSchema });
    await askUserLocal({ prompt: 'b', dataSchema: choiceSchema });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
});
