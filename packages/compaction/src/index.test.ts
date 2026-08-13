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
  it("does not reschedule unchanged history after successful background work", async () => {
    const scheduled: ScheduledConversationCompaction<string>[] = [];
    const scheduleCompaction = vi.fn(async (input: ScheduledConversationCompaction<string>) => {
      scheduled.push(input);
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
    const firstRun = scheduled[0]!.run();
    const repeatedRun = scheduled[0]!.run();
    await expect(Promise.all([firstRun, repeatedRun])).resolves.toEqual([
      "summary",
      "summary",
    ]);
    await expect(scheduled[0]!.run()).resolves.toBe("summary");
    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(controller.pending()).toBe(false);
    expect(controller.latestBlockingSnapshot()).toBeNull();

    await controller.prepareMessages(["raw history"]);
    expect(scheduleCompaction).toHaveBeenCalledOnce();
    expect(controller.pending()).toBe(false);

    await controller.prepareMessages(["raw history", "new tail"]);
    expect(scheduleCompaction).toHaveBeenCalledTimes(2);
    expect(controller.pending()).toBe(true);
  });

  it("clears failed background work and permits later scheduling", async () => {
    const scheduled: ScheduledConversationCompaction<string>[] = [];
    const createSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("summary");
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 8,
      createSnapshot,
      policy,
      scheduleCompaction: async (input) => {
        scheduled.push(input);
      },
    });

    await controller.prepareMessages(["raw history"]);
    await expect(scheduled[0]?.run()).rejects.toThrow("provider unavailable");
    expect(controller.pending()).toBe(false);

    await controller.prepareMessages(["raw history"]);
    expect(scheduled).toHaveLength(2);
    expect(controller.pending()).toBe(true);
    await expect(scheduled[1]?.run()).resolves.toBe("summary");
    expect(controller.pending()).toBe(false);
  });

  it("permits retry when scheduling fails after running the snapshot", async () => {
    const scheduled: ScheduledConversationCompaction<string>[] = [];
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 8,
      createSnapshot: async () => "summary",
      policy,
      scheduleCompaction: async (input) => {
        scheduled.push(input);
        if (scheduled.length === 1) {
          await input.run();
          throw new Error("persistence unavailable");
        }
      },
    });

    await expect(controller.prepareMessages(["raw history"]))
      .rejects.toThrow("persistence unavailable");
    expect(controller.pending()).toBe(false);

    await controller.prepareMessages(["raw history"]);
    expect(scheduled).toHaveLength(2);
    expect(controller.pending()).toBe(true);
  });

  it("permits retry when a failed scheduler leaves its run in flight", async () => {
    let finishSnapshot!: (snapshot: string) => void;
    let inFlight!: Promise<string>;
    const scheduled: ScheduledConversationCompaction<string>[] = [];
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 8,
      createSnapshot: () => new Promise((resolve) => {
        finishSnapshot = resolve;
      }),
      policy,
      scheduleCompaction: async (input) => {
        scheduled.push(input);
        if (scheduled.length === 1) {
          inFlight = input.run();
          throw new Error("scheduling unavailable");
        }
      },
    });

    await expect(controller.prepareMessages(["raw history"]))
      .rejects.toThrow("scheduling unavailable");
    finishSnapshot("orphaned summary");
    await expect(inFlight).resolves.toBe("orphaned summary");

    await controller.prepareMessages(["raw history"]);
    expect(scheduled).toHaveLength(2);
    expect(controller.pending()).toBe(true);
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

    await controller.prepareMessages(["raw", "tail"]);
    expect(scheduled).toHaveLength(2);
    expect(controller.pending()).toBe(true);
    await expect(scheduled[0]?.run()).rejects.toBeInstanceOf(ConversationCompactionSupersededError);
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
