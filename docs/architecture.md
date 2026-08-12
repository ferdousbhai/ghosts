# Architecture

`ghosts` contains transparent, reusable mechanisms. Applications own product and trust policy.

## Shared here

- deterministic schemas and normalization;
- provider-independent prompt construction;
- bounded public-data clients;
- exact-request cache coordination;
- portable transformations and contracts.

## Kept in consumers

- authentication and authorization;
- tenant and visibility boundaries;
- billing claims and settlement;
- credentials and deployment configuration;
- database persistence and migrations;
- tool grants, approvals, and product prompts;
- application telemetry policy.

The split is deliberate: sharing implementation must not weaken a consumer's trust boundary or force unrelated products to share release policy.
