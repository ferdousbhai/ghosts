const DEFAULT_LIMIT = 10;
const MAXIMUM_LIMIT = 100;
export const TOOL_DISCOVERY_LIMITS = Object.freeze({
    catalogEntries: 5_000,
    descriptionCharacters: 4_096,
    fuzzyDistanceCellsPerSearch: 1_000_000,
    idCharacters: 512,
    keywordsPerEntry: 64,
    keywordCharacters: 256,
    nameCharacters: 256,
    queryCharacters: 200,
    queryTerms: 24,
    searchableTokens: 100_000,
    searchableTokensPerEntry: 512,
    tokenCharacters: 128,
});
const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
]);
/**
 * Build a dependency-free discovery index over a consumer-admitted catalog.
 * The snapshot is the activation boundary: neither queries nor restored state
 * can introduce an ID that was not present when this object was created.
 */
export function createToolDiscovery(admittedCatalog) {
    if (!Array.isArray(admittedCatalog)
        || admittedCatalog.length > TOOL_DISCOVERY_LIMITS.catalogEntries) {
        throw new Error(`tool discovery catalog must contain at most ${TOOL_DISCOVERY_LIMITS.catalogEntries} entries`);
    }
    const catalog = Object.freeze(admittedCatalog.map(copyAndValidateEntry));
    const byId = new Map();
    for (const entry of catalog) {
        if (byId.has(entry.id)) {
            throw new Error(`tool discovery catalog contains duplicate ID: ${entry.id}`);
        }
        byId.set(entry.id, entry);
    }
    const indexed = catalog.map(indexEntry);
    const searchableTokenCount = indexed.reduce((total, entry) => total + entry.fields.reduce((fieldTotal, field) => fieldTotal + field.tokens.length, 0), 0);
    if (searchableTokenCount > TOOL_DISCOVERY_LIMITS.searchableTokens) {
        throw new Error(`tool discovery catalog must contain at most ${TOOL_DISCOVERY_LIMITS.searchableTokens} searchable tokens`);
    }
    const createState = (activatedIds = []) => {
        if (!Array.isArray(activatedIds)
            || activatedIds.length > TOOL_DISCOVERY_LIMITS.catalogEntries) {
            throw new Error("tool discovery activatedIds must be a bounded string array");
        }
        const admitted = new Set();
        for (const id of activatedIds) {
            if (typeof id !== "string") {
                throw new Error("tool discovery activatedIds must contain only strings");
            }
            if (id.length > TOOL_DISCOVERY_LIMITS.idCharacters) {
                throw new Error(`tool discovery activated IDs must contain at most ${TOOL_DISCOVERY_LIMITS.idCharacters} characters`);
            }
            if (byId.has(id))
                admitted.add(id);
        }
        return freezeState([...admitted].sort(compareIds));
    };
    const reconcileState = (state) => createState(state.activatedIds);
    const discover = (request = {}) => {
        const limit = validatedLimit(request.limit);
        const state = request.state
            ? reconcileState(request.state)
            : createState();
        const active = new Set(state.activatedIds);
        const available = indexed.filter(({ entry }) => !active.has(entry.id));
        if (available.length === 0) {
            return result("exhausted", [], state, 0);
        }
        if (request.query !== undefined && typeof request.query !== "string") {
            throw new Error("tool discovery query must be a string");
        }
        const query = request.query ?? "";
        if (query.length > TOOL_DISCOVERY_LIMITS.queryCharacters) {
            throw new Error(`tool discovery query must contain at most ${TOOL_DISCOVERY_LIMITS.queryCharacters} characters`);
        }
        const normalizedQuery = normalizeText(query);
        const selected = normalizedQuery
            ? selectBestMatches(rankEntries(available, normalizedQuery), limit)
            : [...available]
                .sort((left, right) => compareIds(left.entry.id, right.entry.id))
                .slice(0, limit);
        if (selected.length === 0) {
            return result("no-match", [], state, available.length);
        }
        const newlyActivatedIds = selected.map(({ entry }) => entry.id);
        const nextState = freezeState([...state.activatedIds, ...newlyActivatedIds].sort(compareIds));
        return result("matched", selected.map(({ entry }) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
        })), nextState, available.length - selected.length);
    };
    return Object.freeze({ catalog, createState, reconcileState, discover });
}
function copyAndValidateEntry(entry) {
    if (!entry || typeof entry !== "object") {
        throw new Error("tool discovery catalog entries must be objects");
    }
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
        throw new Error("tool discovery catalog IDs must be non-empty strings");
    }
    validateCharacterCount(entry.id, TOOL_DISCOVERY_LIMITS.idCharacters, "ID", entry.id);
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
        throw new Error(`tool discovery catalog entry ${entry.id} must have a name`);
    }
    validateCharacterCount(entry.name, TOOL_DISCOVERY_LIMITS.nameCharacters, "name", entry.id);
    if (typeof entry.description !== "string") {
        throw new Error(`tool discovery catalog entry ${entry.id} must have a description`);
    }
    validateCharacterCount(entry.description, TOOL_DISCOVERY_LIMITS.descriptionCharacters, "description", entry.id);
    if (entry.keywords !== undefined && !Array.isArray(entry.keywords)) {
        throw new Error(`tool discovery catalog entry ${entry.id} keywords must be an array`);
    }
    if ((entry.keywords?.length ?? 0) > TOOL_DISCOVERY_LIMITS.keywordsPerEntry) {
        throw new Error(`tool discovery catalog entry ${entry.id} has too many keywords`);
    }
    const keywords = Object.freeze((entry.keywords ?? []).map((keyword) => {
        if (typeof keyword !== "string") {
            throw new Error(`tool discovery catalog entry ${entry.id} has a non-string keyword`);
        }
        validateCharacterCount(keyword, TOOL_DISCOVERY_LIMITS.keywordCharacters, "keyword", entry.id);
        return keyword;
    }));
    return Object.freeze({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        keywords,
    });
}
function indexEntry(entry) {
    const fields = [
        indexField([entry.id], 4),
        indexField([entry.name], 3),
        indexField(entry.keywords ?? [], 2),
        indexField([entry.description], 1),
    ];
    const tokenCount = fields.reduce((total, field) => total + field.tokens.length, 0);
    if (tokenCount > TOOL_DISCOVERY_LIMITS.searchableTokensPerEntry) {
        throw new Error(`tool discovery catalog entry ${entry.id} has too many searchable tokens`);
    }
    return { entry, fields };
}
function indexField(values, weight) {
    const texts = values.map(normalizeText).filter(Boolean);
    return {
        texts,
        tokens: [...new Set(texts.flatMap(tokenize))].map(searchToken),
        weight,
    };
}
function rankEntries(entries, normalizedQuery) {
    const queryTerms = [...new Set(tokenize(normalizedQuery)
            .filter((term) => !STOP_WORDS.has(term)))];
    if (queryTerms.length > TOOL_DISCOVERY_LIMITS.queryTerms) {
        throw new Error(`tool discovery query must contain at most ${TOOL_DISCOVERY_LIMITS.queryTerms} terms`);
    }
    if (queryTerms.length === 0)
        return [];
    const fuzzyBudget = {
        remainingCells: TOOL_DISCOVERY_LIMITS.fuzzyDistanceCellsPerSearch,
    };
    const preparedTerms = queryTerms.map(searchToken);
    return [...entries]
        .sort((left, right) => compareIds(left.entry.id, right.entry.id))
        .flatMap((indexed) => {
        const termScores = [];
        let score = 0;
        for (const term of preparedTerms) {
            let best = 0;
            for (const field of indexed.fields) {
                for (const token of field.tokens) {
                    best = Math.max(best, tokenSimilarity(term, token, fuzzyBudget) * field.weight);
                }
            }
            if (best > 0) {
                termScores.push({ score: best, term: term.text });
                score += best;
            }
        }
        // Phrase matches resolve otherwise-close field matches in favor of IDs,
        // names, and curated keywords over incidental description prose.
        for (const field of indexed.fields) {
            for (const text of field.texts) {
                if (text === normalizedQuery)
                    score += field.weight * 2;
                else if (text.includes(normalizedQuery))
                    score += field.weight;
            }
        }
        return score > 0 ? [{ indexed, score, termScores }] : [];
    }).sort((left, right) => right.score - left.score
        || right.termScores.length - left.termScores.length
        || compareIds(left.indexed.entry.id, right.indexed.entry.id));
}
function selectBestMatches(ranked, limit) {
    const bestByTerm = new Map();
    for (const candidate of ranked) {
        for (const termScore of candidate.termScores) {
            const current = bestByTerm.get(termScore.term);
            if (!current || termScore.score > current.score) {
                bestByTerm.set(termScore.term, { candidate, score: termScore.score });
            }
        }
    }
    const winners = new Set([...bestByTerm.values()].map(({ candidate }) => candidate));
    return ranked
        .filter((candidate) => winners.has(candidate))
        .slice(0, limit)
        .map(({ indexed }) => indexed);
}
function tokenSimilarity(queryTerm, indexedToken, fuzzyBudget) {
    if (queryTerm.text === indexedToken.text)
        return 1;
    if (indexedToken.text.startsWith(queryTerm.text))
        return 0.85;
    if (queryTerm.text.length < 5
        || (queryTerm.bigramMask & indexedToken.bigramMask) === 0) {
        return 0;
    }
    const maximumDistance = Math.floor(queryTerm.text.length * 0.2);
    if (maximumDistance < 1
        || Math.abs(queryTerm.text.length - indexedToken.text.length) > maximumDistance) {
        return 0;
    }
    const maximumCells = queryTerm.text.length * (2 * maximumDistance + 1);
    if (maximumCells > fuzzyBudget.remainingCells)
        return 0;
    fuzzyBudget.remainingCells -= maximumCells;
    const distance = boundedDamerauLevenshtein(queryTerm.text, indexedToken.text, maximumDistance);
    return distance <= maximumDistance
        ? 0.75 * (1 - distance / Math.max(queryTerm.text.length, indexedToken.text.length))
        : 0;
}
/** Optimal-string-alignment distance with an early length bound. */
function boundedDamerauLevenshtein(left, right, maximumDistance) {
    if (left === right)
        return 0;
    if (Math.abs(left.length - right.length) > maximumDistance) {
        return maximumDistance + 1;
    }
    let previousPrevious = Array.from({ length: right.length + 1 }, (_, index) => index);
    let previous = previousPrevious;
    const outsideBand = maximumDistance + 1;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = Array(right.length + 1).fill(outsideBand);
        current[0] = leftIndex;
        let rowMinimum = outsideBand;
        const firstRightIndex = Math.max(1, leftIndex - maximumDistance);
        const lastRightIndex = Math.min(right.length, leftIndex + maximumDistance);
        for (let rightIndex = firstRightIndex; rightIndex <= lastRightIndex; rightIndex += 1) {
            const substitution = previous[rightIndex - 1]
                + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
            let distance = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
            if (leftIndex > 1
                && rightIndex > 1
                && left[leftIndex - 1] === right[rightIndex - 2]
                && left[leftIndex - 2] === right[rightIndex - 1]) {
                distance = Math.min(distance, previousPrevious[rightIndex - 2] + 1);
            }
            current[rightIndex] = distance;
            rowMinimum = Math.min(rowMinimum, distance);
        }
        if (rowMinimum > maximumDistance)
            return outsideBand;
        previousPrevious = previous;
        previous = current;
    }
    return previous[right.length];
}
function normalizeText(value) {
    return value
        .normalize("NFKC")
        .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}
function tokenize(value) {
    const tokens = value.split(/\s+/u).filter(Boolean);
    for (const token of tokens) {
        if (token.length > TOOL_DISCOVERY_LIMITS.tokenCharacters) {
            throw new Error(`tool discovery search tokens must contain at most ${TOOL_DISCOVERY_LIMITS.tokenCharacters} characters`);
        }
    }
    return tokens;
}
function searchToken(text) {
    let bigramMask = 0;
    for (let index = 0; index < text.length - 1; index += 1) {
        const first = text.charCodeAt(index);
        const second = text.charCodeAt(index + 1);
        const bit = ((first * 31 + second) >>> 0) % 32;
        bigramMask |= 1 << bit;
    }
    return { bigramMask, text };
}
function validateCharacterCount(value, maximum, field, id) {
    if (Array.from(value).length > maximum) {
        throw new Error(`tool discovery catalog entry ${id} ${field} must contain at most ${maximum} characters`);
    }
}
function validatedLimit(limit) {
    const resolved = limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAXIMUM_LIMIT) {
        throw new Error(`tool discovery limit must be an integer from 1 to ${MAXIMUM_LIMIT}`);
    }
    return resolved;
}
function freezeState(activatedIds) {
    return Object.freeze({ activatedIds: Object.freeze(activatedIds) });
}
function result(status, matches, state, remainingCount) {
    const frozenMatches = Object.freeze(matches.map((match) => Object.freeze(match)));
    const newlyActivatedIds = Object.freeze(matches.map(({ id }) => id));
    return Object.freeze({
        matches: frozenMatches,
        newlyActivatedIds,
        remainingCount,
        state,
        status,
    });
}
function compareIds(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
