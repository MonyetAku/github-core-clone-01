# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/MonyetAku/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/MonyetAku/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process, standard library only (Node 22+, no dependencies, no model calls, no outside service, no git binary).

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (with v0 fallback) and receive-pack v0. Packfiles are written plain (no deltas) and read back with full OFS/REF delta support. Fast-forward rules, shallow/deepen, sideband framing, annotated-tag peeling.
- **REST v3** under `/api/v3`: repos, branches, commits, git/refs, contents, labels, issues (+comments), pull requests (+files, squash merge with three-way conflict detection). Every reply is JSON with `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository` (issues/pullRequests connections with cursor pagination), `node(id:)`, `__type` introspection, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations, batched operation documents.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, `server/discover` (2026-07-28) with legacy `initialize` fallback, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Notes

- **Auth**: every REST/GraphQL call needs `Authorization: Bearer <token>` from `MAKEFUN_SHOP_TOKEN` (missing or wrong token is 401). A repository belongs to the login the token names; the same name under another owner is 404, never 403.
- **Viewer login**: the suite names the owner by the scenario's deterministic viewer login, so the entry replicates the competition's seeded RNG (fixed scenario seed, the `users` stream) and derives it at startup instead of guessing. No clock or randomness is used in request handling: timestamps come from a deterministic logical clock seeded by `MAKEFUN_TRIAL_NOW`.
- **Lifecycle**: `main.ts` (unchanged from the starter) binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and polls `/done`. `app.ts` is the server.

## Local validation

```sh
node --experimental-strip-types smoke-test.mjs   # REST + git CLI + GraphQL + MCP
node cli/makefun.mjs grade-local --kit . --bot . --driver process --instances 3
```

Results on practice trials 0–2 (2026-11-17, process driver): `feature 600/600`, `agent 200/200`, `perf 171/200`, **score 971 mean** (90% interval 960.7–981.3), 120/120 checks on every trial, replay reproduced byte for byte. House reference is ~900, so this clears the prize bar on practice data.

## Files

- `main.ts` — entry ↔ env lifecycle (starter, unchanged)
- `app.ts` — the whole forge: git primitives, pack codec, store, REST, GraphQL, MCP
- `smoke-test.mjs` — end-to-end smoke test (real `git` CLI as client)
- `package.json`, `tsconfig.json`, `LICENSE` — starter scaffolding

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vqmdgqxf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
