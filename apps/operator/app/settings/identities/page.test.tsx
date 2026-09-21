// @vitest-environment jsdom
/** Render/action coverage for Settings → Identities (identities-v1 P-011). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";

const H = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  queryKeys: new Set<string>(),
  initialQuery: new Map<string, string>(),
  sync: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.sync.get(queryName),
  useSyncMutate: () => H.mutate,
}));

vi.mock("sonner", () => ({ toast: H.toast }));

vi.mock("nuqs", () => ({
  parseAsString: { withDefault: (defaultValue: string) => ({ defaultValue }) },
  parseAsStringEnum: () => ({
    withDefault: (defaultValue: string) => ({ defaultValue }),
  }),
  useQueryState: (key: string, parser?: { defaultValue?: string }) => {
    H.queryKeys.add(key);
    return useState(H.initialQuery.get(key) ?? parser?.defaultValue ?? "");
  },
}));

vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {String(option.label)}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("@papercusp/grid-core", () => ({
  RichGrid: ({
    rows,
  }: {
    rows: Array<{ field: string; applied: unknown; selected: unknown }>;
  }) => (
    <table aria-label="Revision diff">
      <tbody>
        {rows.map((row) => (
          <tr key={row.field}>
            <td>{row.field}</td>
            <td>{String(row.applied)}</td>
            <td>{String(row.selected)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

import IdentitySettingsPage from "./page";

const identity = {
  id: "research-steward",
  sourceId: "research-steward",
  tier: "built-in",
  version: "0.1.0",
  description: "Research and documentation stewardship",
  slots: [{ slot: "domain", cardinality: "exclusive" as const }],
  sourcePath: "/blueprints/research-steward/blueprint.yaml",
};

const revision = (char: string) => ({
  specificationRevision: char.repeat(64),
  stateRevision: `state-${char}`,
});

function surface(
  status: "desired" | "prepared" | "applied" | "failed" = "applied",
) {
  const desired = revision("d");
  const applied = revision("a");
  return {
    identities: [identity],
    unreadable: [],
    session: {
      ownerId: "su-target",
      agent: "codex",
      principalId: "human-1",
      harnessSlug: "papercusp",
      explicitStack: ["domain:research-steward"],
      effectiveStack: ["domain:research-steward"],
      appliedStack:
        status === "applied"
          ? ["domain:research-steward"]
          : ["domain:papercusp-engineer"],
      specificationRevision: desired.specificationRevision,
      stateRevision: desired.stateRevision,
      activation: {
        desired,
        prepared: status === "prepared" ? desired : null,
        applied,
        status,
        ...(status === "failed" ? { failure: "host rejected the render" } : {}),
      },
      artifact: {
        provenance: [
          {
            path: "configuration.roles[0]",
            sourceRef: "identity:research-steward",
          },
        ],
      },
      appliedArtifact: { provenance: [] },
      history: [
        {
          ...applied,
          stack: ["domain:papercusp-engineer"],
          recordedAt: "2026-09-09T00:00:00Z",
        },
      ],
    },
    transitions: [],
    bindings: {
      available: false as const,
      milestone: "M3" as const,
      message:
        "Provider bindings arrive in M3. Existing pot bindings remain unchanged.",
    },
  };
}

function mutation(action: string = "preview") {
  return {
    ok: true,
    changed: true,
    action,
    delivery: "relaunch-with-carry",
    stack: ["domain:research-steward"],
    replaced: "papercusp-engineer",
    ...revision("d"),
    diff: [
      {
        field: "configuration.domain",
        applied: "engineering",
        selected: "research",
        origin: "identity:research-steward",
      },
    ],
    activation: surface("desired").session.activation,
    nudge: { queued: false, reason: null },
  };
}

function seed(
  status: "desired" | "prepared" | "applied" | "failed" = "applied",
) {
  H.sync.set("advRoster.list", {
    data: [
      {
        active: [
          {
            ownerId: "su-target",
            label: "Research agent",
            sessionState: "live",
          },
        ],
      },
    ],
    loading: false,
    error: null,
  });
  H.sync.set("identities.surface", {
    data: [surface(status)],
    loading: false,
    error: null,
    invalidate: H.invalidate,
  });
  H.mutate.mockImplementation(async (args: { action: string }) =>
    mutation(args.action),
  );
}

beforeEach(() => {
  H.mutate.mockReset();
  H.invalidate.mockReset();
  H.toast.mockClear();
  H.toast.success.mockReset();
  H.toast.error.mockReset();
  H.queryKeys.clear();
  H.initialQuery.clear();
  H.sync.clear();
  seed();
});

afterEach(cleanup);

describe("IdentitySettingsPage", () => {
  it("renders the installed library and labels only the host-acknowledged identity Applied", () => {
    render(<IdentitySettingsPage />);

    expect(screen.getByRole("heading", { name: "Identities" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Inspect identity research-steward" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Applied")).toHaveLength(2);
    expect(H.queryKeys).toEqual(
      new Set([
        "identityTab",
        "identitySearch",
        "identitySlot",
        "identityId",
        "identityAgent",
        "identityDelivery",
      ]),
    );
  });

  it("previews the selected identity, opens Current agent, and renders the revision diff before apply", async () => {
    render(<IdentitySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Review switch" }));

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        ownerId: "su-target",
        action: "preview",
        identityId: "research-steward",
        slot: "domain",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Revision diff" })).toBeTruthy(),
    );
    expect(screen.getByText("configuration.domain")).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Delivery" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", {
          name: "Fresh context — relaunch with carried work.",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("applies an exclusive slot as switch only after the review is present", async () => {
    render(<IdentitySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Review switch" }));
    const apply = await screen.findByRole("button", { name: "Apply identity" });
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(apply);

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        ownerId: "su-target",
        action: "switch",
        identityId: "research-steward",
        slot: "domain",
      }),
    );
    await waitFor(() => expect(H.invalidate).toHaveBeenCalled());
  });

  it("shows the immediate desired activation returned by a mutation before the query refreshes", async () => {
    render(<IdentitySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Review switch" }));
    const apply = await screen.findByRole("button", { name: "Apply identity" });
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(apply);

    await waitFor(() =>
      expect(screen.getByText(/Change requested\./)).toBeTruthy(),
    );
    expect(
      screen.getByText("The currently applied identity remains active."),
    ).toBeTruthy();
  });

  it.each([
    [
      "desired",
      "Change requested",
      "The currently applied identity remains active.",
    ],
    [
      "prepared",
      "Validated; waiting for host acknowledgement",
      "The prior identity remains active",
    ],
    ["failed", "The change failed", "host rejected the render"],
  ] as const)(
    "renders honest %s activation truth without an Applied badge",
    (status, title, detail) => {
      seed(status);
      H.initialQuery.set("identityTab", "agent");
      render(<IdentitySettingsPage />);

      expect(screen.getByText(new RegExp(title))).toBeTruthy();
      expect(screen.getByText(new RegExp(detail))).toBeTruthy();
      expect(screen.queryByText("Applied")).toBeNull();
    },
  );

  it("rolls back to the previous validated receipt", async () => {
    H.initialQuery.set("identityTab", "agent");
    render(<IdentitySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Roll back identity" }));
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        ownerId: "su-target",
        action: "rollback",
      }),
    );
  });

  it("states that provider bindings are unavailable until M3 and exposes no fake rebind action", () => {
    H.initialQuery.set("identityTab", "bindings");
    render(<IdentitySettingsPage />);
    expect(screen.getByText("Available in M3.")).toBeTruthy();
    expect(
      screen.getByText(/Existing pot bindings remain unchanged/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /rebind/i })).toBeNull();
  });

  it("surfaces read failure and wires retry to the sync invalidation", () => {
    H.sync.set("identities.surface", {
      data: [],
      loading: false,
      error: new Error("sync down"),
      invalidate: H.invalidate,
    });
    render(<IdentitySettingsPage />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Identities could not be read",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(H.invalidate).toHaveBeenCalled();
  });
});
