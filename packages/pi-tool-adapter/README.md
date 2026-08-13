# @summonghost/pi-tool-adapter

A product-neutral boundary between application tools and Pi's `AgentTool` protocol. It standardizes schema exposure, argument validation, cancellation, updates, result shaping, and error observation without runtime imports from `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, TypeBox, or Zod.

The exported `PiAgentTool` and `PiToolResult` interfaces are compile-time checked against Pi 0.84.1's public protocol through an exact package dev dependency. The published package remains dependency-free, and a consumer can assign the return value of `adaptPiTool` directly to its locally installed `AgentTool` type.

## Exact integration API

```ts
const piTool = adaptPiTool({
  name,
  definition: { inputSchema, description?, execute? },
  label?,
  validateArguments?,
  timeoutMs?,
  createTimeoutError?,
  mapUpdate?,
  mapResult?,
  resultMetadata?,
  trustExecutorResults?,
  onError?,
  constrainedSampling?,
  executionMode?,
  zodUnrepresentable?,
});
```

`definition.execute(input, { toolCallId, abortSignal, onUpdate })` may be synchronous or asynchronous. `piTool.execute(toolCallId, inputFromPi, signal, onUpdate)` always:

1. checks the caller abort signal;
2. asynchronously validates and transforms arguments, racing that validation with caller cancellation;
3. checks cancellation again and installs the optional execution timeout signal;
4. runs the product executor;
5. checks cancellation after execution;
6. wraps executor output as data by default, then maps the result and applies optional Pi metadata.

The package also exports:

- `toDraft07JsonSchema(schema, options?)`
- `validateToolArguments(schema, input, options?)`
- `stringifyToolResult(value)`
- `isPiToolResult(value)`
- `toPiToolResult(value, { trustPiResult? })`
- structural protocol and hook types
- `ToolSchemaError`, `ToolInputValidationError`, and `ToolTimeoutError`

## Schemas and validation

### Zod 4

Zod is detected structurally. The adapter calls the schema's own:

```ts
schema.toJSONSchema({
  io: "input",
  target: "draft-07",
  unrepresentable: "throw", // or the configured "any"
});
await schema.safeParseAsync(rawInput);
```

This keeps Zod owned and versioned by the product while still supporting asynchronous refinements and transformed inputs. Pi itself performs provider-facing draft-07 validation before `AgentTool.execute` and may clone or coerce model arguments. The adapter's explicit Zod validation is a second trust-boundary check over the value received from Pi, not the original provider payload.

### Standard Schema v1

The schema must provide both Standard Schema validation and its JSON Schema extension:

```ts
{
  "~standard": {
    version: 1,
    vendor: "my-validator",
    validate: async (input) => ({ value: validatedInput }),
    jsonSchema: {
      input: ({ target: "draft-07" }) => draft07Schema,
    },
  },
}
```

Validation results with issues reject before execution. Successful transformed values, including `undefined`, are passed through. JSON Schema conversion is synchronous; a Standard Schema extension that returns a promise is rejected. Because the adapter explicitly requests the `draft-07` target from Zod and Standard Schema, an otherwise valid generated object without `$schema` is labeled as Draft-07; an explicit conflicting declaration is rejected.

### Structural JSON Schema

Direct Draft-07 objects and `{ jsonSchema }` / `{ schema }` wrappers are supported only when the structural schema itself explicitly declares Draft-07 with `$schema`. Unlabeled schemas, malformed or ambiguous wrappers, and non-Draft-07 declarations are rejected rather than inferred or silently misrepresented. Accepted explicit declarations are passed through unchanged.

A structural schema has no executable validator, so `adaptPiTool` requires the host's real draft-07 validator:

```ts
const tool = adaptPiTool({
  name: "capability",
  definition,
  validateArguments: async (raw, { parameters, name, toolCallId }) => {
    return capabilityValidator.parseAsync(parameters, raw, { name, toolCallId });
  },
});
```

This is deliberate: model/provider schema checks are not a trust boundary, and this package does not ship an incomplete JSON Schema validator.

## Product hooks

All hooks are mechanisms; the host supplies policy.

- **Labels:** `label` is a string or resolver. Empty labels fail at adaptation time.
- **Timeout:** `timeoutMs` is a number or per-call resolver. It starts after validation and creates a cooperative execution abort signal. `createTimeoutError` maps expiry to a product error; otherwise `ToolTimeoutError` is used. There is no default timeout.
- **Updates:** executor updates are wrapped as data by default. `mapUpdate` is a trusted host hook that can bound or explicitly reshape each update into a Pi result before Pi receives it.
- **Bounding and pagination:** `mapResult(defaultResult, context)` is a trusted host hook that can invoke a result boundary/store and return bounded text plus opaque pagination details. A synchronous store provides retention, not async durability; hosts coordinate durable persistence outside that boundary. There are no package-selected size or retention limits.
- **Terminal/dynamic-tool metadata:** `resultMetadata(context)` is a trusted host hook that supplies Pi's `terminate` and `addedToolNames` fields. `addedToolNames` declares names already introduced by the host; it does not register tools or change Pi's active tool set. Product-specific registration and marker names stay outside this package.
- **Trusted executor Pi results:** `trustExecutorResults: true` preserves valid pre-shaped Pi results emitted as either final output or updates, including their control metadata. Leave it unset unless every executor behind the adapter is trusted to control Pi. Prefer the narrower mapping and metadata hooks when possible.
- **Telemetry:** `onError` receives `{ name, toolCallId, phase, error, aborted, timedOut, durationMs }`. It intentionally receives no arguments or output. Telemetry failures are suppressed so they cannot replace the original tool error.
- **Pi pass-through:** `executionMode` and `constrainedSampling` are emitted structurally.

### Bounding example

```ts
const piTool = adaptPiTool({
  name: "search",
  definition,
  mapResult: async (defaultResult, { output, name, toolCallId }) => {
    const delivered = boundary.deliver({
      content: defaultResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      toolName: name,
      toolCallId,
    });
    return {
      content: [{ type: "text", text: delivered.text }],
      details: delivered.details ?? output,
    };
  },
  resultMetadata: ({ output }) => ({
    terminate: isProductTerminalResult(output),
    addedToolNames: additionalToolsFor(output),
  }),
});
```

In this example, `boundary.deliver` and its injected retention store are synchronous. The provided `@summonghost/tool-results` store is in-memory and non-durable; a host that requires async durable persistence coordinates it outside this mapping boundary.

## Mapping the three existing adapters

- **ask-dan:** pass Zod schemas directly; pass capability JSON schemas with the existing capability validator as `validateArguments`; map `__danTerminateAgent` in `resultMetadata`.
- **summon-ghost:** use `label` for titles, adapt AI SDK `toModelOutput` inside `mapResult`, call the existing `ToolResultBoundary` there, and retain original errors in `onError`.
- **ghost-build:** set `label` from the builder label map, resolve `timeoutMs` from builder budgets, map expiry with `createTimeoutError`, and forward canonical progress through the default `onUpdate` bridge or `mapUpdate`.

Executor results and updates are always treated as ordinary data unless `trustExecutorResults` is true or a trusted mapping hook explicitly returns a Pi result. Likewise, `toPiToolResult` wraps values as data unless `{ trustPiResult: true }` is passed. Trusted valid Pi results are preserved by identity; the shape check validates every text/image content item plus optional usage and metadata fields. Malformed result-like values remain ordinary data. Data uses deterministic stringification: strings pass through, JSON-serializable values use compact JSON, then `String(value)`, then a fixed unreadable fallback.

## Compatibility and security

The package is dependency-free and contains no agent-loop, authorization, persistence, timeout duration, result size, pagination retention, terminal-marker, or telemetry transport policy. Executor-controlled objects that happen to match Pi's result shape cannot set `terminate`, declare added tools, inject usage, or bypass default data rendering unless the host explicitly enables trusted passthrough or does so in a trusted hook. Hosts remain responsible for authorization, tenant isolation, side-effect idempotency, complete structural JSON Schema validation, coordinating any async durable pagination persistence outside synchronous result boundaries, and deciding which tool failures are safe to expose to a model.
