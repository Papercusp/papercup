/**
 * objective-title-parity.test.ts — WI-1963 title parity (owner ask 2026-07-03, request #3),
 * extended for the SINGLE-SOURCE display pipe (tui-status-parity-single-source-2026-07-05).
 *
 * Codex and OMP have no bottom status pane (that's a Claude-Code-only TUI feature), but they
 * own their title bar. Since 2026-07-05 the title is rendered ONCE server-side
 * (status-display.ts → coord:glance `display.title`) and every hook pipes it VERBATIM —
 * parity by construction; the first describe below proves the pipe. The embedded `term_title`
 * copies in the two scripts survive ONLY as the fallback for a pre-display operator, and the
 * legacy describes remain the drift guard for that fallback: for the same display-less glance
 * + SID + equivalent model, the two titles must be equal.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// The THIRD pipe (WI-1383525 GAP 1): OMP owns no statusline, only a tty title. Its
// production leg (`applyStatusDisplay`) selects the title through this exact pure
// function, so driving it here IS driving the pipe — no re-implementation to drift.
import { selectStatusTitle } from "../scripts/hooks/omp/coord-hook";

const STATUSLINE = resolve(
  __dirname,
  "../scripts/hooks/cc/statusline-fleet.sh",
);
const OBJ_TITLE = resolve(
  __dirname,
  "../scripts/hooks/cc/posttooluse-objective-title.sh",
);
const dir = mkdtempSync(join(tmpdir(), "title-parity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SID = "su-9859ea5e-926d-4c65-b8fb-4d7c25a21353";

/** Run the CLAUDE statusline script against a glance fixture + a piped live-model stdin JSON:
 *  returns the TITLE it wrote (raw, via its TITLE_OUT test seam) and the statusline LINES it
 *  printed on stdout (the bottom pane). COLUMNS=200 so width-fitting never clips a chip. */
function claudeRun(
  glance: unknown,
  stdin: string,
): { title: string; lines: string[] } {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.cc.json`);
  const titleFile = join(
    dir,
    `${Math.random().toString(36).slice(2)}.cc.title`,
  );
  writeFileSync(fixture, JSON.stringify(glance));
  const stdout = execFileSync("bash", [STATUSLINE], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
      PAPERCUSP_STATUSLINE_TITLE_OUT: titleFile,
      PAPERCUSP_SID: SID,
      COLUMNS: "200",
    },
  });
  let title = "";
  try {
    title = readFileSync(titleFile, "utf8");
  } catch {
    title = "";
  }
  return { title, lines: stdout.split("\n").filter((l) => l.length > 0) };
}

/** The title the CLAUDE statusline writes, given a glance fixture + a piped live-model stdin. */
function claudeTitle(glance: unknown, stdin: string): string {
  return claudeRun(glance, stdin).title;
}

/** The title the OMP coord-hook pipe writes (OSC-unwrapped) for a glance — the same selector
 *  its production leg uses, under the same SID env the other two pipes run with. */
function ompTitle(glance: unknown): string {
  return selectStatusTitle(glance as Parameters<typeof selectStatusTitle>[0], SID);
}

/** Run the CODEX hook against a glance fixture: returns the TITLE it wrote (OSC-0 escape to its
 *  tty, unwrapped) AND its stdout (the tip-notice additionalContext JSON channel). The notice
 *  cursor is pointed at a per-call temp cache dir unless the caller pins one (dedup tests). */
function codexRun(
  glance: unknown,
  modelSpec: string,
  extraEnv: Record<string, string> = {},
  input = "{}",
): { title: string; stdout: string } {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.cx.json`);
  const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.cx.tty`);
  writeFileSync(fixture, JSON.stringify(glance));
  const stdout = execFileSync("bash", [OBJ_TITLE], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PAPERCUSP_OBJECTIVE_FIXTURE: fixture,
      PAPERCUSP_OBJECTIVE_TTY: ttyFile,
      PAPERCUSP_OBJECTIVE_SYNC: "1",
      PAPERCUSP_SID: SID,
      // Keep test cursor writes OUT of the real ~/.papercusp/locks-cache.
      PAPERCUSP_LOCKS_CACHE_DIR: join(
        dir,
        `cache-${Math.random().toString(36).slice(2)}`,
      ),
      ...(modelSpec ? { PAPERCUSP_MODEL: modelSpec } : {}),
      ...extraEnv,
    },
  });
  let raw = "";
  try {
    raw = readFileSync(ttyFile, "utf8");
  } catch {
    return { title: "", stdout };
  }
  // Strip the OSC-0 wrapper: ESC ] 0 ; <title> BEL.
  const m = raw.match(/\x1b\]0;([\s\S]*?)\x07/);
  return { title: m ? m[1] : "", stdout };
}

/** Run the real non-fixture path against the activity hook's shared cache. */
function codexCachedRun(
  cursor: unknown,
  extraEnv: Record<string, string> = {},
): { title: string; stdout: string } {
  const cache = join(dir, `cache-live-${Math.random().toString(36).slice(2)}`);
  const ttyFile = join(
    dir,
    `${Math.random().toString(36).slice(2)}.cached.tty`,
  );
  mkdirSync(cache, { recursive: true });
  if (typeof cursor === "string") {
    writeFileSync(join(cache, `activity-hook-bundle-${SID}.json`), cursor);
  } else if (cursor !== null) {
    writeFileSync(
      join(cache, `activity-hook-bundle-${SID}.json`),
      JSON.stringify(cursor),
    );
  }
  const stdout = execFileSync("bash", [OBJ_TITLE], {
    encoding: "utf8",
    input: "{}",
    env: {
      ...process.env,
      PAPERCUSP_OBJECTIVE_TTY: ttyFile,
      PAPERCUSP_SID: SID,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      // A network implementation would have no usable operator here; the cache
      // path must still render the full title.
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
  });
  let raw = "";
  try {
    raw = readFileSync(ttyFile, "utf8");
  } catch {
    return { title: "", stdout };
  }
  const m = raw.match(/\x1b\]0;([\s\S]*?)\x07/);
  return { title: m ? m[1] : "", stdout };
}

/** The title the CODEX/OMP hook writes, given a glance fixture + a launch model spec env. */
function codexTitle(glance: unknown, modelSpec: string): string {
  return codexRun(glance, modelSpec).title;
}

const base = {
  ok: true,
  wake: { default: "auto", stagedTotal: 0, stagedOwners: 0 },
  bees: { running: 0 },
  governor: { anyPaused: false, paused: [] },
  activity: [],
  tips: [],
};

// Model display was REMOVED from both titles 2026-07-03 (owner directive, WI-2124). We still feed a
// live-model stdin (Claude) and a launch model spec (codex/omp) that USED to render a model tag, to
// prove neither title surfaces the model any more AND that the two stay byte-identical without it.
const CC_STDIN = JSON.stringify({
  model: { display_name: "Opus 4.8 (1M context)" },
  effort: "xhigh",
});
const CODEX_SPEC = "opus[1m]:xhigh";

describe("SINGLE-SOURCE display pipe — title parity BY CONSTRUCTION (tui-status-parity 2026-07-05)", () => {
  const display = {
    title:
      "👑 windows-parity 🟦 · ⟳1m · ⏸ ✉4 · ☕2 · 2p · su-9859e · 🔭 Resume Linux release readiness",
    statusline: ["🔭 Resume Linux release readiness · ◇ su-9859e"],
    notice: null,
  };

  it("both CLIs print display.title VERBATIM — byte-identical, zero local assembly", () => {
    // A local self.objective that WOULD render differently is present — the display
    // block must win on both sides, proving the pipe (not the fallback) ran.
    const glance = {
      ...base,
      display,
      self: { objective: "LOCAL objective (must not render)" },
    };
    const cc = claudeTitle(glance, CC_STDIN);
    const cx = codexTitle(glance, CODEX_SPEC);
    expect(cc).toBe(display.title);
    expect(cx).toBe(display.title);
  });

  it("control chars in display.title are stripped IDENTICALLY on both sides (OSC safety)", () => {
    const glance = {
      ...base,
      display: { ...display, title: "safe\x1b]0;pwn\x07 title" },
    };
    const cc = claudeTitle(glance, "{}");
    const cx = codexTitle(glance, "");
    expect(cx).toBe(cc);
    expect(cc).toBe("safe]0;pwn title");
  });

  it("a display block WITHOUT a title falls back to the shared legacy render on both sides", () => {
    const glance = {
      ...base,
      display: { ...display, title: null },
      self: { objective: "fallback objective" },
    };
    const cc = claudeTitle(glance, "{}");
    const cx = codexTitle(glance, "");
    expect(cx).toBe(cc);
    expect(cc).toContain("fallback objective");
  });

  it("legacy fallback uses the native session owner when PAPERCUSP_SID has drifted", () => {
    const home = mkdtempSync(join(tmpdir(), "objective-owner-home-"));
    const owners = join(home, ".papercusp", "psu-session-owners");
    const nativeId = "0123abcd-1234-5678-9abc-def012345678";
    mkdirSync(owners, { recursive: true });
    writeFileSync(
      join(owners, nativeId),
      JSON.stringify({ v: 1, ownerId: "su-real-owner" }),
    );
    try {
      const glance = {
        ...base,
        display: { ...display, title: null },
        self: { objective: "fallback objective" },
      };
      const { title } = codexRun(
        glance,
        "",
        { HOME: home, PAPERCUSP_SID: "su-stale-owner" },
        JSON.stringify({ session_id: nativeId }),
      );
      expect(title).toContain("su-real");
      expect(title).not.toContain("su-stale");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Codex/OMP objective-title cache consumer (coord-hook-fold-load-repair P-002)", () => {
  it("renders the complete activity-bundle glance without any independent RPC implementation", () => {
    const glance = {
      ...base,
      display: {
        title: "👑 cached-fleet 🟩 · su-9859e",
        statusline: [],
        notice: null,
      },
    };
    const { title } = codexCachedRun({
      generation: "host-a:42",
      glance,
      glanceObservedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(title).toBe(glance.display.title); // stale is still a valid fail-open render

    const source = readFileSync(OBJ_TITLE, "utf8");
    expect(source).not.toContain("urllib.request.urlopen");
    expect(source).not.toContain("'params': {'name': 'coord:glance'");
  });

  it.each([
    ["missing cache", null],
    ["corrupt cache", "{not-json"],
    ["cache without a glance", { generation: "host-a:42" }],
  ])(
    "%s degrades to the bare owner title without throwing",
    (_label, cursor) => {
      const { title, stdout } = codexCachedRun(cursor);
      expect(title).toBe("su-9859e");
      expect(stdout.trim()).toBe("");
    },
  );
});

describe("Codex 💡 tip notice — PostToolUse additionalContext injection (P-003 codex leg)", () => {
  const noticeGlance = {
    ...base,
    display: {
      title: "su-9859e",
      statusline: ["◇ su-9859e"],
      notice: {
        id: "wake-mode-manual",
        text: "💡 Wake mode is manual — back to auto: coord:wake-mode mode=auto",
      },
    },
  };

  it("a NEW notice emits the PostToolUse additionalContext JSON on stdout", () => {
    const { stdout } = codexRun(noticeGlance, "");
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "papercusp-status-tip",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "Wake mode is manual",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "coord:glance for detail",
    );
  });

  it("the SAME notice is deduped by the per-session cursor (second run stays silent)", () => {
    const cache = {
      PAPERCUSP_LOCKS_CACHE_DIR: join(
        dir,
        `cache-dedup-${Math.random().toString(36).slice(2)}`,
      ),
    };
    expect(codexRun(noticeGlance, "", cache).stdout.trim()).not.toBe("");
    expect(codexRun(noticeGlance, "", cache).stdout.trim()).toBe("");
  });

  it("a CHANGED notice re-emits through the same cursor", () => {
    const cache = {
      PAPERCUSP_LOCKS_CACHE_DIR: join(
        dir,
        `cache-chg-${Math.random().toString(36).slice(2)}`,
      ),
    };
    expect(codexRun(noticeGlance, "", cache).stdout.trim()).not.toBe("");
    const changed = {
      ...base,
      display: {
        ...noticeGlance.display,
        notice: {
          id: "governor-paused",
          text: "💡 Rate governor paused — turns queue",
        },
      },
    };
    const { stdout } = codexRun(changed, "", cache);
    expect(stdout).toContain("Rate governor paused");
  });

  it("PAPERCUSP_TIP_NOTICE=0 disables the channel", () => {
    expect(
      codexRun(noticeGlance, "", { PAPERCUSP_TIP_NOTICE: "0" }).stdout.trim(),
    ).toBe("");
  });

  it("no notice → no stdout (the title leg still runs)", () => {
    const { stdout, title } = codexRun(
      { ...base, display: { title: "su-9859e", statusline: [], notice: null } },
      "",
    );
    expect(stdout.trim()).toBe("");
    expect(title).toBe("su-9859e");
  });
});

describe("Codex/OMP title ⟷ Claude statusline title PARITY (WI-1963 #3)", () => {
  it("a multi-fleet leader renders an identical title on both CLIs", () => {
    const glance = {
      ...base,
      self: {
        objective: "wire the cross-CLI title",
        loop: { active: true, intervalSec: 120, parked: false },
        fleets: [
          { slug: "roman-fleet", label: "roman", role: "leader", square: "🟪" },
          { slug: "greek-fleet", label: "greek", role: "leader", square: "🟩" },
        ],
      },
    };
    const cc = claudeTitle(glance, CC_STDIN);
    const cx = codexTitle(glance, CODEX_SPEC);
    expect(cx).toBe(cc);
    // sanity: the shared shape actually rendered (not two empty strings agreeing)
    expect(cc).toContain("👑 roman 🟪");
    expect(cc).not.toContain("opus"); // WI-2124: model no longer in the title (even with a model stdin/spec fed)
    expect(cc).not.toContain("[1m]");
    expect(cc).toContain("⟳2m");
    expect(cc).toContain("su-9859e");
  });

  it("a member fleet + no loop renders identically", () => {
    const glance = {
      ...base,
      self: {
        objective: null,
        fleets: [{ slug: "blue", label: "blue", role: "member", square: "🟦" }],
      },
    };
    expect(codexTitle(glance, CODEX_SPEC)).toBe(claudeTitle(glance, CC_STDIN));
  });

  it("no fleet / no loop / no model → identical (just the id)", () => {
    const glance = { ...base, self: { objective: null } };
    const cc = claudeTitle(glance, "{}");
    const cx = codexTitle(glance, "");
    expect(cx).toBe(cc);
    expect(cc).toBe("su-9859e");
  });

  it("objective-only renders identically (id + objective, no 🔭 in the title)", () => {
    const glance = { ...base, self: { objective: "ship the fleet UI" } };
    const cc = claudeTitle(glance, "{}");
    const cx = codexTitle(glance, "");
    expect(cx).toBe(cc);
    expect(cc).toContain("ship the fleet UI");
  });
});

describe("Codex/OMP objective-title hook — model REMOVED (WI-2124)", () => {
  it("does NOT render a model tag even when PAPERCUSP_MODEL is set", () => {
    const glance = { ...base, self: { objective: null } };
    const title = codexTitle(glance, "sonnet:medium");
    expect(title).not.toContain("sonnet");
    expect(title).not.toContain("/medium");
    expect(title).toBe("su-9859e"); // just the id — no model
  });

  it("a bare 1M family spec produces no [1m] marker in the title", () => {
    const glance = { ...base, self: { objective: null } };
    expect(codexTitle(glance, "opus[1m]")).not.toContain("[1m]");
  });

  it("no model + no glance detail still anchors the title with the id", () => {
    expect(codexTitle({ ...base, self: {} }, "")).toBe("su-9859e");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WI-1383525 — the three parity gaps DISCLOSED under pui-tui-ship-drive-2026-08-30#D-030,
// carried to CLOSED by pui-tui-next-wave-2026-09-05 P-007.
//
//   GAP 1  full three-surface parity was INFERRED: the omp coord-hook pipe was never
//          cross-compared with the cc statusline pipe. Below, every title assertion
//          runs all THREE pipes (cc statusline script, codex hook script, omp selector)
//          and compares chip SET, ORDER and TEXT — i.e. byte-identity of the ` · `-joined
//          chip row — plus a width-normalised title↔statusline check (the OS title clips
//          the objective tighter than the statusline BY DESIGN: 40 vs 48; that is the only
//          admissible difference).
//   GAP 3  the legacy fallback was never graded WHEN IT FIRES. Both fault models of the
//          server render — it THROWS (glance ships no `display`) and it returns EMPTY
//          (`display.title` blank, `statusline` []) — must leave the three pipes in
//          agreement, and the no-context caller's output is pinned exactly.
//   GAP 2  lives in status-assembler-allowlist.test.ts (consumer allowlist).
// ─────────────────────────────────────────────────────────────────────────────

/** Chip rows are ` · `-joined; compare set/order/text as the list, not the string. */
function chips(title: string): string[] {
  return title.split(" · ").map((c) => c.trim()).filter((c) => c.length > 0);
}

/** Width normalisation: drop a trailing clip ellipsis and the ◇ self-chip prefix. */
function normChip(c: string): string {
  return c.replace(/^◇\s*/u, "").replace(/…$/u, "");
}

const RICH_GLANCE = {
  ...base,
  wake: { default: "manual", stagedTotal: 4, stagedOwners: 2 },
  bees: { running: 2 },
  self: {
    objective:
      "Resume Linux release readiness across the whole desktop shipping matrix today",
    loop: { active: true, intervalSec: 120, parked: false, reachable: true },
    fleets: [
      { slug: "roman-fleet", label: "roman", role: "leader", square: "🟪" },
      { slug: "greek-fleet", label: "greek", role: "member", square: "🟩" },
    ],
  },
};

/** The three pipes' titles for one glance, in a fixed order: [cc, codex, omp]. */
function threeTitles(glance: unknown): [string, string, string] {
  return [claudeTitle(glance, CC_STDIN), codexTitle(glance, CODEX_SPEC), ompTitle(glance)];
}

describe("WI-1383525 GAP 1 — THREE-pipe title parity (cc statusline · codex hook · omp coord-hook)", () => {
  it("served display.title: all three pipes print the same chip set, order and text", () => {
    const display = {
      title:
        "👑 roman 🟪 · 👤 greek 🟩 · ⟳2m · ⏸ ✉4 · ☕2 · su-9859e · 🔭 Resume Linux release readiness across…",
      statusline: [
        "🔭 Resume Linux release readiness across the whole desk… · ◇ su-9859e · ⟳ 2m · ⏸ manual ✉4 · ☕2 · solo",
      ],
      notice: null,
    };
    const glance = { ...RICH_GLANCE, display };
    const [cc, cx, omp] = threeTitles(glance);
    expect(chips(cc)).toEqual(chips(display.title));
    expect(chips(cx)).toEqual(chips(cc));
    expect(chips(omp)).toEqual(chips(cc));
    // and byte-identity, so a whitespace/glyph drift in one pipe cannot hide behind chips()
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
  });

  it("title ↔ statusline: shared chips agree after width normalisation; the objective clip is the ONLY admissible difference", () => {
    const display = {
      title:
        "👑 roman 🟪 · ⟳2m · ⏸ ✉4 · ☕2 · su-9859e · 🔭 Resume Linux release readiness across…",
      statusline: [
        "🔭 Resume Linux release readiness across the whole desk… · ◇ su-9859e · ⟳ 2m · ⏸ manual ✉4 · ☕2 · solo",
      ],
      notice: null,
    };
    const { title, lines } = claudeRun({ ...RICH_GLANCE, display }, CC_STDIN);
    expect(lines[0]).toBe(display.statusline[0]); // the pane prints the served row verbatim
    const titleChips = chips(title).map(normChip);
    const lineChips = chips(lines[0]).map(normChip);
    // self id: identical modulo the ◇ prefix
    expect(lineChips).toContain("su-9859e");
    expect(titleChips).toContain("su-9859e");
    // ☕ bees: identical text on both surfaces
    expect(lineChips).toContain("☕2");
    expect(titleChips).toContain("☕2");
    // objective: the title's 40-clip is a PREFIX of the statusline's 48-clip (width-normalised)
    const titleObj = titleChips.find((c) => c.startsWith("🔭 "))!;
    const lineObj = lineChips.find((c) => c.startsWith("🔭 "))!;
    expect(lineObj.startsWith(titleObj)).toBe(true);
    expect([...lineObj].length).toBeGreaterThan([...titleObj].length);
  });

  it("the parity holds for the FALLBACK render too — display-less glance, all three pipes byte-identical (was: omp diverged)", () => {
    const [cc, cx, omp] = threeTitles(RICH_GLANCE);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    // sanity: the shared legacy shape actually rendered, chips in the term_title order
    expect(chips(cc)).toEqual([
      "👑 roman 🟪",
      "👤 greek 🟩",
      "⟳2m",
      "su-9859e",
      "Resume Linux release readiness across th…",
    ]);
  });

  it("a wake-unreachable loop renders the '!' suffix identically on all three fallbacks (WI-655)", () => {
    const glance = {
      ...RICH_GLANCE,
      self: { ...RICH_GLANCE.self, loop: { active: true, intervalSec: 5400, reachable: false } },
    };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    expect(chips(cc)).toContain("⟳1h30m!");
  });

  it("more than four fleets: the +N overflow and the 16-char name clip agree across the three fallbacks", () => {
    const fleets = ["alpha", "bravo", "charlie", "delta-a-very-long-fleet-name", "echo"].map(
      (label, i) => ({ slug: `${label}-fleet`, label, role: i === 0 ? "leader" : "member", square: "🟦" }),
    );
    const glance = { ...base, self: { objective: null, fleets } };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    expect(cc).toContain("👑 alpha 🟦");
    expect(cc).toContain("delta-a-very-lo… 🟦 +1");
    expect(cc).not.toContain("echo");
  });
});

describe("WI-1383525 GAP 3 — the fallback graded WHEN IT FIRES (render throws / render returns empty)", () => {
  it("render THROWS → glance ships no display block → the three pipes still agree", () => {
    // glance.ts (GAP 3 server half) turns a render throw into display:null + displayError.
    const glance = { ...RICH_GLANCE, display: null, displayError: "injected render fault" };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    expect(cc).not.toBe("");
    expect(cc).toContain("👑 roman 🟪");
    expect(cc).toContain("su-9859e");
  });

  it("render returns EMPTY (title '', statusline []) → every pipe treats it as absent → three-way agreement", () => {
    const glance = { ...RICH_GLANCE, display: { title: "", statusline: [], notice: null } };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    expect(cc).toContain("⟳2m");
    // the cc statusline body falls back to its legacy two-line render, never a blank pane
    const { lines } = claudeRun(glance, CC_STDIN);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("◇ su-9859e");
  });

  it("the NO-CONTEXT caller (no fleet / loop / objective / display) is pinned: exactly the short id, on all three pipes", () => {
    const glance = { ...base, self: {} };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cc).toBe("su-9859e");
    expect(cx).toBe("su-9859e");
    expect(omp).toBe("su-9859e");
  });

  it("control chars in a FALLBACK objective are stripped identically on all three pipes (OSC safety)", () => {
    const glance = { ...base, self: { objective: "safe\x1b]0;pwn\x07 title" } };
    const [cc, cx, omp] = threeTitles(glance);
    expect(cx).toBe(cc);
    expect(omp).toBe(cc);
    expect(cc).toBe("su-9859e · safe]0;pwn title");
  });
});
