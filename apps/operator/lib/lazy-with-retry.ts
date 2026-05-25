import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Turbopack/webpack dev rebuilds invalidate chunk hashes; a `lazy(...)` that
// resolved to chunk-A on first render can fail on the next mount because the
// hash is now chunk-B. The standard React.lazy doesn't retry. This wrapper
// retries the import a few times with backoff and, as a final fallback in
// dev, forces a full reload so the new chunk graph is fetched. The promise
// surface to React is unchanged.
export function shouldAutoReloadChunkFailure(
  reloadOnFail: boolean,
  inTauriDesktop: boolean,
  origin?: string,
): boolean {
  if (!reloadOnFail) return false;
  if (inTauriDesktop) return false;
  if (origin === 'http://localhost:3070' || origin === 'http://127.0.0.1:3070') return false;
  if (origin === 'http://localhost:4173' || origin === 'http://127.0.0.1:4173') return false;
  return true;
}

export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  opts: { retries?: number; intervalMs?: number; reloadOnFail?: boolean } = {},
): LazyExoticComponent<T> {
  const retries = opts.retries ?? 3;
  const intervalMs = opts.intervalMs ?? 400;
  const reloadOnFail = opts.reloadOnFail ?? process.env.NODE_ENV !== 'production';
  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const inTauriDesktop = typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  return lazy(() =>
    new Promise<{ default: T }>((resolve, reject) => {
      const attempt = (n: number) => {
        loader().then(resolve).catch((err: unknown) => {
          const msg = (err as { message?: string } | null)?.message ?? '';
          const isChunkErr =
            (err as { name?: string } | null)?.name === 'ChunkLoadError' ||
            /Failed to (load|fetch) chunk|Loading chunk \d+ failed/i.test(msg);
          if (!isChunkErr || n <= 0) {
            if (isChunkErr && shouldAutoReloadChunkFailure(reloadOnFail, inTauriDesktop, origin) && typeof window !== 'undefined') {
              const k = '__chunkReloadOnce__';
              if (!sessionStorage.getItem(k)) {
                sessionStorage.setItem(k, '1');
                window.location.reload();
                return;
              }
            }
            reject(err);
            return;
          }
          setTimeout(() => attempt(n - 1), intervalMs);
        });
      };
      attempt(retries);
    }),
  );
}
