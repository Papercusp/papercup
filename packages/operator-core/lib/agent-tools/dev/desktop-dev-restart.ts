/**
 * The guarded restart primitive for the desktop-owned dev operator (:3270).
 *
 * `dev:restart` normally delegates to systemd. The desktop dev operator is
 * different: `papercusp-desktop/bin/dev-operator-ifneeded.sh` supervises a
 * process tree started by Tauri, so there is no systemd unit to restart. The
 * safe operation is to kill only the verified `hono-host.ts` listener child;
 * the wrapper observes the non-zero exit and starts a fresh child.
 *
 * This module deliberately does not signal a process group or any ancestor.
 * Every identity check is repeated immediately before the signal to protect
 * against a listener exiting and its PID being recycled between the port
 * lookup and the kill.
 */

import { promises as fsp } from 'node:fs';
import {
  listListeningSockets,
  type ListeningSocket,
  type ListeningSocketsResult,
} from '../../listening-sockets';

export const DESKTOP_DEV_PORT = 3270;
export const DESKTOP_DEV_RESOURCE = 'desktop-dev-server';
export const DESKTOP_DEV_WRAPPER = 'dev-operator-ifneeded.sh';

const REQUIRED_ENV: Readonly<Record<string, string>> = {
  PAPERCUSP_HONO_PORT: String(DESKTOP_DEV_PORT),
  PAPERCUSP_DEV_API_TARGET: String(DESKTOP_DEV_PORT),
  PAPERCUSP_BACKGROUND_WORKERS: '0',
  PAPERCUSP_CLUSTER: '0',
  DBOS__VMID: `desktop-dev-${DESKTOP_DEV_PORT}`,
};

const MAX_PARENT_DEPTH = 24;

export interface DesktopDevProcessMeta {
  pid: number;
  ppid: number;
  processGroup: number;
  session: number;
  cmdline: string;
}

export interface DesktopDevListener {
  pid: number;
  cmdline: string;
  env: Readonly<Record<string, string>>;
  parentChain: readonly DesktopDevProcessMeta[];
}

export interface DesktopDevRestartDeps {
  listSockets?: (options: { port?: number; limit?: number }) => Promise<ListeningSocketsResult>;
  readCmdline?: (pid: number) => Promise<string>;
  readEnviron?: (pid: number) => Promise<string>;
  readStat?: (pid: number) => Promise<string>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface DesktopDevListenerResult {
  ok: boolean;
  pid?: number;
  listener?: DesktopDevListener;
  reason?:
    | 'desktop_dev_listener_not_found'
    | 'desktop_dev_listener_owner_hidden'
    | 'desktop_dev_listener_ambiguous'
    | 'desktop_dev_listener_unreadable'
    | 'desktop_dev_identity_mismatch'
    | 'desktop_dev_supervisor_missing'
    | 'desktop_dev_listener_changed';
  note: string;
}

export interface DesktopDevRestartResult {
  ok: boolean;
  pid?: number;
  reason?: DesktopDevListenerResult['reason'] | 'desktop_dev_signal_failed';
  note: string;
}

function defaultReadCmdline(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
}

function defaultReadEnviron(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/environ`, 'utf8');
}

function defaultReadStat(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/stat`, 'utf8');
}

/** Parse the state/PPID/PGRP/session fields from Linux `/proc/<pid>/stat`. */
export function parseProcStat(stat: string): Omit<DesktopDevProcessMeta, 'pid' | 'cmdline'> | null {
  // The comm field may contain ')', so use the final close paren rather than
  // splitting the whole line naively.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  const session = Number(fields[3]);
  if (![ppid, processGroup, session].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { ppid, processGroup, session };
}

function normalizeCmdline(raw: string): string {
  return raw.replaceAll('\0', ' ').trim();
}

export function parseProcessEnvironment(raw: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!(key in env)) env[key] = entry.slice(separator + 1);
  }
  return env;
}

function isHonoHostCommand(cmdline: string): boolean {
  return /(?:^|[\s/])hono-host\.ts(?:$|[\s])/.test(cmdline);
}

function hasDesktopDevEnvironment(env: Readonly<Record<string, string>>): boolean {
  return Object.entries(REQUIRED_ENV).every(([key, expected]) => env[key] === expected);
}

function isDesktopDevWrapperCommand(cmdline: string): boolean {
  return new RegExp(`(?:^|[\\s/])${DESKTOP_DEV_WRAPPER.replace('.', '\\.')}(?:$|[\\s])`).test(cmdline);
}

async function readMeta(
  pid: number,
  deps: Required<Pick<DesktopDevRestartDeps, 'readCmdline' | 'readStat'>>,
): Promise<DesktopDevProcessMeta | null> {
  try {
    const [rawCmdline, rawStat] = await Promise.all([deps.readCmdline(pid), deps.readStat(pid)]);
    const stat = parseProcStat(rawStat);
    if (!stat) return null;
    return { pid, cmdline: normalizeCmdline(rawCmdline), ...stat };
  } catch {
    return null;
  }
}

async function readParentChain(
  listener: DesktopDevProcessMeta,
  deps: Required<Pick<DesktopDevRestartDeps, 'readCmdline' | 'readStat'>>,
): Promise<DesktopDevProcessMeta[]> {
  const chain: DesktopDevProcessMeta[] = [listener];
  const seen = new Set([listener.pid]);
  let parentPid = listener.ppid;
  for (let depth = 1; depth < MAX_PARENT_DEPTH && parentPid > 1; depth += 1) {
    if (seen.has(parentPid)) break;
    seen.add(parentPid);
    const parent = await readMeta(parentPid, deps);
    if (!parent) break;
    chain.push(parent);
    parentPid = parent.ppid;
  }
  return chain;
}

function findVisiblePids(sockets: readonly ListeningSocket[]): number[] {
  return [...new Set(sockets.filter((socket) => socket.ownerVisible).flatMap((socket) => socket.pids))].filter(
    (pid) => Number.isInteger(pid) && pid > 1,
  );
}

function listenerFailure(
  reason: DesktopDevListenerResult['reason'],
  note: string,
  pid?: number,
): DesktopDevListenerResult {
  return { ok: false, reason, note, ...(pid === undefined ? {} : { pid }) };
}

/** Resolve the one owner-visible, wrapper-supervised desktop listener. */
export async function resolveDesktopDevListener(deps: DesktopDevRestartDeps = {}): Promise<DesktopDevListenerResult> {
  const listSockets = deps.listSockets ?? listListeningSockets;
  const readCmdline = deps.readCmdline ?? defaultReadCmdline;
  const readEnviron = deps.readEnviron ?? defaultReadEnviron;
  const readStat = deps.readStat ?? defaultReadStat;

  let sockets: ListeningSocket[];
  try {
    sockets = (await listSockets({ port: DESKTOP_DEV_PORT, limit: 32 })).sockets;
  } catch (error) {
    return listenerFailure(
      'desktop_dev_listener_unreadable',
      `Could not read the :${DESKTOP_DEV_PORT} listener table: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (sockets.length === 0) {
    return listenerFailure('desktop_dev_listener_not_found', `No TCP listener is present on :${DESKTOP_DEV_PORT}.`);
  }

  const visiblePids = findVisiblePids(sockets);
  if (visiblePids.length === 0) {
    return listenerFailure(
      'desktop_dev_listener_owner_hidden',
      `:${DESKTOP_DEV_PORT} is bound, but its owner is not visible to this user; refusing to signal an unidentified process.`,
    );
  }
  if (visiblePids.length !== 1) {
    return listenerFailure(
      'desktop_dev_listener_ambiguous',
      `:${DESKTOP_DEV_PORT} has multiple owner-visible listener pids (${visiblePids.join(', ')}); refusing an ambiguous restart.`,
    );
  }

  const pid = visiblePids[0]!;
  let rawCmdline: string;
  let rawEnviron: string;
  let rawStat: string;
  try {
    [rawCmdline, rawEnviron, rawStat] = await Promise.all([readCmdline(pid), readEnviron(pid), readStat(pid)]);
  } catch {
    return listenerFailure('desktop_dev_listener_unreadable', `Could not read the process identity for listener pid ${pid}.`, pid);
  }

  const cmdline = normalizeCmdline(rawCmdline);
  const env = parseProcessEnvironment(rawEnviron);
  const stat = parseProcStat(rawStat);
  if (!stat) {
    return listenerFailure('desktop_dev_listener_unreadable', `Could not parse the process identity for listener pid ${pid}.`, pid);
  }
  if (!isHonoHostCommand(cmdline) || !hasDesktopDevEnvironment(env)) {
    return listenerFailure(
      'desktop_dev_identity_mismatch',
      `Listener pid ${pid} is not the expected desktop-dev hono-host process; refusing to signal it.`,
      pid,
    );
  }

  const parentChain = await readParentChain({ pid, cmdline, ...stat }, { readCmdline, readStat });
  if (!parentChain.some((parent) => isDesktopDevWrapperCommand(parent.cmdline))) {
    return listenerFailure(
      'desktop_dev_supervisor_missing',
      `Listener pid ${pid} is not descended from ${DESKTOP_DEV_WRAPPER}; refusing to signal an unsupervised process.`,
      pid,
    );
  }

  return { ok: true, pid, listener: { pid, cmdline, env, parentChain }, note: `Verified ${DESKTOP_DEV_WRAPPER}-supervised hono-host listener pid ${pid} on :${DESKTOP_DEV_PORT}.` };
}

/** Resolve, re-resolve, and signal only the verified desktop listener child. */
export async function restartDesktopDev(deps: DesktopDevRestartDeps = {}): Promise<DesktopDevRestartResult> {
  const first = await resolveDesktopDevListener(deps);
  if (!first.ok || first.pid === undefined) return { ok: false, reason: first.reason, note: first.note };

  const second = await resolveDesktopDevListener(deps);
  if (!second.ok || second.pid !== first.pid) {
    return {
      ok: false,
      pid: first.pid,
      reason: 'desktop_dev_listener_changed',
      note: `The :${DESKTOP_DEV_PORT} listener changed after validation; refusing to signal the original pid ${first.pid}.`,
    };
  }

  try {
    (deps.signal ?? ((pid, signal) => process.kill(pid, signal)))(second.pid, 'SIGKILL');
    return {
      ok: true,
      pid: second.pid,
      note: `SIGKILL sent only to verified desktop-dev listener pid ${second.pid}; ${DESKTOP_DEV_WRAPPER} will respawn it.`,
    };
  } catch (error) {
    return {
      ok: false,
      pid: second.pid,
      reason: 'desktop_dev_signal_failed',
      note: `Could not signal verified desktop-dev listener pid ${second.pid}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
