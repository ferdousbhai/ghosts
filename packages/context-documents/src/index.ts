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
export function normalizeMarkdown(content: string): string {
  return content
    .replace(/^(#{1,6})\s+\*{1,3}(.+?)\*{1,3}[ \t]*$/gm, "$1 $2")
    .replace(/^(#{1,6}\s+.*?)\\\.(.*)$/gm, "$1.$2")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function extractMarkdownTitle(content: string, fallback: string): string;
export function extractMarkdownTitle(
  content: string,
  fallback?: string,
): string | null;
export function extractMarkdownTitle(
  content: string,
  fallback?: string,
): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("# ")) return fallback ?? null;
  const firstLineEnd = trimmed.indexOf("\n");
  const heading =
    firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  return heading.slice(2).trim() || (fallback ?? null);
}

/** Derive a short catalog description from the first prose paragraph. */
export function extractMarkdownDescription(
  content: string,
  maximumCharacters = 240,
): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
    throw new Error("maximumCharacters must be a non-negative safe integer");
  }
  const prose = normalizeMarkdown(content)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(?:#{1,6}\s|[-*+]\s|```|>\s)/.test(block));
  if (!prose || maximumCharacters === 0) return "";
  const plain = prose
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maximumCharacters) return plain;
  return `${plain.slice(0, Math.max(0, maximumCharacters - 1)).trimEnd()}…`;
}

export function formatContextDocumentCatalog(
  documents: readonly ContextDocument[],
): string {
  return documents
    .map((document) =>
      [
        `<document id="${escapeXml(document.id)}" revision="${escapeXml(String(document.revision))}" name="${escapeXml(document.name)}">`,
        escapeXml(document.description),
        "</document>",
      ].join("\n"),
    )
    .join("\n");
}

export function formatContextDocument(document: ContextDocument): string {
  return [
    `<document id="${escapeXml(document.id)}" revision="${escapeXml(String(document.revision))}" name="${escapeXml(document.name)}">`,
    escapeXml(document.markdown),
    "</document>",
  ].join("\n");
}

export function reconcileRevisionedDraft(
  input: Readonly<{
    baselineContent: string;
    nextContent: string;
    currentDraft: string;
    equivalent?: (left: string, right: string) => boolean;
  }>,
): RevisionedDraftReconciliation {
  const equivalent = input.equivalent ?? Object.is;
  const wasDirty = !equivalent(input.currentDraft, input.baselineContent);
  if (wasDirty && !equivalent(input.currentDraft, input.nextContent)) {
    return {
      draft: input.currentDraft,
      conflict: true,
      replaceEditorContent: false,
    };
  }
  return {
    draft: input.nextContent,
    conflict: false,
    replaceEditorContent: true,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
