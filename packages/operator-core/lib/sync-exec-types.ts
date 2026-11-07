/** Shared process timing contract. Keep this leaf free of executor imports so
 * standalone declaration clients do not pull in the sidecar/task runtime. */

/** Monotonic offsets from the call boundary, retained when a child fails. */
export interface ExecFileTiming {
  startedAtUnixMs: number;
  parentPid: number;
  childPid: number | null;
  spawnReturnedMs: number | null;
  spawnEventMs: number | null;
  firstOutputMs: number | null;
  exitMs: number | null;
  callbackMs: number;
}
