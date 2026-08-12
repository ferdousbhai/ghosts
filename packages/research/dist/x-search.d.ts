import { z } from "zod";
export declare const X_SEARCH_MAX_RESULTS = 60;
export declare const X_SEARCH_MAX_TEXT_CHARACTERS = 25000;
export declare const xSearchOutputSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        url: z.ZodURL;
        author_handle: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
        date: z.ZodNullable<z.ZodISODate>;
        engagement: z.ZodNullable<z.ZodObject<{
            likes: z.ZodNullable<z.ZodNumber>;
            reposts: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type XSearchItem = z.infer<typeof xSearchOutputSchema>["items"][number];
export type NativeXSearchToolOptions = Readonly<{
    allowedXHandles?: readonly string[];
    enableImageUnderstanding?: boolean;
    enableVideoUnderstanding?: boolean;
    excludedXHandles?: readonly string[];
    fromDate?: string;
    toDate?: string;
}>;
export type NativeXSearchRequest = Readonly<{
    input: readonly Readonly<{
        content: string;
        role: "user";
    }>[];
    instructions: string;
    max_output_tokens?: number;
    model: string;
    store: false;
    text: Readonly<{
        format: Readonly<{
            description: string;
            name: string;
            schema: Readonly<Record<string, unknown>>;
            strict: true;
            type: "json_schema";
        }>;
    }>;
    tool_choice: "required";
    tools: readonly Readonly<Record<string, unknown>>[];
}>;
export type NativeXSearchTransport = (request: NativeXSearchRequest, options: Readonly<{
    signal: AbortSignal;
}>) => Promise<unknown>;
export type NativeXSearchUsage = Readonly<{
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    totalTokens: number;
    raw: unknown;
}>;
export type NativeXSearchRun = Readonly<{
    items: readonly XSearchItem[];
    totalUsage: NativeXSearchUsage;
}>;
export interface RunNativeXSearchOptions {
    abortSignal?: AbortSignal;
    maxItems?: number;
    maxOutputTokens?: number;
    model: string;
    nativeToolOptions?: NativeXSearchToolOptions;
    outputDescription?: string;
    outputName?: string;
    prompt: string;
    timeoutMs?: number;
    transport: NativeXSearchTransport;
}
/** Build a provider-native xAI Responses payload without binding to an SDK. */
export declare function buildNativeXSearchRequest(options: Omit<RunNativeXSearchOptions, "abortSignal" | "maxItems" | "timeoutMs" | "transport">): NativeXSearchRequest;
/** Normalize an xAI Responses result, validating structured output and usage. */
export declare function normalizeNativeXSearchResult(untrusted: unknown, maxItems?: number): NativeXSearchRun;
export declare function normalizeNativeXSearchUsage(untrusted: unknown): NativeXSearchUsage;
export declare function runNativeXSearch(options: RunNativeXSearchOptions): Promise<NativeXSearchRun>;
