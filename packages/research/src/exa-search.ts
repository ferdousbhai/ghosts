import { z } from "zod";
import type { ResearchResult } from "./contracts.js";

const boundedProviderString = z.string().max(100_000);
const exaResearchResultSchema = z
  .object({
    author: z.string().max(1_000).optional(),
    highlights: z.array(boundedProviderString).max(100).optional(),
    id: z.string().max(1_000).optional(),
    publishedDate: z.string().max(100).optional(),
    summary: boundedProviderString.optional(),
    text: boundedProviderString.optional(),
    title: z.string().max(10_000).optional(),
    url: z.url().max(4_096).refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    }, "Exa result URL must use HTTP or HTTPS"),
  })
  .passthrough();

export type ExaSearchRequest = Readonly<{
  additional_queries?: readonly string[];
  category?: string;
  content_mode?: "highlights" | "text" | "summary";
  exclude_domains?: readonly string[];
  from_date?: string;
  include_domains?: readonly string[];
  max_age_hours?: number;
  moderation?: boolean;
  num_results?: number;
  search_type?: string;
  to_date?: string;
  user_location?: string;
}>;

export type ExaResearchResult = ResearchResult & Readonly<{ id?: string }>;

export type ExaSearchExecution = Readonly<{
  providerResultCount: number;
  results: readonly ExaResearchResult[];
}>;

export type ExecuteExaSearchOptions = Readonly<{
  abortMessage?: string;
  includeResult?: (result: ExaResearchResult) => boolean;
  signal?: AbortSignal;
  textMaxCharacters?: number;
}>;

export type ExaSearchOptions = Readonly<Record<string, unknown>>;

/** Structural Exa client contract; no exa-js version is required. */
export type ExaSearchClient = Readonly<{
  search: (
    query: string,
    options: ExaSearchOptions,
  ) => Promise<Readonly<{ results: readonly unknown[] }>>;
}>;

export async function executeExaSearch(
  exa: ExaSearchClient,
  query: string,
  request: ExaSearchRequest = {},
  options: ExecuteExaSearchOptions = {},
): Promise<ExaSearchExecution> {
  if (options.signal?.aborted) {
    throw options.abortMessage ? new Error(options.abortMessage) : options.signal.reason;
  }
  const contents: Record<string, unknown> =
    request.content_mode === "summary"
      ? { summary: { query } }
      : request.content_mode === "text"
        ? { text: { maxCharacters: options.textMaxCharacters ?? 4_000 } }
        : { highlights: true };
  if (request.max_age_hours !== undefined) {
    contents.maxAgeHours = request.max_age_hours;
  }

  const response = await waitForSignal(
    exa.search(query, {
      ...(mapExaCategory(request.category ?? "general") && {
        category: mapExaCategory(request.category ?? "general"),
      }),
      ...(request.additional_queries?.length && {
        additionalQueries: [...request.additional_queries],
      }),
      ...(request.from_date && { startPublishedDate: request.from_date }),
      ...(request.to_date && { endPublishedDate: request.to_date }),
      ...(request.include_domains?.length && {
        includeDomains: [...request.include_domains],
      }),
      ...(request.exclude_domains?.length && {
        excludeDomains: [...request.exclude_domains],
      }),
      ...(request.user_location && { userLocation: request.user_location }),
      contents,
      moderation: request.moderation ?? true,
      numResults: request.num_results ?? 10,
      type: request.search_type ?? "auto",
    }),
    options.signal,
    options.abortMessage,
  );

  const providerResults = z.array(exaResearchResultSchema).max(1_000).parse(response.results);
  return {
    providerResultCount: providerResults.length,
    results: providerResults
      .map((result) => ({
        ...result,
        text: result.text ?? result.highlights?.join(" ") ?? result.summary,
      }))
      .filter((result) => options.includeResult?.(result) ?? true),
  };
}

export function mapExaCategory(category: string): string | undefined {
  if (category === "general") return undefined;
  if (category === "research" || category === "publication") return "publication";
  if (category === "personal_site") return "personal site";
  if (category === "financial_report") return "financial report";
  return category;
}

async function waitForSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  abortMessage?: string,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw abortMessage ? new Error(abortMessage) : signal.reason;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(abortMessage ? new Error(abortMessage) : signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
