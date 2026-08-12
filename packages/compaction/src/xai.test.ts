import { describe, expect, it, vi } from "vitest";
import {
  buildXaiCompactionInput,
  createXaiCompactionAdapter,
  parseXaiNativeUsage,
  XAI_COMPACTION_MAX_ENCRYPTED_CONTENT_CHARACTERS,
  XAI_COMPACTION_MAX_RESPONSE_BYTES,
  XAI_COMPACTION_MAX_TOKENS,
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
      request: async () => new Response("private provider detail", { status: 403 }),
    });
    await expect(httpFailure.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow(/^xAI context token counting failed \(403\)$/);
    await expect(httpFailure.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.not.toThrow("private provider detail");

    const transportFailure = createXaiCompactionAdapter({
      request: async () => {
        throw new Error("secret transport detail");
      },
    });
    await expect(transportFailure.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow(/^xAI context token counting failed$/);

    const invalidJson = createXaiCompactionAdapter({
      request: async () => new Response("private invalid JSON"),
    });
    await expect(invalidJson.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow(/^xAI context token counting returned invalid JSON$/);

    const bodyReadFailure = createXaiCompactionAdapter({
      request: async () => new Response(new ReadableStream({
        pull: (controller) => {
          controller.error(new Error("secret body read detail"));
        },
      })),
    });
    await expect(bodyReadFailure.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow(/^xAI context token counting failed while reading response$/);

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

  it("caps response bodies, token IDs, and encrypted compaction content", async () => {
    const oversizedBody = createXaiCompactionAdapter({
      request: async () => new Response(
        new Uint8Array(XAI_COMPACTION_MAX_RESPONSE_BYTES + 1),
      ),
    });
    await expect(oversizedBody.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("xAI context token counting response is too large");

    const oversizedTokenIds = createXaiCompactionAdapter({
      request: async () => new Response(
        `{"token_ids":[${"0,".repeat(XAI_COMPACTION_MAX_TOKENS)}0]}`,
        { headers: { "Content-Type": "application/json" } },
      ),
    });
    await expect(oversizedTokenIds.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("returned invalid token IDs");

    for (const tokenId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidTokenId = createXaiCompactionAdapter({
        request: async () => Response.json({ token_ids: [tokenId] }),
      });
      await expect(invalidTokenId.countInputTokens({ items: [], model: "grok-4" }))
        .rejects.toThrow("returned invalid token IDs");
    }

    const oversizedEncryptedContent = createXaiCompactionAdapter({
      request: async () => Response.json({
        output: [{
          encrypted_content: "x".repeat(
            XAI_COMPACTION_MAX_ENCRYPTED_CONTENT_CHARACTERS + 1,
          ),
          id: "cmp_1",
          type: "compaction",
        }],
        usage,
      }),
    });
    await expect(oversizedEncryptedContent.compactInput({
      items: [{ role: "user" }],
      model: "grok-4",
    })).rejects.toThrow("returned no valid compaction item");
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

  it("keeps the timeout active while reading the response body", async () => {
    let bodyCancelled = false;
    let signal: AbortSignal | undefined;
    const adapter = createXaiCompactionAdapter({
      request: async (input) => {
        signal = input.signal;
        return new Response(new ReadableStream({
          cancel: () => {
            bodyCancelled = true;
          },
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode("{\"token_ids\":["));
          },
        }));
      },
      timeoutMs: 1,
    });

    await expect(adapter.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("xAI context token counting timed out");
    expect(signal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  it("cancels a response body returned after the timeout", async () => {
    let bodyCancelled = false;
    const adapter = createXaiCompactionAdapter({
      request: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(new ReadableStream({
          cancel: () => {
            bodyCancelled = true;
          },
        }));
      },
      timeoutMs: 1,
    });

    await expect(adapter.countInputTokens({ items: [], model: "grok-4" }))
      .rejects.toThrow("xAI context token counting timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodyCancelled).toBe(true);
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
    expect(parseXaiNativeUsage({
      input_tokens: XAI_COMPACTION_MAX_TOKENS + 1,
      output_tokens: 0,
      total_tokens: XAI_COMPACTION_MAX_TOKENS + 1,
    })).toBeNull();
  });
});
