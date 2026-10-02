# Changelog

All notable changes to this project are documented here.

---

## 1.6.0 — 2026-10-02

### Highlights

- New headless instance tools (`start_instance`, `task`, `wait`, `list_instances`, `stop_instance`) let an assistant spin up its own opencode instance, hand it a job and collect the result without a TUI. ([38aae8b](https://github.com/kud/mcp-opencode/commit/38aae8b50359a21d610db9e91fb0f9742af14297))
- Guard rails and a background reaper keep those instances in check, and `~/.local/state/mcp-opencode/instances.json` records what is running in a documented, stable shape that other tools can read. ([38aae8b](https://github.com/kud/mcp-opencode/commit/38aae8b50359a21d610db9e91fb0f9742af14297))
- `query` now waits for the background server to actually be ready instead of sleeping a fixed two seconds, so it starts faster when the server is quick and no longer fails when it is slow. ([38aae8b](https://github.com/kud/mcp-opencode/commit/38aae8b50359a21d610db9e91fb0f9742af14297))

### Fixes

- The MCP server now reports its real version from `package.json` rather than a hardcoded `1.0.0`. ([38aae8b](https://github.com/kud/mcp-opencode/commit/38aae8b50359a21d610db9e91fb0f9742af14297))

<details>
<summary>Internal (1 commit)</summary>

- Upgraded `@opencode-ai/sdk` to 1.18.34 and migrated to its v2 client.

</details>

---

## 1.5.0 — 2026-09-28

### Highlights

- `send` now takes an optional `model` (provider/model) to use a different model for that one message, checked against the same `MCP_OPENCODE_MODEL_ALLOW`/`BLOCK` filters as `query`; leave it out and the session keeps using its own model as before. ([9deeb9d](https://github.com/kud/mcp-opencode/commit/9deeb9d75279eef8a7cff24db3fe7747b34780fb))

<details>
<summary>Internal (1 commit)</summary>

- Fixed test isolation so a caller's `MCP_OPENCODE_MODEL` no longer leaks into the test suite.

</details>

---

## 1.4.0 — 2026-09-28

### Highlights

- The model `query` uses is now configurable via `MCP_OPENCODE_MODEL`, instead of being fixed to `github-copilot/gpt-4.1`; the default is unchanged when the variable is unset. Documented in the README's configuration table. ([fedb97e](https://github.com/kud/mcp-opencode/commit/fedb97eaee2836e8f96aa2b493842167597006a9))

---

## 1.3.0 — 2026-09-28

### Highlights

- The MCP now auto-discovers every opencode window that's listening on a local port (`lsof` plus a probe), so several windows work at once instead of just one. ([b7bf3df](https://github.com/kud/mcp-opencode/commit/b7bf3df91496c8a2e11f6aade8c8196423f7f94c))
- `list_sessions` shows sessions across all discovered windows, with the port(s) each one is open on, and `send`/`read` now route to the window that actually owns the session — with an optional `port` to pick one explicitly when a session is open in more than one. ([b7bf3df](https://github.com/kud/mcp-opencode/commit/b7bf3df91496c8a2e11f6aade8c8196423f7f94c))
- `query` and `list_models` keep using the MCP's own background server on port 4096, so throwaway one-off sessions never land in one of your real windows. A plain `opencode` with no serve flag opens no port and won't be discovered — the README now walks through this step by step, with a copy-paste `oc` shell function to launch opencode so it's discoverable. ([b7bf3df](https://github.com/kud/mcp-opencode/commit/b7bf3df91496c8a2e11f6aade8c8196423f7f94c))

---

## 1.2.0 — 2026-09-28

### Highlights

- New `list_sessions`, `send` and `read` tools let an assistant hold a conversation with a live opencode session — messages sent this way show up in the opencode TUI too, so you can watch or join in from either side. ([1b29cb4](https://github.com/kud/mcp-opencode/commit/1b29cb4fc1fd565d70e3b3b6fdfecefebfc67dfe))
- New `MCP_OPENCODE_URL` and `MCP_OPENCODE_SEND_TIMEOUT` environment variables give control over which server to talk to and how long a send can take before timing out. ([1b29cb4](https://github.com/kud/mcp-opencode/commit/1b29cb4fc1fd565d70e3b3b6fdfecefebfc67dfe))

### Fixes

- A spawned `opencode serve` now starts on the port you configured instead of a random one, so `MCP_OPENCODE_URL` and friends actually point at the server that's running. ([1b29cb4](https://github.com/kud/mcp-opencode/commit/1b29cb4fc1fd565d70e3b3b6fdfecefebfc67dfe))
- Model allow/block filtering was silently a no-op — tests set `OPENCODE_MODEL_ALLOW`/`BLOCK` while the code read the `MCP_`-prefixed names, so every model was allowed regardless of configuration. Env var names are now aligned with the documented `MCP_OPENCODE_MODEL_ALLOW`/`BLOCK` contract. ([b818c5f](https://github.com/kud/mcp-opencode/commit/b818c5fc3cab55bf30e8ab15a21a2e4e9c60cb97))

<details>
<summary>Internal (4 commits)</summary>

- Added a CI workflow running typecheck, build and test on pull requests and pushes to main.
- Fixed the npm OIDC release workflow pattern.
- Split the README into multi-page docs, slimmed the top-level README, and aligned it with the canonical kud-site shape.

</details>

---
