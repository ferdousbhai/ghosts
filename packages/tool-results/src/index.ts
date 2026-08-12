export const MODEL_TOOL_RESULT_MAX_CHARACTERS = 64_000;
export const TOOL_RESULT_PAGE_DEFAULT_CHARACTERS = 40_000;
export const TOOL_RESULT_PAGE_MAX_CHARACTERS = 60_000;
export const TOOL_RESULT_SNAPSHOT_MAX_CHARACTERS = 4_000_000;
export const TOOL_RESULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const TOOL_RESULT_SNAPSHOT_MAX_ENTRIES = 24;
export const TOOL_RESULT_STORE_MAX_CHARACTERS = 16_000_000;
export const TOOL_RESULT_BOUNDARY_RETAINED_MAX_CHARACTERS = 8_000_000;
export const TOOL_RESULT_TURN_MAX_CHARACTERS = 512_000;
export const TOOL_ERROR_MAX_CHARACTERS = 8_000;

const TOOL_RESULT_PAGE_ENVELOPE_MAX_CHARACTERS = 2_048;

export type ToolResultSnapshot = Readonly<{
  content: string;
  createdAt: number;
  handle: string;
  scope: string;
  toolCallId: string;
  toolName: string;
}>;

export type ToolResultPage = Readonly<{
  content: string;
  contentEnd: number;
  contentStart: number;
  nextContentStart?: number;
  previousContentStart?: number;
  totalCharacters: number;
}>;

export type StoredToolResultPage = ToolResultSnapshot & ToolResultPage;

/**
 * Private snapshot persistence supplied by the host. A returned handle must
 * never be rebound to different snapshot data. `getPage` is the scoped
 * redemption boundary and must return null for a handle from another scope.
 */
export interface ToolResultStore {
  getPage(input: Readonly<{
    contentStart: number;
    handle: string;
    maxCharacters: number;
    scope: string;
  }>): StoredToolResultPage | null;
  set(input: Readonly<{
    content: string;
    scope: string;
    toolCallId: string;
    toolName: string;
  }>): ToolResultSnapshot | null;
  /** Keep one active scope's handles alive until its run settles. */
  pinScope?(scope: string): () => void;
  clear?(): void;
}

export type ToolResultPaginationDetails = Readonly<{
  handle: string;
  paginated: true;
  toolName: string;
  totalCharacters: number;
}>;

export type ToolResultOmissionDetails = Readonly<{
  omitted: true;
  paginated: false;
  reason: "retention_unavailable" | "turn_output_budget";
  toolName: string;
  totalCharacters: number;
}>;

export type ToolResultDelivery = Readonly<{
  details: ToolResultPaginationDetails | ToolResultOmissionDetails | undefined;
  text: string;
}>;

export type ToolResultBoundary = Readonly<{
  exhausted: boolean;
  /** True after this boundary produces a paginated, redeemable result. */
  hasReadableResult: boolean;
  /** Host-private scope that must accompany later handle redemption. */
  scope: string;
  error(error: unknown): string;
  deliver(input: Readonly<{
    content: string;
    toolCallId: string;
    toolName: string;
  }>): ToolResultDelivery;
}>;

function boundedInteger(value: number, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

/** Replace unpaired UTF-16 surrogates without changing valid Unicode text. */
export function toWellFormedText(value: string): string {
  let normalized = "";
  let segmentStart = 0;
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }
    normalized += `${value.slice(segmentStart, index)}\ufffd`;
    segmentStart = index + 1;
    changed = true;
  }
  return changed ? normalized + value.slice(segmentStart) : value;
}

/** Slice by UTF-16 offsets while never splitting a valid surrogate pair. */
export function sliceTextPage(
  value: string,
  contentStart: number,
  maxCharacters: number,
): Readonly<{ content: string; contentEnd: number; contentStart: number }> {
  let start = Math.min(
    Math.max(0, Number.isSafeInteger(contentStart) ? contentStart : 0),
    value.length,
  );
  if (
    start > 0 &&
    start < value.length &&
    isLowSurrogate(value.charCodeAt(start)) &&
    isHighSurrogate(value.charCodeAt(start - 1))
  ) {
    start -= 1;
  }
  const limit = Number.isSafeInteger(maxCharacters) && maxCharacters > 0
    ? maxCharacters
    : 1;
  let end = Math.min(value.length, start + limit);
  if (
    end > start &&
    end < value.length &&
    isLowSurrogate(value.charCodeAt(end)) &&
    isHighSurrogate(value.charCodeAt(end - 1))
  ) {
    end = end - 1 === start ? Math.min(value.length, end + 1) : end - 1;
  }
  return Object.freeze({
    content: value.slice(start, end),
    contentStart: start,
    contentEnd: end,
  });
}

/** Return one immutable offset page from an exact snapshot. */
export function toolResultPage(
  snapshot: ToolResultSnapshot,
  contentStart = 0,
  maxCharacters = TOOL_RESULT_PAGE_DEFAULT_CHARACTERS,
): ToolResultPage {
  const limit = boundedInteger(
    Math.floor(maxCharacters),
    TOOL_RESULT_PAGE_DEFAULT_CHARACTERS,
    TOOL_RESULT_PAGE_MAX_CHARACTERS,
  );
  const requestedStart = Math.min(
    Math.max(0, Number.isSafeInteger(contentStart) ? contentStart : 0),
    snapshot.content.length,
  );
  const sliced = sliceTextPage(snapshot.content, requestedStart, limit);
  const { content, contentStart: start, contentEnd: end } = sliced;
  return Object.freeze({
    content,
    contentStart: start,
    contentEnd: end,
    totalCharacters: snapshot.content.length,
    ...(end < snapshot.content.length ? { nextContentStart: end } : {}),
    ...(start > 0
      ? { previousContentStart: previousPageStart(snapshot.content, start, limit) }
      : {}),
  });
}

export function formatToolResultPage(
  snapshot: ToolResultSnapshot,
  contentStart = 0,
  maxCharacters = TOOL_RESULT_PAGE_DEFAULT_CHARACTERS,
): string {
  return formatStoredToolResultPage({
    ...snapshot,
    ...toolResultPage(snapshot, contentStart, maxCharacters),
  });
}

export function formatStoredToolResultPage(page: StoredToolResultPage): string {
  return fitStoredToolResultPage(page, MODEL_TOOL_RESULT_MAX_CHARACTERS);
}

/**
 * Bound model-facing tool output and retain oversized exact results in the
 * host's private store. Scope values are capabilities and must stay private.
 */
export function createToolResultBoundary(
  store: ToolResultStore,
  maximumTurnCharacters = TOOL_RESULT_TURN_MAX_CHARACTERS,
  scope = `tool-result-scope-${crypto.randomUUID()}`,
  maximumRetainedCharacters = TOOL_RESULT_BOUNDARY_RETAINED_MAX_CHARACTERS,
): ToolResultBoundary {
  const turnLimit = boundedInteger(
    maximumTurnCharacters,
    TOOL_RESULT_TURN_MAX_CHARACTERS,
    TOOL_RESULT_TURN_MAX_CHARACTERS,
  );
  let deliveredCharacters = 0;
  let retainedCharacters = 0;
  let exhausted = false;
  let hasReadableResult = false;

  const stop = (message: string): string => {
    if (exhausted) return "";
    exhausted = true;
    const remaining = turnLimit - deliveredCharacters;
    const compact = "<tool_output_budget_exhausted/>";
    const text = message.length <= remaining
      ? message
      : compact.length <= remaining
        ? compact
        : "";
    deliveredCharacters += text.length;
    return text;
  };
  const consume = (text: string): Readonly<{ accepted: boolean; text: string }> => {
    if (exhausted) return { accepted: false, text: "" };
    if (deliveredCharacters + text.length > turnLimit) {
      return { accepted: false, text: stop(outputBudgetMessage(turnLimit)) };
    }
    deliveredCharacters += text.length;
    return { accepted: true, text };
  };

  return {
    get exhausted() {
      return exhausted;
    },
    get hasReadableResult() {
      return hasReadableResult;
    },
    scope,
    error(error) {
      return consume(boundedToolErrorMessage(error)).text;
    },
    deliver({ content, toolCallId, toolName }) {
      const safeContent = toWellFormedText(content);
      if (safeContent.length <= MODEL_TOOL_RESULT_MAX_CHARACTERS) {
        const consumed = consume(safeContent);
        return Object.freeze({
          text: consumed.text,
          details: consumed.accepted
            ? undefined
            : Object.freeze({
                omitted: true,
                paginated: false,
                reason: "turn_output_budget",
                toolName: boundedMetadata(toolName),
                totalCharacters: safeContent.length,
              }),
        });
      }

      if (
        exhausted ||
        retainedCharacters + safeContent.length > maximumRetainedCharacters ||
        deliveredCharacters +
            TOOL_RESULT_PAGE_DEFAULT_CHARACTERS +
            TOOL_RESULT_PAGE_ENVELOPE_MAX_CHARACTERS >
          turnLimit
      ) {
        return Object.freeze({
          text: stop(outputBudgetMessage(turnLimit)),
          details: Object.freeze({
            omitted: true,
            paginated: false,
            reason: "turn_output_budget",
            toolName: boundedMetadata(toolName),
            totalCharacters: safeContent.length,
          }),
        });
      }

      let snapshot: ToolResultSnapshot | null = null;
      try {
        snapshot = store.set({
          content: safeContent,
          scope,
          toolCallId,
          toolName,
        });
      } catch {
        // Cache failure must not make a completed side-effecting tool appear
        // retryable. Return a bounded terminal result and stop further tools.
      }
      if (!snapshot) {
        return Object.freeze({
          text: stop(unavailableResultMessage(toolName, safeContent.length)),
          details: Object.freeze({
            paginated: false,
            omitted: true,
            reason: "retention_unavailable",
            toolName: boundedMetadata(toolName),
            totalCharacters: safeContent.length,
          }),
        });
      }
      const immutableSnapshot = Object.freeze({ ...snapshot });
      retainedCharacters += safeContent.length;
      const firstPage = {
        ...immutableSnapshot,
        ...toolResultPage(immutableSnapshot),
      };
      const consumed = consume(fitStoredToolResultPage(
        firstPage,
        turnLimit - deliveredCharacters,
      ));
      if (consumed.accepted) hasReadableResult = true;
      return Object.freeze({
        text: consumed.text,
        details: compactToolDetails(immutableSnapshot),
      });
    },
  };
}

export function boundedToolErrorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "Tool execution failed with an unreadable error.";
  }
  message = toWellFormedText(message);
  if (message.length <= TOOL_ERROR_MAX_CHARACTERS) return message;
  const suffix = "\n… tool error truncated";
  const page = sliceTextPage(
    message,
    0,
    TOOL_ERROR_MAX_CHARACTERS - suffix.length,
  );
  return `${page.content}${suffix}`;
}

/** A bounded process-local adapter; durable stores can implement ToolResultStore. */
export function createInMemoryToolResultStore(
  maximumCharacters = TOOL_RESULT_SNAPSHOT_MAX_CHARACTERS,
  maximumTotalCharacters = TOOL_RESULT_STORE_MAX_CHARACTERS,
): ToolResultStore {
  const entries = new Map<string, ToolResultSnapshot>();
  const pinnedScopes = new Map<string, number>();
  let retainedCharacters = 0;

  const remove = (handle: string, snapshot: ToolResultSnapshot): void => {
    entries.delete(handle);
    retainedCharacters -= snapshot.content.length;
  };
  const get = (handle: string): ToolResultSnapshot | null => {
    const snapshot = entries.get(handle);
    if (!snapshot) return null;
    if (
      snapshot.createdAt < Date.now() - TOOL_RESULT_SNAPSHOT_TTL_MS &&
      !pinnedScopes.has(snapshot.scope)
    ) {
      remove(handle, snapshot);
      return null;
    }
    return snapshot;
  };

  return {
    getPage({ contentStart, handle, maxCharacters, scope }) {
      const snapshot = get(handle);
      if (!snapshot || snapshot.scope !== scope) return null;
      return Object.freeze({
        ...snapshot,
        ...toolResultPage(snapshot, contentStart, maxCharacters),
      });
    },
    set(input) {
      if (input.content.length > maximumCharacters) return null;
      for (const [handle, snapshot] of entries) {
        if (
          snapshot.createdAt < Date.now() - TOOL_RESULT_SNAPSHOT_TTL_MS &&
          !pinnedScopes.has(snapshot.scope)
        ) {
          remove(handle, snapshot);
        }
      }
      const projectedCharacters = retainedCharacters + input.content.length;
      if (projectedCharacters > maximumTotalCharacters) return null;
      if (entries.size >= TOOL_RESULT_SNAPSHOT_MAX_ENTRIES) {
        const evicted = [...entries].find(([, snapshot]) =>
          !pinnedScopes.has(snapshot.scope)
        );
        if (!evicted) return null;
        remove(evicted[0], evicted[1]);
      }
      const handle = `tool-result-${crypto.randomUUID()}`;
      const snapshot = Object.freeze({
        content: input.content,
        createdAt: Date.now(),
        handle,
        scope: input.scope,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      });
      entries.set(handle, snapshot);
      retainedCharacters += input.content.length;
      return snapshot;
    },
    pinScope(scope) {
      pinnedScopes.set(scope, (pinnedScopes.get(scope) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (pinnedScopes.get(scope) ?? 1) - 1;
        if (remaining > 0) pinnedScopes.set(scope, remaining);
        else pinnedScopes.delete(scope);
      };
    },
    clear() {
      entries.clear();
      pinnedScopes.clear();
      retainedCharacters = 0;
    },
  };
}

function previousPageStart(
  value: string,
  contentStart: number,
  maxCharacters: number,
): number {
  const candidate = Math.max(0, contentStart - maxCharacters);
  if (
    candidate > 0 &&
    candidate < value.length &&
    isLowSurrogate(value.charCodeAt(candidate)) &&
    isHighSurrogate(value.charCodeAt(candidate - 1))
  ) {
    const pairStart = candidate - 1;
    return sliceTextPage(value, pairStart, maxCharacters).contentEnd === contentStart
      ? pairStart
      : candidate + 1;
  }
  return candidate;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function boundedMetadata(value: string, maxCharacters = 200): string {
  return sliceTextPage(toWellFormedText(value), 0, maxCharacters).content;
}

function xmlAttribute(value: string, maxCharacters = 200): string {
  return escapeXml(boundedMetadata(value, maxCharacters))
    .replaceAll('"', "&quot;");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fitStoredToolResultPage(
  page: StoredToolResultPage,
  maximumOutputCharacters: number,
): string {
  let low = 0;
  let high = page.content.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const localPage = sliceTextPage(page.content, 0, candidate);
    const fitted = pageWithContent(page, localPage.content, localPage.contentEnd);
    if (renderStoredToolResultPage(fitted).length <= maximumOutputCharacters) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  const localPage = low === 0
    ? { content: "", contentEnd: 0 }
    : sliceTextPage(page.content, 0, low);
  return renderStoredToolResultPage(
    pageWithContent(page, localPage.content, localPage.contentEnd),
  );
}

function pageWithContent(
  page: StoredToolResultPage,
  content: string,
  localContentEnd: number,
): StoredToolResultPage {
  const contentEnd = page.contentStart + localContentEnd;
  return Object.freeze({
    content,
    contentStart: page.contentStart,
    contentEnd,
    createdAt: page.createdAt,
    handle: page.handle,
    scope: page.scope,
    toolCallId: page.toolCallId,
    toolName: page.toolName,
    totalCharacters: page.totalCharacters,
    ...(contentEnd < page.totalCharacters ? { nextContentStart: contentEnd } : {}),
    ...(page.previousContentStart === undefined
      ? {}
      : { previousContentStart: page.previousContentStart }),
  });
}

function renderStoredToolResultPage(page: StoredToolResultPage): string {
  const attributes = [
    `handle="${xmlAttribute(page.handle, 100)}"`,
    `tool="${xmlAttribute(page.toolName)}"`,
    `content_start="${page.contentStart}"`,
    `content_end="${page.contentEnd}"`,
    `shown_chars="${page.contentEnd - page.contentStart}"`,
    `total_chars="${page.totalCharacters}"`,
    `partial="${page.contentEnd < page.totalCharacters ? "true" : "false"}"`,
    ...(page.nextContentStart === undefined
      ? []
      : [`next_content_start="${page.nextContentStart}"`]),
    ...(page.previousContentStart === undefined
      ? []
      : [`previous_content_start="${page.previousContentStart}"`]),
  ];
  return [
    `<tool_result_page ${attributes.join(" ")}>`,
    escapeXml(page.content),
    "</tool_result_page>",
  ].join("\n");
}

function compactToolDetails(input: ToolResultSnapshot): ToolResultPaginationDetails {
  return Object.freeze({
    paginated: true,
    handle: input.handle,
    toolName: boundedMetadata(input.toolName),
    totalCharacters: input.content.length,
  });
}

function outputBudgetMessage(limit: number): string {
  return [
    `<tool_output_budget_exhausted max_chars="${limit}"/>`,
    "No more tool output is available in this turn. Answer using the results already received.",
  ].join("\n");
}

function unavailableResultMessage(toolName: string, totalCharacters: number): string {
  return [
    `<tool_result_unavailable tool="${xmlAttribute(toolName)}" total_chars="${totalCharacters}"/>`,
    "The result exceeded the safe retained-output limit. Narrow the request instead of repeating the same tool call.",
  ].join("\n");
}
