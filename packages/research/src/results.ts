import { z } from "zod";
import type { ResearchResult } from "./contracts.js";

export const WEB_SEARCH_MODEL_MAX_RESULTS = 8;
export const WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS = 600;
export const WEB_SEARCH_MODEL_MAX_CHARACTERS = 8_000;
export const READ_URL_MODEL_MAX_RESULTS = 5;
export const READ_URL_MODEL_CONTENT_MAX_CHARACTERS = 20_000;
export const READ_URL_MODEL_MAX_CHARACTERS = 100_000;
export const RESEARCH_RESULT_TITLE_MAX_CHARACTERS = 1_000;
export const RESEARCH_RESULT_AUTHOR_MAX_CHARACTERS = 200;
export const RESEARCH_RESULT_URL_MAX_CHARACTERS = 4_096;
export const RESEARCH_RESULT_DATE_MAX_CHARACTERS = 100;

const MAX_HIGHLIGHTS_PER_RESULT = 100;
const whitespacePattern = /\s/u;
const isoDateSchema = z.iso.date();
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export function formatWebSearchResults(
  results: readonly ResearchResult[],
): string {
  if (results.length === 0) return "No results.";
  const entries = results
    .slice(0, WEB_SEARCH_MODEL_MAX_RESULTS)
    .map((result, index) => {
      const heading = formatMarkdownResultHeading(result, index);
      const excerpt = truncateText(
        compactHighlights(result.highlights) ||
          compactBoundedText(result.summary, WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS) ||
          compactBoundedText(result.text, WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS),
        WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS,
      );
      return excerpt ? `${heading}\n> ${excerpt}` : heading;
    });
  return joinBoundedResults(entries, WEB_SEARCH_MODEL_MAX_CHARACTERS);
}

export function formatReadUrlResults(
  results: readonly ResearchResult[],
): string {
  if (results.length === 0) return "No content fetched.";
  const entries = results
    .slice(0, READ_URL_MODEL_MAX_RESULTS)
    .map((result, index) => {
      const heading = formatMarkdownResultHeading(result, index);
      const content =
        compactBoundedText(result.text ?? result.summary, READ_URL_MODEL_CONTENT_MAX_CHARACTERS) ||
        "No content extracted.";
      return `${heading}\n${content}`;
    });
  return joinBoundedResults(entries, READ_URL_MODEL_MAX_CHARACTERS);
}

function formatMarkdownResultHeading(
  result: ResearchResult,
  index: number,
): string {
  const title = compactBoundedText(result.title, RESEARCH_RESULT_TITLE_MAX_CHARACTERS) || "Untitled";
  const metadata = [
    compactDate(result.publishedDate),
    compactBoundedText(result.author, RESEARCH_RESULT_AUTHOR_MAX_CHARACTERS),
  ].filter(Boolean);
  const url = compactBoundedText(result.url, RESEARCH_RESULT_URL_MAX_CHARACTERS);
  return [
    `[${index + 1}] [${escapeMarkdownLabel(title, RESEARCH_RESULT_TITLE_MAX_CHARACTERS)}](${escapeMarkdownUrl(url, RESEARCH_RESULT_URL_MAX_CHARACTERS)})`,
    ...metadata,
  ].join(" · ");
}

function compactHighlights(values: readonly string[] | undefined): string {
  if (!values) return "";
  const highlights: string[] = [];
  let length = 0;
  let truncated = values.length > MAX_HIGHLIGHTS_PER_RESULT;
  for (const value of values.slice(0, MAX_HIGHLIGHTS_PER_RESULT)) {
    const separatorLength = highlights.length > 0 ? 1 : 0;
    const remaining = WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS - length - separatorLength;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const highlight = compactBoundedTextResult(value, remaining);
    if (highlight.text) {
      highlights.push(highlight.text);
      length += separatorLength + highlight.text.length;
    }
    if (highlight.truncated) {
      truncated = true;
      break;
    }
  }
  const compacted = highlights.join(" ");
  return truncated && !compacted.endsWith("…")
    ? indicateTruncation(compacted, WEB_SEARCH_MODEL_EXCERPT_MAX_CHARACTERS)
    : compacted;
}

function compactBoundedText(value: string | undefined, maxCharacters: number): string {
  return compactBoundedTextResult(value, maxCharacters).text;
}

function compactBoundedTextResult(
  value: string | undefined,
  maxCharacters: number,
): Readonly<{ text: string; truncated: boolean }> {
  if (!value || maxCharacters <= 0) return { text: "", truncated: false };
  let compacted = "";
  let pendingSpace = false;
  for (const character of value) {
    if (whitespacePattern.test(character)) {
      if (compacted) pendingSpace = true;
      continue;
    }
    const separator = pendingSpace ? " " : "";
    if (compacted.length + separator.length + character.length > maxCharacters) {
      return {
        text: indicateTruncation(compacted, maxCharacters),
        truncated: true,
      };
    }
    compacted += separator + character;
    pendingSpace = false;
  }
  return { text: compacted, truncated: false };
}

function compactDate(value: string | undefined): string {
  const date = compactBoundedText(value, RESEARCH_RESULT_DATE_MAX_CHARACTERS);
  if (isoDateSchema.safeParse(date).success) return date;
  return isoDateTimeSchema.safeParse(date).success ? date.slice(0, 10) : "";
}

function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return indicateTruncation(value, maxCharacters);
}

function indicateTruncation(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  return `${sliceText(value, maxCharacters - 1).trimEnd()}…`;
}

function joinBoundedResults(
  entries: readonly string[],
  maxCharacters: number,
): string {
  let output = "";
  for (const entry of entries) {
    const separator = output ? "\n\n" : "";
    if (output.length + separator.length + entry.length > maxCharacters) break;
    output += separator + entry;
  }
  return output;
}

function sliceText(value: string, maxCharacters: number): string {
  let end = Math.min(value.length, maxCharacters);
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function escapeMarkdownLabel(value: string, maxCharacters: number): string {
  let escaped = "";
  const characters = [...value];
  for (const [index, character] of characters.entries()) {
    const next = character === "\\" || character === "[" || character === "]"
      ? `\\${character}`
      : character;
    const hasMore = index < characters.length - 1;
    if (escaped.length + next.length + (hasMore ? 1 : 0) > maxCharacters) {
      return `${escaped}…`;
    }
    escaped += next;
  }
  return escaped;
}

function escapeMarkdownUrl(value: string, maxCharacters: number): string {
  let escaped = "";
  for (const character of value) {
    const next = character === "(" ? "%28" : character === ")" ? "%29" : character;
    if (escaped.length + next.length > maxCharacters) break;
    escaped += next;
  }
  return escaped;
}
