import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { armSelfWatchdog } from "./green-checkpoint";

describe("checkpoint self-watchdog process boundary", () => {
  it("kills the isolated runner group when its idle deadline expires", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) throw new Error("watchdog integration child has no pid");

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof armSelfWatchdog> | undefined;
    try {
      await once(child, "spawn");
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", reject);
        },
      );
      const release = vi.fn();
      const onFire = vi.fn();
      watchdog = armSelfWatchdog(
        { release },
        {
          pid,
          ms: 80,
          hardCeilingMs: 500,
          trigger: "manual-run-deadline",
          log: () => {},
          snapshotProcessGroup: () => null,
          resolveProcessGroupId: () => pid,
          onFire,
        },
      );

      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("watchdog did not kill its runner group")), 5_000);
        }),
      ]);
      expect(result).toEqual({ code: null, signal: "SIGKILL" });
      expect(release).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledTimes(1);
    } finally {
      watchdog?.cancel();
      if (timeout) clearTimeout(timeout);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The watchdog already killed the isolated group.
      }
    }
  }, 10_000);
});
