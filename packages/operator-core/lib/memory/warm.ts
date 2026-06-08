/**
 * Best-effort embedder warm-up (memory-backend-improve-and-hybrid P-004a).
 *
 * The first memory search after boot pays the embedder's cold-start — a TLS
 * handshake for the OpenAI embedder (~60ms; undici keepalive then reuses the
 * connection, so subsequent calls are warm) or, when the local BGE-ONNX embedder
 * is active, the one-time ONNX model load (~1s, which `injection.ts` otherwise
 * absorbs behind a 5s timeout → degraded mode). Firing one throwaway search at
 * boot moves that cost off the user's first turn.
 *
 * Fully defensive + bounded: it never throws and never blocks the caller — a
 * cold or misconfigured embedder must not affect operator boot. Fire-and-forget.
 */
import { getMemoryBackend, type MemoryBackend } from '@papercusp/memory';

const WARM_TIMEOUT_MS = 8_000;

function deadline<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), WARM_TIMEOUT_MS))]);
}

/** Pre-warm the embedder/connection with one throwaway read. `backend` is
 *  injectable for tests; defaults to the configured backend. */
export async function warmMemoryEmbedder(backend: MemoryBackend = getMemoryBackend()): Promise<void> {
  try {
    const avail = await deadline(backend.available(), { ok: false as const, reason: 'warm_timeout' });
    if (!avail.ok) return;
    await deadline(
      backend.search('warmup', { scope: '__warmup__', limit: 1 }).then(() => undefined),
      undefined,
    );
  } catch {
    /* best-effort — a cold/misconfigured embedder must never affect boot */
  }
}
