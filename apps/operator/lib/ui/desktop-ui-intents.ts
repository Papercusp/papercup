import { isStaticDesktopHost } from './desktop-static-host';

export function shouldEnableRemoteUiIntents(origin: string): boolean {
  return !isStaticDesktopHost(origin);
}

export function shouldMountRemoteUiControl(origin: string): boolean {
  return !isStaticDesktopHost(origin);
}
