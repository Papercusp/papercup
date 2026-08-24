import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realSpawnSync = actual.spawnSync as unknown as (
    ...args: unknown[]
  ) => unknown;
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      const override = spawnSyncMock(...args);
      return override === undefined ? realSpawnSync(...args) : override;
    },
  };
});

import {
  CHECKPOINT_PROCESS_PROBE_TIMEOUT_MS,
  readCheckpointProcTable,
  resolveCheckpointProcessGroupId,
  snapshotCheckpointProcessGroup,
} from "./green-checkpoint";

describe("green-checkpoint process probes", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("uses PID/group-scoped ps with a hard timeout for every supervision probe", () => {
    spawnSyncMock.mockReturnValue({
      stdout: "",
      stderr: "",
      error: undefined,
    });

    snapshotCheckpointProcessGroup(123);
    resolveCheckpointProcessGroupId(123);
    readCheckpointProcTable();

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock.mock.calls[0]).toEqual([
      "ps",
      [
        "-o",
        "pid=,ppid=,pgid=,stat=,etime=,pcpu=,pmem=,command=",
        "-g",
        "123",
      ],
      expect.objectContaining({
        encoding: "utf8",
        timeout: CHECKPOINT_PROCESS_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    ]);
    expect(spawnSyncMock.mock.calls[1]).toEqual([
      "ps",
      ["-o", "pgid=", "-p", "123"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: CHECKPOINT_PROCESS_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    ]);
    expect(spawnSyncMock.mock.calls[2]).toEqual([
      "ps",
      ["-eo", "pid=,ppid=,pgid="],
      expect.objectContaining({
        encoding: "utf8",
        timeout: CHECKPOINT_PROCESS_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    ]);
  });

  it("fails soft when ps times out instead of blocking supervision", () => {
    spawnSyncMock.mockReturnValue({
      stdout: "partial output",
      stderr: "",
      error: Object.assign(new Error("ps timed out"), {
        code: "ETIMEDOUT",
      }),
    });

    expect(snapshotCheckpointProcessGroup(123)).toBeNull();
    expect(resolveCheckpointProcessGroupId(123)).toBeNull();
    expect(readCheckpointProcTable()).toBeNull();
  });
});
