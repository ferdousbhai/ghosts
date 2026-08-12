export const XAI_DEFAULT_COMPACTION_TIMEOUT_MS = 30_000;
export const XAI_COMPACTION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const XAI_COMPACTION_MAX_TOKENS = 2_000_000;
export const XAI_COMPACTION_MAX_ENCRYPTED_CONTENT_CHARACTERS = 8 * 1024 * 1024;
export function createXaiCompactionAdapter(options) {
    const timeoutMs = positiveSafeInteger(options.timeoutMs ?? XAI_DEFAULT_COMPACTION_TIMEOUT_MS, "timeoutMs");
    const countInputTokens = async (input) => {
        const model = requiredString(input.model, "model");
        const payload = asRecord(await requestJsonWithTimeout(options.request, {
            body: {
                model,
                text: JSON.stringify(input.items),
            },
            path: "/tokenize-text",
        }, timeoutMs, "xAI context token counting"));
        const tokenIds = payload?.token_ids;
        if (!Array.isArray(tokenIds) ||
            tokenIds.length > XAI_COMPACTION_MAX_TOKENS ||
            !tokenIds.every((tokenId) => readTokenId(tokenId) !== null)) {
            throw new Error("xAI context token counting returned invalid token IDs");
        }
        return tokenIds.length;
    };
    const compactInput = async (input) => {
        const model = requiredString(input.model, "model");
        if (input.items.length === 0) {
            throw new Error("Cannot compact an empty xAI context");
        }
        const payload = asRecord(await requestJsonWithTimeout(options.request, {
            body: {
                model,
                input: input.items,
            },
            ...(input.conversationId && {
                conversationId: input.conversationId,
            }),
            path: "/responses/compact",
        }, timeoutMs, "xAI context compaction"));
        const items = asInputItems(payload?.output);
        if (items?.length !== 1 || !readCompactionItem(items[0])) {
            throw new Error("xAI context compaction returned no valid compaction item");
        }
        const usage = parseXaiNativeUsage(payload?.usage);
        const droppedMessageCount = readNonNegativeSafeInteger(asRecord(payload?.usage)?.dropped_message_count);
        if (!usage || droppedMessageCount === null) {
            throw new Error("xAI context compaction returned invalid usage");
        }
        return {
            items,
            usage: {
                ...usage,
                droppedMessageCount,
            },
        };
    };
    const shouldCompactInput = async (input) => {
        const hardLimitTokens = positiveSafeInteger(input.hardLimitTokens, "hardLimitTokens");
        const knownTokens = optionalNonNegativeSafeInteger(input.knownTokens, "knownTokens");
        const headroomTokens = optionalNonNegativeSafeInteger(input.headroomTokens, "headroomTokens");
        if (saturatingAdd(knownTokens, headroomTokens) >= hardLimitTokens) {
            return true;
        }
        // One byte cannot require more than one byte-fallback token. Avoid a
        // provider request when even that conservative bound fits.
        if (saturatingAdd(saturatingAdd(knownTokens, serializedByteLength(input.items)), headroomTokens) < hardLimitTokens) {
            return false;
        }
        try {
            const itemTokens = await countInputTokens(input);
            return (saturatingAdd(saturatingAdd(knownTokens, itemTokens), headroomTokens) >=
                hardLimitTokens);
        }
        catch {
            // Failing closed avoids sending a context that may exceed the provider's
            // hard limit when precise preflight counting is unavailable.
            return true;
        }
    };
    return {
        compactInput,
        countInputTokens,
        shouldCompactInput,
    };
}
export function readXaiResponseInput(requestBody) {
    return asInputItems(asRecord(requestBody)?.input);
}
export function readXaiCompletedResponseOutput(rawChunk) {
    return asInputItems(readCompletedResponse(rawChunk)?.output);
}
export function buildXaiCompactionInput(step) {
    return [
        ...step.input.filter((item) => !isSystemInputItem(item)),
        ...step.output,
    ];
}
export function parseXaiNativeUsage(value) {
    const usage = asRecord(value);
    if (!usage)
        return null;
    const inputTokens = readTokenCount(usage.input_tokens);
    const outputTokens = readTokenCount(usage.output_tokens);
    const totalTokens = readTokenCount(usage.total_tokens);
    const inputTokenDetails = usage.input_tokens_details === undefined
        ? null
        : asRecord(usage.input_tokens_details);
    const cacheReadInputTokens = readOptionalTokenCount(inputTokenDetails?.cached_tokens, 0);
    const costUsdTicks = readOptionalNonNegativeSafeInteger(usage.cost_in_usd_ticks, null);
    const serverSideToolCalls = readOptionalNonNegativeSafeInteger(usage.num_server_side_tools_used, 0);
    if (inputTokens === null ||
        outputTokens === null ||
        totalTokens === null ||
        (usage.input_tokens_details !== undefined && !inputTokenDetails) ||
        cacheReadInputTokens === null ||
        (usage.cost_in_usd_ticks !== undefined && costUsdTicks === null) ||
        serverSideToolCalls === null ||
        totalTokens !== saturatingAdd(inputTokens, outputTokens)) {
        return null;
    }
    return {
        cacheReadInputTokens,
        costUsdTicks,
        inputTokens,
        outputTokens,
        serverSideToolCalls,
        totalTokens,
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function asInputItems(value) {
    if (!Array.isArray(value))
        return null;
    const items = value.map(asRecord);
    return items.every((item) => item !== null)
        ? items
        : null;
}
function readOptionalNonNegativeSafeInteger(value, missingValue) {
    return value === undefined ? missingValue : readNonNegativeSafeInteger(value);
}
function serializedByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function readCompletedResponse(rawChunk) {
    const event = parseRawEvent(rawChunk);
    if (event?.type !== "response.completed" &&
        event?.type !== "response.incomplete" &&
        event?.type !== "response.done") {
        return null;
    }
    return asRecord(event.response);
}
function parseRawEvent(value) {
    if (typeof value !== "string")
        return asRecord(value);
    try {
        return asRecord(JSON.parse(value));
    }
    catch {
        return null;
    }
}
function isSystemInputItem(item) {
    return item.role === "system" || item.role === "developer";
}
function readCompactionItem(value) {
    const item = asRecord(value);
    return item?.type === "compaction" &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0 &&
        item.encrypted_content.length <=
            XAI_COMPACTION_MAX_ENCRYPTED_CONTENT_CHARACTERS
        ? item
        : null;
}
class XaiResponseLimitError extends Error {
}
async function requestJsonWithTimeout(request, input, timeoutMs, operation) {
    const controller = new AbortController();
    const timeoutError = new Error(`${operation} timed out`);
    let timeoutId;
    const timeout = new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
        }, timeoutMs);
    });
    const readResponse = async () => {
        let response;
        try {
            response = await request({ ...input, signal: controller.signal });
        }
        catch {
            if (controller.signal.aborted)
                throw timeoutError;
            throw new Error(`${operation} failed`);
        }
        if (!response.ok) {
            void response.body?.cancel().catch(() => { });
            throw new Error(`${operation} failed (${response.status})`);
        }
        let text;
        try {
            text = await readBoundedResponseText(response, XAI_COMPACTION_MAX_RESPONSE_BYTES, controller.signal);
        }
        catch (error) {
            if (controller.signal.aborted)
                throw timeoutError;
            if (error instanceof XaiResponseLimitError) {
                throw new Error(`${operation} response is too large`);
            }
            throw new Error(`${operation} failed while reading response`);
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`${operation} returned invalid JSON`);
        }
    };
    try {
        return await Promise.race([readResponse(), timeout]);
    }
    finally {
        if (timeoutId !== undefined)
            clearTimeout(timeoutId);
    }
}
async function readBoundedResponseText(response, maxBytes, signal) {
    if (signal.aborted) {
        await response.body?.cancel().catch(() => { });
        throw signal.reason;
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength &&
        /^\d+$/.test(declaredLength) &&
        Number(declaredLength) > maxBytes) {
        void response.body?.cancel().catch(() => { });
        throw new XaiResponseLimitError();
    }
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const cancel = () => {
        void reader.cancel().catch(() => { });
    };
    signal.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
        while (true) {
            if (signal.aborted)
                throw signal.reason;
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => { });
                throw new XaiResponseLimitError();
            }
            result += decoder.decode(value, { stream: true });
        }
        return result + decoder.decode();
    }
    finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
    }
}
function positiveSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
}
function optionalNonNegativeSafeInteger(value, name) {
    if (value === undefined)
        return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}
function readNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}
function readTokenCount(value) {
    const count = readNonNegativeSafeInteger(value);
    return count !== null && count <= XAI_COMPACTION_MAX_TOKENS ? count : null;
}
function readOptionalTokenCount(value, missingValue) {
    return value === undefined ? missingValue : readTokenCount(value);
}
function readTokenId(value) {
    return readNonNegativeSafeInteger(value);
}
function saturatingAdd(left, right) {
    return left > Number.MAX_SAFE_INTEGER - right
        ? Number.MAX_SAFE_INTEGER
        : left + right;
}
function requiredString(value, name) {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`${name} is required`);
    return normalized;
}
