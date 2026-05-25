export function isStaticDesktopHost(origin: string): boolean {
  return origin === 'http://localhost:3070'
    || origin === 'http://127.0.0.1:3070'
    || origin === 'http://localhost:4173'
    || origin === 'http://127.0.0.1:4173';
}

export function shouldEnableSupportWidget(pathname: string, origin: string): boolean {
  return pathname.startsWith('/support') && !isStaticDesktopHost(origin);
}
