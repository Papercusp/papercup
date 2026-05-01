// Browser-side wrappers for the desktop app's version + auto-update
// commands. Web mode (papercuspai.com) returns nulls / no-ops so the
// caller can render conditionally without an @tauri-apps/api dep.

export interface UpdateInfo {
  available: boolean;
  current_version: string;
  new_version: string | null;
  notes: string | null;
}

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function tauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export function isDesktop(): boolean {
  return tauri() !== null;
}

export async function appVersion(): Promise<string | null> {
  const t = tauri();
  if (!t) return null;
  return t.invoke<string>('app_version');
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const t = tauri();
  if (!t) return null;
  return t.invoke<UpdateInfo>('check_for_update');
}

export async function installUpdate(): Promise<void> {
  const t = tauri();
  if (!t) throw new Error('not in desktop mode');
  return t.invoke<void>('install_update');
}
