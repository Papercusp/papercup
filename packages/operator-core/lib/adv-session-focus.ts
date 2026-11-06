/**
 * Shared focus service for tracked advanced sessions.
 *
 * Both the operator GUI endpoint and the agent-facing coordination tool use
 * this module. Keeping resolution and activation here prevents the two entry
 * points from drifting into subtly different definitions of “focused”.
 */
import type { AdvSessionRow } from './adv-sessions';
import { setAdvSessionWindowId } from './adv-sessions';
import { readFile } from 'node:fs/promises';
import { findLiveHostAsync, type PsuPtyHost } from './events/await/psu-pty-discovery';
import { readProcessIdentity } from './process-identity';
import {
  focusWindowId,
  resolveWindowIdForPid,
  resolveWindowIdForGnomeTerminalService,
  resolveWindowIdForTitleFragment,
  type FocusWindowOptions,
} from './adv-session-windows';

export interface SessionWindowControlInput extends FocusWindowOptions {
  id?: number;
  pid?: number;
  windowId?: string | null;
}

export interface SessionFocusDeps {
  resolveByPid?: typeof resolveWindowIdForPid;
  resolveByTitle?: typeof resolveWindowIdForTitleFragment;
  rememberWindowId?: typeof setAdvSessionWindowId;
  focus?: typeof focusWindowId;
  findLiveHost?: typeof findLiveHostAsync;
  readTerminalEnviron?: (pid: number) => Promise<string | null>;
  readTerminalProcessIdentity?: (pid: number) => string | null;
  resolveByGnomeTerminalService?: (serviceName: string) => Promise<string | null>;
}

export type SessionFocusResult =
  | { focused: true; windowId: string }
  | {
      focused: false;
      windowId: string | null;
      code: 'no_window' | 'focus_failed';
      reason: string;
    };

function nulEnvironmentValue(raw: string, key: string): string | null {
  const prefix = `${key}=`;
  for (const entry of raw.split('\0')) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

function validGnomeTerminalService(value: string | null): value is string {
  return value !== null && /^:[0-9]+\.[0-9]+$/.test(value);
}

async function readVerifiedGnomeTerminalAttachment(
  host: PsuPtyHost,
  deps: SessionFocusDeps,
): Promise<{ terminalPid: number; identity: string; serviceName: string } | null> {
  const terminalPid = host.terminalPid;
  if (host.bridgeTty === false || !Number.isSafeInteger(terminalPid) || (terminalPid ?? 0) <= 1) return null;

  const readIdentity = deps.readTerminalProcessIdentity ?? readProcessIdentity;
  const before = readIdentity(terminalPid!);
  if (!before) return null;
  const readEnviron = deps.readTerminalEnviron ?? (pid => readFile(`/proc/${pid}/environ`, 'utf8'));
  const raw = await readEnviron(terminalPid!).catch(() => null);
  if (raw === null || readIdentity(terminalPid!) !== before) return null;

  const harness = nulEnvironmentValue(raw, 'PAPERCUSP_HARNESS_SLUG');
  const consoleIdentity = nulEnvironmentValue(raw, 'PAPERCUSP_CONSOLE_IDENTITY');
  const serviceName = nulEnvironmentValue(raw, 'GNOME_TERMINAL_SERVICE');
  if (!harness?.trim() || consoleIdentity !== before || !validGnomeTerminalService(serviceName)) return null;
  return { terminalPid: terminalPid!, identity: before, serviceName };
}

async function resolveCurrentManagedHostWindow(
  row: AdvSessionRow,
  deps: SessionFocusDeps,
): Promise<string | null> {
  if (process.platform !== 'linux' || !row.coordOwnerId || !Number.isSafeInteger(row.id) || row.id <= 0) return null;
  try {
    const host = await (deps.findLiveHost ?? findLiveHostAsync)(row.coordOwnerId);
    if (!host || host.ownerId !== row.coordOwnerId || host.advSessionId !== String(row.id)) return null;
    const attachment = await readVerifiedGnomeTerminalAttachment(host, deps);
    if (!attachment) return null;
    const windowId = await (deps.resolveByGnomeTerminalService ?? resolveWindowIdForGnomeTerminalService)(
      attachment.serviceName,
    );
    if (!windowId) return null;
    return (deps.readTerminalProcessIdentity ?? readProcessIdentity)(attachment.terminalPid) === attachment.identity
      ? windowId
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the window for a session-control action, cheapest source first.
 *
 * The title fallbacks make psu/fleet sessions focusable: those terminals have
 * no per-window pid (gnome-terminal shares one server) and may have no recorded
 * window id. A restored terminal can use the native session UUID in its title,
 * while older titles may contain only the short coordination owner id. Resolved
 * ids are cached on the adv row for the next click/call.
 */
export async function resolveSessionWindowId(
  body: SessionWindowControlInput,
  latestRow: AdvSessionRow | null,
  deps: SessionFocusDeps = {},
): Promise<string | null> {
  const resolveByPid = deps.resolveByPid ?? resolveWindowIdForPid;
  const resolveByTitle = deps.resolveByTitle ?? resolveWindowIdForTitleFragment;
  const rememberWindowId = deps.rememberWindowId ?? setAdvSessionWindowId;

  let windowId = body.windowId ?? null;
  if (!windowId && latestRow?.windowId) windowId = latestRow.windowId;
  if (!windowId && typeof body.pid === 'number') windowId = await resolveByPid(body.pid);
  if (!windowId && latestRow?.id) {
    windowId = await resolveByTitle(`[adv:${latestRow.id}]`);
    if (windowId) await rememberWindowId(latestRow.id, windowId);
  }
  if (!windowId && latestRow?.sessionId) {
    windowId = await resolveByTitle(latestRow.sessionId);
    if (windowId && latestRow.id) await rememberWindowId(latestRow.id, windowId);
  }
  if (!windowId && latestRow?.coordOwnerId) {
    const shortId = latestRow.coordOwnerId.slice(0, 8);
    if (shortId.length >= 6) {
      windowId = await resolveByTitle(shortId);
      if (windowId && latestRow.id) await rememberWindowId(latestRow.id, windowId);
    }
  }
  if (!windowId && latestRow) {
    windowId = await resolveCurrentManagedHostWindow(latestRow, deps);
    if (windowId && latestRow.id) await rememberWindowId(latestRow.id, windowId);
  }
  return windowId;
}

/** Resolve and observably activate one tracked session window. */
export async function focusSessionWindow(
  body: SessionWindowControlInput,
  latestRow: AdvSessionRow | null,
  deps: SessionFocusDeps = {},
): Promise<SessionFocusResult> {
  const windowId = await resolveSessionWindowId(body, latestRow, deps);
  if (!windowId) {
    return {
      focused: false,
      windowId: null,
      code: 'no_window',
      reason: 'could not resolve a window id (headless session, missing desktop metadata, or no matching window)',
    };
  }

  try {
    if (body.workspace !== undefined && body.workspace !== 'current' && body.workspace !== 'window') {
      return { focused: false, windowId, code: 'focus_failed', reason: 'workspace must be current or window' };
    }
    const focused = await (deps.focus ?? focusWindowId)(windowId, { workspace: body.workspace });
    return focused
      ? { focused: true, windowId }
      : {
          focused: false,
          windowId,
          code: 'focus_failed',
          reason: 'could not verify the target as active and visible on the requested workspace; check desktop permissions and platform support (Linux: current/window, Windows: window by default and current when the OS permits the move, macOS: window)',
        };
  } catch (error) {
    return {
      focused: false,
      windowId,
      code: 'focus_failed',
      reason: `focus failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
