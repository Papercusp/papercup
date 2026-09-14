import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OperatorSettingsSlot,
  OperatorSettingsSlotsProvider,
} from "./settings-slots";

describe("operator Settings host slots", () => {
  it("renders each host control only at its named Settings destination", () => {
    const html = renderToStaticMarkup(
      <OperatorSettingsSlotsProvider
        slots={{
          personalization: <span>Portal appearance control</span>,
          "papercup-agent": <span>Ask Papercup control</span>,
        }}
      >
        <div data-page="personalization">
          <OperatorSettingsSlot name="personalization" />
        </div>
        <div data-page="papercup-agent">
          <OperatorSettingsSlot name="papercup-agent" />
        </div>
      </OperatorSettingsSlotsProvider>,
    );

    expect(html).toContain(
      '<div data-page="personalization"><span>Portal appearance control</span></div>',
    );
    expect(html).toContain(
      '<div data-page="papercup-agent"><span>Ask Papercup control</span></div>',
    );
  });

  it("adds no empty wrapper when a host supplies no control", () => {
    expect(
      renderToStaticMarkup(
        <OperatorSettingsSlot name="personalization" />,
      ),
    ).toBe("");
  });
});
