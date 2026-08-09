// The mid-turn steer contract the inbox watcher (coverify say) depends on:
// RoleSession.steer resolves true promptly while a turn is running (so the
// watcher can consume the message before the wake boundary), the steered
// content reaches the model within the same turn, and steer resolves false
// when the session is idle. A pi upgrade that changes AgentHarness.steer
// semantics must fail here, not silently drop user guidance.
import { expect, test } from "bun:test";

const { createHarnessRoleSession } = await import("../src/providers.ts");

const fakeModel = { id: "fake-model", provider: "anthropic", api: "anthropic-messages" };
const mkMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fake-model",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  stopReason: "stop",
  timestamp: Date.now(),
});

test("steer: true and injected mid-run, false when idle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstCall = true;
  const contexts: unknown[] = [];
  const models = {
    getModel: () => fakeModel,
    streamSimple: (_m: unknown, ctx: { messages?: unknown[] }) => {
      contexts.push(ctx);
      const wasFirst = firstCall;
      firstCall = false;
      const stream = (async function* () {
        if (wasFirst) await gate;
        yield { type: "done" };
      })() as AsyncGenerator<unknown> & { result: () => Promise<unknown> };
      (stream as { result?: () => Promise<unknown> }).result = async () => {
        if (wasFirst) await gate;
        return mkMessage(wasFirst ? "first" : "after-steer");
      };
      return stream;
    },
  };

  const session = await createHarnessRoleSession(
    {
      contract: "C",
      charge: "CH",
      spec: { provider: "anthropic", modelId: "fake-model", thinking: "off" },
      models: models as never,
    } as never,
    { sessionId: "steer-contract", ephemeral: true },
  );

  const askP = session.ask("go");
  await new Promise((r) => setTimeout(r, 50)); // let the blocked turn start
  const steerP = session.steer("mid-turn user note");
  // Prompt resolution: the watcher's consume bookkeeping needs the verdict
  // before the wake boundary, not at turn end (the turn is still gated here).
  const promptly = await Promise.race([
    steerP.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
  ]);
  expect(promptly).toBe(true);
  expect(await steerP).toBe(true);
  release();
  // The steered message triggers a follow-up model call within the same ask.
  expect(await askP).toBe("after-steer");
  const followUp = JSON.stringify(contexts.at(-1));
  expect(followUp).toContain("mid-turn user note");

  expect(await session.steer("idle note")).toBe(false);
});
