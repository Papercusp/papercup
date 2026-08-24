// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  fetch: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("@/app/adv/sessions/use-su-launch-options", () => ({
  useSuLaunchOptions: () => ({
    fleets: [],
    nextScheme: null,
    schemes: [],
    accounts: [{ id: "pool-a", label: "Pool A" }],
    ompCatalog: {
      status: "available",
      availability: "enabled-configured",
      credentials: "unchecked",
      upstream: "unchecked",
      models: [],
      error: null,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/app/harness/Popover", () => ({
  Popover: ({
    open,
    onOpenChange,
    trigger,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      <span onClick={() => onOpenChange(!open)}>{trigger}</span>
      {open ? <div data-testid="settings-popover">{children}</div> : null}
    </>
  ),
}));

vi.mock("@/app/harness/Combobox", () => ({
  flattenComboboxEntries: (entries: Array<Record<string, unknown>>) =>
    entries.flatMap((entry) =>
      entry.kind === "group" ? (entry.options as unknown[]) : [entry],
    ),
  Combobox: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{
      value?: string;
      label?: string;
      kind?: string;
      options?: Array<{ value: string; label: string }>;
    }>;
    ariaLabel: string;
    disabled?: boolean;
  }) => {
    const flat = options.flatMap((entry) =>
      entry.kind === "group" ? (entry.options ?? []) : [entry],
    );
    return (
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {flat.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  },
}));

import BulkResolverSettingsControl, {
  formatResolverLaunchReceipt,
} from "./BulkResolverSettingsControl";
import { useBulkResolverSettings } from "./bulk-resolver-settings";
import type { BulkResolverSettingsState } from "./bulk-resolver-settings";

beforeEach(() => {
  H.fetch.mockReset();
  H.updateProfile.mockReset();
  vi.stubGlobal("fetch", H.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resolver profile persistence", () => {
  it("loads one pane and PATCHes only that pane profile through the merge surface", async () => {
    H.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            resolverProfiles: {
              "inbox-resolve": {
                model: null,
                effort: null,
                account: "default",
                carry: "warm",
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { result } = renderHook(() =>
      useBulkResolverSettings("inbox-resolve"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.updateProfile({
        model: "sonnet",
        effort: "high",
        account: "auto",
        carry: "cold",
      });
    });
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(2));
    expect(H.fetch.mock.calls[1][0]).toBe("/api/agent-config");
    expect(H.fetch.mock.calls[1][1].method).toBe("PATCH");
    expect(JSON.parse(H.fetch.mock.calls[1][1].body)).toEqual({
      resolverProfiles: {
        "inbox-resolve": {
          model: "sonnet",
          effort: "high",
          account: "auto",
          carry: "cold",
        },
      },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe("BulkResolverSettingsControl", () => {
  const settings = (
    over: Partial<BulkResolverSettingsState> = {},
  ): BulkResolverSettingsState => ({
    profile: { model: null, effort: null, account: "default", carry: "warm" },
    loading: false,
    saving: false,
    error: null,
    validationError: null,
    ready: true,
    updateProfile: H.updateProfile,
    retry: vi.fn(),
    ...over,
  });

  it("renders the exact immutable launch receipt for a running run", () => {
    render(
      <BulkResolverSettingsControl
        kind="plan-cleanup"
        settings={settings()}
        effective={{
          model: "sol",
          effort: "xhigh",
          backend: "codex",
          account: "pool-a",
          carry: "cold",
        }}
      />,
    );
    expect(
      screen.getByTestId("plan-cleanup-launch-receipt").textContent,
    ).toContain("sol:xhigh · codex · pool-a · cold");
  });

  it("edits the next-run profile and resets effort when the model changes", () => {
    render(
      <BulkResolverSettingsControl
        kind="inbox-resolve"
        settings={settings({
          profile: {
            model: "sonnet",
            effort: "high",
            account: "default",
            carry: "warm",
          },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("inbox-resolve-settings-trigger"));
    fireEvent.change(screen.getByLabelText("Inbox resolver model"), {
      target: { value: "sol" },
    });
    expect(H.updateProfile).toHaveBeenCalledWith({
      model: "sol",
      effort: null,
      account: "default",
      carry: "warm",
    });
  });

  it("renders the canonical stale diagnostic and exposes the restart action", () => {
    const onRestart = vi.fn();
    render(
      <BulkResolverSettingsControl
        kind="inbox-resolve"
        settings={settings()}
        effective={{ account: "default", carry: "warm" }}
        liveness={{ state: "stale", measuredFrom: "start", ageMs: 360_000 }}
        onRestart={onRestart}
      />,
    );
    expect(screen.getByTestId("inbox-resolve-resolver-stale").textContent).toContain(
      "never reported after launch",
    );
    fireEvent.click(screen.getByTestId("inbox-resolve-restart"));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("names legacy rows instead of inventing settings they never recorded", () => {
    expect(formatResolverLaunchReceipt({})).toBe(
      "Launch settings not recorded (legacy run)",
    );
  });
});
