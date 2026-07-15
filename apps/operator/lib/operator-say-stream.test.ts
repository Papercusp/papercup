import { describe, expect, it } from "vitest";
import { OperatorSayStreamProjector } from "./operator-say-stream";

describe("OperatorSayStreamProjector", () => {
  it("waits for the say envelope and emits its body incrementally", () => {
    const projector = new OperatorSayStreamProjector();

    expect(projector.push("  <sa")).toBe("");
    expect(projector.push("y>Hello")).toBe("Hello");
    expect(projector.push(", Avi.")).toBe(", Avi.");
    expect(projector.text).toBe("Hello, Avi.");
    expect(projector.complete).toBe(false);
  });

  it("withholds a split closing tag and never leaks later control tags", () => {
    const projector = new OperatorSayStreamProjector();

    expect(projector.push("<say>Working on it.</sa")).toBe("Working on it.");
    expect(projector.push('y><sleep duration="5">')).toBe("");
    expect(projector.text).toBe("Working on it.");
    expect(projector.complete).toBe(true);
    expect(projector.push("<continue/>")).toBe("");
  });

  it("handles a complete envelope in one chunk", () => {
    const projector = new OperatorSayStreamProjector();

    expect(projector.push("<say>Done.</say>\n<continue/>")).toBe("Done.");
    expect(projector.text).toBe("Done.");
    expect(projector.complete).toBe(true);
  });

  it("does not stream unwrapped prose or protocol-only turns", () => {
    const prose = new OperatorSayStreamProjector();
    const toolOnly = new OperatorSayStreamProjector();

    expect(prose.push("A fallback prose response with no envelope.")).toBe("");
    expect(toolOnly.push('<sleep duration="5"><continue/>')).toBe("");
  });
});
