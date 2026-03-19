```
███╗   ███╗ ██████╗██████╗      ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗
████╗ ████║██╔════╝██╔══██╗    ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝
██╔████╔██║██║     ██████╔╝    ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║   ██║██║  ██║█████╗
██║╚██╔╝██║██║     ██╔═══╝     ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║   ██║██║  ██║██╔══╝
██║ ╚═╝ ██║╚██████╗██║         ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗╚██████╔╝██████╔╝███████╗
╚═╝     ╚═╝ ╚═════╝╚═╝          ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-blueviolet)](https://modelcontextprotocol.io/)
[![npm](https://img.shields.io/npm/v/@kud/mcp-opencode?color=CB3837&logo=npm)](https://www.npmjs.com/package/@kud/mcp-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Query any opencode model from your AI assistant — no API key required.**

[Features](#features) • [Quick Start](#quick-start) • [Installation](#installation) • [Tools](#available-tools) • [Development](#development)

</div>

---

## Features

- 🤖 **Query any model** — send prompts to anthropic, github-copilot, google-vertex, and more
- 🔍 **Discover models** — list all models your opencode is configured for, optionally filtered by provider
- 🚀 **Zero config auth** — no API tokens; delegates authentication entirely to opencode
- ⚡ **Auto-start** — spins up the opencode server automatically if it isn't running
- 🛡️ **Allow/block filters** — restrict which models are accessible via `OPENCODE_MODEL_ALLOW` / `OPENCODE_MODEL_BLOCK`
- 🔌 **Works with any opencode provider** — anthropic, github-copilot, google-vertex, and any others you've configured

---

## Quick Start

### Prerequisites

- [opencode](https://opencode.ai) installed and at least one provider configured
- Node.js ≥ 20

### Install

```bash
npm install -g @kud/mcp-opencode
```

### Minimal Claude Code config

```yaml
opencode:
  transport: stdio
  command: npx
  args:
    - -y
    - "@kud/mcp-opencode"
```

---

## Installation

<details>
<summary><strong>Claude Code CLI</strong></summary>

Add to `~/.claude/claude_code_config.yml` (or your profile config):

```yaml
opencode:
  transport: stdio
  command: npx
  args:
    - -y
    - "@kud/mcp-opencode"
```

Then run:

```bash
my ai client claude-code
```

</details>

<details>
<summary><strong>Claude Desktop — macOS</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "@kud/mcp-opencode"]
    }
  }
}
```

Restart Claude Desktop.

</details>

<details>
<summary><strong>Claude Desktop — Windows</strong></summary>

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "@kud/mcp-opencode"]
    }
  }
}
```

Restart Claude Desktop.

</details>

<details>
<summary><strong>Cursor</strong></summary>

In Cursor settings → MCP → Add server:

```json
{
  "opencode": {
    "command": "npx",
    "args": ["-y", "@kud/mcp-opencode"]
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "@kud/mcp-opencode"]
    }
  }
}
```

</details>

<details>
<summary><strong>VSCode (with Copilot)</strong></summary>

Edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "opencode": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kud/mcp-opencode"]
    }
  }
}
```

</details>

---

## Available Tools

### Querying

| Tool    | Description                                                |
| ------- | ---------------------------------------------------------- |
| `query` | Send a prompt to an opencode model and return the response |

### Discovery

| Tool          | Description                                                 |
| ------------- | ----------------------------------------------------------- |
| `list_models` | List all available models; pass a `provider` name to filter |

**Total: 2 Tools**

---

## Model Filtering

Restrict which models are accessible using environment variables:

| Variable               | Description                                                 | Example                        |
| ---------------------- | ----------------------------------------------------------- | ------------------------------ |
| `OPENCODE_MODEL_ALLOW` | Comma-separated allowlist (supports `provider/*` wildcards) | `github-copilot/*,anthropic/*` |
| `OPENCODE_MODEL_BLOCK` | Comma-separated blocklist                                   | `anthropic/claude-opus-4-6`    |

Both exact model IDs (`anthropic/claude-sonnet-4-6`) and provider wildcards (`github-copilot/*`) are supported. If `OPENCODE_MODEL_ALLOW` is unset, all models are allowed.

Example config with filtering:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "@kud/mcp-opencode"],
      "env": {
        "OPENCODE_MODEL_ALLOW": "github-copilot/*,anthropic/*",
        "OPENCODE_MODEL_BLOCK": "anthropic/claude-opus-4-6"
      }
    }
  }
}
```

---

## Example Conversations

> **"What models do I have access to?"**
> → Calls `list_models`, returns all configured models grouped by provider.

> **"List only my Anthropic models."**
> → Calls `list_models` with `provider: "anthropic"`.

> **"Ask GPT-4.1 via Copilot to explain what a monad is."**
> → Calls `query` with `model: "github-copilot/gpt-4.1"`.

> **"Use Claude Sonnet to review this diff and suggest improvements."**
> → Calls `query` with `model: "anthropic/claude-sonnet-4-6"` and the diff as the prompt.

> **"Get a second opinion from Gemini on this architecture decision."**
> → Calls `query` with `model: "google-vertex/gemini-2.5-pro"`.

> **"What's the default model being used?"**
> → `github-copilot/gpt-4.1` — shown in the `query` tool description.

---

## Development

### Project structure

```
mcp-opencode/
├── src/
│   ├── index.ts              # Server entry point + all tool handlers
│   └── __tests__/
│       └── tools.test.ts     # Unit tests
├── dist/                     # Compiled output (generated)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Scripts

| Script                | Description                             |
| --------------------- | --------------------------------------- |
| `npm run build`       | Compile TypeScript to `dist/`           |
| `npm run build:watch` | Watch mode                              |
| `npm run dev`         | Run directly via tsx (no build needed)  |
| `npm test`            | Run tests                               |
| `npm run test:watch`  | Watch mode tests                        |
| `npm run coverage`    | Test coverage report                    |
| `npm run inspect`     | Open MCP Inspector against built server |
| `npm run inspect:dev` | Open MCP Inspector via tsx              |
| `npm run typecheck`   | Type-check without emitting             |
| `npm run clean`       | Remove `dist/`                          |

### Dev workflow

```bash
git clone https://github.com/kud/mcp-opencode.git
cd mcp-opencode
npm install
npm run build
npm test
```

Use the local `.mcp.json` to connect Claude Code directly to your dev build:

```bash
# Already present in the repo root:
cat .mcp.json
# { "mcpServers": { "opencode": { "command": "node", "args": ["./dist/index.js"] } } }
```

### MCP Inspector

```bash
npm run inspect
```

Opens the interactive inspector at `http://localhost:5173` — useful for testing tools manually without a full AI client.

---

## How it works

This MCP server acts as a bridge between your AI assistant and [opencode](https://opencode.ai):

1. On first use, it checks whether the opencode HTTP server is running on `127.0.0.1:4096`
2. If not, it spawns `opencode serve` in the background and waits for it to be ready
3. Each `query` call creates a temporary opencode session, sends the prompt, waits for the response, then deletes the session
4. Authentication is handled entirely by opencode — configure your providers once in opencode and this MCP inherits them automatically

---

## Troubleshooting

**Server not showing in the MCP list**

- Ensure opencode is installed: `which opencode`
- Check Node.js version: `node --version` (must be ≥ 20)
- Try running manually: `npx @kud/mcp-opencode`

**"failed to create session" error**

- Make sure opencode is installed and at least one provider is configured
- Run `opencode models` to verify your setup

**"The requested model is not supported" error**

- The model ID exists in opencode's registry but isn't supported by the provider's API
- Use `list_models` and pick a working model — e.g. `github-copilot/gpt-4.1` instead of `github-copilot/claude-sonnet-4`

**Model not in the list**

- The model list reflects your opencode configuration, not the full marketplace
- Run `opencode models` in your terminal to see the same list

**MCP Inspector logs**

```bash
npm run inspect
```

---

## Security best practices

- No credentials are stored in or passed through this MCP server
- All authentication is delegated to opencode's own config
- Use `OPENCODE_MODEL_ALLOW` to restrict access to specific providers if needed
- Never commit `.mcp.json` or `.claude/` (both are gitignored)

---

## Tech Stack

|                   |                                  |
| ----------------- | -------------------------------- |
| **Runtime**       | Node.js ≥ 20                     |
| **Language**      | TypeScript 5.x (ESM)             |
| **Protocol**      | Model Context Protocol (MCP) 1.0 |
| **opencode SDK**  | `@opencode-ai/sdk`               |
| **Schema**        | Zod                              |
| **Tests**         | Vitest                           |
| **Module System** | ESM (`"type": "module"`)         |

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-change`
3. Make your changes and add tests
4. Run `npm run build && npm test`
5. Open a pull request

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgments

Built on top of [opencode](https://opencode.ai) by the SST team and the [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic.

---

## Resources

- [opencode documentation](https://opencode.ai/docs)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [@kud/mcp-opencode on npm](https://www.npmjs.com/package/@kud/mcp-opencode)

---

## Support

- 🐛 [Report a bug](https://github.com/kud/mcp-opencode/issues)
- 💡 [Request a feature](https://github.com/kud/mcp-opencode/issues)

---

<div align="center">

Made with ❤️ for opencode users

⭐ Star this repo if it's useful to you · [↑ Back to top](#)

</div>
