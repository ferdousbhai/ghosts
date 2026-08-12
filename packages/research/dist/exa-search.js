import { z } from "zod";
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
export async function executeExaSearch(exa, query, request = {}, options = {}) {
    if (options.signal?.aborted) {
        throw options.abortMessage ? new Error(options.abortMessage) : options.signal.reason;
    }
    const contents = request.content_mode === "summary"
        ? { summary: { query } }
        : request.content_mode === "text"
            ? { text: { maxCharacters: options.textMaxCharacters ?? 4_000 } }
            : { highlights: true };
    if (request.max_age_hours !== undefined) {
        contents.maxAgeHours = request.max_age_hours;
    }
    const response = await waitForSignal(exa.search(query, {
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
    }), options.signal, options.abortMessage);
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
export function mapExaCategory(category) {
    if (category === "general")
        return undefined;
    if (category === "research" || category === "publication")
        return "publication";
    if (category === "personal_site")
        return "personal site";
    if (category === "financial_report")
        return "financial report";
    return category;
}
async function waitForSignal(promise, signal, abortMessage) {
    if (!signal)
        return promise;
    if (signal.aborted) {
        throw abortMessage ? new Error(abortMessage) : signal.reason;
    }
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortMessage ? new Error(abortMessage) : signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}
