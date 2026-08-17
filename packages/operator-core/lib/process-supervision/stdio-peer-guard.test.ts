/**
 * (WI-39599) The property under test is AMPLIFICATION, not "a listener exists".
 *
 * The bug was never that a broken pipe errors — it is that the error was
 * reported by writing to the stream that just failed, which re-raised it. So
 * the control here is a deliberately-wrong "guard" that reports the way the
 * original code did; it must blow the runaway cap while the real guard stays
 * bounded. A test that only asserted `on('error')` had been called would pass
 * for both, which is exactly the green a broken subject also produces.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetStdioPeerGuardForTests,
  installStdioPeerGuard,
  isPeerGoneError,
  type GuardableStream,
} from "./stdio-peer-guard";

const RUNAWAY_CAP = 500;

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

/**
 * A stdio stream whose peer has gone: every write fails by emitting 'error'.
 * Faithful to the real failure — the error arrives as a stream event, which is
 * what Node throws as an uncaughtException when nothing is listening.
 */
class BrokenPipeStream extends EventEmitter implements GuardableStream {
  writes = 0;
  write(): void {
    this.writes += 1;
    if (this.writes > RUNAWAY_CAP) {
      throw new Error(`runaway: ${this.writes} writes — amplification did not terminate`);
    }
    this.emit("error", epipe());
  }
}

afterEach(() => _resetStdioPeerGuardForTests());

describe("isPeerGoneError", () => {
  it("recognises the peer-gone write failures and nothing else", () => {
    expect(isPeerGoneError(epipe())).toBe(true);
    expect(isPeerGoneError(Object.assign(new Error("x"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isPeerGoneError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isPeerGoneError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(false);
    expect(isPeerGoneError(new Error("no code"))).toBe(false);
    expect(isPeerGoneError(undefined)).toBe(false);
  });
});

describe("installStdioPeerGuard — the amplification property (WI-39599)", () => {
  it("absorbs a broken-pipe write without writing again, so the loop cannot start", () => {
    const stdout = new BrokenPipeStream();
    const stderr = new BrokenPipeStream();
    const guard = installStdioPeerGuard({ stdout, stderr });

    stdout.write();

    // One write in, no write out — the amplifier is gone.
    expect(stdout.writes).toBe(1);
    expect(stderr.writes).toBe(0);
    // CALIBRATION: it must still RECORD the fault. A "guard" that swallowed the
    // error into nothing would satisfy the bound above while destroying the
    // signal, so the bound alone is not sufficient evidence.
    expect(guard.absorbed().stdout).toBe(1);
    expect(guard.peerGone()).toBe(true);
  });

  it("PERMANENT WRONG-IMPLEMENTATION CONTROL: reporting via the failed stream runs away", () => {
    const stdout = new BrokenPipeStream();
    // This is the pre-fix serve.ts shape: the fault handler diagnoses by writing
    // to the very stream whose write just failed.
    stdout.on("error", () => stdout.write());

    expect(() => stdout.write()).toThrow(/runaway/);
    expect(stdout.writes).toBeGreaterThan(RUNAWAY_CAP);
  });

  it("a non-peer-gone stdio error is recorded but does NOT latch peerGone", () => {
    const stdout = new BrokenPipeStream();
    const stderr = new BrokenPipeStream();
    const guard = installStdioPeerGuard({ stdout, stderr });

    stdout.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    expect(guard.absorbed()).toEqual({ stdout: 0, stderr: 0, other: 1 });
    expect(guard.peerGone()).toBe(false);
    // Still no write-out: a genuine fault must not be reported through the
    // stream either, or a full disk becomes the same amplifier.
    expect(stdout.writes).toBe(0);
  });

  it("latches peerGone from stderr as well as stdout", () => {
    const stdout = new BrokenPipeStream();
    const stderr = new BrokenPipeStream();
    const guard = installStdioPeerGuard({ stdout, stderr });

    stderr.write();

    expect(guard.absorbed().stderr).toBe(1);
    expect(guard.peerGone()).toBe(true);
  });

  it("is idempotent — a second install does not stack listeners", () => {
    const stdout = new BrokenPipeStream();
    const stderr = new BrokenPipeStream();
    const first = installStdioPeerGuard({ stdout, stderr });
    const second = installStdioPeerGuard({ stdout, stderr });

    expect(second).toBe(first);
    expect(stdout.listenerCount("error")).toBe(1);

    stdout.write();
    // Stacked listeners would double-count the same single failure.
    expect(first.absorbed().stdout).toBe(1);
  });

  it("uninstall detaches, restoring the unguarded (throwing) behaviour", () => {
    const stdout = new BrokenPipeStream();
    const stderr = new BrokenPipeStream();
    installStdioPeerGuard({ stdout, stderr }).uninstall();

    expect(stdout.listenerCount("error")).toBe(0);
    // With no listener, Node's EventEmitter throws the 'error' — which is
    // precisely the uncaughtException the guard exists to prevent.
    expect(() => stdout.write()).toThrow(/EPIPE/);
  });
});
