# Changelog

All notable changes to this project are documented here.

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
