import { z } from "zod";

export const VIRTUAL_FIND_LIMITS = Object.freeze({
  defaultResults: 10,
  maximumResults: 100,
  outputCharacters: 32_000,
  pathCharacters: 1_000,
  queryCharacters: 1_000,
  snippetCharacters: 160,
});

export const virtualFindInputSchema = z.strictObject({
  root: z.string().trim().min(1).max(VIRTUAL_FIND_LIMITS.pathCharacters)
    .describe("Virtual directory under which to discover files"),
  query: z.string().trim().min(1).max(VIRTUAL_FIND_LIMITS.queryCharacters).optional()
    .describe("Optional path, title, tag, or content query; omit to enumerate entries"),
  cursor: z.string().trim().min(1).max(1_000).optional()
    .describe("Opaque continuation cursor returned by a previous find"),
  limit: z.number().int().min(1).max(VIRTUAL_FIND_LIMITS.maximumResults).optional()
    .describe(`Maximum entries; defaults to ${VIRTUAL_FIND_LIMITS.defaultResults}`),
});

export type VirtualFindInput = z.infer<typeof virtualFindInputSchema>;

export type VirtualFileSearchDocument = Readonly<{
  content: string;
  id: string;
  path: string;
  tags?: readonly string[];
  title?: string;
  updatedAt?: Date | string | number;
}>;

export type VirtualFileSearchResult<T extends VirtualFileSearchDocument> =
  T & Readonly<{ score: number; snippet: string }>;

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

export const VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS = Object.freeze({
  title: 8,
  tags: 4,
  path: 2,
  body: 1,
});

// These match SQLite FTS5's built-in BM25 constants.
export const VIRTUAL_FILE_BM25_K1 = 1.2;
export const VIRTUAL_FILE_BM25_B = 0.75;
const DEFAULT_MAX_QUERY_TERMS = 32;
const LOCAL_SEARCH_MIN_TERM_LENGTH = 2;

export function normalizeVirtualFileSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function tokenizeVirtualFileSearchText(value: string): string[] {
  return normalizeVirtualFileSearchText(value)
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((term) => /[\p{L}\p{N}]/u.test(term)) ?? [];
}

export function uniqueVirtualFileSearchTerms(
  value: string,
  limit = DEFAULT_MAX_QUERY_TERMS,
): string[] {
  return [...new Set(tokenizeVirtualFileSearchText(value))]
    .slice(0, Math.max(0, limit));
}

export function buildVirtualFileFtsQuery(query: string): string | null {
  const terms = uniqueVirtualFileSearchTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}

type IndexedDocument<T extends VirtualFileSearchDocument> = Readonly<{
  document: T;
  length: number;
}>;

export function createVirtualFileSearchIndex<T extends VirtualFileSearchDocument>(
  documents: readonly T[],
): Readonly<{
  search(query: string, limit?: number): Array<VirtualFileSearchResult<T>>;
}> {
  const indexedDocuments: Array<IndexedDocument<T>> = [];
  const postings = new Map<string, Array<readonly [number, number]>>();
  let totalLength = 0;

  for (const document of documents) {
    const frequencies = new Map<string, number>();
    let length = 0;
    length += addWeightedTerms(
      frequencies,
      document.title ?? titleFromMarkdown(document.content),
      VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS.title,
    );
    length += addWeightedTerms(
      frequencies,
      document.tags?.join(" ") ?? "",
      VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS.tags,
    );
    length += addWeightedTerms(
      frequencies,
      document.path,
      VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS.path,
    );
    length += addWeightedTerms(
      frequencies,
      document.content,
      VIRTUAL_FILE_SEARCH_FIELD_WEIGHTS.body,
    );

    const documentIndex = indexedDocuments.length;
    indexedDocuments.push({ document, length });
    totalLength += length;
    for (const [term, frequency] of frequencies) {
      const posting = postings.get(term) ?? [];
      posting.push([documentIndex, frequency]);
      postings.set(term, posting);
    }
  }

  const averageLength = indexedDocuments.length > 0
    ? Math.max(1, totalLength / indexedDocuments.length)
    : 1;
  const vocabularyByPrefix = new Map<string, string[]>();
  for (const term of postings.keys()) {
    const prefix = searchTermPrefix(term);
    const terms = vocabularyByPrefix.get(prefix) ?? [];
    terms.push(term);
    vocabularyByPrefix.set(prefix, terms);
  }

  return Object.freeze({
    search(query: string, limit = VIRTUAL_FIND_LIMITS.defaultResults) {
      const queryTerms = uniqueVirtualFileSearchTerms(query)
        .filter((term) => [...term].length >= LOCAL_SEARCH_MIN_TERM_LENGTH);
      const boundedLimit = Math.max(
        0,
        Math.min(VIRTUAL_FIND_LIMITS.maximumResults, Math.floor(limit)),
      );
      if (queryTerms.length === 0 || boundedLimit === 0 || indexedDocuments.length === 0) {
        return [];
      }

      const scores = new Map<number, number>();
      for (const queryTerm of queryTerms) {
        const frequenciesByDocument = new Map<number, number>();
        const candidateTerms = vocabularyByPrefix.get(searchTermPrefix(queryTerm)) ?? [];
        for (const indexedTerm of candidateTerms) {
          if (!indexedTerm.startsWith(queryTerm)) continue;
          for (const [documentIndex, frequency] of postings.get(indexedTerm) ?? []) {
            frequenciesByDocument.set(
              documentIndex,
              (frequenciesByDocument.get(documentIndex) ?? 0) + frequency,
            );
          }
        }
        if (frequenciesByDocument.size === 0) continue;

        const documentFrequency = frequenciesByDocument.size;
        const inverseDocumentFrequency = Math.log(
          1 + (indexedDocuments.length - documentFrequency + 0.5)
            / (documentFrequency + 0.5),
        );
        for (const [documentIndex, termFrequency] of frequenciesByDocument) {
          const indexedDocument = indexedDocuments[documentIndex]!;
          const lengthNormalization = VIRTUAL_FILE_BM25_K1 * (
            1 - VIRTUAL_FILE_BM25_B
              + VIRTUAL_FILE_BM25_B * indexedDocument.length / averageLength
          );
          const termScore = inverseDocumentFrequency
            * (termFrequency * (VIRTUAL_FILE_BM25_K1 + 1))
            / (termFrequency + lengthNormalization);
          scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + termScore);
        }
      }

      return [...scores]
        .sort(([leftIndex, leftScore], [rightIndex, rightScore]) =>
          rightScore - leftScore
          || timestamp(indexedDocuments[rightIndex]!.document.updatedAt)
            - timestamp(indexedDocuments[leftIndex]!.document.updatedAt)
          || indexedDocuments[leftIndex]!.document.id.localeCompare(
            indexedDocuments[rightIndex]!.document.id,
          )
        )
        .slice(0, boundedLimit)
        .map(([documentIndex, score]) => {
          const document = indexedDocuments[documentIndex]!.document;
          return {
            ...document,
            score,
            snippet: virtualFileSearchSnippet(document.content, query),
          };
        });
    },
  });
}

export function formatVirtualFindPage(page: VirtualFindPage): string {
  if (page.entries.length > VIRTUAL_FIND_LIMITS.maximumResults) {
    throw new Error(
      `virtual find page must contain at most ${VIRTUAL_FIND_LIMITS.maximumResults} entries`,
    );
  }
  const attributes = [
    `root="${escapeXml(page.root)}"`,
    `count="${page.entries.length}"`,
    ...(page.query ? [`query="${escapeXml(page.query)}"`] : []),
    ...(page.nextCursor ? [`next_cursor="${escapeXml(page.nextCursor)}"`] : []),
  ];
  const lines = [`<files ${attributes.join(" ")}>`];
  for (const entry of page.entries) {
    const entryAttributes = [
      `kind="${entry.kind}"`,
      `path="${escapeXml(entry.path)}"`,
      ...(entry.title ? [`title="${escapeXml(entry.title)}"`] : []),
      ...(entry.tags?.length
        ? [`tags="${escapeXml(entry.tags.map((tag) => `#${tag}`).join(" "))}"`]
        : []),
      ...(entry.visibility ? [`visibility="${entry.visibility}"`] : []),
      ...(entry.updatedAt !== undefined
        ? [`updated="${escapeXml(isoTimestamp(entry.updatedAt))}"`]
        : []),
    ];
    lines.push(entry.snippet
      ? `  <entry ${entryAttributes.join(" ")}><snippet>${escapeXml(entry.snippet)}</snippet></entry>`
      : `  <entry ${entryAttributes.join(" ")} />`);
  }
  lines.push("</files>");
  const output = lines.join("\n");
  if (output.length > VIRTUAL_FIND_LIMITS.outputCharacters) {
    throw new Error(
      `virtual find output must contain at most ${VIRTUAL_FIND_LIMITS.outputCharacters} characters`,
    );
  }
  return output;
}

function addWeightedTerms(
  frequencies: Map<string, number>,
  value: string,
  weight: number,
): number {
  const terms = tokenizeVirtualFileSearchText(value);
  for (const term of terms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + weight);
  }
  return terms.length;
}

function searchTermPrefix(term: string): string {
  return [...term].slice(0, LOCAL_SEARCH_MIN_TERM_LENGTH).join("");
}

function virtualFileSearchSnippet(content: string, query: string): string {
  const normalizedContent = normalizeVirtualFileSearchText(content);
  const firstTerm = uniqueVirtualFileSearchTerms(query, 1)[0] ?? "";
  const matchIndex = firstTerm ? normalizedContent.indexOf(firstTerm) : -1;
  const start = matchIndex > 40 ? matchIndex - 40 : 0;
  const end = Math.min(content.length, start + VIRTUAL_FIND_LIMITS.snippetCharacters);
  const body = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < content.length ? "…" : ""}`;
}

function titleFromMarkdown(content: string): string {
  const first = content.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return first.startsWith("# ") ? first.slice(2).trim() : "";
}

function timestamp(value: VirtualFileSearchDocument["updatedAt"]): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value: Date | string | number): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("virtual file timestamp is invalid");
  return parsed.toISOString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
