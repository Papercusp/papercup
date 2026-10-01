// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import Joyride from "react-joyride";
import { Button } from "@/app/harness/Button";
import { Modal } from "@/app/harness/Modal";
import { CloudTutorialHighlight } from "./cloud-tutorial-adapter";

// The alternative stays test-only. The production adapter has one engine.
function JoyrideCandidate({ target, active }: { target: string; active: boolean }) {
  return <Joyride run={active} stepIndex={0} steps={[{
    target, content: "Use the real app control", skipBeacon: true,
    disableFocusTrap: true, blockTargetInteraction: false, skipScroll: true,
    targetWaitTimeout: 2000,
  }]} options={{ dismissKeyAction: false, overlayClickAction: false, scrollDuration: 0 }} />;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["driver", "joyride"] as const)("%s on the maintained React/TanStack controls", (candidate) => {
  function Fixture() {
    const [active, setActive] = useState(true);
    const [late, setLate] = useState(false);
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState(false);
    const [target, setTarget] = useState("[data-tutorial-target='late']");
    const [status, setStatus] = useState("");
    return <>
      <Button onClick={() => setLate(true)}>Mount target</Button>
      <Button onClick={() => setActive(false)}>Exit guide</Button>
      <Button onClick={() => { setOpen(true); setTarget("[data-tutorial-target='dialog']"); }}>Open app dialog</Button>
      {late && <label>Workspace name<input data-tutorial-target="late" /></label>}
      <Modal title="Workspace configuration" open={open} onOpenChange={setOpen}>
        <label>Machine size<input data-tutorial-target="dialog" /></label>
        <Button onClick={() => setSaved(true)}>Save configuration</Button>
      </Modal>
      {saved && <p>Saved by product action</p>}
      <p role="status">{status}</p>
      {candidate === "driver" ? <CloudTutorialHighlight target={target} active={active} contextKey="cloud" reducedMotion onStatus={setStatus} /> : <JoyrideCandidate target={target} active={active} />}
    </>;
  }
  function mount() {
    const root = createRootRoute({ component: () => <main><Outlet /></main> });
    const cloud = createRoute({ getParentRoute: () => root, path: "/cloud", component: Fixture });
    const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <h1>Other app view</h1> });
    const router = createRouter({ routeTree: root.addChildren([cloud, other]), history: createMemoryHistory({ initialEntries: ["/cloud"] }) });
    const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    return { ...view, router };
  }
  it("observes a late target without operating the product form, then permits user input", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Mount target" }));
    const input = await screen.findByRole("textbox", { name: "Workspace name" });
    await waitFor(() => expect(document.querySelector(candidate === "driver" ? ".driver-active-element" : "[data-testid='spotlight']")).not.toBeNull());
    input.focus();
    fireEvent.change(input, { target: { value: "my workspace" } });
    expect(input).toHaveProperty("value", "my workspace");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText("Saved by product action")).toBeNull();
  });
  it("keeps the real nested dialog operable and cleans overlays on route exit", async () => {
    const { router } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open app dialog" }));
    const input = await screen.findByRole("textbox", { name: "Machine size" });
    input.focus();
    fireEvent.change(input, { target: { value: "small" } });
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Saved by product action")).toBeTruthy();
    await act(async () => { await router.navigate({ to: "/other" }); });
    expect(await screen.findByRole("heading", { name: "Other app view" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".driver-overlay, .react-joyride__overlay")).toBeNull());
    expect(document.body.classList.contains("driver-active")).toBe(false);
  });
});
