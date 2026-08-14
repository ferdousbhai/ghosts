# @summonghost/tool-discovery

Dependency-free, framework-neutral discovery for dynamic string-ID tool catalogs. It provides weighted ID/name/keyword/description search, prefix and typo-tolerant fuzzy matching, multi-capability result selection, deterministic ranking, and no-repeat activation state.

## Trust boundary

Pass only tools the current request has already admitted. Admission includes any authentication, authorization, tenant, feature, billing, or product-policy checks your application requires. The package snapshots that catalog and can activate only IDs in the snapshot; model queries and restored state cannot add IDs.

This package does not execute tools, resolve permissions, define model schemas, or decide which catalog entries are safe. Re-check authorization at execution time as usual.

## Usage

```ts
import { createToolDiscovery } from "@summonghost/tool-discovery";

const discovery = createToolDiscovery([
  {
    id: "connector-018f/calendar.find_slots",
    name: "Find calendar slots",
    description: "Find open meeting times in connected calendars.",
    keywords: ["availability", "schedule meeting"],
  },
  {
    id: "email_send",
    name: "Send email",
    description: "Compose and send an email message.",
    keywords: ["outbound mail"],
  },
]);

let state = discovery.createState();
const found = discovery.discover({
  query: "schedul a meeting",
  limit: 5,
  state,
});
state = found.state;

// Adapt `found.matches` to your model/tool framework. On the next model step,
// expose implementations only for IDs in `state.activatedIds`.
```

`ToolDiscoveryState` contains only a readonly string array, so it can be serialized between model turns without provider-specific messages or mutable `Set` instances. `discover` is pure with respect to caller state and returns a new immutable, canonically ID-sorted state.

An omitted or whitespace-only query lists the remaining catalog in ID order. Search results are deterministic and omit previously activated tools. `status` distinguishes `"no-match"` from `"exhausted"`; `remainingCount` supports bounded listing in batches. The default limit is 10 and the maximum is 100.

When rebuilding discovery from a changed dynamic catalog, use `createState(oldState.activatedIds)` or `reconcileState(oldState)`. Stale IDs are dropped rather than carried into the new activation surface.

## Search behavior

The built-in index weights exact IDs most strongly, followed by names, curated keywords, and descriptions. It supports token prefixes and edit-distance matching for terms of five or more characters. For multi-capability queries it keeps the strongest result for each matched query term instead of activating every tool that shares a generic word.

The implementation intentionally avoids MiniSearch: tool catalogs are typically small, the package needs no indexing dependency, and the focused scorer preserves the required fuzzy, prefix, weighted, and term-coverage behavior.

## Input bounds

Search work is bounded at the package boundary. A catalog may contain at most 5,000 entries and 100,000 total searchable tokens. Each entry allows an ID up to 512 characters, a name up to 256, a description up to 4,096, up to 64 keywords of 256 characters each, and up to 512 searchable tokens; any normalized token may be at most 128 characters. Queries allow 200 characters and 24 meaningful terms. Restored state must be a string array with at most 5,000 IDs of at most 512 characters each.

Each search allows at most 1,000,000 edit-distance cells. Exact and prefix matching remain available after that budget; excess fuzzy candidates are skipped in canonical ID order, making worst-case degradation deterministic rather than unbounded. Exported `TOOL_DISCOVERY_LIMITS` exposes the catalog, state, query, and fuzzy-work bounds for upstream validation.
