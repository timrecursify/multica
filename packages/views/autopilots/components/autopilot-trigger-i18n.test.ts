import { describe, expect, it } from "vitest";
import type { AutopilotTriggerKind } from "@multica/core/types";
import enAutopilots from "../../locales/en/autopilots.json";
import jaAutopilots from "../../locales/ja/autopilots.json";
import koAutopilots from "../../locales/ko/autopilots.json";
import zhAutopilots from "../../locales/zh-Hans/autopilots.json";

// Contract test for the autopilot trigger-kind translations.
//
// The autopilot detail page and list render `trigger.kind` through
// `$.trigger_kind[trigger.kind]`, which is typed as `AutopilotTriggerKind`.
// Every locale must cover the full union so adding a new kind breaks CI here
// instead of silently rendering an incomplete label or failing the lookup.

const TRIGGER_KINDS: AutopilotTriggerKind[] = ["schedule", "webhook", "api", "event"];

const LOCALES: Record<string, Record<string, string>> = {
  en: enAutopilots.trigger_kind,
  ja: jaAutopilots.trigger_kind,
  ko: koAutopilots.trigger_kind,
  "zh-Hans": zhAutopilots.trigger_kind,
};

describe("autopilot trigger-kind resources", () => {
  it.each(Object.entries(LOCALES))("covers every AutopilotTriggerKind in %s", (locale, triggerKind) => {
    for (const kind of TRIGGER_KINDS) {
      const label = triggerKind[kind];
      expect(
        label,
        `missing trigger_kind translation for "${kind}" in "${locale}"`,
      ).toBeTruthy();
      expect(String(label).trim()).not.toBe("");
    }
  });

  it("keeps the translation map aligned with the trigger-kind union", () => {
    for (const [locale, triggerKind] of Object.entries(LOCALES)) {
      const keys = Object.keys(triggerKind).sort();
      expect(keys, `trigger_kind keys in "${locale}"`).toEqual([...TRIGGER_KINDS].sort());
    }
  });
});
