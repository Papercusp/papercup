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
  isActiveLocalCardHost,
  registerLocalCardHost,
  subscribeAskUserLocal,
  type OpenLocalCard,
} from './ask-user-local';

const choiceSchema = z.object({ choice: z.enum(['yes', 'no']) });

/** Helper: subscribe and resolve to the FIRST card the queue ever gains. */
function captureFirstCard(): { get: () => OpenLocalCard | null } {
  let captured: OpenLocalCard | null = null;
  subscribeAskUserLocal((queue) => {
    if (!captured && queue.length > 0) captured = queue[0];
  });
  return { get: () => captured };
}

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
    const captured = captureFirstCard();
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    // Microtask for the subscriber fan-out.
    await new Promise((r) => setTimeout(r, 1));
    expect(captured.get()).not.toBeNull();
    captured.get()!.resolve({ action: 'submit', payload: { choice: 'yes' } });
    const r = await promise;
    expect(r).toEqual({ action: 'submit', payload: { choice: 'yes' } });
  });

  it('decline path resolves with the decline action', async () => {
    const captured = captureFirstCard();
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    captured.get()!.resolve({ action: 'decline', reason: 'no thanks' });
    expect(await promise).toEqual({ action: 'decline', reason: 'no thanks' });
  });

  it('multiple resolve calls: first wins (idempotent resolve)', async () => {
    const captured = captureFirstCard();
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    captured.get()!.resolve({ action: 'submit', payload: { choice: 'yes' } });
    captured.get()!.resolve({ action: 'cancel' });
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
    const captured = captureFirstCard();
    const promise = askUserLocal({
      prompt: 'Switch?',
      dataSchema: choiceSchema,
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(captured.get()).not.toBeNull();
    captured.get()!.resolve({ action: 'cancel' });
    await promise;
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('each call gets a unique id (UUID)', async () => {
    const ids: string[] = [];
    subscribeAskUserLocal((queue) => {
      for (const card of queue) {
        if (ids.includes(card.id)) continue;
        ids.push(card.id);
        card.resolve({ action: 'cancel' });
      }
    });
    await askUserLocal({ prompt: 'a', dataSchema: choiceSchema });
    await askUserLocal({ prompt: 'b', dataSchema: choiceSchema });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  // EI-19952165837170400: a single askUserLocal call must resolve to exactly
  // ONE queue entry no matter how many hosts are subscribed — the shared
  // queue is the fix for the duplicate-card/orphaned-copy bug.
  it('multiple subscribers all see the SAME shared queue (single card, not per-host copies)', async () => {
    const seenA: readonly OpenLocalCard[][] = [];
    const seenB: readonly OpenLocalCard[][] = [];
    subscribeAskUserLocal((q) => (seenA as OpenLocalCard[][]).push(q as OpenLocalCard[]));
    subscribeAskUserLocal((q) => (seenB as OpenLocalCard[][]).push(q as OpenLocalCard[]));
    const promise = askUserLocal({ prompt: 'Switch?', dataSchema: choiceSchema });
    await new Promise((r) => setTimeout(r, 1));
    const lastA = seenA[seenA.length - 1];
    const lastB = seenB[seenB.length - 1];
    expect(lastA).toHaveLength(1);
    expect(lastB).toHaveLength(1);
    expect(lastA[0].id).toBe(lastB[0].id);

    // Resolving via the card either subscriber saw clears it for BOTH.
    lastA[0].resolve({ action: 'cancel' });
    await promise;
    const finalA = seenA[seenA.length - 1];
    const finalB = seenB[seenB.length - 1];
    expect(finalA).toHaveLength(0);
    expect(finalB).toHaveLength(0);
  });

  it('host election: most-recently-registered host is active; unregistering promotes the prior one', () => {
    const unregisterA = registerLocalCardHost('host-a');
    expect(isActiveLocalCardHost('host-a')).toBe(true);

    const unregisterB = registerLocalCardHost('host-b');
    expect(isActiveLocalCardHost('host-a')).toBe(false);
    expect(isActiveLocalCardHost('host-b')).toBe(true);

    unregisterB();
    expect(isActiveLocalCardHost('host-a')).toBe(true);
    expect(isActiveLocalCardHost('host-b')).toBe(false);

    unregisterA();
    expect(isActiveLocalCardHost('host-a')).toBe(false);
  });
});
