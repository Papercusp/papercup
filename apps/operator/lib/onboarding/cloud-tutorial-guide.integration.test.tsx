// @vitest-environment jsdom
import { StrictMode, useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/app/harness/Button";
import { createTutorialState, tutorialReducer, type ProductObservation } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { CloudTutorialGuide, CloudTutorialHelpEntry } from "./cloud-tutorial-guide";

const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
let systemReducedMotion = false;
vi.mock("motion/react", async importOriginal => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => systemReducedMotion,
}));
beforeEach(() => {
  systemReducedMotion = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function Fixture({ observation = { scope, revision: 1, access: "allowed" } as ProductObservation, target = true, check = vi.fn(), reducedMotion = true }) {
  const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), { type: "observe", observation }));
  return <>
    <Button>App launcher</Button>
    {target && <label>Real connection label<input data-tutorial-target="cloud-connection" /></label>}
    <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion={reducedMotion} onCheckAgain={check} />
  </>;
}
describe("Persistent nonmodal Cloud Guide", () => {
  it("mounts the replay action only after opening the accessible Help disclosure", () => {
    const onStart = vi.fn();
    render(<CloudTutorialHelpEntry onStart={onStart} />);
    const help = screen.getByRole("button", { name: "Help" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Get your first agent running" })).toBeNull();
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
  it("honors the system reduced-motion preference even when a caller does not request reduced motion", async () => {
    systemReducedMotion = true;
    render(<Fixture reducedMotion={false} />);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: "instant", block: "center" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Real connection label" }));
  });
  it("keeps focus on the replacement controls when pause and resume remove the clicked button", async () => {
    render(<Fixture />);
    const pause = screen.getByRole("button", { name: "Pause" }); pause.focus(); fireEvent.click(pause);
    const resume = screen.getByRole("button", { name: "Resume guide" });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    fireEvent.click(resume);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show me" })));
  });
  it("explains and highlights the current action while preserving keyboard and product input", async () => {
    render(<StrictMode><Fixture /></StrictMode>);
    expect(screen.getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByText(/Credentials stay in the product connection form/)).toBeTruthy();
    expect(screen.getByText(/Contextual help is unavailable/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    const input = screen.getByRole("textbox", { name: "Real connection label" });
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(document.activeElement).toBe(input);
    expect(fireEvent.keyDown(input, { key: "Tab", cancelable: true })).toBe(true);
    fireEvent.change(input, { target: { value: "My GCP project" } });
    expect(input).toHaveProperty("value", "My GCP project");
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
    expect(getComputedStyle(document.querySelector(".react-joyride__overlay path")!).pointerEvents).toBe("none");
  });
  it("pauses, resumes, skips, restarts and opens from Help without losing the domain position", async () => {
    render(<Fixture observation={{ scope, revision: 1, access: "allowed", connection: { id: "gcp", provider: "gcp", validated: true } }} />);
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Your lesson is paused.")).toBeTruthy();
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume guide" }));
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip lesson" }));
    expect(screen.getByText(/You can start this lesson again from Help/)).toBeTruthy();
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(screen.getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByText("Already completed in this workspace.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next explanation" }));
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    expect(screen.getByText("1 of 6 steps confirmed")).toBeTruthy();
  });
  it("leaves missing targets recoverable and Check again never invokes a product action", async () => {
    const check = vi.fn();
    render(<Fixture target={false} check={check} />);
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(screen.getByRole("status").textContent).toMatch(/not visible/);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
  });
  it("renders actionable failure/delay recovery while keeping deterministic controls available", () => {
    render(<Fixture observation={{ scope, revision: 1, access: "allowed", attempt: { step: "connection", status: "failed" } }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/needs attention/);
    expect(screen.getByText(/Review the connection’s validation details/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close guide" })).toBeTruthy();
  });
  it("Show me focuses a control mounted by the user’s navigation request", async () => {
    function LateTarget() {
      const [mounted, setMounted] = useState(false);
      const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), { type: "observe", observation: { scope, revision: 1, access: "allowed" } }));
      return <>{mounted && <input aria-label="Navigated product control" data-tutorial-target="cloud-connection" />}
        <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion onShowStep={() => setMounted(true)} /></>;
    }
    render(<LateTarget />);
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Navigated product control" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByRole("region", { name: "First agent guide" })).toBeTruthy();
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
  });
  it("restores entry focus and removes overlays on exit; Help can reopen the lesson", async () => {
    const trigger = document.createElement("button"); trigger.textContent = "Entry focus"; document.body.append(trigger); trigger.focus();
    const view = render(<Fixture />);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close guide" }));
    expect(document.querySelector("[data-cloud-tutorial-guide]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    await waitFor(() => expect(document.querySelectorAll(".react-joyride__overlay")).toHaveLength(1));
    await act(async () => view.unmount()); trigger.remove();
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  });
});
