export type Awaitable<T> = T | PromiseLike<T>;
/** A JSON Schema object accepted structurally by Pi without importing Pi or TypeBox. */
export type Draft07JsonSchema = Readonly<Record<string, unknown>>;
export type PiTextContent = {
    type: "text";
    text: string;
    textSignature?: string;
};
export type PiImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};
export type PiToolContent = PiTextContent | PiImageContent;
export type PiToolUsage = Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: Readonly<{
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    }>;
}>;
export type PiConstrainedSampling = false | Readonly<{
    type: "json_schema";
    strict: "prefer" | "require";
}> | Readonly<{
    type: "grammar";
    variants: Partial<Record<"openai_lark" | "openai_regex", string>>;
}>;
/** Structural counterpart of Pi's AgentToolResult. */
export interface PiToolResult<TDetails = unknown> {
    content: PiToolContent[];
    details: TDetails;
    usage?: PiToolUsage;
    addedToolNames?: string[];
    terminate?: boolean;
}
export type PiToolUpdateCallback<TDetails = unknown> = (partialResult: PiToolResult<TDetails>) => void;
/** Structural counterpart of Pi's AgentTool. */
export interface PiAgentTool<TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: Draft07JsonSchema;
    constrainedSampling?: PiConstrainedSampling;
    executionMode?: "parallel" | "sequential";
    execute(toolCallId: string, parameters: unknown, signal?: AbortSignal, onUpdate?: PiToolUpdateCallback<TDetails>): Promise<PiToolResult<TDetails>>;
}
export type StandardSchemaIssue = Readonly<{
    message?: string;
    path?: unknown;
}>;
export type StandardSchemaResult<T = unknown> = Readonly<{
    value: T;
    issues?: undefined;
}> | Readonly<{
    issues: readonly StandardSchemaIssue[];
}>;
export interface StandardSchemaV1<T = unknown> {
    readonly "~standard": Readonly<{
        version: 1;
        vendor: string;
        validate(value: unknown): Awaitable<StandardSchemaResult<T>>;
        jsonSchema?: Readonly<{
            input(options: Readonly<{
                target: "draft-07";
            }>): unknown;
        }>;
    }>;
}
export interface ZodSchemaLike<T = unknown> {
    readonly _zod?: unknown;
    safeParseAsync(value: unknown): Promise<Readonly<{
        success: true;
        data: T;
    }> | Readonly<{
        success: false;
        error: unknown;
    }>>;
    toJSONSchema(options: Readonly<{
        io: "input";
        target: "draft-07";
        unrepresentable: "any" | "throw";
    }>): unknown;
}
export type ToolInputSchema = Draft07JsonSchema | StandardSchemaV1<unknown> | ZodSchemaLike<unknown> | Readonly<{
    jsonSchema: Draft07JsonSchema;
}> | Readonly<{
    schema: Draft07JsonSchema;
}>;
export type ToolExecutionOptions = Readonly<{
    abortSignal?: AbortSignal;
    onUpdate?: (update: unknown) => void;
    toolCallId: string;
}>;
export type ToolDefinition<TInput = unknown, TOutput = unknown> = Readonly<{
    description?: string;
    execute?: (input: TInput, options: ToolExecutionOptions) => Awaitable<TOutput>;
    inputSchema: ToolInputSchema;
}>;
export type ToolInvocationContext<TInput = unknown> = Readonly<{
    input: TInput;
    name: string;
    signal?: AbortSignal;
    toolCallId: string;
}>;
export type ToolResultContext<TInput = unknown, TOutput = unknown> = ToolInvocationContext<TInput> & Readonly<{
    output: TOutput;
}>;
export type ToolUpdateContext<TInput = unknown> = ToolInvocationContext<TInput> & Readonly<{
    update: unknown;
}>;
export type ToolResultMetadata = Readonly<{
    addedToolNames?: readonly string[];
    terminate?: boolean;
}>;
export type ToPiToolResultOptions = Readonly<{
    /** Treat a valid pre-shaped Pi result as trusted protocol data. */
    trustPiResult?: boolean;
}>;
export type ToolErrorPhase = "validation" | "execution" | "update" | "result";
export type ToolErrorEvent = Readonly<{
    aborted: boolean;
    durationMs: number;
    error: unknown;
    name: string;
    phase: ToolErrorPhase;
    timedOut: boolean;
    toolCallId: string;
}>;
export type StructuralArgumentValidator<TInput> = (input: unknown, context: Readonly<{
    name: string;
    parameters: Draft07JsonSchema;
    toolCallId: string;
}>) => Awaitable<TInput>;
export type AdaptPiToolOptions<TInput = unknown, TOutput = unknown, TDetails = unknown> = Readonly<{
    name: string;
    definition: ToolDefinition<TInput, TOutput>;
    label?: string | ((context: Readonly<{
        definition: ToolDefinition<TInput, TOutput>;
        name: string;
    }>) => string);
    /** Required for structural JSON Schema; optional override for Zod/Standard Schema. */
    validateArguments?: StructuralArgumentValidator<TInput>;
    /** Product-selected timeout. The adapter supplies only the timer/abort mechanism. */
    timeoutMs?: number | ((context: ToolInvocationContext<TInput>) => number | undefined);
    createTimeoutError?: (context: ToolInvocationContext<TInput> & Readonly<{
        timeoutMs: number;
    }>) => unknown;
    mapUpdate?: (defaultResult: PiToolResult<unknown>, context: ToolUpdateContext<TInput>) => PiToolResult<unknown>;
    /** Bound, paginate, redact, or otherwise reshape a completed result. */
    mapResult?: (defaultResult: PiToolResult<unknown>, context: ToolResultContext<TInput, TOutput>) => Awaitable<PiToolResult<TDetails>>;
    resultMetadata?: (context: ToolResultContext<TInput, TOutput>) => Awaitable<ToolResultMetadata | undefined>;
    /** Trust pre-shaped Pi results emitted by the executor, including updates. */
    trustExecutorResults?: boolean;
    onError?: (event: ToolErrorEvent) => Awaitable<void>;
    constrainedSampling?: PiConstrainedSampling;
    executionMode?: "parallel" | "sequential";
    zodUnrepresentable?: "any" | "throw";
}>;
export type ValidateToolArgumentsOptions<TInput> = Readonly<{
    name?: string;
    structuralValidator?: StructuralArgumentValidator<TInput>;
    toolCallId?: string;
}>;
export declare class ToolSchemaError extends Error {
    readonly name = "ToolSchemaError";
}
export declare class ToolInputValidationError extends Error {
    readonly name = "ToolInputValidationError";
    constructor(toolName: string, message: string, cause?: unknown);
}
export declare class ToolTimeoutError extends Error {
    readonly name = "TimeoutError";
    readonly timeoutMs: number;
    constructor(toolName: string, timeoutMs: number);
}
/** Convert Zod 4, Standard Schema JSON Schema extensions, and structural schemas. */
export declare function toDraft07JsonSchema(schema: ToolInputSchema, options?: Readonly<{
    zodUnrepresentable?: "any" | "throw";
}>): Draft07JsonSchema;
/**
 * Asynchronously validate and return transformed arguments. Structural JSON
 * Schema requires a host validator because this dependency-free package does
 * not pretend to implement the complete draft-07 validation specification.
 */
export declare function validateToolArguments<TInput = unknown>(schema: ToolInputSchema, input: unknown, options?: ValidateToolArgumentsOptions<TInput>): Promise<TInput>;
/** Deterministic, non-throwing model text conversion for ordinary results. */
export declare function stringifyToolResult(value: unknown): string;
export declare function isPiToolResult(value: unknown): value is PiToolResult<unknown>;
/** Wrap a value as data, unless trusted Pi-result passthrough is explicit. */
export declare function toPiToolResult<TDetails = unknown>(value: unknown, options?: ToPiToolResultOptions): PiToolResult<TDetails>;
/** Adapt one product tool to the current structural Pi AgentTool contract. */
export declare function adaptPiTool<TInput = unknown, TOutput = unknown, TDetails = unknown>(options: AdaptPiToolOptions<TInput, TOutput, TDetails>): PiAgentTool<TDetails>;
