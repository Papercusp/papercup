export const NO_VITE_CLIENT_BODY = '/* Papercusp desktop dev: Vite client disabled; refresh manually. */';
import { shouldSuppressStaticDesktopReload } from '../operator/lib/ui/desktop-static-host';

export function isDesktopHmrEnabled(env: Record<string, string | undefined>): boolean {
  return env.PAPERCUSP_ENABLE_HMR === '1' || env.NEXT_PUBLIC_ENABLE_HMR === '1';
}

export function shouldServeNoopViteClient(url: string | undefined, enableHmr: boolean): boolean {
  return !enableHmr && typeof url === 'string' && url.startsWith('/@vite/client');
}

export function shouldSuppressJsReload(origin: string): boolean {
  return shouldSuppressStaticDesktopReload(origin);
}

export function shouldInterceptStaticAnchor(targetHref: string, currentHref: string): boolean {
  if (!shouldSuppressJsReload(new URL(currentHref).origin)) return false;
  try {
    const current = new URL(currentHref);
    const next = new URL(targetHref, currentHref);
    if (!(next.protocol === 'http:' || next.protocol === 'https:')) return false;
    return next.origin === current.origin;
  } catch {
    return false;
  }
}
