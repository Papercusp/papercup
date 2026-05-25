export function isStaticDesktopHost(origin: string): boolean {
  const normalized = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return normalized === 'http://localhost:3070'
    || normalized === 'http://127.0.0.1:3070'
    || normalized === 'http://localhost:4173'
    || normalized === 'http://127.0.0.1:4173';
}

export function shouldEnableSupportWidget(pathname: string, origin: string): boolean {
  return pathname.startsWith('/support') && !isStaticDesktopHost(origin);
}

export function shouldSuppressStaticDesktopReload(origin: string): boolean {
  return isStaticDesktopHost(origin);
}

export function shouldFallbackToSupportRoute(hasOracleDock: boolean): boolean {
  return !hasOracleDock;
}
