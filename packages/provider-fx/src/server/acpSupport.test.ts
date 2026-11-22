import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  applyFxModelSelection,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  fxToolCallWasCancelled,
} from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });

  it("answers Full access prompts itself unless an explicit policy confines them", () => {
    const fullAccess = {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/work",
    } as const;
    assert.equal(
      fxPermissionDisposition(ProviderAdapterV2RuntimePolicy.make(fullAccess), editRequest),
      "allow",
    );
    // Runs fx's `ask`, so the policy decides what fx asks about.
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({ ...fullAccess, approvalPolicy: "on-request" }),
        editRequest,
      ),
      "ask",
    );
    for (const confined of [
      { approvalPolicy: "on-request" },
      { sandboxPolicy: { type: "readOnly" } },
    ] as const) {
      assert.equal(
        fxSessionModeForPolicy(ProviderAdapterV2RuntimePolicy.make({ ...fullAccess, ...confined })),
        "ask",
      );
    }
  });

  it("keeps panel permissions in supervised mode and answers them without prompting", () => {
    for (const role of ["panelist", "code_agent"] as const) {
      const policy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/work",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        panel: { role },
      });
      assert.equal(fxSessionModeForPolicy(policy), "ask");
      assert.equal(fxPermissionDisposition(policy, editRequest), "deny");
      assert.equal(
        fxPermissionDisposition(policy, {
          ...editRequest,
          toolCall: { ...editRequest.toolCall, kind: "read" },
        }),
        role === "panelist" ? "deny" : "allow",
      );
    }
  });
});

describe("fx model selection", () => {
  it.effect.each(["unavailable", "rejected"] as const)(
    "restores the original backend and model when Default is %s",
    (failure) =>
      Effect.gen(function* () {
        let backend = "codex";
        let model = "codex-custom";
        const configOptions = (): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
          {
            id: "provider",
            name: "provider",
            type: "select",
            currentValue: backend,
            options: ["codex", "gateway"].map((value) => ({ value, name: value })),
          },
          {
            id: "model",
            name: "model",
            type: "select",
            currentValue: model,
            options: (backend === "codex"
              ? ["codex-default", "codex-custom"]
              : ["gateway-fallback", ...(failure === "rejected" ? ["gateway-default"] : [])]
            ).map((value) => ({ value, name: value })),
          },
        ];
        const runtime = {
          getConfigOptions: Effect.sync(configOptions),
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.gen(function* () {
              if (id === "provider") {
                backend = String(value);
                model = backend === "codex" ? "codex-default" : "gateway-fallback";
              } else if (id === "model") {
                if (value === "gateway-default") {
                  return yield* new EffectAcpErrors.AcpRequestError({
                    code: -32602,
                    errorMessage: "Model rejected",
                  });
                }
                model = String(value);
              }
              return { configOptions: configOptions() };
            }),
        };
        const result = yield* applyFxModelSelection(
          runtime,
          { instanceId: ProviderInstanceId.make("fx"), model: "default" },
          Effect.succeed({ backend: "gateway", model: "gateway-default" }),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          assert.include(
            Cause.pretty(result.cause),
            failure === "unavailable"
              ? "The default fx model is unavailable on its configured backend."
              : "Model rejected",
          );
        }
        assert.equal(backend, "codex");
        assert.equal(model, "codex-custom");
      }),
  );
});

describe("fx cancellation failures", () => {
  const diff = { type: "diff", path: "notes.txt", oldText: "old", newText: "new" };
  const terminal = { type: "terminal", terminalId: "fx-terminal" };

  it.each([
    { content: ["Cancelled"], cancelled: true },
    { content: ["Cancelled."], cancelled: true },
    { content: ['{"error":{"details":{"error":"Cancelled"}}}'], cancelled: true },
    {
      content: ['{"error":{"tool":"shell","code":"Cancelled","retryable":false}}'],
      cancelled: true,
    },
    {
      content: ['{"error":{"tool":"shell","code":"PermissionDenied","retryable":false}}'],
      cancelled: false,
    },
    { content: ['{"error":{"details":{"error":"Permission denied"}}}'], cancelled: false },
    { content: ["Command failed"], cancelled: false },
    { content: [""], cancelled: false },
    { content: ["Cancelled"], followingItems: [diff], cancelled: true },
    { content: ["Cancelled"], precedingItems: [diff], cancelled: false },
    {
      content: ['{"error":{"details":{"error":"Permission denied"}}}', "Cancelled"],
      cancelled: false,
    },
    {
      content: ["Command failed", '{"error":{"details":{"error":"Cancelled"}}}'],
      cancelled: false,
    },
    {
      content: ["Cancelled", '{"error":{"details":{"error":"Permission denied"}}}'],
      cancelled: true,
    },
  ])(
    "recognizes $content as cancellation: $cancelled",
    ({ content, cancelled, precedingItems = [], followingItems = [] }) => {
      assert.equal(
        fxToolCallWasCancelled({
          update: {
            content: [
              ...precedingItems,
              ...content.map((text) => ({ content: { text } })),
              ...followingItems,
            ],
          },
        }),
        cancelled,
      );
    },
  );

  it.each([
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content: "",
      cancelled: true,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content:
        '{"error":{"type":"tool_execution_failed","message":"Command started, but its final process status could not be confirmed",',
      followingContent: ["Cancelled"],
      cancelled: false,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content: '{"error":{"message":"Permission denied","details":{"error":"Permission denied"}}}',
      followingItems: [terminal],
      cancelled: false,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content: '{"error":{"type":"tool_execution_failed","message":"clipped",',
      followingItems: [diff],
      cancelled: false,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content: "Still processing",
      followingContent: ['{"error":{"message":"Permission denied"}}'],
      followingItems: [diff],
      cancelled: false,
    },
    {
      exit_code: 1,
      signal: null,
      timed_out: false,
      termination_indeterminate: false,
      content: "",
      cancelled: false,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: true,
      termination_indeterminate: true,
      content: "",
      cancelled: false,
    },
  ])(
    "recognizes a command result with exit $exit_code, timeout $timed_out",
    ({ cancelled, content, followingContent = [], followingItems = [], ...commandResult }) => {
      assert.equal(
        fxToolCallWasCancelled({
          update: {
            command_result: commandResult,
            content: [
              ...[content, ...followingContent].map((text) => ({ content: { text } })),
              ...followingItems,
            ],
          },
        }),
        cancelled,
      );
    },
  );
});
