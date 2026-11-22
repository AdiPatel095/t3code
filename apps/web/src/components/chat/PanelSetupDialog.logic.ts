import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import {
  createModelSelection,
  getProviderOptionDescriptors,
  modelSelectionsEqual,
} from "@t3tools/shared/model";
import {
  PANEL_MAX_PANELISTS,
  PANEL_MIN_PANELISTS,
  PANEL_TEXT_MAX_CHARS,
} from "@t3tools/shared/panelChat";
import { msg } from "gt-react";

import type { ProviderInstanceEntry } from "../../providerInstances";

export const PANEL_SETUP_REASONS = {
  minimum: msg("Add at least 2 models."),
  maximum: msg("A panel has up to 5 models."),
  duplicate: msg("Already in this panel."),
  panelist: msg("This provider can't join a panel chat."),
  code_agent: msg("This provider can't be limited to reading, so it can't be the code agent."),
  emptyTopic: msg("Enter a topic."),
  longTopic: msg("Keep the topic under 8,000 characters."),
  firstMessage: msg("Panel chats start after the first message."),
  unavailable: msg("Connect at least two models to start a panel chat."),
};

type PanelRole = "panelist" | "code_agent";
type PanelSetupProvider = Pick<
  ProviderInstanceEntry,
  "instanceId" | "enabled" | "installed" | "isAvailable" | "status" | "models"
> & { snapshot: Pick<ProviderInstanceEntry["snapshot"], "auth" | "panelChat"> };

export interface PanelRosterPreference {
  readonly panelists: ReadonlyArray<ModelSelection>;
  readonly codeAgent: ModelSelection | null;
  readonly rounds: number;
}

export function lowestPanelModelOptions(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  const reasoning = descriptors.find(isReasoningSelect);
  const lowest = reasoning?.options[0];
  return reasoning && lowest ? [{ id: reasoning.id, value: lowest.id }] : undefined;
}

export function findPanelModel(
  provider: PanelSetupProvider | undefined,
  model: string,
): ServerProviderModel | undefined {
  return (
    provider?.models.find((entry) => entry.slug === model) ??
    provider?.models.find((entry) =>
      entry.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
    )
  );
}

function isPanelProviderAvailable(
  provider: PanelSetupProvider | undefined,
): provider is PanelSetupProvider {
  return (
    provider !== undefined &&
    provider.enabled &&
    provider.installed &&
    provider.isAvailable &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.snapshot.auth.status !== "unauthenticated"
  );
}

export function providerOffersPanelRole(provider: PanelSetupProvider, role: PanelRole) {
  return (
    isPanelProviderAvailable(provider) &&
    (role === "panelist"
      ? provider.snapshot.panelChat?.panelist
      : provider.snapshot.panelChat?.codeAgent)
  );
}

export function countEligiblePanelModels(providers: ReadonlyArray<PanelSetupProvider>) {
  return providers.reduce(
    (count, provider) =>
      count + (providerOffersPanelRole(provider, "panelist") ? provider.models.length : 0),
    0,
  );
}

export function panelModelDisabledReason(
  providers: ReadonlyArray<PanelSetupProvider>,
  selection: ModelSelection,
  role: PanelRole,
  otherPanelists: ReadonlyArray<ModelSelection> = [],
) {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = findPanelModel(provider, selection.model);
  if (!model || !isPanelProviderAvailable(provider)) return PANEL_SETUP_REASONS.panelist;
  if (!providerOffersPanelRole(provider, role)) return PANEL_SETUP_REASONS[role];
  if (
    role === "panelist" &&
    otherPanelists.some((other) => {
      if (other.instanceId !== selection.instanceId) return false;
      const otherModel = findPanelModel(provider, other.model);
      return modelSelectionsEqual(
        { ...selection, model: model.slug },
        { ...other, model: otherModel?.slug ?? other.model },
      );
    })
  ) {
    return PANEL_SETUP_REASONS.duplicate;
  }
  return null;
}

export function newPanelModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  advertised: ServerProviderModel | undefined,
) {
  const descriptors = getProviderOptionDescriptors({ caps: advertised?.capabilities ?? {} });
  return createModelSelection(
    instanceId,
    advertised?.slug ?? model,
    lowestPanelModelOptions(descriptors),
  );
}

export function filterRememberedPanelRoster(
  roster: PanelRosterPreference,
  providers: ReadonlyArray<PanelSetupProvider>,
): PanelRosterPreference {
  return {
    panelists: roster.panelists.filter(
      (selection) => panelModelDisabledReason(providers, selection, "panelist") === null,
    ),
    codeAgent:
      roster.codeAgent &&
      panelModelDisabledReason(providers, roster.codeAgent, "code_agent") === null
        ? roster.codeAgent
        : null,
    rounds: roster.rounds,
  };
}

export function panelSetupDisabledReason(
  roster: PanelRosterPreference,
  topic: string,
  providers: ReadonlyArray<PanelSetupProvider>,
  eligibleModelCount: number,
) {
  if (roster.panelists.length < PANEL_MIN_PANELISTS) return PANEL_SETUP_REASONS.minimum;
  if (roster.panelists.length > PANEL_MAX_PANELISTS) return PANEL_SETUP_REASONS.maximum;
  if (!topic.trim()) return PANEL_SETUP_REASONS.emptyTopic;
  if (topic.trim().length > PANEL_TEXT_MAX_CHARS) return PANEL_SETUP_REASONS.longTopic;
  if (eligibleModelCount < PANEL_MIN_PANELISTS) return PANEL_SETUP_REASONS.unavailable;
  for (const [index, selection] of roster.panelists.entries()) {
    const reason = panelModelDisabledReason(
      providers,
      selection,
      "panelist",
      roster.panelists.slice(0, index),
    );
    if (reason) return reason;
  }
  return roster.codeAgent
    ? panelModelDisabledReason(providers, roster.codeAgent, "code_agent")
    : null;
}
