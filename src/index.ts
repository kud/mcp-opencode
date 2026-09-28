#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { execSync, spawn } from "child_process"
import { z } from "zod"

const OPENCODE_SERVER_URL =
  process.env.MCP_OPENCODE_URL ?? "http://127.0.0.1:4096"
const SERVER = new URL(OPENCODE_SERVER_URL)
const SERVER_PORT = SERVER.port || "4096"
const DEFAULT_SEND_TIMEOUT_SECONDS =
  Number(process.env.MCP_OPENCODE_SEND_TIMEOUT) || 600
const DEFAULT_MODEL = "github-copilot/gpt-4.1"

const parsePatterns = (env: string | undefined) =>
  (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const ALLOW_PATTERNS = parsePatterns(process.env.MCP_OPENCODE_MODEL_ALLOW)
const BLOCK_PATTERNS = parsePatterns(process.env.MCP_OPENCODE_MODEL_BLOCK)

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
    execSync(`lsof -i :${SERVER_PORT} -sTCP:LISTEN -t`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const ensureServer = async () => {
  if (isServerRunning()) return
  spawn(
    "opencode",
    ["serve", "--port", SERVER_PORT, "--hostname", SERVER.hostname],
    { detached: true, stdio: "ignore" },
  ).unref()
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

// ─── Sessions ───

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
})

const errorResult = (e: unknown) =>
  textResult(`Error: ${e instanceof Error ? e.message : String(e)}`)

type SessionPart = {
  type: string
  text?: unknown
  tool?: string
  state?: { status?: string }
}

const condenseParts = (parts: SessionPart[]) =>
  parts
    .map((p) => {
      if (p.type === "text") return String(p.text ?? "").trim()
      if (p.type === "tool")
        return `[tool: ${p.tool} (${p.state?.status ?? "unknown"})]`
      return ""
    })
    .filter(Boolean)
    .join("\n")

export const listSessions = async ({
  directory,
}: {
  directory?: string
} = {}) => {
  try {
    await ensureServer()
    const response = await getClient().session.list(
      directory ? { query: { directory } } : {},
    )
    const lines = [...(response.data ?? [])]
      .sort((a, b) => b.time.updated - a.time.updated)
      .map(
        (s) =>
          `${s.id}  ${s.title || "(untitled)"}  ${s.directory}  updated ${new Date(s.time.updated).toISOString()}`,
      )
    return textResult(lines.join("\n") || "No sessions found")
  } catch (e) {
    return errorResult(e)
  }
}

export const send = async ({
  session_id,
  prompt,
  agent,
  timeout_seconds = DEFAULT_SEND_TIMEOUT_SECONDS,
}: {
  session_id: string
  prompt: string
  agent?: string
  timeout_seconds?: number
}) => {
  try {
    await ensureServer()
    const reply = getClient().session.prompt({
      path: { id: session_id },
      body: {
        parts: [{ type: "text", text: prompt }],
        ...(agent && { agent }),
      },
    })

    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeout_seconds * 1000)
    })
    const response = await Promise.race([reply, timedOut]).finally(() =>
      clearTimeout(timer),
    )

    if (response === "timeout")
      return textResult(
        `Still running after ${timeout_seconds}s — opencode keeps working on it. Use read with session_id "${session_id}" later to get the reply.`,
      )

    const info = response.data?.info
    if (info?.error) {
      const error = info.error as { data?: { message?: string }; name?: string }
      return textResult(
        `Error: ${error.data?.message ?? error.name ?? "unknown provider error"}`,
      )
    }

    return textResult(
      condenseParts((response.data?.parts ?? []) as SessionPart[]) ||
        "Error: no response",
    )
  } catch (e) {
    return errorResult(e)
  }
}

export const read = async ({
  session_id,
  limit = 20,
}: {
  session_id: string
  limit?: number
}) => {
  try {
    await ensureServer()
    const response = await getClient().session.messages({
      path: { id: session_id },
      query: { limit },
    })
    const transcript = (response.data ?? [])
      .map(({ info, parts }) => {
        const body = condenseParts(parts as SessionPart[])
        return body ? `── ${info.role} ──\n${body}` : ""
      })
      .filter(Boolean)
      .join("\n\n")
    return textResult(transcript || "No messages in this session")
  } catch (e) {
    return errorResult(e)
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

server.registerTool(
  "list_sessions",
  {
    description: `List sessions on the running opencode server (${OPENCODE_SERVER_URL}), most recently updated first. Use this to find a live session — e.g. one open in the opencode TUI — to talk to with send.`,
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe("Only list sessions for this project directory"),
    },
  },
  listSessions,
)

server.registerTool(
  "send",
  {
    description: `Send a message to an existing opencode session and return its reply. The session keeps its history and model, and the exchange appears live in any attached opencode TUI. Never creates or deletes sessions. Model allow/block filters do not apply: the session's own model is used.`,
    inputSchema: {
      session_id: z.string().describe("Session ID from list_sessions"),
      prompt: z.string().describe("The message to send"),
      agent: z
        .string()
        .optional()
        .describe(
          "opencode agent to handle the message (e.g. 'build', 'plan')",
        ),
      timeout_seconds: z
        .number()
        .positive()
        .optional()
        .describe(
          `Stop waiting after this many seconds (default: ${DEFAULT_SEND_TIMEOUT_SECONDS}). opencode keeps working; use read to fetch the reply later.`,
        ),
    },
  },
  send,
)

server.registerTool(
  "read",
  {
    description:
      "Read the recent messages of an opencode session as a condensed transcript (text, with tool calls summarised).",
    inputSchema: {
      session_id: z.string().describe("Session ID from list_sessions"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of most recent messages to return (default: 20)"),
    },
  },
  read,
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
