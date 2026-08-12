# @summonghost/research

Portable research primitives shared by Summon Ghost applications:

- bounded, model-facing `web_search`, `x_search`, `read_url`, and Reddit schemas
- public HTTPS URL validation and byte-bounded response reading
- deterministic pagination and consumer-owned bounded cache state
- Reddit listing validation and normalized post results
- structural Exa execution and result normalization
- native xAI Responses request construction, injected transport, structured-result validation, and usage normalization
- bounded model-facing Markdown formatting

The package intentionally has no auth, billing, tenancy, gateway, secret, persistence, telemetry, or application result-envelope code. Consumers create provider clients and inject configured transport.

## Native xAI transport

```ts
import { runNativeXSearch } from "@summonghost/research";

const result = await runNativeXSearch({
  model: "grok-4",
  prompt: "Find current posts about durable agents.",
  transport: async (request, { signal }) => {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`xAI failed: ${response.status}`);
    return response.json();
  },
});
```

Keep credentials outside library inputs and validate redirects/DNS resolution at the fetch boundary. `assertPublicHttpsUrl` rejects explicit non-public destinations, but hostname validation alone cannot prevent DNS rebinding.

## Consumer adaptations

- `runNativeXSearch` no longer accepts a pi-ai model/stream facade or an AI SDK `LanguageModel`; pass an xAI model ID and structural `transport(request, { signal })` instead.
- Native X usage is normalized to `{ input, output, cacheRead, cacheWrite, totalTokens, raw }`. Consumers using AI SDK or pi-ai usage names must map this object.
- The shared `web_search` contract is the richer multi-query contract from ask-dan. Consumers using summon-ghost's former `{ query }`-only schema may continue passing just `query`, but parsed defaults are now present.
- `x_search` uses the portable `{ query, from_date?, to_date?, depth? }` base contract. Delegated-agent tools and app-specific synthesis envelopes are intentionally excluded.
- `formatWebSearchResults` uses the summon-ghost bounded Markdown contract and accepts only `results`; ask-dan consumers must remove the former leading `query` argument and should not expect XML.
- `executeExaSearch` accepts an optional request as its third argument. summon-ghost's former execution options move to the fourth argument (or pass `{}` as request).
