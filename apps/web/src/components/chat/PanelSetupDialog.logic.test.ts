import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { panelReplyBudget } from "@t3tools/shared/panelChat";
import { describe, expect, it } from "vite-plus/test";

import {
  countEligiblePanelModels,
  filterRememberedPanelRoster,
  lowestPanelModelOptions,
  newPanelModelSelection,
  panelModelDisabledReason,
  panelSetupDisabledReason,
  PANEL_SETUP_REASONS,
} from "./PanelSetupDialog.logic";

const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("another");
const effort: ProviderOptionDescriptor = {
  type: "select",
  id: "reasoningEffort",
  label: "Effort",
  currentValue: "high",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
};
const firstModel = {
  slug: "first",
  name: "First",
  isCustom: false,
  aliases: ["first-alias"],
  capabilities: { optionDescriptors: [effort] },
};
const secondModel = { slug: "second", name: "Second", isCustom: false, capabilities: null };
const provider: Parameters<typeof countEligiblePanelModels>[0][number] = {
  instanceId,
  enabled: true,
  installed: true,
  isAvailable: true,
  status: "ready",
  models: [firstModel, secondModel],
  snapshot: {
    auth: { status: "authenticated" },
    panelChat: { panelist: true, codeAgent: true, panelistToolsRemoved: true },
  },
};
const first = newPanelModelSelection(instanceId, "first", firstModel);
const second = newPanelModelSelection(instanceId, "second", secondModel);
const high: ModelSelection = { ...first, options: [{ id: effort.id, value: "high" }] };
const roster = { panelists: [first, second], codeAgent: null, rounds: 2 };

describe("panel setup", () => {
  it("chooses the first reasoning option for conventional and provider-defined descriptors", () => {
    const mode: ProviderOptionDescriptor = { ...effort, id: "mode" };
    const toggle: ProviderOptionDescriptor = { type: "boolean", id: "thinking", label: "Thinking" };
    expect(lowestPanelModelOptions([mode, toggle, effort])).toEqual([
      { id: "reasoningEffort", value: "low" },
    ]);
    expect(
      lowestPanelModelOptions([mode, { ...effort, id: "thought_level", role: "reasoning" }]),
    ).toEqual([{ id: "thought_level", value: "low" }]);
    expect(lowestPanelModelOptions([mode, toggle])).toBeUndefined();
    expect(lowestPanelModelOptions([{ ...effort, options: [] }])).toBeUndefined();
    expect(first.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("rejects exact duplicate panelists while allowing differences in effort, instance or role", () => {
    const providers = [provider, { ...provider, instanceId: otherInstanceId }];
    expect(
      panelModelDisabledReason(providers, { ...first, model: "first-alias" }, "panelist", [first]),
    ).toBe(PANEL_SETUP_REASONS.duplicate);
    expect(panelModelDisabledReason(providers, high, "panelist", [first])).toBeNull();
    expect(
      panelModelDisabledReason(providers, { ...first, instanceId: otherInstanceId }, "panelist", [
        first,
      ]),
    ).toBeNull();
    expect(panelModelDisabledReason(providers, first, "code_agent", [first])).toBeNull();
  });

  it("distinguishes unsupported roles and filters remembered models that are no longer offered", () => {
    const panelistOnly = {
      ...provider,
      snapshot: {
        ...provider.snapshot,
        panelChat: { panelist: true, codeAgent: false, panelistToolsRemoved: false },
      },
    };
    const unsupported = { ...provider, snapshot: { auth: provider.snapshot.auth } };
    const signedOut = {
      ...provider,
      instanceId: otherInstanceId,
      snapshot: { ...provider.snapshot, auth: { status: "unauthenticated" as const } },
    };
    expect(panelModelDisabledReason([unsupported], first, "panelist")).toBe(
      PANEL_SETUP_REASONS.panelist,
    );
    expect(panelModelDisabledReason([panelistOnly], first, "code_agent")).toBe(
      PANEL_SETUP_REASONS.code_agent,
    );
    expect(countEligiblePanelModels([panelistOnly, signedOut])).toBe(2);
    expect(
      filterRememberedPanelRoster(
        {
          panelists: [
            high,
            { ...second, model: "removed" },
            { ...first, instanceId: otherInstanceId },
          ],
          codeAgent: first,
          rounds: 4,
        },
        [panelistOnly, signedOut],
      ),
    ).toEqual({ panelists: [high], codeAgent: null, rounds: 4 });
  });

  it("gives the first unmet start reason and counts the conclusion in the reply budget", () => {
    const reason = (setup: typeof roster, topic: string, eligible = 2) =>
      panelSetupDisabledReason(setup, topic, [provider], eligible);
    expect(reason({ ...roster, panelists: [first] }, "")).toBe(PANEL_SETUP_REASONS.minimum);
    expect(reason({ ...roster, panelists: Array.from({ length: 6 }, () => first) }, "")).toBe(
      PANEL_SETUP_REASONS.maximum,
    );
    expect(reason(roster, " \n ")).toBe(PANEL_SETUP_REASONS.emptyTopic);
    expect(reason(roster, "a".repeat(8001))).toBe(PANEL_SETUP_REASONS.longTopic);
    expect(reason(roster, "Topic", 1)).toBe(PANEL_SETUP_REASONS.unavailable);
    expect(reason({ ...roster, panelists: [first, first] }, "Topic")).toBe(
      PANEL_SETUP_REASONS.duplicate,
    );
    expect(reason(roster, "Topic")).toBeNull();
    expect(panelReplyBudget(3, 2)).toBe(7);
  });
});
