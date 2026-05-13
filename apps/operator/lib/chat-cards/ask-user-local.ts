/**
 * askUserLocal — client-side companion to server-side ctx.askUser.
 *
 * For render-time-only prompts (tab pickers, settings dialogs,
 * confirm-before-action). The card never crosses the wire; the
 * resolver runs in the same React tree as the renderer.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.4 (M6 boundary)
 *
 * Usage (inside a React component):
 *   const r = await askUserLocal({
 *     prompt: 'Switch to new chat?',
 *     dataSchema: z.object({ choice: z.enum(['yes', 'no']) }),
 *     presentation: { kind: 'radio', options: [{id:'yes',label:'Yes'},{id:'no',label:'No'}] },
 *   });
 *
 * Implementation: a global `Subject<OpenLocalCard>` that the host
 * component (OracleDock, ChatPane) subscribes to. The first subscribed
 * host renders the card and resolves the promise on user action.
 *
 * Falls back to {action:'cancel'} when no host is mounted.
 */

import type { CardResponse, CardSpec } from '@papercusp/agent-mcp';
import type { ZodTypeAny } from 'zod';

export interface OpenLocalCard<TSchema extends ZodTypeAny = ZodTypeAny> {
  id: string;
  spec: CardSpec<TSchema>;
  resolve: (response: CardResponse<TSchema>) => void;
}

type LocalCardListener = (card: OpenLocalCard) => void;

const __SYM = Symbol.for('papercusp.askUserLocalRegistry');
type Registry = {
  listeners: Set<LocalCardListener>;
};
type RegistryGlobals = typeof globalThis & { [__SYM]?: Registry };

function registry(): Registry {
  const g = globalThis as RegistryGlobals;
  if (!g[__SYM]) g[__SYM] = { listeners: new Set() };
  return g[__SYM]!;
}

/**
 * Subscribe a host renderer. Returns an unsubscribe function. The host
 * receives every askUserLocal call and is responsible for rendering
 * the card + calling resolve().
 */
export function subscribeAskUserLocal(cb: LocalCardListener): () => void {
  registry().listeners.add(cb);
  return () => {
    registry().listeners.delete(cb);
  };
}

/**
 * Request a local prompt. Returns a promise that resolves when any
 * host calls `resolve()`. If no host is subscribed, resolves
 * immediately with `{action:'cancel'}` (the caller decides how to
 * handle that).
 */
export function askUserLocal<TSchema extends ZodTypeAny>(
  spec: CardSpec<TSchema>,
): Promise<CardResponse<TSchema>> {
  const r = registry();
  if (r.listeners.size === 0) {
    return Promise.resolve({ action: 'cancel' } as CardResponse<TSchema>);
  }
  return new Promise<CardResponse<TSchema>>((resolve) => {
    const card: OpenLocalCard<TSchema> = {
      id: crypto.randomUUID(),
      spec,
      resolve,
    };
    // Fan out to every subscriber. First resolver wins.
    let resolved = false;
    const wrap = (response: CardResponse<TSchema>) => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    card.resolve = wrap;
    for (const l of r.listeners) {
      try {
        l(card as unknown as OpenLocalCard);
      } catch (e) {
        console.warn('[askUserLocal] listener threw', e);
      }
    }
  });
}

/** Test-only: clear all subscribers. */
export function _resetAskUserLocalForTests(): void {
  registry().listeners.clear();
}
