import { describe, expect, it } from "vitest";
import {
  createToolDiscovery,
  TOOL_DISCOVERY_LIMITS,
  type ToolDiscoveryCatalogEntry,
  type ToolDiscoveryState,
} from "./index";

const CATALOG: readonly ToolDiscoveryCatalogEntry[] = [
  {
    id: "email_list",
    name: "List email",
    description: "List and search messages in a mailbox.",
    keywords: ["inbox", "mailbox"],
  },
  {
    id: "email_send",
    name: "Send email",
    description: "Compose and send an email message.",
    keywords: ["compose message", "outbound mail"],
  },
  {
    id: "automation_create",
    name: "Create reminder",
    description: "Schedule a reminder or recurring automation.",
    keywords: ["schedule", "reminder"],
  },
  {
    id: "history.search:v2",
    name: "Conversation history",
    description: "Find relevant information from prior conversations.",
    keywords: ["chat recall"],
  },
];

describe("tool discovery", () => {
  it("uses weighted fields, prefix matching, and typo-tolerant fuzzy matching", () => {
    const discovery = createToolDiscovery([
      ...CATALOG,
      {
        id: "generic_notes",
        name: "Notes",
        description: "Contains incidental text about sending email.",
      },
    ]);

    expect(discovery.discover({ query: "send email", limit: 1 }).matches)
      .toEqual([{
        id: "email_send",
        name: "Send email",
        description: "Compose and send an email message.",
      }]);
    expect(discovery.discover({ query: "convers", limit: 1 }).newlyActivatedIds)
      .toEqual(["history.search:v2"]);
    expect(discovery.discover({ query: "conversatinos", limit: 1 }).newlyActivatedIds)
      .toEqual(["history.search:v2"]);
  });

  it("orders exact IDs, names, keywords, and descriptions by field weight", () => {
    const discovery = createToolDiscovery([
      { id: "target", name: "Other", description: "Other" },
      { id: "name-match", name: "Target", description: "Other" },
      { id: "keyword-match", name: "Other", description: "Other", keywords: ["target"] },
      { id: "description-match", name: "Other", description: "Target" },
    ]);

    expect(discovery.discover({ query: "target" }).newlyActivatedIds)
      .toEqual(["target"]);
    expect(discovery.discover({
      query: "target",
      state: discovery.createState(["target"]),
    }).newlyActivatedIds).toEqual(["name-match"]);
    expect(discovery.discover({
      query: "target",
      state: discovery.createState(["target", "name-match"]),
    }).newlyActivatedIds).toEqual(["keyword-match"]);
    expect(discovery.discover({
      query: "target",
      state: discovery.createState(["target", "name-match", "keyword-match"]),
    }).newlyActivatedIds).toEqual(["description-match"]);
  });

  it("preserves distinct capabilities from a multi-capability query", () => {
    const result = createToolDiscovery(CATALOG).discover({
      query: "send email and schedule reminder",
    });

    expect(result.newlyActivatedIds).toEqual([
      "email_send",
      "automation_create",
    ]);
  });

  it("chooses the strongest tool for each term instead of letting weak matches suppress it", () => {
    const discovery = createToolDiscovery([
      { id: "alpha", name: "Alpha", description: "Also mentions beta." },
      { id: "beta", name: "Beta", description: "The dedicated beta capability." },
    ]);

    expect(discovery.discover({ query: "alpha beta" }).newlyActivatedIds)
      .toEqual(["alpha", "beta"]);
  });

  it("does not repeat activated tools and reports exhaustion", () => {
    const discovery = createToolDiscovery(CATALOG);
    const first = discovery.discover({ query: "prior conversations" });
    const second = discovery.discover({
      query: "prior conversations",
      state: first.state,
    });

    expect(first.newlyActivatedIds).toEqual(["history.search:v2"]);
    expect(second).toMatchObject({
      matches: [],
      newlyActivatedIds: [],
      status: "no-match",
    });

    const allRemaining = discovery.discover({ state: first.state });
    expect(allRemaining.newlyActivatedIds).toEqual([
      "automation_create",
      "email_list",
      "email_send",
    ]);
    expect(discovery.discover({ state: allRemaining.state })).toMatchObject({
      matches: [],
      remainingCount: 0,
      status: "exhausted",
    });
  });

  it("activates only IDs in the snapshotted admitted catalog", () => {
    const source = [{
      id: "tenant/tool-7f3c",
      name: "Tenant calendar",
      description: "Find calendar availability.",
      keywords: ["meeting"],
    }];
    const discovery = createToolDiscovery(source);
    source[0]!.keywords[0] = "mutated after admission";
    source.push({
      id: "not-admitted-later",
      name: "Late tool",
      description: "Must remain unavailable.",
      keywords: [],
    });

    const restored = discovery.createState([
      "model-invented-id",
      "tenant/tool-7f3c",
      "tenant/tool-7f3c",
    ]);
    expect(restored).toEqual({ activatedIds: ["tenant/tool-7f3c"] });
    expect(discovery.reconcileState({
      activatedIds: ["model-invented-id"],
    })).toEqual({ activatedIds: [] });
    expect(() => discovery.reconcileState({
      activatedIds: "tenant/tool-7f3c",
    } as unknown as ToolDiscoveryState)).toThrow("bounded string array");
    expect(() => discovery.reconcileState({
      activatedIds: [7],
    } as unknown as ToolDiscoveryState)).toThrow("contain only strings");
    expect(discovery.discover({ query: "retirement ledger" }).newlyActivatedIds)
      .toEqual([]);
    expect(discovery.discover({ query: "mutated after admission" }).newlyActivatedIds)
      .toEqual([]);
    expect(discovery.discover({ query: "meeting" }).newlyActivatedIds)
      .toEqual(["tenant/tool-7f3c"]);
    expect(discovery.catalog.map(({ id }) => id))
      .toEqual(["tenant/tool-7f3c"]);
  });

  it("returns deterministic rankings and serializable immutable state", () => {
    const tied = [
      { id: "z.dynamic", name: "Weather", description: "Weather forecast." },
      { id: "a.dynamic", name: "Weather", description: "Weather forecast." },
    ];
    const forward = createToolDiscovery(tied).discover({ query: "weather" });
    const reverse = createToolDiscovery([...tied].reverse()).discover({ query: "weather" });

    expect(forward.newlyActivatedIds).toEqual(["a.dynamic"]);
    expect(reverse.newlyActivatedIds).toEqual(forward.newlyActivatedIds);
    expect(JSON.parse(JSON.stringify(forward.state))).toEqual(forward.state);
    expect(createToolDiscovery(tied).createState(["z.dynamic", "a.dynamic"]))
      .toEqual({ activatedIds: ["a.dynamic", "z.dynamic"] });
    expect(Object.isFrozen(forward.state)).toBe(true);
    expect(Object.isFrozen(forward.state.activatedIds)).toBe(true);
  });

  it("lists the remaining dynamic catalog in bounded deterministic batches", () => {
    const discovery = createToolDiscovery(CATALOG);
    const first = discovery.discover({ limit: 2 });
    const second = discovery.discover({ limit: 2, state: first.state });

    expect(first.newlyActivatedIds).toEqual(["automation_create", "email_list"]);
    expect(first.remainingCount).toBe(2);
    expect(second.newlyActivatedIds).toEqual(["email_send", "history.search:v2"]);
    expect(second.remainingCount).toBe(0);
  });

  it("keeps fuzzy-budget behavior deterministic regardless of catalog order", () => {
    const fuzzyCatalog = Array.from({ length: 300 }, (_, index) => ({
      id: `tool-${String(index).padStart(3, "0")}`,
      name: "Capability",
      description: `${"a".repeat(127)}c`,
    }));
    const query = `${"a".repeat(127)}b`;

    const forward = createToolDiscovery(fuzzyCatalog).discover({ query });
    const reverse = createToolDiscovery([...fuzzyCatalog].reverse()).discover({ query });

    expect(forward.newlyActivatedIds).toEqual(["tool-000"]);
    expect(reverse.newlyActivatedIds).toEqual(forward.newlyActivatedIds);
  });

  it("bounds untrusted query, state, and catalog search work", () => {
    const discovery = createToolDiscovery(CATALOG);
    expect(() => discovery.discover({
      query: "x".repeat(TOOL_DISCOVERY_LIMITS.queryCharacters + 1),
    })).toThrow("query must contain at most 200 characters");
    expect(() => discovery.createState(
      Array.from(
        { length: TOOL_DISCOVERY_LIMITS.catalogEntries + 1 },
        () => "unknown",
      ),
    )).toThrow("bounded string array");
    expect(() => discovery.createState([
      "x".repeat(TOOL_DISCOVERY_LIMITS.idCharacters + 1),
    ])).toThrow("activated IDs must contain at most 512 characters");
    expect(() => createToolDiscovery([{
      id: "oversized",
      name: "Oversized",
      description: "x".repeat(TOOL_DISCOVERY_LIMITS.descriptionCharacters + 1),
    }])).toThrow("description must contain at most 4096 characters");
    expect(() => createToolDiscovery(Array.from(
      { length: TOOL_DISCOVERY_LIMITS.catalogEntries + 1 },
      (_, index) => ({ id: String(index), name: "Tool", description: "" }),
    ))).toThrow("catalog must contain at most 5000 entries");
  });

  it("rejects ambiguous catalogs and invalid result limits", () => {
    expect(() => createToolDiscovery([
      { id: "same", name: "One", description: "" },
      { id: "same", name: "Two", description: "" },
    ])).toThrow("duplicate ID: same");
    expect(() => createToolDiscovery([
      { id: " ", name: "Blank", description: "" },
    ])).toThrow("IDs must be non-empty strings");

    const discovery = createToolDiscovery(CATALOG);
    expect(() => discovery.discover({ limit: 0 })).toThrow(
      "limit must be an integer from 1 to 100",
    );
    expect(() => discovery.discover({ limit: 101 })).toThrow(
      "limit must be an integer from 1 to 100",
    );
  });
});
