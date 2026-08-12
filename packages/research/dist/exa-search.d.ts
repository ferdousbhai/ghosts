import type { ResearchResult } from "./contracts.js";
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
export type ExaResearchResult = ResearchResult & Readonly<{
    id?: string;
}>;
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
    search: (query: string, options: ExaSearchOptions) => Promise<Readonly<{
        results: readonly unknown[];
    }>>;
}>;
export declare function executeExaSearch(exa: ExaSearchClient, query: string, request?: ExaSearchRequest, options?: ExecuteExaSearchOptions): Promise<ExaSearchExecution>;
export declare function mapExaCategory(category: string): string | undefined;
