// The coverify patch on pi-ai's openai-codex SSE path: a transport death
// DURING stream consumption re-issues the request (bounded, backoff) instead
// of failing the turn. 2026-08-08: ~30% of long Sol turns died to such
// resets; the request phase already retried, mid-stream did not.
import { expect, test } from "bun:test";

const { stream } = await import("@earendil-works/pi-ai/api/openai-codex-responses");

const MODEL = {
  id: "gpt-test",
  provider: "openai-codex",
  baseUrl: "https://example.invalid/backend-api/codex",
  api: "openai-codex-responses",
  input: ["text"],
  output: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 8192,
  reasoning: true,
} as never;

const CONTEXT = { systemPrompt: "s", messages: [], tools: [] } as never;

// The provider extracts a ChatGPT account id from the token's JWT claims
// before any request; a structurally valid fake satisfies it offline.
const FAKE_JWT =
  "h.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOiB7ImNoYXRncHRfYWNjb3VudF9pZCI6ICJhY2N0X3Rlc3QifX0.s";

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(new TextEncoder().encode(`data: ${e}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ITEM_ADDED = JSON.stringify({
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "message", id: "msg_1", role: "assistant", content: [] },
});
const delta = (text: string) =>
  JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: text });

function dyingResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${ITEM_ADDED}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: ${delta("par")}\n\n`));
      controller.error(new Error("The socket connection was closed unexpectedly."));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const COMPLETED = JSON.stringify({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    usage: { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
  },
});

test("mid-stream transport death re-requests and completes", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return calls === 1 ? dyingResponse() : sseResponse([ITEM_ADDED, delta("hello"), COMPLETED]);
  };
  const s = stream(MODEL, CONTEXT, { apiKey: FAKE_JWT, fetch: fetchStub as never, transport: "sse" });
  const events: { type: string }[] = [];
  for await (const e of s as AsyncIterable<{ type: string }>) events.push(e);
  const done = events.find((e) => e.type === "done") as { message?: { content?: { text?: string }[] } } | undefined;
  expect(calls).toBe(2);
  expect(done).toBeDefined();
  const texts = (done?.message?.content ?? []).map((c) => c.text ?? "").join("");
  // The reset must have discarded attempt 1's partial "par"; attempt 2's
  // content stands alone.
  expect(texts).toBe("hello");
  expect(events.some((e) => e.type === "error")).toBe(false);
});

test("non-transport errors are not retried", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return sseResponse([JSON.stringify({ type: "error", code: "usage_limit_reached", message: "usage limit reached" })]);
  };
  const s = stream(MODEL, CONTEXT, { apiKey: FAKE_JWT, fetch: fetchStub as never, transport: "sse" });
  const events: { type: string }[] = [];
  for await (const e of s as AsyncIterable<{ type: string }>) events.push(e);
  expect(calls).toBe(1);
  expect(events.some((e) => e.type === "error")).toBe(true);
});

test("a retried attempt that closes empty still errors (no silent contentless done)", async () => {
  // Regression for the reset: stopReason must return to "pending", not be
  // deleted, or assertSuccessfulOutput waves an empty retried stream through.
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return calls === 1 ? dyingResponse() : sseResponse([]);
  };
  const s = stream(MODEL, CONTEXT, { apiKey: FAKE_JWT, fetch: fetchStub as never, transport: "sse" });
  const events: { type: string }[] = [];
  for await (const e of s as AsyncIterable<{ type: string }>) events.push(e);
  expect(calls).toBe(2);
  expect(events.some((e) => e.type === "error")).toBe(true);
  expect(events.some((e) => e.type === "done")).toBe(false);
});
