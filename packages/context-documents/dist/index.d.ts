export type ContextDocument = Readonly<{
    id: string;
    name: string;
    description: string;
    markdown: string;
    revision: string | number;
}>;
export type RevisionedDraftReconciliation = Readonly<{
    draft: string;
    conflict: boolean;
    replaceEditorContent: boolean;
}>;
/** Normalize harmless Markdown formatting without changing its meaning. */
export declare function normalizeMarkdown(content: string): string;
export declare function extractMarkdownTitle(content: string, fallback: string): string;
export declare function extractMarkdownTitle(content: string, fallback?: string): string | null;
/** Derive a short catalog description from the first prose paragraph. */
export declare function extractMarkdownDescription(content: string, maximumCharacters?: number): string;
export declare function formatContextDocumentCatalog(documents: readonly ContextDocument[]): string;
export declare function formatContextDocument(document: ContextDocument): string;
export declare function reconcileRevisionedDraft(input: Readonly<{
    baselineContent: string;
    nextContent: string;
    currentDraft: string;
    equivalent?: (left: string, right: string) => boolean;
}>): RevisionedDraftReconciliation;
