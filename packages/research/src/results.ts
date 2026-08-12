import type { ResearchResult } from "./contracts.js";

export const WEB_SEARCH_MODEL_MAX_RESULTS = 8;
export const WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS = 600;
export const READ_URL_MODEL_MAX_RESULTS = 5;
export const READ_URL_MODEL_CONTENT_MAX_CHARACTERS = 20_000;

export function formatWebSearchResults(
  results: readonly ResearchResult[],
): string {
  if (results.length === 0) return "No results.";
  return results
    .slice(0, WEB_SEARCH_MODEL_MAX_RESULTS)
    .map((result, index) => {
      const heading = formatMarkdownResultHeading(result, index);
      const excerpt = truncateText(
        result.highlights?.map(compactText).filter(Boolean).join(" ") ||
          compactText(result.summary) ||
          compactText(result.text),
        WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS,
      );
      return excerpt ? `${heading}\n> ${excerpt}` : heading;
    })
    .join("\n\n");
}

export function formatReadUrlResults(
  results: readonly ResearchResult[],
): string {
  if (results.length === 0) return "No content fetched.";
  return results
    .slice(0, READ_URL_MODEL_MAX_RESULTS)
    .map((result, index) => {
      const heading = formatMarkdownResultHeading(result, index);
      const content = truncateText(
        compactText(result.text ?? result.summary) || "No content extracted.",
        READ_URL_MODEL_CONTENT_MAX_CHARACTERS,
      );
      return `${heading}\n${content}`;
    })
    .join("\n\n");
}

function formatMarkdownResultHeading(
  result: ResearchResult,
  index: number,
): string {
  const title = compactText(result.title) || "Untitled";
  const metadata = [compactDate(result.publishedDate), compactText(result.author)].filter(Boolean);
  return [
    `[${index + 1}] [${escapeMarkdownLabel(title)}](${escapeMarkdownUrl(result.url)})`,
    ...metadata,
  ].join(" · ");
}

function compactText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function compactDate(value: string | undefined): string {
  const date = compactText(value);
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date;
}

function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function escapeMarkdownUrl(value: string): string {
  return value.replaceAll("(", "%28").replaceAll(")", "%29");
}
