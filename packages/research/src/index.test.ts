import { describe, expect, it, vi } from "vitest";
import {
  WEB_SEARCH_TOOL_NAME,
  X_SEARCH_TOOL_NAME,
  assertPublicHttpsUrl,
  buildNativeXSearchRequest,
  buildRedditSearchUrl,
  executeExaSearch,
  formatWebSearchResults,
  normalizeNativeXSearchResult,
  normalizeSearchQueries,
  parseRedditSearchResults,
  readBoundedText,
  readUrlInputSchema,
  redditSearchInputSchema,
  runNativeXSearch,
  webSearchInputSchema,
  xSearchInputSchema,
  xSearchOutputSchema,
} from "./index.js";

describe("model-facing contracts", () => {
  it("standardizes base names and bounded inputs", () => {
    expect(WEB_SEARCH_TOOL_NAME).toBe("web_search");
    expect(X_SEARCH_TOOL_NAME).toBe("x_search");
    expect(webSearchInputSchema.parse({ query: " current agents " })).toMatchObject({
      query: "current agents",
      num_results: 5,
    });
    expect(normalizeSearchQueries(webSearchInputSchema.parse({
      queries: [" agents ", "agents", "workers"],
    }))).toEqual(["agents", "workers"]);
    expect(webSearchInputSchema.safeParse({ query: "x".repeat(501) }).success).toBe(false);
    expect(xSearchInputSchema.parse({ query: "Cloudflare" })).toMatchObject({ depth: "default" });
    expect(xSearchInputSchema.safeParse({
      query: "Cloudflare",
      from_date: "2026-08-02",
      to_date: "2026-08-01",
    }).success).toBe(false);
  });

  it("keeps URL reads and Reddit validation separate", () => {
    expect(readUrlInputSchema.safeParse({ urls: ["https://example.com"] }).success).toBe(true);
    expect(readUrlInputSchema.safeParse({ urls: ["http://example.com"] }).success).toBe(false);
    expect(readUrlInputSchema.safeParse({ urls: ["https://127.0.0.1"] }).success).toBe(false);
    const reddit = redditSearchInputSchema.parse({ query: "agents", subreddits: ["typescript"] });
    expect(buildRedditSearchUrl(reddit).searchParams.get("raw_json")).toBe("1");
  });
});

describe("public URL boundaries", () => {
  it.each([
    "https://localhost/a",
    "https://service.internal/a",
    "https://127.0.0.1/a",
    "https://10.0.0.1/a",
    "https://169.254.169.254/a",
    "https://[::1]/a",
    "https://[fd00::1]/a",
    "http://example.com/a",
    "https://user:secret@example.com/a",
  ])("rejects %s", (value) => {
    expect(() => assertPublicHttpsUrl(value)).toThrow();
  });

  it("accepts public HTTPS and bounds streamed bytes", async () => {
    expect(assertPublicHttpsUrl("https://example.com/a#secret").hash).toBe("");
    await expect(readBoundedText(new Response("too much"), 3)).rejects.toMatchObject({
      code: "PublicUrlResponseTooLarge",
    });
  });
});

describe("provider normalization", () => {
  it("maps and normalizes Exa through a structural client", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [{
        id: "exa-1",
        url: "https://example.com/article",
        highlights: ["Useful", "context"],
        providerSecret: "must not escape",
      }],
    });
    const execution = await executeExaSearch(
      { search },
      "agents",
      { category: "personal_site", content_mode: "highlights", num_results: 3 },
    );
    expect(search).toHaveBeenCalledWith("agents", expect.objectContaining({
      category: "personal site",
      contents: { highlights: true },
      moderation: true,
      numResults: 3,
    }), { signal: undefined });
    expect(execution.results[0]).toEqual({
      highlights: ["Useful", "context"],
      id: "exa-1",
      text: "Useful context",
      url: "https://example.com/article",
    });
  });

  it("forwards Exa cancellation to the structural client", async () => {
    const controller = new AbortController();
    const providerAbort = vi.fn();
    const search = vi.fn((
      _query: string,
      _options: Readonly<Record<string, unknown>>,
      { signal }: Readonly<{ signal?: AbortSignal }>,
    ) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        providerAbort();
        reject(signal.reason);
      }, { once: true });
    }));
    const execution = executeExaSearch(
      { search },
      "agents",
      {},
      { signal: controller.signal },
    );

    expect(search).toHaveBeenCalledWith(
      "agents",
      expect.any(Object),
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled"));

    await expect(execution).rejects.toThrow("cancelled");
    expect(providerAbort).toHaveBeenCalledOnce();
  });

  it("does not expose Exa provider errors", async () => {
    const search = vi.fn().mockRejectedValue(
      new Error("private Exa response detail"),
    );

    await expect(executeExaSearch({ search }, "agents"))
      .rejects.toThrow(/^Exa research failed$/);
    await expect(executeExaSearch({ search }, "agents"))
      .rejects.not.toThrow("private Exa response detail");

    const malformedSearch = vi.fn().mockResolvedValue({
      results: [{ url: "private malformed provider value" }],
    });
    await expect(executeExaSearch({ search: malformedSearch }, "agents"))
      .rejects.toThrow(/^Exa research returned invalid results$/);
  });

  it("normalizes Reddit without provider or app envelopes", () => {
    expect(parseRedditSearchResults({
      data: {
        children: [{
          data: {
            author: "ghost",
            created_utc: 1,
            id: "post-1",
            num_comments: 3,
            permalink: "/r/test/comments/post-1/example",
            score: 7,
            selftext: "Example body",
            subreddit: "test",
            title: "Example",
          },
        }],
      },
    }, 1)).toEqual([expect.objectContaining({
      comments: 3,
      url: "https://www.reddit.com/r/test/comments/post-1/example",
    })]);
  });

  it("formats bounded model-facing web results", () => {
    const formatted = formatWebSearchResults(Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Result ${index}`,
      highlights: ["a".repeat(700)],
    })));
    expect(formatted).toContain("Result 7");
    expect(formatted).not.toContain("Result 8");
    expect(formatted.length).toBeLessThan(6_000);
  });
});

describe("native xAI X search", () => {
  it("builds native requests without an SDK dependency", () => {
    expect(buildNativeXSearchRequest({
      model: "grok-4",
      nativeToolOptions: { allowedXHandles: ["@cloudflare"], fromDate: "2026-08-01" },
      prompt: "Search X",
    })).toMatchObject({
      model: "grok-4",
      store: false,
      tool_choice: "required",
      tools: [{
        type: "x_search",
        allowed_x_handles: ["cloudflare"],
        from_date: "2026-08-01",
      }],
    });
  });

  it("normalizes direct structured and Responses API output", () => {
    const item = {
      author_handle: "@cloudflare",
      date: "2026-08-01",
      engagement: { likes: 2, reposts: 1 },
      text: "Durable agents",
      url: "https://x.com/cloudflare/status/1",
    };
    expect(xSearchOutputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(normalizeNativeXSearchResult({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ items: [item] }) }] }],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 5,
        total_tokens: 15,
      },
    })).toMatchObject({
      items: [{ author_handle: "cloudflare" }],
      totalUsage: { cacheRead: 2, input: 8, output: 5, totalTokens: 15 },
    });
  });

  it("rejects provider errors with safe messages and attached usage", () => {
    expect(() => normalizeNativeXSearchResult({
      status: "incomplete: sensitive detail",
      error: { message: "provider secret" },
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    })).toThrow("xAI native X research did not complete");

    try {
      normalizeNativeXSearchResult({
        error: { message: "provider secret" },
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          private_usage_detail: "provider secret",
          total_tokens: 3,
        },
      });
      expect.fail("expected provider response to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        message: "xAI native X research failed",
        usage: { totalTokens: 3 },
      });
      expect((error as Error).message).not.toContain("provider secret");
      expect(error).not.toHaveProperty("usage.raw");
      expect(error).not.toHaveProperty("usage.private_usage_detail");
    }
  });

  it("does not expose native X transport or parse details", async () => {
    const transport = vi.fn().mockRejectedValue(
      new Error("private xAI transport detail"),
    );
    await expect(runNativeXSearch({
      model: "grok-4",
      prompt: "Search X",
      transport,
    })).rejects.toThrow(/^xAI native X research failed$/);

    try {
      normalizeNativeXSearchResult({
        output_text: "private invalid JSON",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
      expect.fail("expected invalid provider output to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        message: "xAI native X research returned invalid structured output",
      });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private invalid JSON");
    }
  });

  it("injects transport and preserves normalized metering", async () => {
    const transport = vi.fn().mockResolvedValue({
      output: { items: [{
        author_handle: null,
        date: null,
        engagement: null,
        text: "A post",
        url: "https://x.com/i/status/1",
      }] },
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    });
    const result = await runNativeXSearch({ model: "grok-4", prompt: "Search X", transport });
    expect(result.totalUsage.totalTokens).toBe(7);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ store: false }), {
      signal: expect.any(AbortSignal),
    });
  });
});
