/** Hard limits for strings emitted into model context. */
export const CONTEXT_DOCUMENT_LIMITS = Object.freeze({
    documents: 100,
    outputCharacters: 256_000,
});
/** Normalize harmless Markdown formatting without changing fenced code. */
export function normalizeMarkdown(content) {
    let normalized = "";
    let outsideFence = "";
    let fenced = "";
    let outsideBeginsAfterFence = false;
    let fence = null;
    for (const line of content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
        if (!line)
            continue;
        const body = line.replace(/(?:\r\n|\r|\n)$/, "");
        if (fence) {
            fenced += line;
            if (isClosingFence(body, fence.character, fence.length)) {
                normalized += fenced;
                fenced = "";
                outsideBeginsAfterFence = true;
                fence = null;
            }
            continue;
        }
        const openingFence = parseOpeningFence(body);
        if (openingFence) {
            normalized += normalizeMarkdownProse(outsideFence, outsideBeginsAfterFence);
            outsideFence = "";
            outsideBeginsAfterFence = false;
            fenced = line;
            fence = openingFence;
            continue;
        }
        outsideFence += line;
    }
    if (fence)
        return normalized + fenced;
    return normalized + normalizeMarkdownProse(outsideFence, outsideBeginsAfterFence).trimEnd();
}
export function extractMarkdownTitle(content, fallback) {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("# "))
        return fallback ?? null;
    const firstLineEnd = trimmed.indexOf("\n");
    const heading = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
    return heading.slice(2).trim() || (fallback ?? null);
}
/** Derive a short catalog description from the first prose paragraph. */
export function extractMarkdownDescription(content, maximumCharacters = 240) {
    if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
        throw new Error("maximumCharacters must be a non-negative safe integer");
    }
    const prose = markdownProseOutsideFences(normalizeMarkdown(content))
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .find((block) => block && !/^(?:#{1,6}\s|[-*+]\s|```|>\s)/.test(block));
    if (!prose || maximumCharacters === 0)
        return "";
    const plain = prose
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (plain.length <= maximumCharacters)
        return plain;
    return `${sliceText(plain, Math.max(0, maximumCharacters - 1)).trimEnd()}…`;
}
export function formatContextDocumentCatalog(documents) {
    if (documents.length > CONTEXT_DOCUMENT_LIMITS.documents) {
        throw new Error(`context document catalog must contain at most ${CONTEXT_DOCUMENT_LIMITS.documents} documents`);
    }
    const entries = [];
    let outputCharacters = 0;
    for (const document of documents) {
        if (entries.length >= CONTEXT_DOCUMENT_LIMITS.documents) {
            throw new Error(`context document catalog must contain at most ${CONTEXT_DOCUMENT_LIMITS.documents} documents`);
        }
        const snapshot = snapshotDocumentEnvelope(document);
        const description = document.description;
        outputCharacters += documentOutputCharacters(snapshot, description) + (entries.length === 0 ? 0 : 1);
        assertBoundedOutput(outputCharacters);
        entries.push(formatDocumentBody(snapshot, description));
    }
    return entries.join("\n");
}
export function formatContextDocument(document) {
    const snapshot = snapshotDocumentEnvelope(document);
    const markdown = document.markdown;
    documentOutputCharacters(snapshot, markdown);
    return formatDocumentBody(snapshot, markdown);
}
export function reconcileRevisionedDraft(input) {
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
function markdownProseOutsideFences(content) {
    const prose = [];
    let fence = null;
    for (const line of content.split(/\r\n|\r|\n/)) {
        if (fence) {
            if (isClosingFence(line, fence.character, fence.length))
                fence = null;
            continue;
        }
        const openingFence = parseOpeningFence(line);
        if (openingFence) {
            fence = openingFence;
            prose.push("");
            continue;
        }
        prose.push(line);
    }
    return prose.join("\n");
}
function normalizeMarkdownProse(content, beginsAfterFence = false) {
    const withoutExcessLeadingLines = beginsAfterFence
        ? content.replace(/^(?:\r\n|(?<!\r)\n|\r(?!\n)){2,}/, "\n")
        : content;
    return withoutExcessLeadingLines
        .replace(/^(#{1,6})[ \t]+\*{1,3}(.+?)\*{1,3}[ \t]*(\r?)$/gm, "$1 $2$3")
        .replace(/^(#{1,6}[ \t]+.*?)\\\.(.*?)(\r?)$/gm, "$1.$2$3")
        .replace(/(?:\r\n|(?<!\r)\n|\r(?!\n)){3,}/g, "\n\n");
}
function parseOpeningFence(line) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match)
        return null;
    const marker = match[1];
    if (marker[0] === "`" && match[2].includes("`"))
        return null;
    return { character: marker[0], length: marker.length };
}
function isClosingFence(line, character, minimumLength) {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return Boolean(match && match[1][0] === character && match[1].length >= minimumLength);
}
function snapshotDocumentEnvelope(document) {
    return {
        id: document.id,
        name: document.name,
        revision: String(document.revision),
    };
}
function formatDocumentBody(document, content) {
    return [
        `<document id="${escapeXml(document.id)}" revision="${escapeXml(document.revision)}" name="${escapeXml(document.name)}">`,
        escapeXml(content),
        "</document>",
    ].join("\n");
}
function documentOutputCharacters(document, content) {
    let characters = '<document id="'.length;
    characters = addEscapedXmlCharacters(characters, document.id);
    characters += '" revision="'.length;
    characters = addEscapedXmlCharacters(characters, document.revision);
    characters += '" name="'.length;
    characters = addEscapedXmlCharacters(characters, document.name);
    characters += '">\n'.length;
    characters = addEscapedXmlCharacters(characters, content);
    characters += "\n</document>".length;
    assertBoundedOutput(characters);
    return characters;
}
function addEscapedXmlCharacters(total, value) {
    let characters = total;
    for (const character of value) {
        characters += character === "&"
            ? 5
            : character === "<" || character === ">"
                ? 4
                : character === '"' || character === "'"
                    ? 6
                    : character.length;
        assertBoundedOutput(characters);
    }
    return characters;
}
function assertBoundedOutput(characters) {
    if (characters > CONTEXT_DOCUMENT_LIMITS.outputCharacters) {
        throw new Error(`context document output must contain at most ${CONTEXT_DOCUMENT_LIMITS.outputCharacters} characters`);
    }
}
function sliceText(value, maximumCharacters) {
    let end = Math.min(value.length, maximumCharacters);
    if (end > 0 &&
        end < value.length &&
        value.charCodeAt(end - 1) >= 0xd800 &&
        value.charCodeAt(end - 1) <= 0xdbff &&
        value.charCodeAt(end) >= 0xdc00 &&
        value.charCodeAt(end) <= 0xdfff) {
        end -= 1;
    }
    return value.slice(0, end);
}
function escapeXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
