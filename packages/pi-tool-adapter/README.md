# @summonghost/pi-tool-adapter

A product-neutral boundary between application tools and Pi's `AgentTool` protocol. It standardizes schema exposure, argument validation, cancellation, updates, result shaping, and error observation without importing or pinning `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, TypeBox, or Zod.

The exported `PiAgentTool` and `PiToolResult` interfaces structurally match Pi 0.83's public protocol. A consumer can assign the return value of `adaptPiTool` directly to its locally installed `AgentTool` type.

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
6. preserves or maps the result and applies optional Pi metadata.

The package also exports:

- `toDraft07JsonSchema(schema, options?)`
- `validateToolArguments(schema, input, options?)`
- `stringifyToolResult(value)`
- `isPiToolResult(value)`
- `toPiToolResult(value)`
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

Validation results with issues reject before execution. Successful transformed values, including `undefined`, are passed through. JSON Schema conversion is synchronous; a Standard Schema extension that returns a promise is rejected.

### Structural JSON Schema

Direct draft-07 objects and `{ jsonSchema }` / `{ schema }` wrappers are supported. A declared non-draft-07 `$schema` is rejected rather than silently misrepresenting unsupported keywords.

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
- **Updates:** raw executor updates are normalized to Pi results. `mapUpdate` can bound or reshape each update before Pi receives it.
- **Bounding and pagination:** `mapResult(defaultResult, context)` can invoke a host result boundary/store and return bounded text plus opaque pagination details. There are no package-selected size or retention limits.
- **Terminal/dynamic-tool metadata:** `resultMetadata(context)` supplies Pi's `terminate` and `addedToolNames` fields. `addedToolNames` declares names already introduced by the host; it does not register tools or change Pi's active tool set. Product-specific registration and marker names stay outside this package.
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

## Mapping the three existing adapters

- **ask-dan:** pass Zod schemas directly; pass capability JSON schemas with the existing capability validator as `validateArguments`; map `__danTerminateAgent` in `resultMetadata`.
- **summon-ghost:** use `label` for titles, adapt AI SDK `toModelOutput` inside `mapResult`, call the existing `ToolResultBoundary` there, and retain original errors in `onError`.
- **ghost-build:** set `label` from the builder label map, resolve `timeoutMs` from builder budgets, map expiry with `createTimeoutError`, and forward canonical progress through the default `onUpdate` bridge or `mapUpdate`.

Valid already-shaped Pi results are returned by identity when no result or metadata hook changes them. The shape check validates every text/image content item plus optional usage and metadata fields; malformed result-like values are treated as ordinary values. Ordinary results use deterministic stringification: strings pass through, JSON-serializable values use compact JSON, then `String(value)`, then a fixed unreadable fallback.

## Compatibility and security

The package is dependency-free and contains no agent-loop, authorization, persistence, timeout duration, result size, pagination retention, terminal-marker, or telemetry transport policy. Hosts remain responsible for authorization, tenant isolation, side-effect idempotency, complete structural JSON Schema validation, durable pagination storage, and deciding which tool failures are safe to expose to a model.
