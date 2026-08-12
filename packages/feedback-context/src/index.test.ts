import { describe, expect, it } from "vitest";
import {
  FEEDBACK_CONTEXT_POLICY,
  decorateAssistantMessageFeedback,
  renderFeedbackContext,
} from "./index";

describe("@summonghost/feedback-context", () => {
  it("renders compact private and attributed feedback", () => {
    expect(renderFeedbackContext([{ value: "👍" }])).toBe(
      "<feedback>👍</feedback>",
    );
    expect(renderFeedbackContext([{ value: "🔥", by: "Alex" }])).toBe(
      '<feedback by="Alex">🔥</feedback>',
    );
  });

  it("escapes XML, deduplicates reactions, and rejects oversized values", () => {
    expect(
      renderFeedbackContext([
        { value: "<&", by: 'A "B"' },
        { value: "<&", by: 'A "B"' },
        { value: "x".repeat(33) },
      ]),
    ).toBe('<feedback by="A &quot;B&quot;">&lt;&amp;</feedback>');
    expect(renderFeedbackContext([{ value: "👍".repeat(32) }])).not.toBeNull();
    expect(renderFeedbackContext([{ value: "👍".repeat(33) }])).toBeNull();
    expect(
      renderFeedbackContext([{ value: `${" ".repeat(33)}👍` }]),
    ).toBeNull();
  });

  it("inspects at most 16 reaction candidates without expanding the array", () => {
    const reactions = Array.from({ length: 17 }, () => ({ value: "👍" }));
    Object.defineProperty(reactions, 16, {
      get: () => {
        throw new Error("reaction candidate limit exceeded");
      },
    });

    expect(renderFeedbackContext(reactions)).toBe("<feedback>👍</feedback>");

    const overflow = [{ value: "🔥" }];
    Object.defineProperty(overflow, 0, {
      get: () => {
        throw new Error("merged reaction candidate limit exceeded");
      },
    });
    expect(
      decorateAssistantMessageFeedback(
        [{ role: "assistant", content: "Answer" }],
        [
          { messageIndex: 0, reactions: reactions.slice(0, 16) },
          { messageIndex: 0, reactions: overflow },
        ],
      ),
    ).toEqual([
      {
        role: "assistant",
        content: "Answer\n\n<feedback>👍</feedback>",
      },
    ]);
  });

  it("decorates only the exact assistant message without mutation", () => {
    const messages = [
      { role: "user", content: "Question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Next question" },
      { role: "assistant", content: "Second answer" },
    ] as const;
    const decorated = decorateAssistantMessageFeedback(messages, [
      { messageIndex: 1, reactions: [{ value: "👍" }] },
    ]);

    expect(decorated).toEqual([
      messages[0],
      {
        role: "assistant",
        content: "First answer\n\n<feedback>👍</feedback>",
      },
      messages[2],
      messages[3],
    ]);
    expect(messages[1].content).toBe("First answer");
    expect(decorated[3]).toBe(messages[3]);
  });

  it("merges repeated entries and supports structured-message adapters", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
    ];
    const decorated = decorateAssistantMessageFeedback(
      messages,
      [
        { messageIndex: 0, reactions: [{ value: "👍" }] },
        { messageIndex: 0, reactions: [{ value: "🔥", by: "Sam" }] },
      ],
      (message, feedback) => ({
        ...message,
        content: [...message.content, { type: "text", text: feedback }],
      }),
    );

    expect(decorated[0]?.content).toEqual([
      { type: "text", text: "Answer" },
      {
        type: "text",
        text: '<feedback>👍</feedback><feedback by="Sam">🔥</feedback>',
      },
    ]);
    expect(FEEDBACK_CONTEXT_POLICY).toContain("message containing it");
  });

  it("ignores feedback for user, missing, or unsupported messages", () => {
    const messages = [
      { role: "user", content: "Question" },
      { role: "assistant", content: [{ type: "text", text: "Answer" }] },
    ];
    expect(
      decorateAssistantMessageFeedback(messages, [
        { messageIndex: 0, reactions: [{ value: "👍" }] },
        { messageIndex: 1, reactions: [{ value: "👍" }] },
        { messageIndex: 99, reactions: [{ value: "👍" }] },
      ]),
    ).toEqual(messages);
  });
});
