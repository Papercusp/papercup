import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./capture-signals.py", import.meta.url));

describe("capture-signals.py CLI", () => {
  it("prints help without creating a capture artifact", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "capture-signals-help-"));

    try {
      const help = execFileSync(
        "python3",
        [scriptPath, "--help", "--out", outputDir],
        { encoding: "utf8" },
      );

      expect(help).toContain("usage:");
      expect(help).toContain("--label");
      expect(help).toContain("--out");
      expect(readdirSync(outputDir)).toEqual([]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

/** Load capture-signals.py as a module (its filename has a hyphen) and run `body`
 *  with `cs` bound and `root` = a fresh temp dir; `body` prints one JSON line. */
function runPy(body: string): unknown {
  const root = mkdtempSync(join(tmpdir(), "capture-signals-io-"));
  try {
    const code = [
      "import importlib.util, json, os, sys",
      `spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(scriptPath)})`,
      "cs = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cs)",
      "root = sys.argv[1]",
      "def put(rel, name, text):",
      "    d = os.path.join(root, rel)",
      "    os.makedirs(d, exist_ok=True)",
      "    open(os.path.join(d, name), 'w').write(text)",
      body,
    ].join("\n");
    return JSON.parse(execFileSync("python3", ["-c", code, root], { encoding: "utf8" }).trim().split("\n").pop()!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// EI-24438849822675827: the 2026-09-27 IO saturation could not be attributed because
// the capture recorded host PSI but neither per-cgroup IO nor the D-state task set.
describe("capture-signals.py IO-stall attribution", () => {
  it("cgroup_io ranks cgroups by bytes moved over the sample and carries their io.pressure", () => {
    const out = runPy([
      "zero = '259:1 rbytes=0 wbytes=0 rios=0 wios=0\\n'",
      "put('cg/a.slice', 'io.stat', zero)",
      "put('cg/b.slice', 'io.stat', zero)",
      "put('cg/b.slice', 'io.pressure', 'some avg10=50.00 avg60=1.00 avg300=1.00 total=1\\nfull avg10=42.00 avg60=1.00 avg300=1.00 total=1\\n')",
      "put('cg/c.slice', 'io.stat', '259:1 rbytes=0 wbytes=9000000 rios=0 wios=9\\n')",
      "put('cg/idle.slice', 'io.stat', zero)",
      "clock = [0.0]",
      "def sleep(_s):",
      "    clock[0] += 2.0",
      "    put('cg/a.slice', 'io.stat', '259:1 rbytes=0 wbytes=2000000 rios=0 wios=10\\n')",
      "    put('cg/b.slice', 'io.stat', '259:1 rbytes=4000000 wbytes=20000000 rios=8 wios=400\\n259:2 rbytes=0 wbytes=2000000 rios=0 wios=0\\n')",
      "    put('cg/c.slice', 'io.stat', '259:1 rbytes=0 wbytes=1 rios=0 wios=1\\n')",
      "r = cs.cgroup_io(root=os.path.join(root, 'cg'), monotonic_fn=lambda: clock[0], sleep_fn=sleep)",
      "print(json.dumps(r))",
    ].join("\n")) as { top: Array<Record<string, unknown>>; sampleSec: number; partial: boolean };

    expect(out.sampleSec).toBe(2);
    expect(out.partial).toBe(false);
    // b: 22 MB written + 4 MB read over 2 s across two devices; a: 2 MB written.
    // c's counter went BACKWARDS (cgroup recreated) and idle moved nothing: both dropped.
    expect(out.top.map((row) => row.path)).toEqual(["/b.slice", "/a.slice"]);
    expect(out.top[0]).toMatchObject({ writeMBps: 11, readMBps: 2, writeIops: 200, readIops: 4 });
    expect(out.top[0].ioPressure).toMatchObject({ full: { avg10: 42 } });
    expect(out.top[1]).toMatchObject({ writeMBps: 1, ioPressure: null });
  });

  it("dstate_tasks counts D-state threads by command, wait channel and cgroup", () => {
    const out = runPy([
      "def task(pid, tid, comm, state, wchan, cg):",
      "    put(f'proc/{pid}/task/{tid}', 'stat', f'{tid} ({comm}) {state} 1 2 3\\n')",
      "    put(f'proc/{pid}/task/{tid}', 'wchan', wchan)",
      "    put(f'proc/{pid}', 'cgroup', f'0::{cg}\\n')",
      "task(100, 100, 'kworker/u256:3+flush-259:1', 'D', 'rq_qos_wait', '/')",
      "task(101, 101, 'kworker/u256:7+flush-259:1', 'D', 'rq_qos_wait', '/')",
      "task(200, 200, 'pg (odd) name', 'D', 'jbd2_log_wait_commit', '/system.slice/pg.service')",
      "task(300, 300, 'bash', 'S', 'do_wait', '/user.slice')",
      "task(300, 301, 'node', 'D', 'folio_wait_bit', '/user.slice')",
      "put('proc', 'self-not-a-pid', '')",
      "r = cs.dstate_tasks(proc_root=os.path.join(root, 'proc'))",
      "print(json.dumps(r))",
    ].join("\n")) as Record<string, unknown>;

    expect(out).toMatchObject({ available: true, dStateTasks: 4, scannedTasks: 5, partial: false });
    expect(out.topComms).toEqual([
      { comm: "kworker/*+flush-259:1", count: 2 },
      { comm: "node", count: 1 },
      { comm: "pg (odd) name", count: 1 },
    ]);
    expect(out.topWchans).toContainEqual({ wchan: "rq_qos_wait", count: 2 });
    expect(out.topCgroups).toEqual([
      { cgroup: "/", count: 2 },
      { cgroup: "/system.slice/pg.service", count: 1 },
      { cgroup: "/user.slice", count: 1 },
    ]);
  });

  it("dstate_tasks reports an unreadable /proc as unavailable, never as zero D-state tasks", () => {
    const out = runPy("print(json.dumps(cs.dstate_tasks(proc_root=os.path.join(root, 'missing'))))");
    expect(out).toEqual({ available: false, dStateTasks: null, partial: true });
  });

  it("keeps an io-pressure incident copy at full avg10 >= 20, at most once per gap", () => {
    const out = runPy([
      "src = os.path.join(root, '2026-10-02T020000Z-cron.json')",
      "open(src, 'w').write('{}')",
      "hot = {'io': {'full': {'avg10': 31.5}}}",
      "first = cs.maybe_preserve_io_incident(hot, root, src)",
      "again = cs.maybe_preserve_io_incident(hot, root, src)",
      "calm = cs.maybe_preserve_io_incident({'io': {'full': {'avg10': 5.0}}}, root, src, min_gap_sec=0)",
      "missing = cs.maybe_preserve_io_incident({'io': None}, root, src, min_gap_sec=0)",
      "print(json.dumps({'first': os.path.basename(first or ''), 'again': again, 'calm': calm, 'missing': missing, 'files': sorted(os.listdir(root))}))",
    ].join("\n"));
    expect(out).toEqual({
      first: "2026-10-02T020000Z-cron-incident-io-pressure.json",
      again: null,
      calm: null,
      missing: null,
      files: ["2026-10-02T020000Z-cron-incident-io-pressure.json", "2026-10-02T020000Z-cron.json"],
    });
  });
});
