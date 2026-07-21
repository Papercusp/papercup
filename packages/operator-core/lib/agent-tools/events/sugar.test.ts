import { describe, it, expect, vi, beforeEach } from "vitest";

const definedTools = vi.hoisted(
  () =>
    [] as Array<{
      name: string;
      handler: (
        args: never,
        ctx: never,
      ) => Promise<{ content: Array<{ text: string }> }>;
    }>,
);

vi.mock("@papercusp/agent-mcp", () => ({
  defineTool: (def: (typeof definedTools)[number]) => {
    definedTools.push(def);
    return def;
  },
  SU_ROLES: ["operator"],
}));

vi.mock("../coordination/identity", () => ({
  resolveAgentIdentity: () => ({
    ownerId: "su-awaiter",
    ownerLabel: "a",
    source: "static-client",
    workspaceId: "ws-x",
    userId: null,
  }),
}));

vi.mock("../../events/await/handle", () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({
    handle: {
      kind: "adv-session",
      advSessionId: 1,
      agent: "codex",
      sessionId: "s",
      ompThreadId: null,
      cwd: "/r",
      pid: 1,
    },
  })),
}));

vi.mock("../../events/await/store", () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({
    id: 99,
    eventKey: i.eventKey,
    expiresTs: "2030-01-01",
    timeoutBehavior: i.timeoutBehavior,
  })),
  cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
}));

vi.mock("../../events/await/engine", () => ({ startAwaitSweeper: vi.fn() }));

vi.mock("../../dev-deploy-state", () => ({
  devDeployState: vi.fn(async () => ({
    integrationRoot: "/home/x/papercupai-workspace/papercusp",
  })),
}));

// EI-13095: the work-item:await latches probe the live item — mocked here so the
// rig stays hermetic (the real module pulls db-org). Default 'live'/'blocked' =
// every existing case registers exactly as before.
vi.mock("../../work-items-events", () => ({
  liveSettledProbe: vi.fn(async () => ({ verdict: "live" as const, itemState: "wip" })),
  liveBlockedState: vi.fn(async () => "blocked" as const),
}));

await import("./sugar");

import { registerAwait, cancelAwaitsForSubscribersOnKeys } from "../../events/await/store";
import { devDeployState } from "../../dev-deploy-state";
import { liveBlockedState, liveSettledProbe } from "../../work-items-events";
import { checkpointPipelineName } from "./sugar";

const checkpointTool = definedTools.find(
  (tool) => tool.name === "checkpoint:await",
);
if (!checkpointTool)
  throw new Error("checkpoint:await tool was not registered");

const ctx = { workspaceId: "ws-x" } as never;
const call = async (args: Record<string, unknown>) => {
  const res = await checkpointTool.handler(args as never, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkpoint:await sugar", () => {
  it("defaults to the current pipeline-scoped gate keys", async () => {
    const out = await call({});

    expect(devDeployState).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual(["release:green:papercusp", "green-checkpoint:red:papercusp"]);
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
    ]);
    expect(out.advice).toContain("End your turn");
  });

  it("uses an explicit pipeline without reading deploy state", async () => {
    await call({ pipeline: "papercup" });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual(["release:green:papercup", "green-checkpoint:red:papercup"]);
  });

  it("keeps an explicit global escape hatch for cross-pipeline monitors", async () => {
    await call({ global: true });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual(["release:green", "green-checkpoint:red"]);
  });

  it("sanitizes pipeline names the same way checkpoint emitters do", () => {
    expect(checkpointPipelineName("/weird/dir with spaces!")).toBe(
      "dir-with-spaces-",
    );
  });

  // EI-12457: candidateSha binds the wait to an exact subject via a payload
  // predicate, and re-arming must retire this subscriber's own prior pending
  // checkpoint-family wait for the pipeline BEFORE registering the new one.
  it("binds candidateSha to a payloadFilter on every registered key", async () => {
    const out = await call({ candidateSha: "94c1234567" });

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({
        sha: { startsWith: "94c1234567" },
      });
    }
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
    ]);
  });

  it("omits payloadFilter when no candidateSha is given", async () => {
    await call({});

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toBeNull();
    }
  });

  // WI-4957: runId binds further than candidateSha alone — needed only when two runs
  // might judge the same candidate (a re-fire, or a routine/manual race).
  it("WI-4957: binds runId to a payloadFilter on every registered key", async () => {
    const out = await call({ runId: "run-abc-123" });

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({ runId: "run-abc-123" });
    }
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
    ]);
  });

  it("WI-4957: candidateSha + runId compose into ONE AND-filter (both must match)", async () => {
    await call({ candidateSha: "94c1234567", runId: "run-abc-123" });

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({
        sha: { startsWith: "94c1234567" },
        runId: "run-abc-123",
      });
    }
  });

  it("supersedes this subscriber's own prior pending checkpoint keys BEFORE registering the new wait, and threads the count into the response", async () => {
    const callOrder: string[] = [];
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockImplementationOnce(
      async () => {
        callOrder.push("supersede");
        return 3;
      },
    );
    vi.mocked(registerAwait).mockImplementationOnce(async (i) => {
      callOrder.push("register");
      return {
        id: 99,
        eventKey: i.eventKey,
        expiresTs: "2030-01-01",
        timeoutBehavior: i.timeoutBehavior,
      } as never;
    });

    const out = await call({ candidateSha: "94c1234567" });

    expect(cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledWith(
      ["su-awaiter"],
      ["release:green:papercusp", "green-checkpoint:red:papercusp"],
    );
    expect(callOrder[0]).toBe("supersede");
    expect(callOrder).toContain("register");
    expect(out.superseded).toBe(3);
  });

  it("reports zero superseded when nothing was retired (checkpoint:await always attempts supersession)", async () => {
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockResolvedValueOnce(0);

    const out = await call({});

    expect(out.superseded).toBe(0);
  });

  // WI-5685: the generic events:await default (1800s/30min) is shorter than the suite can
  // legitimately run (the systemd backstop alone allows up to 3h) — a default-timeout
  // checkpoint:await used to strand the caller mid-suite on EVERY default call. This verb now
  // carries its OWN default derived from the suite's real ceiling.
  it("WI-5685: defaults the registered timeout to the suite's real ceiling, not the generic 30min events:await default", async () => {
    await call({});

    const timeouts = vi
      .mocked(registerAwait)
      .mock.calls.map((c) => c[0].timeoutSec);
    expect(new Set(timeouts).size).toBe(1);
    expect(timeouts[0]).toBeGreaterThan(30 * 60); // strictly longer than the generic default
    expect(timeouts[0]).toBeGreaterThanOrEqual(3 * 60 * 60); // at least the systemd backstop (3h)
  });

  it("WI-5685: an explicit timeout_sec still always wins over the checkpoint-specific default", async () => {
    await call({ timeout_sec: 60 });

    const timeouts = vi
      .mocked(registerAwait)
      .mock.calls.map((c) => c[0].timeoutSec);
    expect(timeouts).toEqual([60, 60]);
  });
});

describe("work-item:await registration latches (EI-13095 — the sugar used to bypass them)", () => {
  const wiTool = definedTools.find((tool) => tool.name === "work-item:await");
  if (!wiTool) throw new Error("work-item:await tool was not registered");
  const callWi = async (args: Record<string, unknown>) => {
    const res = await wiTool.handler(args as never, ctx);
    return JSON.parse(res.content[0].text);
  };

  it("state:'done' on an ALREADY-settled item answers already_done and registers NOTHING (the WI-5075 stranded-await class)", async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: "settled", itemState: "resolved" });
    const out = await callWi({ id: "WI-5075", state: "done" });
    expect(out).toMatchObject({ ok: true, already_done: true, item_state: "resolved" });
    expect(out.advice).toContain("Do not wait");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'done' on a LIVE item registers the done key exactly as before", async () => {
    const out = await callWi({ id: "WI-42", state: "done" });
    expect(out.ok).toBe(true);
    expect(out.already_done).toBeUndefined();
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:done:WI-42");
  });

  it("state:'done' with an UNKNOWN probe (unreadable item) fails OPEN — registers normally", async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: "unknown" });
    const out = await callWi({ id: "WI-404", state: "done" });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it("state:'unblocked' on an item with no live blocker answers already_unblocked (the P-006 latch, now applied via sugar too)", async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce("unblocked");
    const out = await callWi({ id: "WI-7", state: "unblocked" });
    expect(out).toMatchObject({ ok: true, already_unblocked: true, item_state: "unblocked" });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'unblocked' on a SETTLED item also latches (the key can never fire)", async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce("settled");
    const out = await callWi({ id: "WI-8", state: "unblocked" });
    expect(out).toMatchObject({ already_unblocked: true, item_state: "settled" });
    expect(out.advice).toContain("never fire");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'unblocked' on a genuinely BLOCKED item registers as before", async () => {
    const out = await callWi({ id: "WI-9", state: "unblocked" });
    expect(out.already_unblocked).toBeUndefined();
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:unblocked:WI-9");
  });

  it("state:'any' probes NOTHING (the general status key can always fire again)", async () => {
    const out = await callWi({ id: "WI-10" });
    expect(liveSettledProbe).not.toHaveBeenCalled();
    expect(liveBlockedState).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:status:WI-10");
  });
});
