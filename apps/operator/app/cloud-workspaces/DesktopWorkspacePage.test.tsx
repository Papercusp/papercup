// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

const H = vi.hoisted(() => ({
  rows: [] as WorkspaceHostControlRow[],
  params: {} as Record<string, unknown>,
  updates: [] as Array<[string, unknown]>,
  loading: false,
  error: null as Error | null,
  invalidate: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({ data: H.rows, loading: H.loading, error: H.error, invalidate: H.invalidate }),
  useSyncMutate: () => vi.fn(),
}));
vi.mock("nuqs", async () => {
  const React = await import("react");
  const parser = (defaultValue: unknown = null): any => ({
    defaultValue,
    withDefault: (value: unknown) => parser(value),
    withOptions: () => parser(defaultValue),
  });
  return {
    parseAsString: parser(),
    parseAsStringEnum: () => parser(),
    useQueryState: (key: string, config?: { defaultValue?: unknown }) => {
      const [value, setValue] = React.useState(H.params[key] ?? config?.defaultValue ?? null);
      return [value, (next: unknown) => {
        H.updates.push([key, next]);
        setValue(next);
        return Promise.resolve(next);
      }];
    },
  };
});
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, options, onChange, ariaLabel }: {
    value: string; options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void; ariaLabel: string;
  }) => <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock("@/app/harness/Tooltip", () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

// Exercise the registry the real portal mounts, not a hand-selected viewer component.
import { OPERATOR_SURFACES } from "@papercusp/operator-ui/surfaces";

function workspace(id: string, observedState: WorkspaceHostControlRow["observedState"] = "running"): WorkspaceHostControlRow {
  return {
    kind: "workspace", id, name: id, connectionId: "gcp", target: "gcp",
    scopeLabel: "project", region: "us-central1", size: "small", image: "linux",
    diskGiB: 40, network: "private", desiredState: observedState, observedState,
    recoverability: { kind: "none", label: "No snapshot" },
    capabilities: { start: false, stop: false, repair: false, snapshot: false, destroy: false },
  };
}

function openDesktops() {
  const Desktops = OPERATOR_SURFACES.desktops;
  return render(<Suspense fallback={<p>Loading surface</p>}><Desktops /></Suspense>);
}

afterEach(cleanup);
beforeEach(() => {
  H.rows = [workspace("Old workspace", "absent"), workspace("Research workspace")];
  H.params = { app: "desktops", step: "operate", tab: "desktops" };
  H.updates = [];
  H.loading = false;
  H.error = null;
});

describe("portal Desktops entry — approved option B", () => {
  it("opens the desktop composition without expanding a cloud-host row", async () => {
    openDesktops();
    expect(await screen.findByRole("region", { name: "Desktops for Research workspace" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Managed workspace hosts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Cloud Workspaces" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Workspace desktops and activity" })).toBeTruthy();
    expect(screen.getByText("Your desktop is not ready yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("honors an explicit workspace and records workspace switches in URL state", async () => {
    H.rows.push(workspace("Budget workspace"));
    H.params.desktopHost = "Budget workspace";
    openDesktops();
    expect(await screen.findByRole("region", { name: "Desktops for Budget workspace" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Desktop workspace" }), { target: { value: "Research workspace" } });
    expect(await screen.findByRole("region", { name: "Desktops for Research workspace" })).toBeTruthy();
    expect(H.updates).toContainEqual(["desktopHost", "Research workspace"]);
  });

  it("does not silently open a different workspace for an invalid deep link", async () => {
    H.params.desktopHost = "missing-host";
    openDesktops();
    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Desktops for Research workspace" })).toBeNull();
  });

  it("keeps an honest empty destination when no active workspace exists", async () => {
    H.rows = [workspace("Removed workspace", "absent")];
    openDesktops();
    expect(await screen.findByText("No desktop workspaces yet")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Managed workspace hosts" })).toBeNull();
  });
});
