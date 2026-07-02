/**
 * windows-desktop-windows.ts — Windows-side window enumeration + focus helpers
 * (windows-desktop-feature-parity-2026-07-02, shared contract for Lane 1/2/5).
 *
 * THE ONE INSIGHT: on Windows the agent/session runs INSIDE the `papercup-runtime`
 * WSL2 distro while its terminal window (`wt.exe` / WindowsTerminal.exe) is a
 * Windows process — there is NO Windows window-ancestor for a WSL pid, so the
 * Linux approach (desktop-window-liveness.ts's wmctrl pid/ancestry matching) is
 * structurally impossible here. Every session→window link on Windows is instead
 * by window TITLE: each session's terminal is titled `Papercup — <sessionId>`
 * (em dash U+2014) — see native_console.rs / console-launcher.ts (Lane 1) for
 * where the title is set, and desktop-window-liveness.ts (Lane 2) /
 * adv-sessions.ts focusWindowId (Lane 1/5) for the consumers.
 *
 * Implementation: shells out to `powershell.exe` from inside WSL (WSL→Windows
 * interop) to enumerate top-level windows via the classic EnumWindows/
 * GetWindowText/GetWindowThreadProcessId P/Invoke trio, and to focus one via
 * FindWindow + ShowWindow(SW_RESTORE) + SetForegroundWindow.
 *
 * ⚠ OPEN RISK (flagged for the fleet lead / VM verification): it is UNVERIFIED
 * whether a `powershell.exe` spawned from inside WSL sees the INTERACTIVE
 * session's `wt.exe` windows (a Session-0 / window-station boundary could hide
 * them). If VM verification shows an empty result despite windows being open,
 * pivot this module to a Tauri Rust command invoked over the existing
 * operator↔Tauri IPC bridge instead of shelling to powershell.exe — the
 * exported function SIGNATURES here are the contract every caller codes
 * against, so that pivot is a drop-in swap of the implementation only.
 *
 * Fail-soft throughout, mirroring desktop-window-liveness.ts's wmctrl contract:
 * ANY failure (not a Windows-via-WSL host, no powershell, WSL interop
 * unavailable, spawn timeout, parse miss) yields `[]` / `false` — never
 * throws.
 *
 * ⚠ PLATFORM-DETECTION GOTCHA (P-025 audit finding, WI-1646's sibling — do NOT
 * regress this): `process.platform` is USELESS for gating this module.
 * main.rs's `make_sidecar_command` ALWAYS launches the operator via
 * `wsl.exe --distribution papercup-runtime --exec node …`, so the Node
 * process is a genuine Linux binary running under the WSL2 kernel — it sees
 * `process.platform === 'linux'` on a REAL Windows install, same as on the
 * Linux dev box. `process.platform === 'win32'` can therefore never be true
 * here in production (verified: it silently no-ops the whole module, the
 * exact WI-1586 "0 on-desktop every sweep" failure class this plan exists to
 * avoid). `isWindowsDesktopHost()` below is the correct guard — it detects
 * "this Linux process is running inside a WSL2 VM that IS the Windows
 * desktop host" via the WSL2 kernel's `/proc/version` signature, which is
 * present regardless of how the process was spawned (exec vs. login shell,
 * unlike env vars such as WSL_DISTRO_NAME that depend on profile scripts).
 */

import { readFileSync } from 'node:fs';
// Lazy/dynamic `node:child_process` import (mirrors adv-sessions.ts's wmctrl
// calls) rather than a static top-level one: several unrelated test suites
// do a blanket `vi.mock('node:child_process', () => ({ spawn: ... }))` that
// fully replaces the module with just `spawn` — a static top-level
// `execFile` import here would break their (unrelated) tests the moment
// this module lands anywhere in their transitive import graph. A dynamic
// import inside the one function that needs it is only resolved when
// actually called, which the platform guard (isWindowsDesktopHost()) means
// is never, off a Windows-via-WSL host.
let cachedIsWindowsDesktopHost: boolean | null = null;

/**
 * True iff this Node process is running as the Windows desktop's operator
 * sidecar — i.e. a Linux process (`process.platform === 'linux'`) inside the
 * WSL2 VM that hosts it, NOT a genuine Linux/macOS dev box. Detected via the
 * WSL2 kernel's `/proc/version` signature (contains "microsoft" — e.g.
 * `5.15.153.1-microsoft-standard-WSL2`), which every WSL2 process can read
 * regardless of spawn method (unlike `WSL_DISTRO_NAME`/`WSL_INTEROP`, which
 * depend on shell-profile initialization that `wsl.exe --exec` skips).
 * `process.platform === 'win32'` is checked first as a defensive fallback (it
 * is never true in the current architecture — see the module doc — but costs
 * nothing to keep in case that ever changes, e.g. a future native port).
 * Cached: platform doesn't change at runtime. Exported so callers/tests don't
 * need to know the detection mechanism.
 */
export function isWindowsDesktopHost(): boolean {
  if (cachedIsWindowsDesktopHost != null) return cachedIsWindowsDesktopHost;
  if (process.platform === 'win32') {
    cachedIsWindowsDesktopHost = true;
  } else if (process.platform !== 'linux') {
    cachedIsWindowsDesktopHost = false; // darwin (or anything else) is never WSL
  } else {
    try {
      cachedIsWindowsDesktopHost = /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
    } catch {
      cachedIsWindowsDesktopHost = false; // no /proc/version → not Linux-as-we-know-it → not WSL
    }
  }
  return cachedIsWindowsDesktopHost;
}

/** Test seam: drop the cached platform-detection result. */
export function __resetIsWindowsDesktopHostCache(): void {
  cachedIsWindowsDesktopHost = null;
}

/** One enumerated top-level Windows window. */
export interface WindowsDesktopWindow {
  /** Window title, e.g. `Papercup — <sessionId>`. */
  title: string;
  /** Owning process id (Windows pid — NOT the WSL-side session host pid). */
  pid: number;
  /** Window handle, hex-formatted (e.g. `0x1a2b3c`). */
  hwnd: string;
}

/** The exact title prefix Lane 1 stamps on every session's terminal window. */
export const WINDOW_TITLE_PREFIX = 'Papercup — ';

/** A hung/absent powershell must never wedge the caller (presence read / reaper sweep). */
const PS_TIMEOUT_MS = 2000;

/** PowerShell script: enumerate visible top-level windows as `hwnd|pid|title` lines. */
const LIST_WINDOWS_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PapercuspWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$results = New-Object System.Collections.Generic.List[string]
$callback = {
  param($hWnd, $lParam)
  if ([PapercuspWin32]::IsWindowVisible($hWnd)) {
    $len = [PapercuspWin32]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [PapercuspWin32]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
      $title = $sb.ToString()
      $procId = 0
      [PapercuspWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
      $results.Add("$hWnd|$procId|$title")
    }
  }
  return $true
}
[PapercuspWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$results | ForEach-Object { Write-Output $_ }
`.trim();

/**
 * Leader VM finding (2026-07-02): `powershell.exe` is deliberately NOT on the
 * `papercup-runtime` WSL PATH, so a bare `powershell.exe` fails with
 * "command not found" — it must be invoked by its absolute Windows-mount path.
 * Tried first; a bare-name fallback covers a WSL config where PATH forwarding
 * IS enabled (still fail-soft either way).
 */
const POWERSHELL_ABS_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

async function execPowershell(bin: string, script: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(bin, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: PS_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });
  return typeof stdout === 'string' ? stdout : '';
}

async function runPowershell(script: string): Promise<string | null> {
  try {
    return await execPowershell(POWERSHELL_ABS_PATH, script);
  } catch {
    try {
      return await execPowershell('powershell.exe', script); // PATH-forwarding fallback
    } catch {
      return null; // absolute path missing (non-standard drive) AND not on PATH / timeout / spawn error
    }
  }
}

/**
 * PURE: parse the `hwnd|pid|title` lines emitted by LIST_WINDOWS_SCRIPT. A line
 * missing either separator, or with a non-numeric pid, is skipped. The title is
 * everything after the SECOND `|` (rejoined, so a title containing `|` survives).
 */
export function parseWindowListOutput(stdout: string): WindowsDesktopWindow[] {
  const out: WindowsDesktopWindow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx1 = trimmed.indexOf('|');
    if (idx1 < 0) continue;
    const idx2 = trimmed.indexOf('|', idx1 + 1);
    if (idx2 < 0) continue;
    const hwnd = trimmed.slice(0, idx1).trim();
    const pid = Number(trimmed.slice(idx1 + 1, idx2).trim());
    const title = trimmed.slice(idx2 + 1);
    if (!hwnd || !Number.isFinite(pid) || pid <= 0) continue;
    out.push({ hwnd, pid, title });
  }
  return out;
}

/**
 * Enumerate top-level Windows windows, optionally filtered to titles starting
 * with `prefix` (pass WINDOW_TITLE_PREFIX to get only Papercup session
 * terminals). Best-effort: not a Windows desktop host, no powershell.exe, or a
 * parse miss all yield `[]` — mirrors listOpenWindows' wmctrl fail-soft
 * contract so a caller (desktop-window-liveness.ts) never has to special-case
 * this platform.
 */
export async function listWindowsByTitle(prefix?: string): Promise<WindowsDesktopWindow[]> {
  if (!isWindowsDesktopHost()) return [];
  try {
    const stdout = await runPowershell(LIST_WINDOWS_SCRIPT);
    const windows = stdout ? parseWindowListOutput(stdout) : [];
    return prefix ? windows.filter((w) => w.title.startsWith(prefix)) : windows;
  } catch {
    return [];
  }
}

/**
 * PURE: extract the sessionId from a `Papercup — <sessionId>` window title, or
 * null if the title doesn't carry the tag. Exported so title-format changes are
 * unit-covered in one place (desktop-window-liveness.ts's matcher imports this).
 */
export function parseSessionIdFromWindowTitle(title: string): string | null {
  if (!title.startsWith(WINDOW_TITLE_PREFIX)) return null;
  const sessionId = title.slice(WINDOW_TITLE_PREFIX.length).trim();
  return sessionId.length > 0 ? sessionId : null;
}

function escapeForPowershellSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Bring a Windows window to the foreground by exact title match (FindWindow +
 * ShowWindow(SW_RESTORE) + SetForegroundWindow, with the AttachThreadInput
 * focus-steal workaround Windows requires from a background process).
 * USER-INITIATED ONLY — mirrors adv-sessions.ts focusWindowId's memory
 * (feedback_e2e_no_focus_steal): never call this from an automated driver.
 * Best-effort: returns false on any failure (no match / no powershell / timeout).
 */
export async function focusWindowByTitle(title: string): Promise<boolean> {
  if (!isWindowsDesktopHost()) return false;
  const escaped = escapeForPowershellSingleQuoted(title);
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PapercuspFocus {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
"@
$hwnd = [PapercuspFocus]::FindWindow($null, '${escaped}')
if ($hwnd -eq [IntPtr]::Zero) { exit 1 }
[PapercuspFocus]::ShowWindow($hwnd, 9) | Out-Null
$targetTid = 0
[PapercuspFocus]::GetWindowThreadProcessId($hwnd, [ref]$targetTid) | Out-Null
$curTid = [PapercuspFocus]::GetCurrentThreadId()
[PapercuspFocus]::AttachThreadInput($curTid, $targetTid, $true) | Out-Null
$ok = [PapercuspFocus]::SetForegroundWindow($hwnd)
[PapercuspFocus]::AttachThreadInput($curTid, $targetTid, $false) | Out-Null
if ($ok) { exit 0 } else { exit 1 }
`.trim();
  try {
    await execPowershell(POWERSHELL_ABS_PATH, script);
    return true;
  } catch {
    try {
      await execPowershell('powershell.exe', script); // PATH-forwarding fallback
      return true;
    } catch {
      return false; // no match (non-zero exit) / no powershell / timeout
    }
  }
}
