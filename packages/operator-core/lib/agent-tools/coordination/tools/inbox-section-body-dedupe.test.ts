/**
 * coord:inbox — P-006 (oversized-tool-results-reduction-2026-10-12): a bounded read
 * keeps ONE copy of a sectioned message's prose.
 *
 * WHY THIS EXISTS. `body` is the flattened projection of `sections[].text`
 * (message-fields.ts joins the texts with a blank line), and `boundInboxEntries`
 * caps `body` and the combined section text separately. A sectioned message, the
 * normal shape since coord:send refuses a plain-string body, therefore spent the
 * per-entry budget twice on identical prose. Measured on 67 real coord:inbox
 * spills: 46 of the 63 entries carrying both fields had duplicated text.
 *
 * FALSIFIABILITY. `noDedupe` below is the pre-fix behaviour (identity). The
 * `control` block asserts the single-copy pin FAILS against it, so a refactor that
 * silently stops deduplicating cannot keep every test here green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity")>()),
  resolveAgentIdentity: (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
}));
vi.mock("../actor-identity", () => ({
  resolveActorIdentity: async (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
  actorMailboxKeys: () => [] as string[],
}));
vi.mock("../messages", () => ({
  readInbox: M.readInbox,
  drainAndDeliverUserMailbox: vi.fn(async () => {}),
}));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: vi.fn(async () => null),
}));
vi.mock("../watermarks", () => ({
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => {}),
}));
vi.mock("@papercusp/coordination/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/coordination/core")>()),
  emptyWatermark: () => ({ messages_shown_ts: "" }),
  COORD_EXECUTABLE_KINDS: ["yield", "handoff", "ack"],
  COORD_CONVERSATIONAL_KINDS: ["message", "notify"],
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({}),
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: async () => null,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));
vi.mock("../../../cache", () => ({
  cachedRead: async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { authoredFieldsMarker } from "../message-fields";
import tool, { boundInboxEntries, dropSectionTextDuplicatedInBody } from "./inbox";

type Row = Record<string, unknown>;

const sectioned = (texts: string[], structure: Array<Row | undefined> = []): Row => ({
  msg_id: "m-1",
  ts: "2026-10-13T05:00:00.000Z",
  from: "peer",
  to: ["owner-a"],
  kind: "message",
  summary: "short summary",
  body: texts.join("\n\n"),
  sections: texts.map((text, i) => ({ text, ...(structure[i] ?? {}) })),
});

/** Characters of message prose a row carries across `body` and `sections[].text`. */
const proseChars = (row: Row): number => {
  const body = typeof row["body"] === "string" ? (row["body"] as string).length : 0;
  const sections = Array.isArray(row["sections"]) ? (row["sections"] as Row[]) : [];
  return body + sections.reduce((n, s) => n + (typeof s["text"] === "string" ? (s["text"] as string).length : 0), 0);
};

/** The single-copy pin, shared by the subject and the control. */
const expectSingleCopy = (dedupe: (rows: Row[]) => Row[]) => {
  const texts = ["context ".repeat(30), "Please take the next step."];
  const [row] = boundInboxEntries(dedupe([sectioned(texts, [undefined, { forYouBecause: { relation: "owns" } }])]), 120);
  expect(proseChars(row!)).toBeLessThanOrEqual(120);
};

const noDedupe = (rows: Row[]): Row[] => rows;

describe("dropSectionTextDuplicatedInBody", () => {
  it("keeps body, strips duplicated section text, and preserves structural keys", () => {
    const fyb = { relation: "owns", ref: "EI-1" };
    const premises = ["session_turn:x:1"];
    const entry = sectioned(["first part", "the ask"], [{ premises }, { forYouBecause: fyb }]);
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(row!["body"]).toBe("first part\n\nthe ask");
    expect(row!["sections"]).toEqual([{ premises }, { forYouBecause: fyb }]);
    expect(row!["sections_text_in_body"]).toBe(true);
    expect(row!["summary"]).toBe("short summary");
  });

  it("keeps an empty placeholder so a kept array stays index-aligned with the body paragraphs", () => {
    const [row] = dropSectionTextDuplicatedInBody([sectioned(["a", "b", "c"], [undefined, { premises: ["p"] }])]);
    expect(row!["sections"]).toEqual([{}, { premises: ["p"] }, {}]);
  });

  it("drops the sections array when no section carries anything beyond its text", () => {
    const [row] = dropSectionTextDuplicatedInBody([sectioned(["only text", "more text"])]);
    expect(row).not.toHaveProperty("sections");
    expect(row).not.toHaveProperty("sections_text_in_body");
    expect(row!["body"]).toBe("only text\n\nmore text");
  });

  it("leaves an entry untouched when body is not exactly the joined section text", () => {
    const entry = { ...sectioned(["a", "b"]), body: "a\nb" };
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(row).toBe(entry);
  });

  it("leaves malformed or absent sections untouched", () => {
    const nonString = { body: "x", sections: [{ text: 42 }] };
    const nonObject = { body: "x", sections: ["x"] };
    const none = { body: "x" };
    const noBody = { sections: [{ text: "x" }] };
    const empty = { body: "", sections: [] };
    const rows = [nonString, nonObject, none, noBody, empty];
    const out = dropSectionTextDuplicatedInBody(rows);
    out.forEach((row, i) => expect(row).toBe(rows[i]));
  });

  it("does not change the authored marker", () => {
    const entry = sectioned(
      ["claim", "ask"],
      [{ premises: ["session_turn:x:1"], couldNotDetermine: [{ what: "y" }] }, { forYouBecause: { relation: "owns" } }],
    );
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(authoredFieldsMarker(row)).toBe(authoredFieldsMarker(entry));
    expect(authoredFieldsMarker(row)).toBeTruthy();
  });

  it("halves the bounded prose of a duplicated message", () => {
    expectSingleCopy(dropSectionTextDuplicatedInBody);
  });
});

describe("control: the pre-fix behaviour fails the single-copy pin", () => {
  it("keeping both copies spends the cap twice", () => {
    expect(() => expectSingleCopy(noDedupe)).toThrow();
  });
});

describe("coord:inbox handler wiring", () => {
  const ctx = (): never =>
    ({ ownerId: "owner-a", workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;
  const callInbox = async (args: Row = {}) => {
    const res = (await tool.handler(args as never, ctx())) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text) as { entries: Row[] };
  };

  beforeEach(() => {
    M.readInbox.mockReset();
    M.readInbox.mockResolvedValue([
      sectioned(["background", "the ask"], [undefined, { forYouBecause: { relation: "owns" } }]),
    ]);
  });

  it("a bounded read returns one copy of the prose", async () => {
    const out = await callInbox({ max_body_chars: 300 });
    const row = out.entries.find((e) => e["msg_id"] === "m-1")!;
    expect(row["body"]).toBe("background\n\nthe ask");
    expect(row["sections"]).toEqual([{}, { forYouBecause: { relation: "owns" } }]);
    expect(row["sections_text_in_body"]).toBe(true);
  });

  it("an unbounded read (max_body_chars: 0) keeps the sections whole", async () => {
    const out = await callInbox({ max_body_chars: 0 });
    const row = out.entries.find((e) => e["msg_id"] === "m-1")!;
    expect((row["sections"] as Row[]).map((s) => s["text"])).toEqual(["background", "the ask"]);
    expect(row).not.toHaveProperty("sections_text_in_body");
  });
});
