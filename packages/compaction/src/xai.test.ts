import { describe, expect, it, vi } from "vitest";
import {
  buildXaiCompactionInput,
  createXaiCompactionAdapter,
  parseXaiNativeUsage,
  readXaiCompletedResponseOutput,
  readXaiResponseInput,
  type XaiCompactionTransportRequest,
} from "./xai";

const usage = {
  cost_in_usd_ticks: 7,
  dropped_message_count: 3,
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 4 },
  num_server_side_tools_used: 1,
  output_tokens: 2,
  total_tokens: 14,
};

describe("xAI native compaction adapter", () => {
  it("counts and compacts through the application-owned transport", async () => {
    const requests: XaiCompactionTransportRequest[] = [];
    const request = vi.fn(async (input: XaiCompactionTransportRequest) => {
      requests.push(input);
      if (input.path === "/tokenize-text") {
        return Response.json({ token_ids: [4, 5, 6] });
      }
      return Response.json({
        output: [{
          encrypted_content: "opaque",
          id: "cmp_1",
          type: "compaction",
        }],
        usage,
      });
    });
    const adapter = createXaiCompactionAdapter({ request });
    const items = [{ content: "remember RQ-7F3A", role: "user" }];

    await expect(adapter.countInputTokens({ items, model: "grok-4" })).resolves.toBe(3);
    await expect(adapter.compactInput({
      conversationId: "conversation-1",
      items,
      model: "grok-4",
    })).resolves.toEqual({
      items: [{ encrypted_content: "opaque", id: "cmp_1", type: "compaction" }],
      usage: {
        cacheReadInputTokens: 4,
        costUsdTicks: 7,
        droppedMessageCount: 3,
        inputTokens: 12,
        outputTokens: 2,
        serverSideToolCalls: 1,
        totalTokens: 14,
      },
    });

    expect(requests.map(({ body, conversationId, path }) => ({ body, conversationId, path }))).toEqual([
      {
        body: { model: "grok-4", text: JSON.stringify(items) },
        conversationId: undefined,
        path: "/tokenize-text",
      },
      {
        body: { input: items, model: "grok-4" },
        conversationId: "conversation-1",
        path: "/responses/compact",
      },
    ]);
    expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
  });

  it("uses conservative preflight shortcuts and fails closed when counting fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("tokenizer unavailable");
    });
    const adapter = createXaiCompactionAdapter({ request });
    const items = [{ content: "small", role: "user" }];

    await expect(adapter.shouldCompactInput({
      hardLimitTokens: 100,
      items,
      knownTokens: 100,
      model: "grok-4",
    })).resolves.toBe(true);
    await expect(adapter.shouldCompactInput({
      hardLimitTokens: 10_000,
      items,
      model: "grok-4",
    })).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();

    await expect(adapter.shouldCompactInput({
      hardLimitTokens: 30,
      items: [{ content: "x".repeat(100), role: "user" }],
      model: "grok-4",
    })).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects unsuccessful, malformed, and unsafe provider responses", async () => {
    const httpFailure = createXaiCompactionAdapter({
      request: async () => new Response("denied", { status: 403 }),
    });
    await expect(httpFailure.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("xAI context token counting failed (403): denied");

    const malformed = createXaiCompactionAdapter({
      request: async () => Response.json({
        output: [{ id: "cmp_1", type: "compaction" }],
        usage,
      }),
    });
    await expect(malformed.compactInput({ items: [{ role: "user" }], model: "grok-4" }))
      .rejects.toThrow("returned no valid compaction item");
    await expect(malformed.compactInput({ items: [], model: "grok-4" }))
      .rejects.toThrow("Cannot compact an empty xAI context");
  });

  it("aborts transport at the configured timeout", async () => {
    let signal: AbortSignal | undefined;
    const adapter = createXaiCompactionAdapter({
      request: (input) => {
        signal = input.signal;
        return new Promise<Response>(() => undefined);
      },
      timeoutMs: 1,
    });

    await expect(adapter.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("xAI context token counting timed out");
    expect(signal?.aborted).toBe(true);
  });
});

describe("xAI payload helpers", () => {
  it("extracts input and completed output and rejects malformed events", () => {
    const items = [{ content: "hello", role: "user" }];
    expect(readXaiResponseInput({ input: items })).toEqual(items);
    expect(readXaiResponseInput({ input: [null] })).toBeNull();
    expect(readXaiCompletedResponseOutput(JSON.stringify({
      response: { output: items },
      type: "response.completed",
    }))).toEqual(items);
    expect(readXaiCompletedResponseOutput({ response: { output: items }, type: "response.delta" }))
      .toBeNull();
    expect(readXaiCompletedResponseOutput("not json")).toBeNull();
  });

  it("removes prior system instructions but preserves all output in order", () => {
    const developer = { content: "policy", role: "developer" };
    const user = { content: "request", role: "user" };
    const output = { content: "answer", role: "assistant" };
    expect(buildXaiCompactionInput({ input: [developer, user], output: [output] }))
      .toEqual([user, output]);
  });

  it("strictly parses additive usage with safe optional defaults", () => {
    expect(parseXaiNativeUsage({ input_tokens: 3, output_tokens: 2, total_tokens: 5 }))
      .toEqual({
        cacheReadInputTokens: 0,
        costUsdTicks: null,
        inputTokens: 3,
        outputTokens: 2,
        serverSideToolCalls: 0,
        totalTokens: 5,
      });
    expect(parseXaiNativeUsage({ input_tokens: 3, output_tokens: 2, total_tokens: 6 }))
      .toBeNull();
    expect(parseXaiNativeUsage({ input_tokens: -1, output_tokens: 2, total_tokens: 1 }))
      .toBeNull();
    expect(parseXaiNativeUsage({ input_tokens: 1, output_tokens: 0, total_tokens: 1.5 }))
      .toBeNull();
  });
});
