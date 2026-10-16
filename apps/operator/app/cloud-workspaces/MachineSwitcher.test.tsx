// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import MachineSwitcher, { MachineSwitcherView } from "./MachineSwitcher";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

const query = vi.hoisted(() => vi.fn());
vi.mock("@papercusp/sync", () => ({ useSyncQuery: query }));
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, options, onChange, ariaLabel, disabled, placeholder }: {
    value: string; options: { value: string; label: string }[];
    onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; placeholder?: string;
  }) => <select aria-label={ariaLabel} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value)}>
    <option value="">{placeholder}</option>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const rows = [
  { kind: "workspace", id: "a", name: "Home desktop", observedState: "running" },
  { kind: "workspace", id: "b", name: "Laptop", observedState: "stopped" },
] as WorkspaceHostControlRow[];

describe("persistent machine selection", () => {
  it("uses the authorized inventory, shows availability and leaves missing selections explicit", () => {
    const onSelect = vi.fn();
    render(<MachineSwitcherView localMode={false} value="removed" rows={rows}
      loading={false} error={null} onSelect={onSelect} />);
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("removed");
    expect(screen.getByRole("option", { name: "Machine unavailable" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Laptop — stopped" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "This computer" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("keeps a new hosted account inert until it has an authorized workspace", () => {
    render(<MachineSwitcher localMode={false} workspaceSelected={false} />);
    expect(screen.getByRole("status").textContent).toContain("Choose a workspace");
    expect(query).not.toHaveBeenCalled();
  });

  it("does not claim a machine is connected when no inventory exists", () => {
    render(<MachineSwitcherView localMode={false} value={null} rows={[]}
      loading={false} error={null} onSelect={vi.fn()} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("link", { name: "Connect a machine" }).getAttribute("href")).toBe("/cloud-workspaces?step=connect");
  });

  it("clears old machine desktop state only in the selecting window", async () => {
    query.mockReturnValue({ data: rows, loading: false, error: null });
    const update = vi.fn();
    const onSelect = vi.fn();
    render(<MachineSwitcher onSelect={onSelect} />, { wrapper: withNuqsTestingAdapter({
      searchParams: "?ws=own&desktopHost=a&host=a&desktop=watch:old&desktopPins=old&desktopFilter=old",
      onUrlUpdate: update,
    }) });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("b"));
    const params = update.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("desktopHost")).toBe("b");
    expect(params.get("host")).toBe("b");
    expect(params.get("ws")).toBe("own");
    expect(params.has("desktop")).toBe(false);
    expect(params.has("desktopPins")).toBe(false);
    expect(params.has("desktopFilter")).toBe(false);
  });
});
