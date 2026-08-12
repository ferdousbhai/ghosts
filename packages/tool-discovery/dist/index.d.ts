export type ToolDiscoveryCatalogEntry = Readonly<{
    /** Consumer-defined ID. It is preserved exactly and never interpreted. */
    id: string;
    name: string;
    description: string;
    keywords?: readonly string[];
}>;
/** JSON-serializable state that can be carried between model turns. */
export type ToolDiscoveryState = Readonly<{
    activatedIds: readonly string[];
}>;
export type ToolDiscoveryRequest = Readonly<{
    /** Omit or pass an empty string to list the remaining catalog. */
    query?: string;
    /** Number of tools to activate. Defaults to 10 and may not exceed 100. */
    limit?: number;
    state?: ToolDiscoveryState;
}>;
export type ToolDiscoveryMatch = Readonly<{
    id: string;
    name: string;
    description: string;
}>;
export type ToolDiscoveryResult = Readonly<{
    matches: readonly ToolDiscoveryMatch[];
    newlyActivatedIds: readonly string[];
    remainingCount: number;
    state: ToolDiscoveryState;
    status: "matched" | "no-match" | "exhausted";
}>;
export interface ToolDiscovery {
    /** An immutable snapshot of the admitted catalog. */
    readonly catalog: readonly ToolDiscoveryCatalogEntry[];
    /** Create or restore state, dropping IDs that are not in this catalog. */
    createState(activatedIds?: readonly string[]): ToolDiscoveryState;
    /** Drop stale or unadmitted IDs from state after a catalog change. */
    reconcileState(state: ToolDiscoveryState): ToolDiscoveryState;
    /** Search and activate matching, not-yet-activated catalog entries. */
    discover(request?: ToolDiscoveryRequest): ToolDiscoveryResult;
}
export declare const TOOL_DISCOVERY_LIMITS: Readonly<{
    catalogEntries: 5000;
    descriptionCharacters: 4096;
    fuzzyDistanceCellsPerSearch: 1000000;
    idCharacters: 512;
    keywordsPerEntry: 64;
    keywordCharacters: 256;
    nameCharacters: 256;
    queryCharacters: 200;
    queryTerms: 24;
    searchableTokens: 100000;
    searchableTokensPerEntry: 512;
    tokenCharacters: 128;
}>;
/**
 * Build a dependency-free discovery index over a consumer-admitted catalog.
 * The snapshot is the activation boundary: neither queries nor restored state
 * can introduce an ID that was not present when this object was created.
 */
export declare function createToolDiscovery(admittedCatalog: readonly ToolDiscoveryCatalogEntry[]): ToolDiscovery;
