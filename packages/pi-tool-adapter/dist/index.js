const DRAFT_07_SCHEMA = "http://json-schema.org/draft-07/schema#";
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
export class ToolSchemaError extends Error {
    name = "ToolSchemaError";
}
export class ToolInputValidationError extends Error {
    name = "ToolInputValidationError";
    constructor(toolName, message, cause) {
        super(`Invalid tool input for "${toolName}": ${message}`, { cause });
    }
}
export class ToolTimeoutError extends Error {
    name = "TimeoutError";
    timeoutMs;
    constructor(toolName, timeoutMs) {
        super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
    }
}
/** Convert Zod 4, Standard Schema JSON Schema extensions, and structural schemas. */
export function toDraft07JsonSchema(schema, options = {}) {
    let converted;
    if (isZodSchema(schema)) {
        converted = schema.toJSONSchema({
            io: "input",
            target: "draft-07",
            unrepresentable: options.zodUnrepresentable ?? "throw",
        });
    }
    else if (isStandardSchema(schema)) {
        const input = schema["~standard"].jsonSchema?.input;
        if (!input) {
            throw new ToolSchemaError("Standard Schema tool inputs must expose ~standard.jsonSchema.input");
        }
        converted = input({ target: "draft-07" });
    }
    else {
        return requireDeclaredDraft07Object(unwrapStructuralSchema(schema));
    }
    return normalizeGeneratedDraft07Object(converted);
}
/**
 * Asynchronously validate and return transformed arguments. Structural JSON
 * Schema requires a host validator because this dependency-free package does
 * not pretend to implement the complete draft-07 validation specification.
 */
export async function validateToolArguments(schema, input, options = {}) {
    const name = options.name ?? "tool";
    if (options.structuralValidator) {
        const parameters = toDraft07JsonSchema(schema);
        return await options.structuralValidator(input, {
            name,
            parameters,
            toolCallId: options.toolCallId ?? "",
        });
    }
    if (isZodSchema(schema)) {
        const result = await schema.safeParseAsync(input);
        if (result.success)
            return result.data;
        throw new ToolInputValidationError(name, errorMessage(result.error), result.error);
    }
    if (isStandardSchema(schema)) {
        let result;
        try {
            result = await schema["~standard"].validate(input);
        }
        catch (error) {
            throw new ToolInputValidationError(name, errorMessage(error), error);
        }
        if ("issues" in result && result.issues && result.issues.length > 0) {
            throw new ToolInputValidationError(name, formatIssues(result.issues));
        }
        if ("value" in result)
            return result.value;
        throw new ToolInputValidationError(name, "validator returned no value");
    }
    throw new ToolSchemaError(`Structural JSON Schema tool "${name}" requires validateArguments`);
}
/** Deterministic, non-throwing model text conversion for ordinary results. */
export function stringifyToolResult(value) {
    if (typeof value === "string")
        return value;
    try {
        const json = JSON.stringify(value);
        if (json !== undefined)
            return json;
    }
    catch {
        // Fall through to the language string representation.
    }
    try {
        return String(value);
    }
    catch {
        return "[Unserializable tool result]";
    }
}
export function isPiToolResult(value) {
    if (!isObject(value) ||
        !Array.isArray(value.content) ||
        !("details" in value)) {
        return false;
    }
    if (!Array.from(value.content).every(isPiToolContent))
        return false;
    if ("terminate" in value &&
        value.terminate !== undefined &&
        typeof value.terminate !== "boolean") {
        return false;
    }
    if ("addedToolNames" in value &&
        value.addedToolNames !== undefined &&
        (!Array.isArray(value.addedToolNames) ||
            !Array.from(value.addedToolNames).every((name) => typeof name === "string"))) {
        return false;
    }
    return (!("usage" in value) ||
        value.usage === undefined ||
        isPiToolUsage(value.usage));
}
/** Wrap a value as data, unless trusted Pi-result passthrough is explicit. */
export function toPiToolResult(value, options = {}) {
    if (options.trustPiResult === true && isPiToolResult(value)) {
        return value;
    }
    return {
        content: [{ type: "text", text: stringifyToolResult(value) }],
        details: value,
    };
}
/** Adapt one product tool to the current structural Pi AgentTool contract. */
export function adaptPiTool(options) {
    const { definition, name } = options;
    const parameters = toDraft07JsonSchema(definition.inputSchema, {
        zodUnrepresentable: options.zodUnrepresentable,
    });
    const label = resolveLabel(options);
    const tool = {
        name,
        label,
        description: definition.description ?? name,
        parameters,
        execute: async (toolCallId, rawInput, signal, onUpdate) => {
            const startedAt = Date.now();
            let phase = "validation";
            let timeoutController;
            let timeoutId;
            let executionSignal = signal;
            let abortSource;
            const markCallerAbort = () => {
                abortSource ??= "caller";
            };
            signal?.addEventListener("abort", markCallerAbort, { once: true });
            try {
                throwIfAborted(signal);
                const validation = options.validateArguments
                    ? options.validateArguments(rawInput, {
                        name,
                        parameters,
                        toolCallId,
                    })
                    : validateToolArguments(definition.inputSchema, rawInput, {
                        name,
                        toolCallId,
                    });
                const input = await awaitWithAbort(validation, signal);
                throwIfAborted(signal);
                const invocation = { input, name, signal, toolCallId };
                phase = "execution";
                const timeoutMs = resolveTimeout(options.timeoutMs, invocation);
                if (timeoutMs !== undefined) {
                    timeoutController = new AbortController();
                    timeoutId = setTimeout(() => {
                        if (abortSource !== undefined)
                            return;
                        abortSource = "timeout";
                        const context = { ...invocation, timeoutMs };
                        let reason;
                        try {
                            reason =
                                options.createTimeoutError?.(context) ??
                                    new ToolTimeoutError(name, timeoutMs);
                        }
                        catch (error) {
                            reason = error;
                        }
                        timeoutController?.abort(reason);
                    }, timeoutMs);
                    executionSignal = signal
                        ? AbortSignal.any([signal, timeoutController.signal])
                        : timeoutController.signal;
                }
                throwIfAborted(executionSignal);
                if (!definition.execute) {
                    throw new Error(`Tool "${name}" is not executable`);
                }
                let updatesOpen = true;
                let output;
                try {
                    output = await definition.execute(input, {
                        abortSignal: executionSignal,
                        onUpdate: onUpdate
                            ? (update) => {
                                if (!updatesOpen)
                                    return;
                                const previousPhase = phase;
                                phase = "update";
                                try {
                                    throwIfAborted(executionSignal);
                                    const defaultResult = toPiToolResult(update, {
                                        trustPiResult: options.trustExecutorResults,
                                    });
                                    const mapped = options.mapUpdate?.(defaultResult, {
                                        input,
                                        name,
                                        signal: executionSignal,
                                        toolCallId,
                                        update,
                                    }) ?? defaultResult;
                                    assertPiToolResult(mapped, "mapUpdate");
                                    throwIfAborted(executionSignal);
                                    onUpdate(mapped);
                                    phase = previousPhase;
                                }
                                catch (error) {
                                    phase = "update";
                                    throw error;
                                }
                            }
                            : undefined,
                        toolCallId,
                    });
                }
                finally {
                    updatesOpen = false;
                }
                throwIfAborted(executionSignal);
                phase = "result";
                const context = {
                    input,
                    name,
                    output,
                    signal: executionSignal,
                    toolCallId,
                };
                const defaultResult = toPiToolResult(output, {
                    trustPiResult: options.trustExecutorResults,
                });
                let result = options.mapResult
                    ? await options.mapResult(defaultResult, context)
                    : defaultResult;
                assertPiToolResult(result, "mapResult");
                throwIfAborted(executionSignal);
                const metadata = await options.resultMetadata?.(context);
                if (metadata !== undefined)
                    result = applyMetadata(result, metadata);
                throwIfAborted(executionSignal);
                return result;
            }
            catch (caught) {
                const aborted = abortSource !== undefined || executionSignal?.aborted === true;
                const timedOut = abortSource === "timeout";
                const error = aborted &&
                    executionSignal?.aborted &&
                    !options.preferCaughtErrorOverAbort?.(caught)
                    ? abortReason(executionSignal)
                    : caught;
                await reportError(options.onError, {
                    aborted,
                    durationMs: Date.now() - startedAt,
                    error,
                    name,
                    phase,
                    timedOut,
                    toolCallId,
                });
                throw error;
            }
            finally {
                if (timeoutId !== undefined)
                    clearTimeout(timeoutId);
                signal?.removeEventListener("abort", markCallerAbort);
            }
        },
    };
    if (options.constrainedSampling !== undefined) {
        tool.constrainedSampling = options.constrainedSampling;
    }
    if (options.executionMode !== undefined)
        tool.executionMode = options.executionMode;
    return tool;
}
function isZodSchema(value) {
    if (!isObject(value))
        return false;
    return (typeof value.safeParseAsync === "function" &&
        typeof value.toJSONSchema === "function" &&
        ("_zod" in value || "_def" in value));
}
function isStandardSchema(value) {
    if (!isObject(value) || !("~standard" in value))
        return false;
    const standard = value["~standard"];
    return (isObject(standard) &&
        standard.version === 1 &&
        typeof standard.vendor === "string" &&
        typeof standard.validate === "function");
}
function unwrapStructuralSchema(schema) {
    if (!isObject(schema))
        return schema;
    const candidate = schema;
    const hasDeclaration = Object.hasOwn(candidate, "$schema");
    const hasJsonSchema = Object.hasOwn(candidate, "jsonSchema");
    const hasSchema = Object.hasOwn(candidate, "schema");
    if (hasDeclaration && (hasJsonSchema || hasSchema)) {
        throw new ToolSchemaError("Structural tool schema must not mix $schema with wrapper fields");
    }
    if (hasDeclaration)
        return schema;
    if (hasJsonSchema && hasSchema) {
        throw new ToolSchemaError("Structural tool schema wrapper must declare only jsonSchema or schema");
    }
    if (hasJsonSchema || hasSchema) {
        const wrapped = hasJsonSchema ? candidate.jsonSchema : candidate.schema;
        if (!isObject(wrapped)) {
            throw new ToolSchemaError("Structural tool schema wrapper must contain a JSON Schema object");
        }
        return wrapped;
    }
    return schema;
}
function requireDeclaredDraft07Object(value) {
    const schema = requireSchemaObject(value);
    if (Object.hasOwn(schema, "jsonSchema") || Object.hasOwn(schema, "schema")) {
        throw new ToolSchemaError("Structural tool schema must not mix $schema with wrapper fields");
    }
    if (!Object.hasOwn(schema, "$schema")) {
        throw new ToolSchemaError("Structural tool schema must explicitly declare Draft-07 with $schema");
    }
    return requireDraft07Identifier(schema);
}
function normalizeGeneratedDraft07Object(value) {
    const schema = requireSchemaObject(value);
    if (!Object.hasOwn(schema, "$schema") || schema.$schema === undefined) {
        return { ...schema, $schema: DRAFT_07_SCHEMA };
    }
    return requireDraft07Identifier(schema);
}
function requireSchemaObject(value) {
    if (!isObject(value) || typeof value.then === "function") {
        throw new ToolSchemaError("Tool input schema must convert to a JSON Schema object");
    }
    return value;
}
function requireDraft07Identifier(schema) {
    if (typeof schema.$schema !== "string" ||
        !isDraft07Identifier(schema.$schema)) {
        throw new ToolSchemaError(`Tool input schema declares unsupported draft: ${String(schema.$schema)}`);
    }
    return schema;
}
function isDraft07Identifier(value) {
    return /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(value);
}
function resolveLabel(options) {
    const label = typeof options.label === "function"
        ? options.label({ definition: options.definition, name: options.name })
        : (options.label ?? options.name);
    const trimmed = label.trim();
    if (!trimmed)
        throw new TypeError("Pi tool label must not be empty");
    return trimmed;
}
function resolveTimeout(timeout, context) {
    const value = typeof timeout === "function" ? timeout(context) : timeout;
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_TIMER_MILLISECONDS) {
        throw new RangeError(`Tool timeout must be an integer from 0 to ${MAX_TIMER_MILLISECONDS} milliseconds`);
    }
    return value;
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw abortReason(signal);
}
function abortReason(signal) {
    if (signal.reason !== undefined)
        return signal.reason;
    return new DOMException("Tool execution was aborted", "AbortError");
}
function applyMetadata(result, metadata) {
    if (metadata.terminate !== undefined &&
        typeof metadata.terminate !== "boolean") {
        throw new TypeError("resultMetadata.terminate must be a boolean");
    }
    let addedToolNames;
    if (metadata.addedToolNames !== undefined) {
        if (!Array.isArray(metadata.addedToolNames) ||
            !Array.from(metadata.addedToolNames).every((name) => typeof name === "string")) {
            throw new TypeError("resultMetadata.addedToolNames must contain only strings");
        }
        addedToolNames = [...metadata.addedToolNames];
    }
    return {
        ...result,
        ...(metadata.terminate === undefined
            ? {}
            : { terminate: metadata.terminate }),
        ...(addedToolNames === undefined ? {} : { addedToolNames }),
    };
}
function isPiToolContent(value) {
    if (!isObject(value) || typeof value.type !== "string")
        return false;
    if (value.type === "text") {
        return (typeof value.text === "string" &&
            (!("textSignature" in value) ||
                value.textSignature === undefined ||
                typeof value.textSignature === "string"));
    }
    return (value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string");
}
function isPiToolUsage(value) {
    if (!isObject(value) || !isObject(value.cost))
        return false;
    return ([
        value.input,
        value.output,
        value.cacheRead,
        value.cacheWrite,
        value.totalTokens,
        value.cost.input,
        value.cost.output,
        value.cost.cacheRead,
        value.cost.cacheWrite,
        value.cost.total,
    ].every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
        (!("cacheWrite1h" in value) ||
            value.cacheWrite1h === undefined ||
            typeof value.cacheWrite1h === "number") &&
        (!("reasoning" in value) ||
            value.reasoning === undefined ||
            typeof value.reasoning === "number"));
}
function assertPiToolResult(value, hook) {
    if (!isPiToolResult(value)) {
        throw new TypeError(`${hook} must return a valid Pi tool result`);
    }
}
async function awaitWithAbort(value, signal) {
    if (!signal)
        return await value;
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
        const abort = () => reject(abortReason(signal));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(value).then((result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
        }, (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}
async function reportError(reporter, event) {
    if (!reporter)
        return;
    try {
        await reporter(event);
    }
    catch {
        // Telemetry must never replace the tool error seen by the runtime.
    }
}
function formatIssues(issues) {
    return issues
        .map((issue) => issue.message?.trim() || "Invalid input")
        .join("; ");
}
function errorMessage(error) {
    if (error instanceof Error && error.message)
        return error.message;
    try {
        return String(error);
    }
    catch {
        return "validation failed";
    }
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
