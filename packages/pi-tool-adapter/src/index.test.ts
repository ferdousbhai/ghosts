import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptPiTool,
  isPiToolResult,
  stringifyToolResult,
  toDraft07JsonSchema,
  ToolInputValidationError,
  ToolSchemaError,
  toPiToolResult,
  ToolTimeoutError,
  validateToolArguments,
  withModelJsonSchema,
  type PiToolResult,
  type StandardSchemaV1,
  type ToolInputSchema,
} from "./index";

const objectSchema = {
  additionalProperties: false,
  properties: { value: { type: "string" } },
  required: ["value"],
  type: "object",
} as const;

const draft07ObjectSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...objectSchema,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("schema conversion", () => {
  it("exposes a compact model schema while retaining strict validation", async () => {
    const validation = zodLike({
      safeParseAsync: vi.fn(async (value: unknown) =>
        value === "valid"
          ? { success: true as const, data: { value: "normalized" } }
          : { success: false as const, error: new Error("strict rejection") }
      ),
    });
    const compact = {
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      type: "object",
    } as const;
    const schema = withModelJsonSchema<{ value: string }>(validation, compact);

    expect(toDraft07JsonSchema(schema)).toBe(compact);
    await expect(validateToolArguments(schema, "valid"))
      .resolves.toEqual({ value: "normalized" });
    await expect(validateToolArguments(schema, "invalid"))
      .rejects.toThrow(/strict rejection/);
  });

  it("rejects an unlabeled compact model schema", () => {
    expect(() => withModelJsonSchema(zodLike(), objectSchema as never))
      .toThrow(/explicitly declare Draft-07/);
  });

  it("asks Zod for an input draft-07 schema with strict unrepresentable handling", () => {
    const toJSONSchema = vi.fn(() => objectSchema);
    const schema = zodLike({ toJSONSchema });

    expect(toDraft07JsonSchema(schema)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      ...objectSchema,
    });
    expect(toJSONSchema).toHaveBeenCalledWith({
      io: "input",
      target: "draft-07",
      unrepresentable: "throw",
    });
  });

  it("allows a host to expose unrepresentable Zod inputs as any", () => {
    const toJSONSchema = vi.fn(() => objectSchema);
    toDraft07JsonSchema(zodLike({ toJSONSchema }), {
      zodUnrepresentable: "any",
    });
    expect(toJSONSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        unrepresentable: "any",
      }),
    );
  });

  it("uses the Standard Schema JSON Schema extension with a draft-07 target", () => {
    const input = vi.fn(() => objectSchema);
    const schema = standardSchema((value) => ({ value }), input);

    expect(toDraft07JsonSchema(schema)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      ...objectSchema,
    });
    expect(input).toHaveBeenCalledWith({ target: "draft-07" });
  });

  it("rejects a Standard Schema without model-facing JSON Schema conversion", () => {
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value }),
      },
    };
    expect(() => toDraft07JsonSchema(schema)).toThrow(ToolSchemaError);
  });

  it.each([
    ["direct", draft07ObjectSchema],
    ["jsonSchema wrapper", { jsonSchema: draft07ObjectSchema }],
    ["schema wrapper", { schema: draft07ObjectSchema }],
  ])("accepts an explicitly declared %s structural schema", (_label, schema) => {
    expect(toDraft07JsonSchema(schema as ToolInputSchema)).toBe(
      draft07ObjectSchema,
    );
  });

  it("preserves an explicitly declared Draft-07 identifier", () => {
    const schema = {
      ...objectSchema,
      $schema: "https://json-schema.org/draft-07/schema" as const,
    };
    expect(toDraft07JsonSchema(schema)).toBe(schema);
  });

  it.each([
    ["direct", objectSchema],
    ["jsonSchema wrapper", { jsonSchema: objectSchema }],
    ["schema wrapper", { schema: objectSchema }],
  ])("rejects an unlabeled %s structural schema", (_label, schema) => {
    expect(() =>
      toDraft07JsonSchema(schema as unknown as ToolInputSchema),
    ).toThrow(/explicitly declare Draft-07/);
  });

  it("rejects malformed, ambiguous, or inherited structural declarations", () => {
    expect(() =>
      toDraft07JsonSchema({ jsonSchema: true } as never),
    ).toThrow(/wrapper must contain/);
    expect(() =>
      toDraft07JsonSchema({
        jsonSchema: draft07ObjectSchema,
        schema: draft07ObjectSchema,
      } as never),
    ).toThrow(/only jsonSchema or schema/);
    expect(() =>
      toDraft07JsonSchema({
        $schema: draft07ObjectSchema.$schema,
        jsonSchema: draft07ObjectSchema,
      } as never),
    ).toThrow(/must not mix/);
    expect(() =>
      toDraft07JsonSchema({
        jsonSchema: {
          $schema: draft07ObjectSchema.$schema,
          schema: draft07ObjectSchema,
        },
      } as never),
    ).toThrow(/must not mix/);
    const inheritedDeclaration = Object.assign(
      Object.create({ $schema: draft07ObjectSchema.$schema }) as object,
      objectSchema,
    );
    expect(() =>
      toDraft07JsonSchema(inheritedDeclaration as never),
    ).toThrow(/explicitly declare Draft-07/);
  });

  it("rejects a conflicting draft returned by a targeted generator", () => {
    const schema = standardSchema(
      (value) => ({ value }),
      () => ({
        ...objectSchema,
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
    );
    expect(() => toDraft07JsonSchema(schema)).toThrow(/unsupported draft/);
  });

  it("rejects arrays, booleans, async conversions, and declared non-draft-07 schemas", () => {
    expect(() => toDraft07JsonSchema([] as never)).toThrow(ToolSchemaError);
    expect(() => toDraft07JsonSchema(true as never)).toThrow(ToolSchemaError);
    expect(() =>
      toDraft07JsonSchema(
        standardSchema(
          (value) => ({ value }),
          () => Promise.resolve(objectSchema),
        ),
      ),
    ).toThrow(ToolSchemaError);
    expect(() =>
      toDraft07JsonSchema({
        ...objectSchema,
        $schema: "https://json-schema.org/draft/2020-12/schema",
      } as never),
    ).toThrow(/unsupported draft/);
  });
});

describe("argument validation", () => {
  it("awaits Zod safeParseAsync and returns transformed data", async () => {
    const safeParseAsync = vi.fn(async () => {
      await Promise.resolve();
      return { success: true as const, data: { value: "NORMALIZED" } };
    });
    const result = await validateToolArguments(
      zodLike({ safeParseAsync }),
      { value: "normalized" },
      { name: "normalize" },
    );

    expect(result).toEqual({ value: "NORMALIZED" });
    expect(safeParseAsync).toHaveBeenCalledWith({ value: "normalized" });
  });

  it("wraps Zod validation failures without executing product code", async () => {
    const cause = new Error("value must be a string");
    const schema = zodLike({
      safeParseAsync: vi.fn(async () => ({
        success: false as const,
        error: cause,
      })),
    });
    await expect(
      validateToolArguments(schema, { value: 1 }, { name: "echo" }),
    ).rejects.toMatchObject({
      cause,
      message: 'Invalid tool input for "echo": value must be a string',
      name: "ToolInputValidationError",
    });
  });

  it("awaits Standard Schema validation and preserves successful undefined values", async () => {
    const validate = vi.fn(async () => {
      await Promise.resolve();
      return { value: undefined };
    });
    await expect(
      validateToolArguments(standardSchema(validate), "ignored"),
    ).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith("ignored");
  });

  it("formats all Standard Schema issues and rejects malformed validator results", async () => {
    await expect(
      validateToolArguments(
        standardSchema(() => ({
          issues: [{ message: "first" }, {} as never, { message: "third" }],
        })),
        null,
        { name: "submit" },
      ),
    ).rejects.toThrow(
      'Invalid tool input for "submit": first; Invalid input; third',
    );
    await expect(
      validateToolArguments(
        standardSchema(() => ({ issues: [] }) as never),
        null,
      ),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });

  it("requires and awaits a host validator for structural JSON Schema", async () => {
    await expect(
      validateToolArguments(
        draft07ObjectSchema,
        { value: "x" },
        { name: "raw" },
      ),
    ).rejects.toThrow(
      'Structural JSON Schema tool "raw" requires validateArguments',
    );

    const structuralValidator = vi.fn(async (input, context) => ({
      ...(input as object),
      checked: context.parameters.type === "object",
    }));
    await expect(
      validateToolArguments(
        draft07ObjectSchema,
        { value: "x" },
        {
          name: "raw",
          structuralValidator,
          toolCallId: "call-1",
        },
      ),
    ).resolves.toEqual({ value: "x", checked: true });
    expect(structuralValidator).toHaveBeenCalledWith(
      { value: "x" },
      expect.objectContaining({ name: "raw", toolCallId: "call-1" }),
    );
  });
});

describe("result normalization", () => {
  it.each([
    ["string", "ready", "ready"],
    ["object", { ok: true }, '{"ok":true}'],
    ["undefined", undefined, "undefined"],
    ["bigint", 4n, "4"],
  ])("stringifies %s results consistently", (_label, value, expected) => {
    expect(stringifyToolResult(value)).toBe(expected);
  });

  it("falls back safely for cyclic and hostile results", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(stringifyToolResult(cyclic)).toBe("[object Object]");
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.toJSON = () => {
      throw new Error("no json");
    };
    hostile.toString = () => {
      throw new Error("no string");
    };
    expect(stringifyToolResult(hostile)).toBe("[Unserializable tool result]");
  });

  it("treats shaped Pi results as data unless passthrough is explicitly trusted", () => {
    const shaped: PiToolResult<{ raw: true }> = {
      content: [{ type: "text", text: "bounded" }],
      details: { raw: true },
      terminate: true,
      addedToolNames: ["read_more"],
    };
    expect(isPiToolResult(shaped)).toBe(true);
    expect(toPiToolResult(shaped)).toEqual({
      content: [{ type: "text", text: JSON.stringify(shaped) }],
      details: shaped,
    });
    expect(toPiToolResult(shaped, { trustPiResult: true })).toBe(shaped);
    expect(toPiToolResult(shaped, { trustPiResult: "true" } as never)).not.toBe(
      shaped,
    );
    const image: PiToolResult = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: null,
    };
    expect(toPiToolResult(image, { trustPiResult: true })).toBe(image);
    expect(toPiToolResult({ ok: true })).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: { ok: true },
    });
  });

  it.each([
    { content: ["not content"], details: {} },
    { content: [{ type: "text" }], details: {} },
    { content: [{ type: "image", data: "x" }], details: {} },
    { content: [], details: {}, terminate: "yes" },
    { content: [], details: {}, addedToolNames: [1] },
    { content: [], details: {}, usage: { input: 1 } },
  ])("does not preserve malformed result-like values", (value) => {
    expect(isPiToolResult(value)).toBe(false);
    expect(toPiToolResult(value, { trustPiResult: true })).toEqual({
      content: [{ type: "text", text: JSON.stringify(value) }],
      details: value,
    });
  });

  it("rejects sparse Pi result arrays", () => {
    const sparseContent = { content: Array(1), details: {} };
    const sparseTools = { content: [], details: {}, addedToolNames: Array(1) };
    expect(isPiToolResult(sparseContent)).toBe(false);
    expect(isPiToolResult(sparseTools)).toBe(false);
  });
});

describe("adaptPiTool", () => {
  it("returns a structural AgentTool and validates asynchronously before execution", async () => {
    const order: string[] = [];
    const execute = vi.fn(
      async (input: { value: string }, executionOptions) => {
        order.push("execute");
        expect(executionOptions).toEqual({
          abortSignal: undefined,
          onUpdate: undefined,
          toolCallId: "call-1",
        });
        return { value: input.value };
      },
    );
    const tool = adaptPiTool({
      name: "echo_value",
      label: ({ name }) => `  ${name.replaceAll("_", " ")}  `,
      definition: {
        description: "Echo a value",
        inputSchema: standardSchema(async (input) => {
          order.push("validate");
          return {
            value: { value: String((input as { value: unknown }).value) },
          };
        }),
        execute,
      },
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      executionMode: "sequential",
    });

    expect(tool).toMatchObject({
      name: "echo_value",
      label: "echo value",
      description: "Echo a value",
      executionMode: "sequential",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    });
    await expect(tool.execute("call-1", { value: 7 })).resolves.toEqual({
      content: [{ type: "text", text: '{"value":"7"}' }],
      details: { value: "7" },
    });
    expect(order).toEqual(["validate", "execute"]);
  });

  it("requires explicit trust for executor Pi results and control metadata, including updates", async () => {
    const shaped: PiToolResult = {
      content: [{ type: "text", text: "trusted" }],
      details: { source: "executor" },
      addedToolNames: ["next_tool"],
      terminate: true,
    };
    const definition = {
      inputSchema: standardSchema((value) => ({ value })),
      execute: async (
        _input: unknown,
        options: { onUpdate?: (update: unknown) => void },
      ) => {
        options.onUpdate?.(shaped);
        return shaped;
      },
    };
    const defaultUpdate = vi.fn();
    const defaultResult = await adaptPiTool({
      name: "default_data",
      definition,
    }).execute("call-default", {}, undefined, defaultUpdate);

    expect(defaultResult).toEqual({
      content: [{ type: "text", text: JSON.stringify(shaped) }],
      details: shaped,
    });
    expect(defaultUpdate).toHaveBeenCalledWith(defaultResult);
    expect(defaultResult).not.toHaveProperty("terminate");
    expect(defaultResult).not.toHaveProperty("addedToolNames");

    const trustedUpdate = vi.fn();
    const trustedResult = await adaptPiTool({
      name: "trusted_protocol",
      definition,
      trustExecutorResults: true,
    }).execute("call-trusted", {}, undefined, trustedUpdate);

    expect(trustedResult).toBe(shaped);
    expect(trustedUpdate).toHaveBeenCalledWith(shaped);
  });

  it("checks caller abort before validation and preserves the abort reason", async () => {
    const reason = new DOMException("cancelled", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);
    const validateArguments = vi.fn();
    const execute = vi.fn();
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: "write",
      definition: { inputSchema: draft07ObjectSchema, execute },
      validateArguments,
      onError,
    });

    await expect(
      tool.execute("call-abort", {}, controller.signal),
    ).rejects.toBe(reason);
    expect(validateArguments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        aborted: true,
        error: reason,
        phase: "validation",
        timedOut: false,
      }),
    );
  });

  it("settles promptly when aborted during asynchronous validation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop validating", "AbortError");
    const execute = vi.fn();
    const tool = adaptPiTool({
      name: "validate_forever",
      definition: {
        inputSchema: standardSchema(
          async () => await new Promise(() => undefined),
        ),
        execute,
      },
    });

    const execution = tool.execute(
      "call-validation-abort",
      {},
      controller.signal,
    );
    const rejection = expect(execution).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the timeout reason when the caller aborts later during cleanup", async () => {
    vi.useFakeTimers();
    const timeoutReason = new Error("timeout first");
    const callerReason = new Error("caller second");
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: "slow_cleanup",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () =>
          await new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
      timeoutMs: 10,
      createTimeoutError: () => timeoutReason,
      onError,
    });

    const execution = tool.execute("call-race", {}, controller.signal);
    const rejection = expect(execution).rejects.toBe(timeoutReason);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(callerReason);
    release?.();
    await rejection;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: timeoutReason,
        timedOut: true,
      }),
    );
  });

  it("preserves a safety-critical cleanup failure discovered after timeout", async () => {
    vi.useFakeTimers();
    const timeoutReason = new Error("ordinary timeout");
    const settlementFailure = Object.assign(
      new Error("settlement indeterminate"),
      {
        code: "operation_indeterminate",
      },
    );
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: "unsafe_cleanup",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) =>
          await new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => reject(settlementFailure),
              { once: true },
            );
          }),
      },
      timeoutMs: 10,
      createTimeoutError: () => timeoutReason,
      preferCaughtErrorOverAbort: (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "operation_indeterminate",
      onError,
    });

    const execution = tool.execute("call-indeterminate", {});
    const rejection = expect(execution).rejects.toBe(settlementFailure);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        aborted: true,
        error: settlementFailure,
        timedOut: true,
      }),
    );
  });

  it("ignores delayed progress after the product executor settles", async () => {
    let emitUpdate: ((update: unknown) => void) | undefined;
    let releaseResult: (() => void) | undefined;
    let mappingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      mappingStarted = resolve;
    });
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const onUpdate = vi.fn();
    const tool = adaptPiTool({
      name: "settled_progress",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) => {
          emitUpdate = options.onUpdate;
          return "done";
        },
      },
      mapResult: async (result) => {
        mappingStarted?.();
        await resultGate;
        return result;
      },
    });

    const execution = tool.execute("call-settled", {}, undefined, onUpdate);
    await started;
    emitUpdate?.("too late");
    expect(onUpdate).not.toHaveBeenCalled();
    releaseResult?.();
    await execution;
  });

  it("does not forward progress after cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const onUpdate = vi.fn();
    const tool = adaptPiTool({
      name: "late_progress",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) => {
          controller.abort(reason);
          options.onUpdate?.("too late");
          return "unused";
        },
      },
    });

    await expect(
      tool.execute("call-late", {}, controller.signal, onUpdate),
    ).rejects.toBe(reason);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("forwards mapped progress updates and lets the trusted hook shape updates", async () => {
    const shaped: PiToolResult = {
      content: [{ type: "text", text: "halfway" }],
      details: { percent: 50 },
    };
    const onUpdate = vi.fn();
    const mapUpdate = vi.fn((defaultResult, context) =>
      isPiToolResult(context.update)
        ? { ...context.update, details: { bounded: true } }
        : { ...defaultResult, details: { bounded: true } },
    );
    const tool = adaptPiTool({
      name: "exec",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) => {
          options.onUpdate?.(shaped);
          options.onUpdate?.({ stdout: "done" });
          return "complete";
        },
      },
      mapUpdate,
    });

    await tool.execute("call-update", {}, undefined, onUpdate);
    expect(mapUpdate.mock.calls[0]?.[0]).toEqual({
      content: [{ type: "text", text: JSON.stringify(shaped) }],
      details: shaped,
    });
    expect(onUpdate).toHaveBeenNthCalledWith(1, {
      ...shaped,
      details: { bounded: true },
    });
    expect(onUpdate).toHaveBeenNthCalledWith(2, {
      content: [{ type: "text", text: '{"stdout":"done"}' }],
      details: { bounded: true },
    });
  });

  it("supports asynchronous bounding/pagination and terminal/additional-tool metadata", async () => {
    const output = { rows: [1, 2, 3], privateCursor: "cursor" };
    const mapResult = vi.fn(async (_defaultResult, context) => ({
      content: [{ type: "text" as const, text: "page 1 of 2" }],
      details: { handle: "opaque-handle", original: context.output },
    }));
    const tool = adaptPiTool({
      name: "search",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () => output,
      },
      mapResult,
      resultMetadata: async () => ({
        addedToolNames: ["read_search_page"],
        terminate: true,
      }),
    });

    await expect(tool.execute("call-page", {})).resolves.toEqual({
      content: [{ type: "text", text: "page 1 of 2" }],
      details: { handle: "opaque-handle", original: output },
      addedToolNames: ["read_search_page"],
      terminate: true,
    });
  });

  it("aborts with a product-selected timeout and reports telemetry without replacing errors", async () => {
    vi.useFakeTimers();
    const mappedTimeout = new Error("BuilderToolBudgetExceeded");
    const onError = vi.fn(async () => {
      throw new Error("telemetry unavailable");
    });
    const tool = adaptPiTool({
      name: "exec",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) =>
          await new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason),
              { once: true },
            );
          }),
      },
      timeoutMs: ({ input }) => (input === undefined ? undefined : 25),
      createTimeoutError: ({ timeoutMs }) => {
        expect(timeoutMs).toBe(25);
        return mappedTimeout;
      },
      onError,
    });

    const execution = tool.execute("call-timeout", {});
    const rejection = expect(execution).rejects.toBe(mappedTimeout);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        aborted: true,
        error: mappedTimeout,
        phase: "execution",
        timedOut: true,
      }),
    );
  });

  it("uses a neutral TimeoutError and validates timeout ranges", async () => {
    const bad = adaptPiTool({
      name: "bad-timeout",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () => "unused",
      },
      timeoutMs: -1,
    });
    await expect(bad.execute("call-bad", {})).rejects.toBeInstanceOf(
      RangeError,
    );

    vi.useFakeTimers();
    const timed = adaptPiTool({
      name: "slow",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) =>
          await new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () =>
              reject(options.abortSignal?.reason),
            );
          }),
      },
      timeoutMs: 1,
    });
    const execution = timed.execute("call-slow", {});
    const rejection = expect(execution).rejects.toMatchObject({
      name: "TimeoutError",
      timeoutMs: 1,
    } satisfies Partial<ToolTimeoutError>);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it.each([
    [
      "validation",
      standardSchema(() => ({ issues: [{ message: "bad" }] })),
      async (): Promise<string> => "unused",
    ],
    [
      "execution",
      standardSchema((value) => ({ value })),
      async (): Promise<never> => {
        throw new Error("failed");
      },
    ],
  ] as const)("reports %s failures", async (phase, inputSchema, execute) => {
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: phase,
      definition: { inputSchema, execute },
      onError,
    });
    await expect(tool.execute(`call-${phase}`, {})).rejects.toBeDefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ phase }));
  });

  it("reports result-hook failures and rejects malformed hook output", async () => {
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: "bounded",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () => "ok",
      },
      mapResult: async () => ({ content: [] }) as never,
      onError,
    });
    await expect(tool.execute("call-result", {})).rejects.toThrow(
      "mapResult must return a valid Pi tool result",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "result" }),
    );
  });

  it("reports update-hook failures as update failures", async () => {
    const onError = vi.fn();
    const tool = adaptPiTool({
      name: "progress",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async (_input, options) => {
          options.onUpdate?.("partial");
          return "done";
        },
      },
      mapUpdate: () => {
        throw new Error("bad partial");
      },
      onError,
    });
    await expect(
      tool.execute("call-progress", {}, undefined, vi.fn()),
    ).rejects.toThrow("bad partial");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "update" }),
    );
  });

  it("rejects unavailable execution, empty labels, and malformed metadata", async () => {
    const unavailable = adaptPiTool({
      name: "missing",
      definition: { inputSchema: standardSchema((value) => ({ value })) },
    });
    await expect(unavailable.execute("call-missing", {})).rejects.toThrow(
      'Tool "missing" is not executable',
    );
    expect(() =>
      adaptPiTool({
        name: "blank",
        label: "  ",
        definition: { inputSchema: standardSchema((value) => ({ value })) },
      }),
    ).toThrow("Pi tool label must not be empty");

    const metadata = adaptPiTool({
      name: "metadata",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () => "ok",
      },
      resultMetadata: () => ({ addedToolNames: [1] }) as never,
    });
    await expect(metadata.execute("call-metadata", {})).rejects.toThrow(
      "resultMetadata.addedToolNames must contain only strings",
    );

    const sparseMetadata = adaptPiTool({
      name: "sparse_metadata",
      definition: {
        inputSchema: standardSchema((value) => ({ value })),
        execute: async () => "ok",
      },
      resultMetadata: () => ({ addedToolNames: Array(1) }),
    });
    await expect(sparseMetadata.execute("call-sparse", {})).rejects.toThrow(
      "resultMetadata.addedToolNames must contain only strings",
    );
  });
});

function standardSchema<T>(
  validate: StandardSchemaV1<T>["~standard"]["validate"],
  input: (options: Readonly<{ target: "draft-07" }>) => unknown = () =>
    objectSchema,
): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
      jsonSchema: { input },
    },
  };
}

function zodLike(
  overrides: Partial<{
    safeParseAsync: ZodSchemaLikeFixture["safeParseAsync"];
    toJSONSchema: ZodSchemaLikeFixture["toJSONSchema"];
  }> = {},
): ToolInputSchema {
  return {
    _zod: {},
    safeParseAsync:
      overrides.safeParseAsync ??
      (async (value) => ({ success: true as const, data: value })),
    toJSONSchema: overrides.toJSONSchema ?? (() => objectSchema),
  } as ToolInputSchema;
}

type ZodSchemaLikeFixture = {
  safeParseAsync(
    value: unknown,
  ): Promise<
    { success: true; data: unknown } | { success: false; error: unknown }
  >;
  toJSONSchema(options: unknown): unknown;
};
