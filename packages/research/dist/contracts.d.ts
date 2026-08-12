import { z } from "zod";
export declare const WEB_SEARCH_TOOL_NAME: "web_search";
export declare const X_SEARCH_TOOL_NAME: "x_search";
export declare const WEB_SEARCH_TYPES: readonly ["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"];
export declare const WEB_SEARCH_CATEGORIES: readonly ["general", "news", "publication", "company", "people", "personal_site", "financial_report"];
/** Provider-neutral, model-facing web_search input. */
export declare const webSearchInputSchema: z.ZodObject<{
    query: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    queries: z.ZodOptional<z.ZodArray<z.ZodString>>;
    search_type: z.ZodDefault<z.ZodEnum<{
        instant: "instant";
        fast: "fast";
        auto: "auto";
        "deep-lite": "deep-lite";
        deep: "deep";
        "deep-reasoning": "deep-reasoning";
    }>>;
    additional_queries: z.ZodOptional<z.ZodArray<z.ZodString>>;
    category: z.ZodDefault<z.ZodEnum<{
        general: "general";
        news: "news";
        publication: "publication";
        company: "company";
        people: "people";
        personal_site: "personal_site";
        financial_report: "financial_report";
    }>>;
    num_results: z.ZodDefault<z.ZodNumber>;
    include_domains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    exclude_domains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    user_location: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    moderation: z.ZodDefault<z.ZodBoolean>;
    from_date: z.ZodOptional<z.ZodISODate>;
    to_date: z.ZodOptional<z.ZodISODate>;
    max_age_hours: z.ZodOptional<z.ZodNumber>;
    content_mode: z.ZodDefault<z.ZodEnum<{
        highlights: "highlights";
        text: "text";
        summary: "summary";
    }>>;
    max_characters: z.ZodDefault<z.ZodNumber>;
    content_start: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const xSearchInputSchema: z.ZodObject<{
    query: z.ZodString;
    from_date: z.ZodOptional<z.ZodISODate>;
    to_date: z.ZodOptional<z.ZodISODate>;
    depth: z.ZodDefault<z.ZodEnum<{
        deep: "deep";
        default: "default";
        quick: "quick";
    }>>;
}, z.core.$strict>;
export declare const readUrlInputSchema: z.ZodObject<{
    urls: z.ZodArray<z.ZodURL>;
    max_characters: z.ZodDefault<z.ZodNumber>;
    content_start: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const redditSearchInputSchema: z.ZodObject<{
    query: z.ZodDefault<z.ZodString>;
    subreddits: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sort: z.ZodDefault<z.ZodEnum<{
        relevance: "relevance";
        hot: "hot";
        new: "new";
        top: "top";
    }>>;
    time_range: z.ZodDefault<z.ZodEnum<{
        hour: "hour";
        day: "day";
        week: "week";
        month: "month";
        year: "year";
        all: "all";
    }>>;
    num_results: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type XSearchInput = z.infer<typeof xSearchInputSchema>;
export type ReadUrlInput = z.infer<typeof readUrlInputSchema>;
export type RedditSearchInput = z.infer<typeof redditSearchInputSchema>;
export type ResearchResult = Readonly<{
    url: string;
    title?: string;
    publishedDate?: string;
    author?: string;
    highlights?: readonly string[];
    text?: string;
    summary?: string;
}>;
export declare function normalizeSearchQueries(input: Pick<WebSearchInput, "query" | "queries">): string[];
