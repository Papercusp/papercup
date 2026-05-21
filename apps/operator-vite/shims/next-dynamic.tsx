import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';

/**
 * `next/dynamic` compatibility shim for the operator-vite migration.
 *
 * Wired via `resolve.alias` in `vite.config.ts`. The live Next operator
 * resolves `next/dynamic` via `node_modules/next/` and is unaffected.
 *
 * Maps Next's `dynamic(loader, { loading, ssr })` onto React's `lazy()`
 * plus a `Suspense` boundary. Key compatibility points:
 *
 *   - Next's `loading: () => <Spinner/>` becomes our `Suspense` fallback,
 *     so call sites that don't wrap their own `Suspense` still get the
 *     intended spinner. Without this, every `next/dynamic` use under the
 *     shim would need a Suspense wrapper added at every call site.
 *
 *   - `ssr: false` is a no-op under a Vite SPA (no SSR exists). The plan
 *     ([B3](#b3)) flags this as the one non-mechanical concern; we collapse
 *     it to a no-op because the operator's `ssr: false` uses are uniformly
 *     for client-only widgets that work fine under Vite's client render.
 *
 *   - Loader can return `ComponentType<P>` directly or `{ default }`.
 *     We normalize both shapes for `React.lazy`, matching Next's behavior.
 */

interface DynamicOptions {
  ssr?: boolean;
  loading?: () => ReactNode;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

export default function dynamic<P extends object>(
  loader: Loader<P>,
  options?: DynamicOptions,
): ComponentType<P> {
  const Lazy = lazy<ComponentType<P>>(async () => {
    const mod = await loader();
    return 'default' in mod ? mod : { default: mod };
  });

  const fallback: ReactNode = options?.loading ? options.loading() : null;

  const Wrapped: ComponentType<P> = (props) => (
    <Suspense fallback={fallback}>
      <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
    </Suspense>
  );
  return Wrapped;
}
