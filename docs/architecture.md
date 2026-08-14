# Architecture

This document records the former shared architecture. `ghosts` is now
deprecated; each former consumer owns its mechanisms and trust policy locally.

## Formerly shared here

- deterministic schemas and normalization;
- provider-independent prompt construction;
- bounded public-data clients;
- exact-request cache coordination;
- portable transformations and contracts.

## Always kept in consumers

- authentication and authorization;
- tenant and visibility boundaries;
- billing claims and settlement;
- credentials and deployment configuration;
- database persistence and migrations;
- tool grants, approvals, and product prompts;
- application telemetry policy.

The split was retired because the small amount of active reuse did not justify
cross-repository package and release coordination. The application trust
boundaries remain local in the self-contained consumers.
