import { describe, expect, it, vi } from "vitest";
import {
  canApplyConversationCompaction,
  conversationCompactionKey,
  ConversationCompactionLimitError,
  ConversationCompactionSupersededError,
  createConversationCompactionController,
  decideConversationCompaction,
  type ScheduledConversationCompaction,
} from "./index";

const policy = {
  proactiveTokens: 10,
  hardLimitTokens: 20,
  headroomTokens: 2,
} as const;

describe("conversation compaction policy", () => {
  it("uses projected tokens and pending state at both thresholds", () => {
    expect(decideConversationCompaction({ estimatedTokens: 7, policy })).toBe("none");
    expect(decideConversationCompaction({ estimatedTokens: 8, policy })).toBe("background");
    expect(decideConversationCompaction({ estimatedTokens: 8, pending: true, policy })).toBe("none");
    expect(decideConversationCompaction({ estimatedTokens: 18, pending: true, policy })).toBe("blocking");
  });

  it("rejects unsafe policies and token counts", () => {
    expect(() => decideConversationCompaction({
      estimatedTokens: 0,
      policy: { proactiveTokens: 10, hardLimitTokens: 10 },
    })).toThrow("0 < proactiveTokens < hardLimitTokens");
    expect(() => decideConversationCompaction({
      estimatedTokens: 1.5,
      policy,
    })).toThrow("estimatedTokens must be a non-negative safe integer");
    expect(() => decideConversationCompaction({
      estimatedTokens: 0,
      policy: { proactiveTokens: 10, hardLimitTokens: 20, headroomTokens: 20 },
    })).toThrow("headroomTokens must be less than hardLimitTokens");
  });
});

describe("conversation compaction coordination", () => {
  it("builds normalized, encoded revision keys", () => {
    expect(conversationCompactionKey({
      scope: " room/a ",
      throughId: "message:2",
    })).toBe("conversation-compaction:room%2Fa:message%3A2:0");
    expect(() => conversationCompactionKey({ scope: " ", throughId: "2" })).toThrow("scope is required");
  });

  it("rejects stale, missing, and reordered source ranges", () => {
    const source = {
      currentMessageIds: ["a", "b", "c", "d"],
      expectedFromId: "a",
      expectedThroughId: "c",
    } as const;
    expect(canApplyConversationCompaction(source)).toBe(true);
    expect(canApplyConversationCompaction({ ...source, currentThroughId: "b" })).toBe(true);
    expect(canApplyConversationCompaction({ ...source, currentThroughId: "c" })).toBe(false);
    expect(canApplyConversationCompaction({ ...source, currentThroughId: "missing" })).toBe(false);
    expect(canApplyConversationCompaction({ ...source, currentThroughId: "" })).toBe(false);
    expect(canApplyConversationCompaction({ ...source, expectedFromId: "missing" })).toBe(false);
    expect(canApplyConversationCompaction({ ...source, expectedFromId: "d" })).toBe(false);
  });
});

describe("conversation compaction controller", () => {
  it("durably schedules proactive work without awaiting snapshot creation or duplicating it", async () => {
    let scheduled: ScheduledConversationCompaction<string> | undefined;
    const scheduleCompaction = vi.fn(async (input: ScheduledConversationCompaction<string>) => {
      scheduled = input;
    });
    const createSnapshot = vi.fn(async () => "summary");
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 8,
      createSnapshot,
      policy,
      scheduleCompaction,
    });

    await expect(controller.prepareMessages(["raw history"])).resolves.toEqual(["raw history"]);
    expect(scheduleCompaction).toHaveBeenCalledOnce();
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(controller.pending()).toBe(true);

    await controller.prepareMessages(["raw history"]);
    expect(scheduleCompaction).toHaveBeenCalledOnce();
    await expect(scheduled?.run()).resolves.toBe("summary");
    expect(controller.latestBlockingSnapshot()).toBeNull();
  });

  it("clears superseded background state when blocking work takes over", async () => {
    const scheduled: ScheduledConversationCompaction<string>[] = [];
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(8);
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens,
      createSnapshot: async ({ sequence }) => `summary-${sequence}`,
      policy,
      scheduleCompaction: async (input) => {
        scheduled.push(input);
      },
    });

    await controller.prepareMessages(["raw"]);
    expect(controller.pending()).toBe(true);
    await expect(controller.prepareMessages(["raw"])).resolves.toEqual(["summary-2"]);
    expect(controller.pending()).toBe(false);
    await expect(scheduled[0]?.run()).rejects.toBeInstanceOf(ConversationCompactionSupersededError);

    await controller.prepareMessages(["raw", "tail"]);
    expect(scheduled).toHaveLength(2);
    expect(controller.pending()).toBe(true);
  });

  it("replaces blocking history, appends only the new tail, and compacts repeatedly", async () => {
    const createSnapshot = vi.fn(async ({ sequence, messages }) =>
      `summary-${sequence}:${messages.join("|")}`,
    );
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async ({ messages }) =>
        messages[0]?.startsWith("summary-") && messages.length === 1 ? 1 : 18,
      createSnapshot,
      policy,
    });

    const first = await controller.prepareMessages(["raw"]);
    expect(first).toEqual(["summary-1:raw"]);
    expect(controller.latestSnapshot()).toBe("summary-1:raw");

    const second = await controller.prepareMessages(["raw", "tool result"]);
    expect(second).toEqual(["summary-2:summary-1:raw|tool result"]);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.snapshotSequence()).toBe(2);
  });

  it("supersedes scheduled work when the observed history branch changes", async () => {
    let scheduled: ScheduledConversationCompaction<string> | undefined;
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 8,
      createSnapshot: async () => "summary",
      policy,
      scheduleCompaction: async (input) => {
        scheduled ??= input;
      },
    });

    await controller.prepareMessages(["old"]);
    await controller.prepareMessages(["replacement"]);
    await expect(scheduled?.run()).rejects.toBeInstanceOf(ConversationCompactionSupersededError);
  });

  it("never applies a blocking replacement that still reaches the hard limit", async () => {
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce(18);
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens,
      createSnapshot: async () => "oversized summary",
      policy,
    });

    const error = await controller.prepareMessages(["raw"]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ConversationCompactionLimitError);
    expect(error).toMatchObject({
      code: "conversation_compaction_limit",
      hardLimitTokens: 20,
      headroomTokens: 2,
      replacementTokens: 18,
    });
    expect(controller.latestBlockingSnapshot()).toBeNull();
  });

  it("serializes concurrent preparation so append-only history remains ordered", async () => {
    let release!: () => void;
    const firstCount = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[][] = [];
    const countInputTokens = vi.fn(async ({ messages }: { messages: readonly string[] }) => {
      seen.push([...messages]);
      if (seen.length === 1) await firstCount;
      return 0;
    });
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens,
      createSnapshot: async () => "summary",
      policy,
    });

    const first = controller.prepareMessages(["a"]);
    const second = controller.prepareMessages(["a", "b"]);
    await vi.waitFor(() => expect(countInputTokens).toHaveBeenCalledOnce());
    expect(seen).toEqual([["a"]]);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([["a"], ["a", "b"]]);
    expect(seen).toEqual([["a"], ["a", "b"]]);
  });
});
