import type { ResearchResult } from "./contracts.js";
export declare const WEB_SEARCH_MODEL_MAX_RESULTS = 8;
export declare const WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS = 600;
export declare const READ_URL_MODEL_MAX_RESULTS = 5;
export declare const READ_URL_MODEL_CONTENT_MAX_CHARACTERS = 20000;
export declare function formatWebSearchResults(results: readonly ResearchResult[]): string;
export declare function formatReadUrlResults(results: readonly ResearchResult[]): string;
