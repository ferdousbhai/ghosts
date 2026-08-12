import { z } from "zod";
import { assertPublicHttpsUrl } from "./public-url.js";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const X_SEARCH_TOOL_NAME = "x_search";
export const WEB_SEARCH_TYPES = [
    "instant",
    "fast",
    "auto",
    "deep-lite",
    "deep",
    "deep-reasoning",
];
export const WEB_SEARCH_CATEGORIES = [
    "general",
    "news",
    "publication",
    "company",
    "people",
    "personal_site",
    "financial_report",
];
const optionalTrimmedString = z.preprocess((value) => typeof value === "string" && value.trim().length === 0 ? undefined : value, z.string().trim().min(1).max(500).optional());
const boundedDomains = z
    .array(z.string().trim().min(1).max(253))
    .min(1)
    .max(100)
    .optional();
/** Provider-neutral, model-facing web_search input. */
export const webSearchInputSchema = z
    .strictObject({
    query: optionalTrimmedString.describe("Query. Use queries for parallel search."),
    queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3).optional(),
    search_type: z.enum(WEB_SEARCH_TYPES).default("auto"),
    additional_queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3).optional(),
    category: z.enum(WEB_SEARCH_CATEGORIES).default("general"),
    num_results: z.number().int().min(1).max(10).default(5),
    include_domains: boundedDomains,
    exclude_domains: boundedDomains,
    user_location: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional(),
    moderation: z.boolean().default(true),
    from_date: z.iso.date().optional(),
    to_date: z.iso.date().optional(),
    max_age_hours: z.number().int().min(-1).max(876_000).optional(),
    content_mode: z.enum(["highlights", "text", "summary"]).default("highlights"),
    max_characters: z.number().int().min(1).max(100_000).default(20_000),
    content_start: z.number().int().min(0).max(10_000_000).default(0),
})
    .superRefine((value, context) => {
    if (!value.query && !value.queries?.length) {
        context.addIssue({
            code: "custom",
            message: "query or queries is required",
            path: ["query"],
        });
    }
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
        context.addIssue({
            code: "custom",
            message: "from_date must not be after to_date",
            path: ["from_date"],
        });
    }
});
export const xSearchInputSchema = z
    .strictObject({
    query: z.string().trim().min(1).max(2_000),
    from_date: z.iso.date().optional(),
    to_date: z.iso.date().optional(),
    depth: z.enum(["quick", "default", "deep"]).default("default"),
})
    .superRefine((value, context) => {
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
        context.addIssue({
            code: "custom",
            message: "from_date must not be after to_date",
            path: ["from_date"],
        });
    }
});
export const readUrlInputSchema = z.strictObject({
    urls: z
        .array(z.url().max(4_096).superRefine((value, context) => {
        try {
            assertPublicHttpsUrl(value);
        }
        catch {
            context.addIssue({ code: "custom", message: "URL must be public HTTPS" });
        }
    }))
        .min(1)
        .max(5),
    max_characters: z.number().int().min(1).max(100_000).default(20_000),
    content_start: z.number().int().min(0).max(10_000_000).default(0),
});
export const redditSearchInputSchema = z.strictObject({
    query: z.string().trim().max(500).default(""),
    subreddits: z
        .array(z.string().trim().regex(/^[A-Za-z0-9_]{1,50}$/))
        .min(1)
        .max(10)
        .optional(),
    sort: z.enum(["relevance", "hot", "new", "top"]).default("relevance"),
    time_range: z.enum(["hour", "day", "week", "month", "year", "all"]).default("month"),
    num_results: z.number().int().min(1).max(50).default(15),
});
export function normalizeSearchQueries(input) {
    const parallel = input.queries?.map((query) => query.trim()).filter(Boolean);
    if (parallel?.length)
        return [...new Set(parallel)];
    const query = input.query?.trim();
    return query ? [query] : [];
}
