// EI-23076695727837648 — a carry-respawn that ADOPTS fresh host code must hand its
// first turn to the launcher successor. The in-process respawn injects carryText
// after spawn; an adopting predecessor exits first, so before this fix the
// successor booted on the carry document and idled until an unrelated loop fire or
// wake (measured 3-48 min on 11 of 11 adoptions of one goal holder, 2026-10-01/02).
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handoffFirstTurnText } from "../scripts/psu-launcher.mjs";
import { writeHostHandoff, readHostHandoff } from "../scripts/psu-pty-host.mjs";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const hostSrc = read("../scripts/psu-pty-host.mjs");
const launcherSrc = read("../scripts/psu-launcher.mjs");

describe("EI-23076695727837648: an adopting carry-respawn hands its first turn to the successor", () => {
  it("handoffFirstTurnText returns the text verbatim, or null for a handoff from an older host", () => {
    const text = "⟦turn-origin:self-compaction nonce:abc⟧\nContinue where you left off";
    expect(handoffFirstTurnText({ firstTurnText: text })).toBe(text);
    expect(handoffFirstTurnText({})).toBeNull();
    expect(handoffFirstTurnText({ firstTurnText: "" })).toBeNull();
    expect(handoffFirstTurnText({ firstTurnText: 42 })).toBeNull();
    expect(handoffFirstTurnText(null)).toBeNull();
  });

  it("firstTurnText survives the on-disk handoff round trip", () => {
    const owner = `su-test-adopt-first-turn-${process.pid}-${Date.now()}`;
    const p = writeHostHandoff(owner, { mode: "carry-respawn", args: ["--x"], firstTurnText: "first turn" });
    try {
      expect(p).toBeTruthy();
      const rec = readHostHandoff(owner, { isAlive: () => false });
      expect(rec?.firstTurnText).toBe("first turn");
      expect(handoffFirstTurnText(rec)).toBe("first turn");
    } finally {
      if (p) rmSync(p, { force: true });
    }
  });

  it("the adopting branch writes firstTurnText from carryText into its handoff", () => {
    const at = hostSrc.indexOf("appendHostEvent(ownerId, 'host-code-adopting'");
    expect(at).toBeGreaterThan(0);
    const writeAt = hostSrc.lastIndexOf("const handoffPath = writeHostHandoff(ownerId, {", at);
    expect(writeAt).toBeGreaterThan(0);
    expect(hostSrc.slice(writeAt, at)).toMatch(/firstTurnText:\s*typeof carryText === 'string'/);
  });

  it("the launcher successor seeds the handoff's first turn instead of dropping it", () => {
    const at = launcherSrc.indexOf("args = hostHandoff.args;");
    expect(at).toBeGreaterThan(0);
    const end = launcherSrc.indexOf("kickoffFile = null;", at);
    expect(end).toBeGreaterThan(at);
    const branch = launcherSrc.slice(at, end);
    expect(branch).toMatch(/kickoff = handoffFirstTurnText\(hostHandoff\);/);
    expect(branch).not.toMatch(/\n\s*kickoff = null;/);
  });
});
