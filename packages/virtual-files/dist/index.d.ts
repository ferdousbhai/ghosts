import { z } from "zod";
export declare const VIRTUAL_FIND_LIMITS: Readonly<{
    defaultResults: 20;
    maximumResults: 100;
    outputCharacters: 64000;
    pathCharacters: 1000;
    queryCharacters: 1000;
    snippetCharacters: 240;
}>;
export declare const virtualFindInputSchema: z.ZodObject<{
    root: z.ZodString;
    query: z.ZodOptional<z.ZodString>;
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type VirtualFindInput = z.infer<typeof virtualFindInputSchema>;
export type VirtualFileSearchDocument = Readonly<{
    content: string;
    id: string;
    path: string;
    tags?: readonly string[];
    title?: string;
    updatedAt?: Date | string | number;
}>;
export type VirtualFileSearchResult<T extends VirtualFileSearchDocument> = T & Readonly<{
    score: number;
    snippet: string;
}>;
export type VirtualFindEntry = Readonly<{
    kind: "directory" | "file";
    path: string;
    title?: string;
    tags?: readonly string[];
    visibility?: "private" | "public";
    revision?: string | number;
    createdAt?: Date | string | number;
    updatedAt?: Date | string | number;
    snippet?: string;
}>;
export type VirtualFindPage = Readonly<{
    entries: readonly VirtualFindEntry[];
    nextCursor?: string;
    root: string;
    query?: string;
}>;
export declare const VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS: Readonly<{
    title: 8;
    tags: 4;
    path: 2;
    body: 1;
}>;
export declare const VIRTUAL_FILE_BM25_K1 = 1.2;
export declare const VIRTUAL_FILE_BM25_B = 0.75;
export declare function normalizeVirtualFileSearchText(value: string): string;
export declare function tokenizeVirtualFileSearchText(value: string): string[];
export declare function uniqueVirtualFileSearchTerms(value: string, limit?: number): string[];
export declare function buildVirtualFileFtsQuery(query: string): string | null;
export declare function createVirtualFileSearchIndex<T extends VirtualFileSearchDocument>(documents: readonly T[]): Readonly<{
    search(query: string, limit?: number): Array<VirtualFileSearchResult<T>>;
}>;
export declare function formatVirtualFindPage(page: VirtualFindPage): string;
