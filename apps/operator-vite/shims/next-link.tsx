import type { ComponentProps, ReactNode } from 'react';
import { Link as TsrLink } from '@tanstack/react-router';

/**
 * `next/link` compatibility shim for the operator-vite migration.
 *
 * Wired via `resolve.alias` in `vite.config.ts`. The live Next operator
 * resolves `next/link` via `node_modules/next/` and is unaffected.
 *
 * Next's `<Link href="/foo">` becomes TSR's `<Link to="/foo">`. We
 * preserve the `href` prop name at the call sites by adapting here, so
 * shared components don't need to change their imports.
 *
 * Dropped props (Next-only, ignored under TSR):
 *   - `prefetch` — TSR has its own preloading model; this just keeps the
 *     prop type-compatible.
 *   - `legacyBehavior` — Next 12 compat flag, irrelevant under Vite.
 *   - `passHref` — same.
 *   - `as` — also Next 12.
 */
type NextLinkOnlyProps = {
  prefetch?: boolean;
  legacyBehavior?: boolean;
  passHref?: boolean;
  as?: string;
};

type NextLinkProps = NextLinkOnlyProps &
  Omit<ComponentProps<typeof TsrLink>, 'to'> & {
    href: string;
    children?: ReactNode;
  };

export default function Link({
  href,
  prefetch: _prefetch,
  legacyBehavior: _legacyBehavior,
  passHref: _passHref,
  as: _as,
  ...rest
}: NextLinkProps) {
  return <TsrLink to={href} {...rest} />;
}
