import { assert, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { kiroAutopilotValue, kiroPermissionDisposition } from "./acpSupport.ts";

it("denies panel permissions without a safe once-only option", () => {
  const read = {
    sessionId: "session-1",
    toolCall: { toolCallId: "read-1", kind: "read" },
    options: [{ optionId: "always", name: "Allow always", kind: "allow_always" }],
  } satisfies EffectAcpSchema.RequestPermissionRequest;
  const once = {
    ...read,
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  } satisfies EffectAcpSchema.RequestPermissionRequest;
  const readOnly = {
    cwd: "/work",
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
  } as const;
  assert.equal(kiroPermissionDisposition(readOnly, read), "ask");
  for (const role of ["panelist", "code_agent"] as const) {
    const policy = { ...readOnly, panel: { role } };
    assert.equal(kiroAutopilotValue(policy), "off");
    assert.equal(kiroPermissionDisposition(policy, read), "deny");
    assert.equal(kiroPermissionDisposition(policy, once), role === "panelist" ? "deny" : "allow");
    assert.equal(
      kiroPermissionDisposition(policy, {
        ...once,
        toolCall: { ...once.toolCall, kind: "execute" },
      }),
      "deny",
    );
  }
});
