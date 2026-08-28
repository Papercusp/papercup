// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Select } from "./Select";

const harnessCss = readFileSync("app/harness/harness.css", "utf8");

afterEach(cleanup);

describe("Select", () => {
  it("gives the default trigger a visible keyboard-focus hook without suppressing its outline inline", () => {
    render(
      <Select
        value="one"
        onChange={vi.fn()}
        ariaLabel="Focus-visible select"
        options={[{ value: "one", label: "One" }]}
      />,
    );

    const trigger = screen.getByRole("combobox", {
      name: "Focus-visible select",
    });
    expect(trigger.className).toBe("h-select-trigger");
    expect((trigger as HTMLButtonElement).style.outline).toBe("");
    expect(harnessCss).toMatch(
      /\.h-select-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*2px;/s,
    );
  });

  it("preserves a caller-owned trigger class and styling surface", () => {
    render(
      <Select
        value="one"
        onChange={vi.fn()}
        ariaLabel="Custom select"
        triggerClassName="custom-trigger"
        options={[{ value: "one", label: "One" }]}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Custom select" });
    expect(trigger.className).toBe("custom-trigger");
    expect(trigger.getAttribute("style")).toBeNull();
  });
});
