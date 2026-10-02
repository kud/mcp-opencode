#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  createOpencodeClient,
  type PermissionRuleset,
  type Session,
} from "@opencode-ai/sdk/v2/client"
import { execSync, spawn } from "child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { join } from "path"
import { z } from "zod"

const OPENCODE_SERVER_URL =
  process.env.MCP_OPENCODE_URL ?? "http://127.0.0.1:4096"
const SERVER = new URL(OPENCODE_SERVER_URL)
const SERVER_PORT = SERVER.port || "4096"
const DEFAULT_SEND_TIMEOUT_SECONDS =
  Number(process.env.MCP_OPENCODE_SEND_TIMEOUT) || 600
const DEFAULT_MODEL = process.env.MCP_OPENCODE_MODEL || "github-copilot/gpt-4.1"

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

const SERVER_READY_TIMEOUT_MS = 10_000
const READY_POLL_INTERVAL_MS = 100

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const ensureServer = async () => {
  if (isServerRunning()) return
  spawn(
    "opencode",
    ["serve", "--port", SERVER_PORT, "--hostname", SERVER.hostname],
    { detached: true, stdio: "ignore" },
  ).unref()
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await answersAsOpencode(OPENCODE_SERVER_URL)) return
    await sleep(READY_POLL_INTERVAL_MS)
  }
  throw new Error(
    `opencode server did not answer on ${OPENCODE_SERVER_URL} within ${SERVER_READY_TIMEOUT_MS / 1000}s`,
  )
}

const getClient = (baseUrl = OPENCODE_SERVER_URL, directory?: string) =>
  createOpencodeClient({ baseUrl, ...(directory && { directory }) })

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
      sessionID: sessionId,
      model: { providerID, modelID },
      parts: [{ type: "text", text: prompt }],
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
      await client.session.delete({ sessionID: sessionId })
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] }
    }

    const text = (response.data?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? String(p.text) : ""))
      .join("")
      .trim()

    await client.session.delete({ sessionID: sessionId })

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

// ─── Discovery ───

type OpencodeServer = { port: number; url: string }

const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost", "*"])
const PROBE_TIMEOUT_MS = 300
const NO_WINDOWS_MESSAGE =
  "No opencode windows found. A plain `opencode` opens no port: start it with `opencode --port <port>` (or the `oc` wrapper) so it can be discovered."

const listeningOpencodePorts = () => {
  try {
    const output = execSync("lsof -nP -a -c opencode -iTCP -sTCP:LISTEN -Fn", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const ports = String(output)
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => {
        const address = line.slice(1)
        const separator = address.lastIndexOf(":")
        return {
          host: address.slice(0, separator),
          port: Number(address.slice(separator + 1)),
        }
      })
      .filter(({ host, port }) => LOCAL_HOSTS.has(host) && port > 0)
      .map(({ port }) => port)
    return [...new Set(ports)].sort((a, b) => a - b)
  } catch {
    return []
  }
}

const answersAsOpencode = async (url: string) => {
  try {
    const response = await fetch(`${url}/session`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok && Array.isArray(await response.json())
  } catch {
    return false
  }
}

export const discoverServers = async (): Promise<OpencodeServer[]> => {
  if (process.env.MCP_OPENCODE_URL)
    return [{ port: Number(SERVER_PORT), url: OPENCODE_SERVER_URL }]

  const candidates = listeningOpencodePorts().map((port) => ({
    port,
    url: `http://127.0.0.1:${port}`,
  }))
  const reachable = await Promise.all(
    candidates.map((server) => answersAsOpencode(server.url)),
  )
  return candidates.filter((_, i) => reachable[i])
}

type LocatedSession = Session & { ports: number[] }

const sessionsByServer = async (
  servers: OpencodeServer[],
  directory?: string,
) => {
  const located = new Map<string, LocatedSession>()
  for (const server of servers) {
    const response = await getClient(server.url).session.list(
      directory ? { directory } : {},
    )
    for (const session of response.data ?? []) {
      const existing = located.get(session.id)
      if (existing) existing.ports.push(server.port)
      else located.set(session.id, { ...session, ports: [server.port] })
    }
  }
  return located
}

const resolveSessionServer = async (session_id: string, port?: number) => {
  const servers = await discoverServers()
  if (port !== undefined) {
    const chosen = servers.find((s) => s.port === port)
    if (!chosen)
      throw new Error(`no opencode window is listening on port ${port}`)
    return { server: chosen, otherPorts: [] as number[] }
  }
  if (servers.length === 0) throw new Error(NO_WINDOWS_MESSAGE)

  const session = (await sessionsByServer(servers)).get(session_id)
  if (!session)
    throw new Error(
      `session "${session_id}" not found in any opencode window. Use list_sessions to see what's open.`,
    )
  const [first, ...otherPorts] = session.ports
  return {
    server: servers.find((s) => s.port === first) as OpencodeServer,
    otherPorts,
  }
}

const otherWindowsNote = (server: OpencodeServer, otherPorts: number[]) =>
  otherPorts.length
    ? `\n\n(Sent via the window on port ${server.port}. Windows on ${otherPorts.join(", ")} share this session but won't show it live.)`
    : ""

export const listSessions = async ({
  directory,
}: {
  directory?: string
} = {}) => {
  try {
    const servers = await discoverServers()
    if (servers.length === 0) return textResult(NO_WINDOWS_MESSAGE)

    const lines = [...(await sessionsByServer(servers, directory)).values()]
      .sort((a, b) => b.time.updated - a.time.updated)
      .map(
        (s) =>
          `${s.id}  ${s.title || "(untitled)"}  ${s.directory}  port ${s.ports.join(", ")}  updated ${new Date(s.time.updated).toISOString()}`,
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
  model,
  port,
  timeout_seconds = DEFAULT_SEND_TIMEOUT_SECONDS,
}: {
  session_id: string
  prompt: string
  agent?: string
  model?: string
  port?: number
  timeout_seconds?: number
}) => {
  if (model && !isModelAllowed(model))
    return textResult(
      `Error: model "${model}" is not allowed. Use list_models to see available models.`,
    )

  try {
    const { server, otherPorts } = await resolveSessionServer(session_id, port)
    const [providerID, modelID] = (model?.split("/") ?? []) as [string, string]
    const reply = getClient(server.url).session.prompt({
      sessionID: session_id,
      parts: [{ type: "text", text: prompt }],
      ...(agent && { agent }),
      ...(model && { model: { providerID, modelID } }),
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

    const text = condenseParts((response.data?.parts ?? []) as SessionPart[])
    return textResult(
      text ? text + otherWindowsNote(server, otherPorts) : "Error: no response",
    )
  } catch (e) {
    return errorResult(e)
  }
}

export const read = async ({
  session_id,
  limit = 20,
  port,
}: {
  session_id: string
  limit?: number
  port?: number
}) => {
  try {
    const { server } = await resolveSessionServer(session_id, port)
    const response = await getClient(server.url).session.messages({
      sessionID: session_id,
      limit,
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

// ─── Headless instances ───

const MAX_WAIT_SECONDS = 570
const WAIT_POLL_INTERVAL_MS = 2000
const INSTANCE_START_TIMEOUT_MS = 10_000
const INSTANCE_STOP_TIMEOUT_MS = 5000
const INSTANCE_TTL_MS =
  (Number(process.env.MCP_OPENCODE_INSTANCE_TTL) || 30 * 60) * 1000
const STATE_DIR =
  process.env.MCP_OPENCODE_STATE_DIR ??
  join(homedir(), ".local", "state", "mcp-opencode")
const REGISTRY_PATH = join(STATE_DIR, "instances.json")
const LISTENING_LINE = /opencode server listening on http:\/\/[^\s:]+:(\d+)/

const BASH_DENY_PATTERNS = [
  "git push*",
  "git remote*",
  "gh *",
  "npm publish*",
  "git reset --hard*",
]

const ruleFor = (
  permission: string,
  action: "allow" | "deny",
  pattern = "*",
) => ({ permission, pattern, action })

// opencode evaluates rules with findLast: the last matching rule wins, and no
// match means "ask", which would hang a headless session forever. So every
// rule here is allow or deny, and the bash denies come after the bash allow.
export const HEADLESS_PERMISSION_RULESET: PermissionRuleset = [
  ...["read", "edit", "glob", "grep", "list", "todowrite", "task"].map((p) =>
    ruleFor(p, "allow"),
  ),
  ...["external_directory", "question", "doom_loop", "webfetch"].map((p) =>
    ruleFor(p, "deny"),
  ),
  ruleFor("bash", "allow"),
  ...BASH_DENY_PATTERNS.map((pattern) => ruleFor("bash", "deny", pattern)),
]

// The same rules in opencode's config shape, so they also govern every agent
// in the instance, including task subagents, which only inherit denies.
const rulesetAsConfig = (ruleset: PermissionRuleset) => {
  const grouped = new Map<string, Record<string, string>>()
  for (const { permission, pattern, action } of ruleset)
    grouped.set(permission, {
      ...grouped.get(permission),
      [pattern]: action,
    })
  return Object.fromEntries(
    [...grouped].map(([permission, patterns]) => {
      const keys = Object.keys(patterns)
      return [
        permission,
        keys.length === 1 && keys[0] === "*" ? patterns["*"] : patterns,
      ]
    }),
  )
}

export const hardenedInstance = (
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const { GH_TOKEN, GITHUB_TOKEN, ...env } = baseEnv
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: DEFAULT_MODEL,
      small_model: DEFAULT_MODEL,
      permission: rulesetAsConfig(HEADLESS_PERMISSION_RULESET),
    }),
  }
}

export type InstanceSessionRecord = {
  id: string
  title: string
  model: string
  startedAt: string
}

// Stable contract: other tools read instances.json directly. Live state
// (busy/idle, last activity) stays off the file; read it from the server.
export type InstanceRecord = {
  runtime: "opencode"
  pid: number
  port: number
  directory: string
  startedAt: string
  mcpPid: number
  sessions: InstanceSessionRecord[]
}

const instanceUrl = (port: number) => `http://127.0.0.1:${port}`

export const readRegistry = (): InstanceRecord[] => {
  try {
    const rows = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

const writeRegistry = (rows: InstanceRecord[]) => {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n")
  renameSync(tmp, REGISTRY_PATH)
}

const registerInstance = (row: InstanceRecord) =>
  writeRegistry([...readRegistry().filter((r) => r.port !== row.port), row])

const recordInstanceSession = (port: number, session: InstanceSessionRecord) =>
  writeRegistry(
    readRegistry().map((r) =>
      r.port === port
        ? { ...r, sessions: [...(r.sessions ?? []), session] }
        : r,
    ),
  )

const deregisterInstance = (port: number) =>
  writeRegistry(readRegistry().filter((r) => r.port !== port))

const findInstance = (port: number) =>
  readRegistry().find((r) => r.port === port)

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

const terminate = (pid: number, signal: NodeJS.Signals = "SIGTERM") => {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

export const parseListeningPort = (output: string) => {
  const match = LISTENING_LINE.exec(output)
  return match ? Number(match[1]) : undefined
}

const waitForListeningPort = async (logPath: string, pid: number) => {
  const deadline = Date.now() + INSTANCE_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const port = parseListeningPort(readFileSync(logPath, "utf8"))
    if (port) return port
    if (!isPidAlive(pid)) break
    await sleep(READY_POLL_INTERVAL_MS)
  }
  throw new Error(
    `opencode serve did not report a listening port within ${INSTANCE_START_TIMEOUT_MS / 1000}s (log: ${logPath})`,
  )
}

type SessionStatusType = "idle" | "busy" | "retry"

const instanceSessions = async ({ port, directory }: InstanceRecord) => {
  const client = getClient(instanceUrl(port), directory)
  const [sessions, statuses] = await Promise.all([
    client.session.list({ directory }),
    client.session.status({ directory }),
  ])
  if (!sessions.data) throw new Error("session list failed")
  const statusMap = (statuses.data ?? {}) as Record<
    string,
    { type: SessionStatusType }
  >
  return sessions.data.map((s) => ({
    id: s.id,
    title: s.title,
    updated: s.time.updated,
    status: statusMap[s.id]?.type ?? ("idle" as SessionStatusType),
  }))
}

const isOpencodeProcess = (pid: number) => {
  try {
    return String(
      execSync(`ps -p ${pid} -o command=`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).includes("opencode")
  } catch {
    return false
  }
}

export const reapInstances = async (now = Date.now()) => {
  const reaped: number[] = []
  for (const row of readRegistry()) {
    if (!isPidAlive(row.pid)) {
      deregisterInstance(row.port)
      reaped.push(row.port)
      continue
    }
    const startedAt = Date.parse(row.startedAt)
    let lastActivity = startedAt
    try {
      const sessions = await instanceSessions(row)
      if (sessions.some((s) => s.status !== "idle")) continue
      lastActivity = Math.max(startedAt, ...sessions.map((s) => s.updated))
    } catch {
      // Unreachable but alive: only its age can tell us it's stale.
    }
    if (now - lastActivity <= INSTANCE_TTL_MS) continue
    if (isOpencodeProcess(row.pid)) terminate(row.pid)
    deregisterInstance(row.port)
    reaped.push(row.port)
  }
  return reaped
}

export const killOwnedInstances = () => {
  const rows = readRegistry()
  const owned = rows.filter((r) => r.mcpPid === process.pid)
  if (owned.length === 0) return
  owned.forEach((r) => terminate(r.pid))
  try {
    writeRegistry(rows.filter((r) => r.mcpPid !== process.pid))
  } catch {}
}

const jsonResult = (value: unknown) =>
  textResult(JSON.stringify(value, null, 2))

const unknownPortError = (port: number) =>
  textResult(
    `Error: port ${port} is not a registered instance. Use start_instance first, or list_instances to see what's running.`,
  )

const attachCommand = (port: number, sessionId: string) =>
  `opencode attach ${instanceUrl(port)} --session ${sessionId}`

export const startInstance = async ({ directory }: { directory: string }) => {
  if (!isModelAllowed(DEFAULT_MODEL))
    return textResult(
      `Error: the default model "${DEFAULT_MODEL}" is not allowed, so an instance can't be pinned to it. Set MCP_OPENCODE_MODEL to an allowed model.`,
    )
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      return textResult(`Error: "${directory}" is not a directory`)

    await reapInstances()
    mkdirSync(STATE_DIR, { recursive: true })
    const logPath = join(STATE_DIR, `instance-${Date.now()}.log`)
    const logFd = openSync(logPath, "a")
    const child = spawn(
      "opencode",
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: hardenedInstance(),
      },
    )
    closeSync(logFd)
    child.unref()
    const pid = child.pid
    if (!pid) return textResult("Error: failed to spawn opencode serve")

    let port: number
    try {
      port = await waitForListeningPort(logPath, pid)
    } catch (e) {
      terminate(pid)
      throw e
    }

    registerInstance({
      runtime: "opencode",
      pid,
      port,
      directory,
      startedAt: new Date().toISOString(),
      mcpPid: process.pid,
      sessions: [],
    })
    return jsonResult({ port, url: instanceUrl(port) })
  } catch (e) {
    return errorResult(e)
  }
}

export const task = async ({
  port,
  prompt,
  model,
  agent = "build",
  title,
}: {
  port: number
  prompt: string
  model?: string
  agent?: string
  title?: string
}) => {
  const instance = findInstance(port)
  if (!instance) return unknownPortError(port)
  const chosenModel = model ?? DEFAULT_MODEL
  if (!isModelAllowed(chosenModel))
    return textResult(
      `Error: model "${chosenModel}" is not allowed. Use list_models to see available models.`,
    )

  try {
    const client = getClient(instanceUrl(port), instance.directory)
    const created = await client.session.create({
      directory: instance.directory,
      permission: HEADLESS_PERMISSION_RULESET,
      ...(title && { title }),
    })
    const sessionId = created.data?.id
    if (!sessionId) return textResult("Error: failed to create session")

    const [providerID, modelID] = chosenModel.split("/") as [string, string]
    const sent = await client.session.promptAsync({
      sessionID: sessionId,
      directory: instance.directory,
      agent,
      model: { providerID, modelID },
      parts: [{ type: "text", text: prompt }],
    })
    if (sent.error)
      return textResult(
        `Error: prompt was not accepted: ${JSON.stringify(sent.error)}`,
      )

    recordInstanceSession(port, {
      id: sessionId,
      title: created.data?.title ?? title ?? "",
      model: chosenModel,
      startedAt: new Date().toISOString(),
    })

    return jsonResult({
      session_id: sessionId,
      port,
      attach: attachCommand(port, sessionId),
    })
  } catch (e) {
    return errorResult(e)
  }
}

type MessageEntry = {
  info: {
    id?: string
    role: string
    error?: { name?: string; data?: { message?: string } }
    time?: { completed?: number }
  }
  parts: SessionPart[]
}

const settledOutcome = (messages: MessageEntry[]) => {
  const last = messages.at(-1)
  if (!last || last.info.role !== "assistant") return undefined
  if (last.info.error) return "error" as const
  return last.info.time?.completed ? ("idle" as const) : undefined
}

const lastAssistantText = (messages: MessageEntry[]) => {
  const last = messages.findLast((m) => m.info.role === "assistant")
  if (!last) return ""
  if (last.info.error)
    return `Error: ${last.info.error.data?.message ?? last.info.error.name ?? "unknown error"}`
  return last.parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
}

export const wait = async ({
  port,
  session_id,
  timeout_seconds = MAX_WAIT_SECONDS,
}: {
  port: number
  session_id: string
  timeout_seconds?: number
}) => {
  const instance = findInstance(port)
  if (!instance) return unknownPortError(port)
  const { directory } = instance
  const client = getClient(instanceUrl(port), directory)
  const deadline =
    Date.now() + Math.min(timeout_seconds, MAX_WAIT_SECONDS) * 1000

  try {
    const snapshot = async () => {
      const [statuses, messages] = await Promise.all([
        client.session.status({ directory }),
        client.session.messages({ sessionID: session_id, directory }),
      ])
      const entries = (messages.data ?? []) as MessageEntry[]
      const live = (
        (statuses.data ?? {}) as Record<string, { type: SessionStatusType }>
      )[session_id]?.type
      const settled =
        live && live !== "idle" ? undefined : settledOutcome(entries)
      return { entries, status: settled ?? ("busy" as const) }
    }

    let current = await snapshot()
    while (current.status === "busy" && Date.now() < deadline) {
      await sleep(Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()))
      current = await snapshot()
    }

    // opencode keeps diffs per user message; the last prompt is this job.
    const promptId = current.entries.findLast((m) => m.info.role === "user")
      ?.info.id
    const diff = promptId
      ? await client.session.diff({
          sessionID: session_id,
          directory,
          messageID: promptId,
        })
      : { data: [] }
    const files = (diff.data ?? []).map((d) => ({
      file: d.file,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
    }))
    return jsonResult({
      session_id,
      port,
      status: current.status,
      ...(current.status === "busy" && {
        note: `Still running at the timeout. Call wait again, or attach: ${attachCommand(port, session_id)}`,
      }),
      last_assistant_text: lastAssistantText(current.entries),
      files,
    })
  } catch (e) {
    return errorResult(e)
  }
}

export const listInstances = async () => {
  try {
    await reapInstances()
    const rows = await Promise.all(
      readRegistry().map(async (row) => {
        try {
          const live = new Map(
            (await instanceSessions(row)).map((s) => [s.id, s]),
          )
          return {
            ...row,
            sessions: (row.sessions ?? []).map((s) => ({
              ...s,
              status: live.get(s.id)?.status ?? "missing",
              updated: live.get(s.id)?.updated,
            })),
          }
        } catch (e) {
          return {
            ...row,
            error: e instanceof Error ? e.message : String(e),
          }
        }
      }),
    )
    return rows.length ? jsonResult(rows) : textResult("No instances running")
  } catch (e) {
    return errorResult(e)
  }
}

const waitForPortToClose = async (port: number) => {
  const deadline = Date.now() + INSTANCE_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!(await answersAsOpencode(instanceUrl(port)))) return true
    await sleep(READY_POLL_INTERVAL_MS)
  }
  return false
}

export const stopInstance = async ({ port }: { port: number }) => {
  const instance = findInstance(port)
  if (!instance) return unknownPortError(port)

  try {
    const aborted: string[] = []
    try {
      const client = getClient(instanceUrl(port), instance.directory)
      for (const s of await instanceSessions(instance)) {
        if (s.status === "idle") continue
        await client.session.abort({
          sessionID: s.id,
          directory: instance.directory,
        })
        aborted.push(s.id)
      }
    } catch {
      // An unreachable server has nothing to abort; stop it all the same.
    }

    terminate(instance.pid)
    let closed = await waitForPortToClose(port)
    if (!closed) {
      terminate(instance.pid, "SIGKILL")
      closed = await waitForPortToClose(port)
    }
    deregisterInstance(port)
    return jsonResult({ port, stopped: closed, aborted_sessions: aborted })
  } catch (e) {
    return errorResult(e)
  }
}

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version

const server = new McpServer({
  name: "mcp-opencode",
  version: PACKAGE_VERSION,
})

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
    description: `List sessions across every open opencode window (discovered automatically; only windows started with --port are visible), most recently updated first, with the port(s) each is open on. Use this to find a live session to talk to with send.`,
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
    description: `Send a message to an existing opencode session and return its reply. The session keeps its history and model, and the exchange appears live in any attached opencode TUI. Never creates or deletes sessions. Uses the session's own model unless \`model\` is passed, which must pass the allow/block filters (${filterSummary}).`,
    inputSchema: {
      session_id: z.string().describe("Session ID from list_sessions"),
      prompt: z.string().describe("The message to send"),
      agent: z
        .string()
        .optional()
        .describe(
          "opencode agent to handle the message (e.g. 'build', 'plan')",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model for this message in provider/model format (default: the session's own model)",
        ),
      port: z
        .number()
        .int()
        .optional()
        .describe(
          "Port of the opencode window to use (default: the window that owns the session; lowest port if several)",
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
      port: z
        .number()
        .int()
        .optional()
        .describe(
          "Port of the opencode window to read from (default: discovered)",
        ),
    },
  },
  read,
)

server.registerTool(
  "start_instance",
  {
    description: `Start a private, headless opencode server for one job, rooted in \`directory\`. It listens on a free localhost port, runs with git credentials and GitHub tokens stripped, and pins its model to ${DEFAULT_MODEL}. Returns { port, url }. Idle instances are reaped after ${INSTANCE_TTL_MS / 60000} minutes; use stop_instance when done.`,
    inputSchema: {
      directory: z
        .string()
        .describe("Absolute path of the project the instance works in"),
    },
  },
  startInstance,
)

server.registerTool(
  "task",
  {
    description: `Start a job on an instance from start_instance: creates a fresh session with the headless guard rails (no permission prompts; bash allowed except git push/remote, gh, npm publish and git reset --hard; no web fetch, no questions, nothing outside the directory) and prompts it in the background. Returns { session_id, port, attach } at once; use wait to collect the result. Model must pass the allow/block filters (${filterSummary}).`,
    inputSchema: {
      port: z.number().int().describe("Port returned by start_instance"),
      prompt: z.string().describe("What the job should do"),
      model: z
        .string()
        .optional()
        .describe(`Model in provider/model format (default: ${DEFAULT_MODEL})`),
      agent: z
        .string()
        .optional()
        .describe("opencode agent to run the job (default: build)"),
      title: z.string().optional().describe("Session title"),
    },
  },
  task,
)

server.registerTool(
  "wait",
  {
    description: `Wait for a task's session to finish, polling every ${WAIT_POLL_INTERVAL_MS / 1000}s. Returns its status (idle, busy or error), the last assistant text, and the files it changed with line counts. Stops at the timeout with status busy; call it again to keep waiting.`,
    inputSchema: {
      port: z.number().int().describe("Port of the instance"),
      session_id: z.string().describe("Session ID returned by task"),
      timeout_seconds: z
        .number()
        .positive()
        .optional()
        .describe(
          `Stop waiting after this many seconds (default and maximum: ${MAX_WAIT_SECONDS})`,
        ),
    },
  },
  wait,
)

server.registerTool(
  "list_instances",
  {
    description:
      "List the instances started by start_instance, with each session's live status. Reaps dead and idle instances first.",
    inputSchema: {},
  },
  listInstances,
)

server.registerTool(
  "stop_instance",
  {
    description:
      "Stop an instance from start_instance: aborts its busy sessions, terminates the server and confirms the port has closed.",
    inputSchema: {
      port: z.number().int().describe("Port of the instance"),
    },
  },
  stopInstance,
)

const shutDown = () => {
  killOwnedInstances()
  process.exit(0)
}

const main = async () => {
  process.on("exit", killOwnedInstances)
  process.on("SIGTERM", shutDown)
  process.on("SIGINT", shutDown)
  process.stdin.on("end", shutDown)
  await reapInstances().catch(() => [])
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("mcp-opencode running")
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
