export const NO_VITE_CLIENT_BODY = '/* Papercusp desktop dev: Vite client disabled; refresh manually. */';

export function isDesktopHmrEnabled(env: Record<string, string | undefined>): boolean {
  return env.PAPERCUSP_ENABLE_HMR === '1' || env.NEXT_PUBLIC_ENABLE_HMR === '1';
}

export function shouldServeNoopViteClient(url: string | undefined, enableHmr: boolean): boolean {
  return !enableHmr && typeof url === 'string' && url.startsWith('/@vite/client');
}
