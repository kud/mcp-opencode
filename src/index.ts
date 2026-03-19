#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { execSync, spawn } from "child_process"
import { z } from "zod"

const OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
const DEFAULT_MODEL = "github-copilot/gpt-4.1"

const parsePatterns = (env: string | undefined) =>
  (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const ALLOW_PATTERNS = parsePatterns(process.env.OPENCODE_MODEL_ALLOW)
const BLOCK_PATTERNS = parsePatterns(process.env.OPENCODE_MODEL_BLOCK)

const matchesPattern = (model: string, pattern: string) =>
  pattern.endsWith("/*")
    ? model.startsWith(pattern.slice(0, -1))
    : model === pattern

export const isModelAllowed = (model: string) => {
  const allowed =
    ALLOW_PATTERNS.length === 0 ||
    ALLOW_PATTERNS.some((p) => matchesPattern(model, p))
  const blocked = BLOCK_PATTERNS.some((p) => matchesPattern(model, p))
  return allowed && !blocked
}

const isServerRunning = () => {
  try {
    execSync("lsof -i :4096 -sTCP:LISTEN -t", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const ensureServer = async () => {
  if (isServerRunning()) return
  spawn("opencode", ["serve"], { detached: true, stdio: "ignore" }).unref()
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

const getClient = () => createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL })

// ─── Query ───

export const query = async ({
  prompt,
  model = DEFAULT_MODEL,
}: {
  prompt: string
  model?: string
}) => {
  if (!isModelAllowed(model))
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: model "${model}" is not allowed. Use list_models to see available models.`,
        },
      ],
    }

  try {
    await ensureServer()
    const client = getClient()

    const [providerID, modelID] = model.split("/") as [string, string]

    const session = await client.session.create({})
    const sessionId = session.data?.id
    if (!sessionId)
      return {
        content: [
          { type: "text" as const, text: "Error: failed to create session" },
        ],
      }

    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        parts: [{ type: "text", text: prompt }],
      },
    })

    const info = response.data?.info
    const providerError =
      info && "error" in info && info.error
        ? (info.error as { data?: { message?: string }; message?: string })
        : null

    if (providerError) {
      const msg =
        providerError.data?.message ??
        providerError.message ??
        "unknown provider error"
      await client.session.delete({ path: { id: sessionId } })
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] }
    }

    const text = (response.data?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? String(p.text) : ""))
      .join("")
      .trim()

    await client.session.delete({ path: { id: sessionId } })

    return {
      content: [{ type: "text" as const, text: text || "Error: no response" }],
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { content: [{ type: "text" as const, text: `Error: ${message}` }] }
  }
}

// ─── Models ───

export const listModels = async ({
  provider,
}: {
  provider?: string
} = {}) => {
  try {
    await ensureServer()
    const client = getClient()
    const response = await client.config.providers({})
    const providers = response.data?.providers ?? []

    const lines = providers
      .flatMap((p) =>
        Object.keys(p.models ?? {}).map((modelId) => `${p.id}/${modelId}`),
      )
      .filter(isModelAllowed)
      .filter((m) => !provider || m.startsWith(`${provider}/`))

    return {
      content: [
        {
          type: "text" as const,
          text:
            lines.join("\n") ||
            `No models found${provider ? ` for provider "${provider}"` : ""}`,
        },
      ],
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { content: [{ type: "text" as const, text: `Error: ${message}` }] }
  }
}

const server = new McpServer({ name: "mcp-opencode", version: "1.0.0" })

const filterSummary = [
  ALLOW_PATTERNS.length ? `allow: ${ALLOW_PATTERNS.join(", ")}` : "allow: all",
  BLOCK_PATTERNS.length ? `block: ${BLOCK_PATTERNS.join(", ")}` : null,
]
  .filter(Boolean)
  .join(" | ")

server.registerTool(
  "query",
  {
    description: `Send a prompt to an opencode model. Defaults to ${DEFAULT_MODEL}. Filters — ${filterSummary}. Use list_models to see what's available.`,
    inputSchema: {
      prompt: z.string().describe("The prompt to send"),
      model: z
        .string()
        .optional()
        .describe(
          `Model to use in provider/model format (default: ${DEFAULT_MODEL})`,
        ),
    },
  },
  query,
)

server.registerTool(
  "list_models",
  {
    description: `List models available for use. Without a provider, returns providers with model counts. Pass a provider name to list its models. Respects allow/block filters (${filterSummary}).`,
    inputSchema: {
      provider: z
        .string()
        .optional()
        .describe(
          "Provider name to filter by (e.g. 'anthropic', 'openai'). Omit to list all providers.",
        ),
    },
  },
  listModels,
)

const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("mcp-opencode running")
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
