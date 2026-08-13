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
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(X_SEARCH_MAX_TEXT_CHARACTERS),
        url: z.url().max(4_096).refine(
          (value) => URL.canParse(value) && new URL(value).protocol === "https:",
          { message: "X post URL must use HTTPS" },
        ),
        author_handle: z
          .string()
          .trim()
          .regex(/^@?[A-Za-z0-9_]{1,15}$/)
          .transform((value) => value.replace(/^@/, ""))
          .nullable(),
        date: z.iso.date().nullable(),
        engagement: xSearchEngagementSchema,
      }),
    )
    .max(X_SEARCH_MAX_RESULTS),
});

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
  input: readonly Readonly<{ content: string; role: "user" }>[];
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

export type NativeXSearchTransport = (
  request: NativeXSearchRequest,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

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
export function buildNativeXSearchRequest(
  options: Omit<RunNativeXSearchOptions, "abortSignal" | "maxItems" | "timeoutMs" | "transport">,
): NativeXSearchRequest {
  const model = options.model.trim();
  const prompt = options.prompt.trim();
  if (!model) throw new Error("model is required");
  if (!prompt || prompt.length > 100_000) {
    throw new Error("prompt must contain 1-100000 characters");
  }
  if (options.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
    throw new Error("maxOutputTokens must be a positive safe integer");
  }
  validateNativeToolOptions(options.nativeToolOptions);
  const description =
    options.outputDescription ??
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
export function normalizeNativeXSearchResult(
  untrusted: unknown,
  maxItems = X_SEARCH_MAX_RESULTS,
): NativeXSearchRun {
  assertMaximumItems(maxItems);
  const record = asRecord(untrusted);
  if (!record) throw new Error("xAI native X research returned an invalid response");
  const untrustedUsage = record.usage ?? record.totalUsage;
  const meteredUsage = normalizeNativeXSearchUsageForError(untrustedUsage);
  if (typeof record.status === "string" && record.status !== "completed") {
    throw meteredError("xAI native X research did not complete", meteredUsage);
  }
  if (record.error) {
    throw meteredError("xAI native X research failed", meteredUsage);
  }
  let totalUsage: NativeXSearchUsage;
  try {
    totalUsage = normalizeNativeXSearchUsage(untrustedUsage);
  } catch {
    throw meteredError("xAI native X research returned invalid usage", meteredUsage);
  }
  const output = extractStructuredOutput(record, totalUsage);
  try {
    const parsed = xSearchOutputSchema.parse(output);
    return { items: parsed.items.slice(0, maxItems), totalUsage };
  } catch {
    throw meteredError(
      "xAI native X research returned invalid structured output",
      totalUsage,
    );
  }
}

export function normalizeNativeXSearchUsage(untrusted: unknown): NativeXSearchUsage {
  const usage = asRecord(untrusted);
  if (!usage) throw new Error("xAI native X research returned invalid usage");
  const rawInputDetails = readAliasedValue(
    usage,
    "input_tokens_details",
    "inputTokenDetails",
  );
  const inputDetails = rawInputDetails === undefined ? null : asRecord(rawInputDetails);
  const input = readAliasedValue(usage, "input_tokens", "inputTokens");
  const output = readAliasedValue(usage, "output_tokens", "outputTokens");
  const reportedTotal = readAliasedValue(usage, "total_tokens", "totalTokens");
  const rawCacheRead = inputDetails
    ? readAliasedValue(inputDetails, "cached_tokens", "cacheReadTokens")
    : undefined;
  const rawCacheWrite = inputDetails
    ? readAliasedValue(inputDetails, "cache_write_tokens", "cacheWriteTokens")
    : undefined;
  const cacheRead = rawCacheRead === undefined ? 0 : rawCacheRead;
  const cacheWrite = rawCacheWrite === undefined ? 0 : rawCacheWrite;
  if (
    !isNonNegativeInteger(input) ||
    !isNonNegativeInteger(output) ||
    !isNonNegativeInteger(reportedTotal) ||
    (rawInputDetails !== undefined && !inputDetails) ||
    !isNonNegativeInteger(cacheRead) ||
    !isNonNegativeInteger(cacheWrite) ||
    !Number.isSafeInteger(input + output) ||
    reportedTotal !== input + output ||
    cacheRead + cacheWrite > input
  ) {
    throw new Error("xAI native X research returned invalid usage");
  }
  return {
    cacheRead,
    cacheWrite,
    input: input - cacheRead - cacheWrite,
    output,
    totalTokens: reportedTotal,
    raw: untrusted,
  };
}

export async function runNativeXSearch(
  options: RunNativeXSearchOptions,
): Promise<NativeXSearchRun> {
  const maximumItems = options.maxItems ?? X_SEARCH_MAX_RESULTS;
  assertMaximumItems(maximumItems);
  const signal = withTimeout(options.abortSignal, options.timeoutMs);
  const request = buildNativeXSearchRequest(options);
  let response: unknown;
  try {
    response = await options.transport(request, { signal });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error("xAI native X research failed");
  }
  return normalizeNativeXSearchResult(response, maximumItems);
}

function validateNativeToolOptions(options: NativeXSearchToolOptions | undefined): void {
  if (options?.allowedXHandles && options.excludedXHandles) {
    throw new Error("allowedXHandles and excludedXHandles are mutually exclusive");
  }
  for (const handles of [options?.allowedXHandles, options?.excludedXHandles]) {
    if (handles && (handles.length < 1 || handles.length > 10)) {
      throw new Error("X handle lists must contain 1-10 handles");
    }
    handles?.forEach(normalizeHandle);
  }
  if (options?.fromDate !== undefined && !z.iso.date().safeParse(options.fromDate).success) {
    throw new Error("fromDate must be a real date using YYYY-MM-DD");
  }
  if (options?.toDate !== undefined && !z.iso.date().safeParse(options.toDate).success) {
    throw new Error("toDate must be a real date using YYYY-MM-DD");
  }
  if (options?.fromDate && options.toDate && options.fromDate > options.toDate) {
    throw new Error("fromDate must not be after toDate");
  }
}

function nativeXSearchTool(options: NativeXSearchToolOptions | undefined): Record<string, unknown> {
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

function extractStructuredOutput(
  response: Record<string, unknown>,
  usage: NativeXSearchUsage,
): unknown {
  if (asRecord(response.output)?.items) return response.output;
  if (response.items) return { items: response.items };
  const text = extractOutputText(response.output) ??
    (typeof response.output_text === "string" ? response.output_text : undefined);
  if (!text?.trim()) {
    throw meteredError(
      "xAI native X research returned an empty answer",
      usage,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw meteredError(
      "xAI native X research returned invalid structured output",
      usage,
    );
  }
}

function extractOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  return output.flatMap((item) => {
    const content = asRecord(item)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      const record = asRecord(part);
      return record?.type === "output_text" && typeof record.text === "string"
        ? [record.text]
        : [];
    });
  }).join("");
}

function assertMaximumItems(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > X_SEARCH_MAX_RESULTS) {
    throw new Error(
      `maxItems must be a positive safe integer no greater than ${X_SEARCH_MAX_RESULTS}`,
    );
  }
}

function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new Error(`Invalid X handle: ${value}`);
  }
  return handle;
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs = 120_000): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function normalizeNativeXSearchUsageForError(untrusted: unknown): NativeXSearchUsage {
  try {
    return normalizeNativeXSearchUsage(untrusted);
  } catch {
    return {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      totalTokens: 0,
      raw: untrusted,
    };
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readAliasedValue(
  record: Record<string, unknown>,
  providerName: string,
  alternativeName: string,
): unknown {
  return record[providerName] === undefined
    ? record[alternativeName]
    : record[providerName];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function meteredError(
  message: string,
  usage: NativeXSearchUsage,
): Error {
  const error = new Error(message);
  Object.defineProperty(error, "usage", {
    value: {
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      input: usage.input,
      output: usage.output,
      totalTokens: usage.totalTokens,
    },
  });
  return error;
}
