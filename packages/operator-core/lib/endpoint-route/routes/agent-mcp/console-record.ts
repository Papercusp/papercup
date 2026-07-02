/**
 * POST /api/agent-mcp/console/record — record an adv_sessions row for a
 * terminal the DESKTOP SHELL spawned Rust-side (Tauri `console_launch`,
 * papercusp-desktop/src-tauri/src/native_console.rs).
 *
 * windows-desktop-feature-parity-2026-07-02 P-014: `console-spawn.ts`'s
 * server-side spawner (Linux + macOS) calls `recordAdvSession` itself right
 * after it forks the terminal — see `console-launch.ts`'s POST handler. On
 * Windows (and any future non-Linux/non-macOS operator host) that spawn
 * happens OUTSIDE the operator, in Rust, via `console_launch` — and until
 * this route, `native-console.ts`'s Tauri fallback never told the operator a
 * new terminal had opened at all. A plain (non-psu) console spawned that way
 * had NO adv_sessions row: invisible to /adv, unparkable, unresumable, and —
 * for the on-desktop reaper exemption (P-019) — undetectable, because there
 * was nothing to detect.
 *
 * A psu (agent) session self-registers independently via bootstrap-su.ts the
 * moment `psu` boots — that call happens FROM INSIDE the WSL distro TO the
 * WSL-hosted operator (console-spawn.ts: "the operator runs inside WSL"), so
 * it already works cross-platform with no Windows-specific code. This route
 * only closes the gap for the OTHER case: a plain shell console with no
 * agent to self-register.
 *
 * Deliberately DOES NOT accept a caller-supplied `pid`. The Rust caller's
 * only candidate pid is the WINDOWS-side wt.exe/wsl.exe process id (Rust
 * `Command::spawn().id()`, native_console.rs) — a Windows PID lives in a
 * DIFFERENT pid namespace than the WSL-hosted operator that would later
 * `process.kill(pid, 0)` it (wake-executor.ts / wake-reachability.ts). Ever
 * accepting one from the client and forwarding it into `adv_sessions.pid`
 * would silently poison every liveness check with a foreign-namespace
 * number — the exact "breaks across the WSL boundary" trap the underlying
 * plan calls out. Leaving `pid` unset degrades to the SAME
 * presence-freshness liveness path bootstrap-su-launched (hook-bootstrapped,
 * no-pid) sessions already use — a known-correct, already-tested channel,
 * not a new one.
 *
 * No exit-watcher: `console-launch.ts`'s Linux/macOS path can attach one
 * because it holds the Node `ChildProcess`; here the child lives in the Rust
 * process and this route only fires once, at spawn time. The row is closed
 * out on the periodic reconcile path instead (matches the documented
 * "operator-restart is the recovery boundary" limitation next to
 * `attachExitWatcher`).
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { recordAdvSession } from '../../../adv-sessions';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';

interface RecordBody {
  cwd?: string | null;
  terminalBin?: string | null;
  label?: string | null;
  planSlug?: string | null;
  launchArgv?: string[] | null;
}

function normalizeLaunchArgv(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : null;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/console/record',
  auth: 'loopback',
  async handler(req) {
    try {
      await requirePrincipal(req.headers);
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        return Response.json({ status: 'error', error: err.reason }, { status: err.status });
      }
      throw err;
    }
    const body = (await req.json().catch(() => ({}))) as RecordBody;
    if (!body.cwd || typeof body.cwd !== 'string') {
      return Response.json({ status: 'error', error: 'cwd is required' }, { status: 400 });
    }
    const id = await recordAdvSession({
      workspaceId: activeWorkspaceId(),
      planSlug: body.planSlug ?? null,
      mode: 'console',
      terminalBin: body.terminalBin ?? null,
      // Deliberately omitted: see module header. Never forward a caller pid.
      label: body.label ?? null,
      cwd: body.cwd,
      launchArgv: normalizeLaunchArgv(body.launchArgv),
    });
    return Response.json({ status: 'ok', id });
  },
});
