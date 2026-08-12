import { z } from "zod";
export const X_SEARCH_MAX_RESULTS = 60;
export const X_SEARCH_MAX_TEXT_CHARACTERS = 25_000;
const xSearchEngagementSchema = z
    .strictObject({
    likes: z.number().int().nonnegative().nullable(),
    reposts: z.number().int().nonnegative().nullable(),
})
    .nullable();
export const xSearchOutputSchema = z.strictObject({
    items: z
        .array(z.strictObject({
        text: z.string().trim().min(1).max(X_SEARCH_MAX_TEXT_CHARACTERS),
        url: z.url().max(4_096).refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", { message: "X post URL must use HTTPS" }),
        author_handle: z
            .string()
            .trim()
            .regex(/^@?[A-Za-z0-9_]{1,15}$/)
            .transform((value) => value.replace(/^@/, ""))
            .nullable(),
        date: z.iso.date().nullable(),
        engagement: xSearchEngagementSchema,
    }))
        .max(X_SEARCH_MAX_RESULTS),
});
/** Build a provider-native xAI Responses payload without binding to an SDK. */
export function buildNativeXSearchRequest(options) {
    const model = options.model.trim();
    const prompt = options.prompt.trim();
    if (!model)
        throw new Error("model is required");
    if (!prompt || prompt.length > 100_000) {
        throw new Error("prompt must contain 1-100000 characters");
    }
    if (options.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
        throw new Error("maxOutputTokens must be a positive safe integer");
    }
    validateNativeToolOptions(options.nativeToolOptions);
    const description = options.outputDescription ??
        "Relevant public X posts returned by xAI's native X search.";
    return {
        input: [{ content: prompt, role: "user" }],
        instructions: [
            "Use the hosted x_search tool before answering.",
            description,
        ].join("\n"),
        ...(options.maxOutputTokens !== undefined && {
            max_output_tokens: options.maxOutputTokens,
        }),
        model,
        store: false,
        text: {
            format: {
                description,
                name: options.outputName ?? "x_search_results",
                schema: z.toJSONSchema(xSearchOutputSchema, {
                    io: "input",
                    target: "draft-07",
                    unrepresentable: "throw",
                }),
                strict: true,
                type: "json_schema",
            },
        },
        tool_choice: "required",
        tools: [nativeXSearchTool(options.nativeToolOptions)],
    };
}
/** Normalize an xAI Responses result, validating structured output and usage. */
export function normalizeNativeXSearchResult(untrusted, maxItems = X_SEARCH_MAX_RESULTS) {
    assertMaximumItems(maxItems);
    const record = asRecord(untrusted);
    if (!record)
        throw new Error("xAI native X research returned an invalid response");
    const totalUsage = normalizeNativeXSearchUsage(record.usage ?? record.totalUsage);
    if (typeof record.status === "string" && record.status !== "completed") {
        const providerError = asRecord(record.error);
        throw meteredError(typeof providerError?.message === "string"
            ? providerError.message
            : `xAI native X research did not complete (${record.status})`, totalUsage);
    }
    if (record.error) {
        const providerError = asRecord(record.error);
        throw meteredError(typeof providerError?.message === "string"
            ? providerError.message
            : "xAI native X research failed", totalUsage);
    }
    const output = extractStructuredOutput(record);
    try {
        const parsed = xSearchOutputSchema.parse(output);
        return { items: parsed.items.slice(0, maxItems), totalUsage };
    }
    catch (cause) {
        throw meteredError("xAI native X research returned invalid structured output", totalUsage, cause);
    }
}
export function normalizeNativeXSearchUsage(untrusted) {
    const usage = asRecord(untrusted);
    const inputDetails = asRecord(usage?.input_tokens_details ?? usage?.inputTokenDetails);
    const input = nonNegativeInteger(usage?.input_tokens ?? usage?.inputTokens);
    const output = nonNegativeInteger(usage?.output_tokens ?? usage?.outputTokens);
    const reportedTotal = nonNegativeInteger(usage?.total_tokens ?? usage?.totalTokens);
    const cacheRead = nonNegativeInteger(inputDetails?.cached_tokens ?? inputDetails?.cacheReadTokens);
    const cacheWrite = nonNegativeInteger(inputDetails?.cache_write_tokens ?? inputDetails?.cacheWriteTokens);
    const cacheInput = cacheRead + cacheWrite <= input ? input - cacheRead - cacheWrite : input;
    return {
        cacheRead: cacheRead + cacheWrite <= input ? cacheRead : 0,
        cacheWrite: cacheRead + cacheWrite <= input ? cacheWrite : 0,
        input: cacheInput,
        output,
        totalTokens: reportedTotal === input + output ? reportedTotal : input + output,
        raw: untrusted,
    };
}
export async function runNativeXSearch(options) {
    const maximumItems = options.maxItems ?? X_SEARCH_MAX_RESULTS;
    assertMaximumItems(maximumItems);
    const signal = withTimeout(options.abortSignal, options.timeoutMs);
    const response = await options.transport(buildNativeXSearchRequest(options), { signal });
    return normalizeNativeXSearchResult(response, maximumItems);
}
function validateNativeToolOptions(options) {
    if (options?.allowedXHandles && options.excludedXHandles) {
        throw new Error("allowedXHandles and excludedXHandles are mutually exclusive");
    }
    for (const handles of [options?.allowedXHandles, options?.excludedXHandles]) {
        if (handles && (handles.length < 1 || handles.length > 10)) {
            throw new Error("X handle lists must contain 1-10 handles");
        }
        handles?.forEach(normalizeHandle);
    }
    if (options?.fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.fromDate)) {
        throw new Error("fromDate must use YYYY-MM-DD");
    }
    if (options?.toDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.toDate)) {
        throw new Error("toDate must use YYYY-MM-DD");
    }
    if (options?.fromDate && options.toDate && options.fromDate > options.toDate) {
        throw new Error("fromDate must not be after toDate");
    }
}
function nativeXSearchTool(options) {
    return {
        type: "x_search",
        ...(options?.allowedXHandles?.length && {
            allowed_x_handles: options.allowedXHandles.map(normalizeHandle),
        }),
        ...(options?.excludedXHandles?.length && {
            excluded_x_handles: options.excludedXHandles.map(normalizeHandle),
        }),
        ...(options?.fromDate && { from_date: options.fromDate }),
        ...(options?.toDate && { to_date: options.toDate }),
        ...(options?.enableImageUnderstanding && { enable_image_understanding: true }),
        ...(options?.enableVideoUnderstanding && { enable_video_understanding: true }),
    };
}
function extractStructuredOutput(response) {
    if (asRecord(response.output)?.items)
        return response.output;
    if (response.items)
        return { items: response.items };
    const text = extractOutputText(response.output) ??
        (typeof response.output_text === "string" ? response.output_text : undefined);
    if (!text?.trim()) {
        throw meteredError("xAI native X research returned an empty answer", normalizeNativeXSearchUsage(response.usage ?? response.totalUsage));
    }
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw meteredError("xAI native X research returned invalid structured output", normalizeNativeXSearchUsage(response.usage ?? response.totalUsage), cause);
    }
}
function extractOutputText(output) {
    if (!Array.isArray(output))
        return undefined;
    return output.flatMap((item) => {
        const content = asRecord(item)?.content;
        if (!Array.isArray(content))
            return [];
        return content.flatMap((part) => {
            const record = asRecord(part);
            return record?.type === "output_text" && typeof record.text === "string"
                ? [record.text]
                : [];
        });
    }).join("");
}
function assertMaximumItems(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > X_SEARCH_MAX_RESULTS) {
        throw new Error(`maxItems must be a positive safe integer no greater than ${X_SEARCH_MAX_RESULTS}`);
    }
}
function normalizeHandle(value) {
    const handle = value.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        throw new Error(`Invalid X handle: ${value}`);
    }
    return handle;
}
function withTimeout(parent, timeoutMs = 120_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("timeoutMs must be a positive safe integer");
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function meteredError(message, usage, cause) {
    const error = cause === undefined ? new Error(message) : new Error(message, { cause });
    Object.defineProperty(error, "usage", { value: usage });
    return error;
}
