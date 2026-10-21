#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  OpenCode,
  type OpenCodeClient,
  type PermissionRule,
  type SessionInfo,
  type SessionMessageAssistant,
  type SessionMessageInfo,
  type SessionStructuredError,
} from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/service"
import { execSync, spawn } from "child_process"
import { randomBytes } from "crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { join } from "path"
import { z } from "zod"
import {
  buildSrtSettings,
  filterExistingPaths,
  isSrtAvailable,
  missingSrtError,
  resolveGitDirs,
  resolveSandbox,
  sandboxShellDenyRules,
  tmpdirsForSandbox,
  type SandboxKind,
} from "./sandbox.js"

// Unset: use opencode's shared background service, discovered (and started
// for query/list_models) the way the TUI does. Set: use this server only.
const CONFIGURED_URL = process.env.MCP_OPENCODE_URL
const CONFIGURED_PASSWORD = process.env.MCP_OPENCODE_PASSWORD
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

export const getFallbackModels = (): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of parsePatterns(process.env.MCP_OPENCODE_MODEL_FALLBACK)) {
    if (!isModelAllowed(m) || seen.has(m)) continue
    seen.add(m)
    out.push(m)
  }
  return out
}

export const getRetryTimeoutSeconds = (): number => {
  const n = Number(process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS)
  return Number.isFinite(n) && n > 0 ? n : 90
}

// "provider/model", where the model id itself may contain slashes.
export const toModelRef = (model: string) => {
  const separator = model.indexOf("/")
  return {
    providerID: model.slice(0, separator),
    id: model.slice(separator + 1),
  }
}

const READY_POLL_INTERVAL_MS = 100
const RUN_POLL_INTERVAL_MS = 500

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

// ─── Servers ───

// opencode v2 servers use HTTP basic auth with the fixed user "opencode".
const SERVER_USER = "opencode"

type OpencodeServer = { port: number; url: string; password?: string }

const basicAuth = (password: string) =>
  `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`

const getClient = ({
  url,
  password,
}: Pick<OpencodeServer, "url" | "password">) =>
  OpenCode.make({
    baseUrl: url,
    ...(password && { headers: { authorization: basicAuth(password) } }),
  })

const portOf = (url: string) => {
  const parsed = new URL(url)
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
}

const fromEndpoint = (endpoint: Endpoint): OpencodeServer => ({
  url: endpoint.url,
  port: portOf(endpoint.url),
  ...(endpoint.auth && { password: endpoint.auth.password }),
})

const configuredServer = (url: string): OpencodeServer => ({
  url,
  port: portOf(url),
  ...(CONFIGURED_PASSWORD && { password: CONFIGURED_PASSWORD }),
})

// The server query and list_models talk to: the configured one, else the
// background service, started if it is not running yet.
const sharedServer = async () =>
  CONFIGURED_URL
    ? configuredServer(CONFIGURED_URL)
    : fromEndpoint(await Service.ensure())

const PROBE_TIMEOUT_MS = 300

const answersAsOpencode = async (server: OpencodeServer) => {
  try {
    await getClient(server).server.info({
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return true
  } catch {
    return false
  }
}

// ─── Runs ───

type RunStatus = "idle" | "busy" | "retry" | "error"

const isAssistant = (m: SessionMessageInfo): m is SessionMessageAssistant =>
  m.type === "assistant"

// opencode v2 closes every run with an "idle" message carrying its outcome,
// and lists the session in /session/active while a run is in flight.
export const runStatus = (
  running: boolean,
  newestFirst: SessionMessageInfo[],
): RunStatus => {
  const [newest] = newestFirst
  if (!running && newest?.type === "idle")
    return newest.outcome === "succeeded" ? "idle" : "error"
  if (newest && isAssistant(newest) && newest.retry && !newest.time.completed)
    return "retry"
  return "busy"
}

const runError = (
  newestFirst: SessionMessageInfo[],
): SessionStructuredError | undefined => {
  const [newest] = newestFirst
  if (newest?.type === "idle")
    return (
      newest.error ??
      (newest.outcome === "succeeded"
        ? undefined
        : { type: newest.outcome, message: `run ${newest.outcome}` })
    )
  return newestFirst.find(isAssistant)?.error
}

const assistantText = (message: SessionMessageAssistant) =>
  message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n")

const condenseAssistant = (message: SessionMessageAssistant) =>
  message.content
    .map((c) => {
      if (c.type === "text") return c.text.trim()
      if (c.type === "tool") return `[tool: ${c.name} (${c.state.status})]`
      return ""
    })
    .filter(Boolean)
    .join("\n")

const RECENT_MESSAGES = 100

const recentMessages = async (client: OpenCodeClient, sessionID: string) =>
  (
    await client.message.list({
      sessionID,
      order: "desc",
      limit: RECENT_MESSAGES,
    })
  ).data

const runSnapshot = async (client: OpenCodeClient, sessionID: string) => {
  const [active, newestFirst] = await Promise.all([
    client.session.active(),
    recentMessages(client, sessionID),
  ])
  return {
    newestFirst,
    status: runStatus(Boolean(active[sessionID]), newestFirst),
  }
}

// Polls a run until it settles or the deadline passes.
const settleRun = async (
  client: OpenCodeClient,
  sessionID: string,
  deadline: number,
) => {
  let snapshot = await runSnapshot(client, sessionID)
  while (
    (snapshot.status === "busy" || snapshot.status === "retry") &&
    Date.now() < deadline
  ) {
    await sleep(Math.min(RUN_POLL_INTERVAL_MS, deadline - Date.now()))
    snapshot = await runSnapshot(client, sessionID)
  }
  return snapshot
}

// Assistant messages newer than the given user message, oldest first.
const repliesTo = (newestFirst: SessionMessageInfo[], promptId: string) => {
  const promptIndex = newestFirst.findIndex((m) => m.id === promptId)
  const newer =
    promptIndex === -1 ? newestFirst : newestFirst.slice(0, promptIndex)
  return newer.filter(isAssistant).reverse()
}

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
    const client = getClient(await sharedServer())
    const session = await client.session.create({ model: toModelRef(model) })

    try {
      const sent = await client.session.prompt({
        sessionID: session.id,
        text: prompt,
      })
      const { status, newestFirst } = await settleRun(
        client,
        session.id,
        Date.now() + DEFAULT_SEND_TIMEOUT_SECONDS * 1000,
      )
      if (status === "error")
        return textResult(
          `Error: ${runError(newestFirst)?.message ?? "unknown provider error"}`,
        )
      if (status !== "idle")
        return textResult(
          `Error: no reply within ${DEFAULT_SEND_TIMEOUT_SECONDS}s`,
        )
      const text = repliesTo(newestFirst, sent.id)
        .map(assistantText)
        .filter(Boolean)
        .join("\n")
        .trim()
      return textResult(text || "Error: no response")
    } finally {
      await client.session.remove({ sessionID: session.id }).catch(() => {})
    }
  } catch (e) {
    return errorResult(e)
  }
}

// ─── Models ───

export const listModels = async ({
  provider,
}: {
  provider?: string
} = {}) => {
  try {
    const client = getClient(await sharedServer())
    const { data } = await client.model.list()

    const lines = data
      .filter((m) => m.enabled)
      .map((m) => `${m.providerID}/${m.id}`)
      .filter(isModelAllowed)
      .filter((m) => !provider || m.startsWith(`${provider}/`))

    return textResult(
      lines.join("\n") ||
        `No models found${provider ? ` for provider "${provider}"` : ""}`,
    )
  } catch (e) {
    return errorResult(e)
  }
}

// ─── Sessions ───

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function errorResult(e: unknown) {
  return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
}

// ─── Discovery ───

const NO_SERVER_MESSAGE =
  "No opencode server found. Open opencode (the TUI starts the background service) or run `opencode service start`."

// The background service every TUI window shares, plus the headless
// instances from start_instance, keeping only those that answer.
export const discoverServers = async (): Promise<OpencodeServer[]> => {
  if (CONFIGURED_URL) return [configuredServer(CONFIGURED_URL)]

  const service = await Service.discover().catch(() => undefined)
  const candidates = [
    ...(service ? [fromEndpoint(service)] : []),
    ...readRegistry()
      .filter((r) => isPidAlive(r.pid))
      .map(instanceServer),
  ].filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i)
  const reachable = await Promise.all(candidates.map(answersAsOpencode))
  return candidates.filter((_, i) => reachable[i])
}

type LocatedSession = SessionInfo & { ports: number[] }

const sessionsByServer = async (
  servers: OpencodeServer[],
  directory?: string,
) => {
  const located = new Map<string, LocatedSession>()
  for (const server of servers) {
    const { data } = await getClient(server).session.list({
      limit: RECENT_MESSAGES,
      ...(directory && { directory }),
    })
    for (const session of data) {
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
      throw new Error(`no opencode server is listening on port ${port}`)
    return chosen
  }
  if (servers.length === 0) throw new Error(NO_SERVER_MESSAGE)

  const session = (await sessionsByServer(servers)).get(session_id)
  if (!session)
    throw new Error(
      `session "${session_id}" not found on any opencode server. Use list_sessions to see what's open.`,
    )
  // v2 servers share one session store, so a session shows on every server.
  // A task's session stays on its instance, under that instance's guard rails.
  const owner = readRegistry().find((r) =>
    r.sessions?.some((s) => s.id === session_id),
  )
  const ownerPort =
    owner && session.ports.includes(owner.port) ? owner.port : session.ports[0]
  return servers.find((s) => s.port === ownerPort) as OpencodeServer
}

export const listSessions = async ({
  directory,
}: {
  directory?: string
} = {}) => {
  try {
    const servers = await discoverServers()
    if (servers.length === 0) return textResult(NO_SERVER_MESSAGE)

    const lines = [...(await sessionsByServer(servers, directory)).values()]
      .sort((a, b) => b.time.updated - a.time.updated)
      .map(
        (s) =>
          `${s.id}  ${s.title || "(untitled)"}  ${s.location.directory}  port ${s.ports.join(", ")}  updated ${new Date(s.time.updated).toISOString()}`,
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
    const client = getClient(await resolveSessionServer(session_id, port))
    // v2 prompts carry no agent or model: both are switched on the session,
    // which keeps them for later turns, as picking them in the TUI does.
    if (agent)
      await client.session.switchAgent({ sessionID: session_id, agent })
    if (model)
      await client.session.switchModel({
        sessionID: session_id,
        model: toModelRef(model),
      })
    const sent = await client.session.prompt({
      sessionID: session_id,
      text: prompt,
    })

    const { status, newestFirst } = await settleRun(
      client,
      session_id,
      Date.now() + timeout_seconds * 1000,
    )
    if (status === "busy" || status === "retry")
      return textResult(
        `Still running after ${timeout_seconds}s — opencode keeps working on it. Use read with session_id "${session_id}" later to get the reply.`,
      )
    if (status === "error")
      return textResult(
        `Error: ${runError(newestFirst)?.message ?? "unknown provider error"}`,
      )

    const text = repliesTo(newestFirst, sent.id)
      .map(condenseAssistant)
      .filter(Boolean)
      .join("\n")
    return textResult(text || "Error: no response")
  } catch (e) {
    return errorResult(e)
  }
}

const transcriptEntry = (message: SessionMessageInfo) => {
  if (message.type === "user") return `── user ──\n${message.text.trim()}`
  if (isAssistant(message)) {
    const body = condenseAssistant(message)
    return body ? `── assistant ──\n${body}` : ""
  }
  return ""
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
    const client = getClient(await resolveSessionServer(session_id, port))
    const { data } = await client.message.list({
      sessionID: session_id,
      order: "desc",
      limit,
    })
    const transcript = [...data]
      .reverse()
      .map(transcriptEntry)
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
const LISTENING_LINE = /server listening on http:\/\/[^\s:]+:(\d+)/i

// Globs match the whole command, so a leading and inner * also catch
// `git -C <dir> push`, `env X=1 git push` and `cd x && git push`. The
// cost is the odd false positive (a commit message saying " push"), which
// fails safe.
const SHELL_DENY_PATTERNS = [
  "*git* push*",
  "*git* remote*",
  "*git* reset*--hard*",
  "gh *",
  "* gh *",
  "*npm* publish*",
]

const rule = (
  action: string,
  effect: "allow" | "deny",
  resource = "*",
): PermissionRule => ({ action, resource, effect })

// opencode v2 evaluates rules in order and the last match wins; agents start
// from a base policy that allows everything, and their own rules land after
// these. Every rule here is allow or deny, never ask, which would hang a
// headless session, and the shell denies come after the shell allow.
export const HEADLESS_PERMISSION_RULESET: PermissionRule[] = [
  ...["read", "edit", "glob", "grep", "subagent"].map((action) =>
    rule(action, "allow"),
  ),
  // v2 allows external_directory by default; keep it denied.
  ...["external_directory", "question", "webfetch", "websearch"].map((action) =>
    rule(action, "deny"),
  ),
  rule("shell", "allow"),
  ...SHELL_DENY_PATTERNS.map((pattern) => rule("shell", "deny", pattern)),
]

const rulesetFor = (sandboxed: boolean) =>
  sandboxed
    ? [...HEADLESS_PERMISSION_RULESET, ...sandboxShellDenyRules()]
    : HEADLESS_PERMISSION_RULESET

// Policies run after every permission rule, agent and project config
// included, and can only deny: each deny is repeated there so a repository's
// own opencode config cannot allow it back.
const denyPolicies = (ruleset: PermissionRule[]) =>
  ruleset
    .filter((r) => r.effect === "deny")
    .map((r) => ({
      action: "tool.use" as const,
      resource: `${r.action}:${r.resource}`,
      effect: "deny" as const,
    }))

export const instanceConfig = (sandboxed = false) => {
  const ruleset = rulesetFor(sandboxed)
  return {
    model: DEFAULT_MODEL,
    agents: { title: { model: DEFAULT_MODEL } },
    permissions: ruleset,
    policies: denyPolicies(ruleset),
  }
}

export const hardenedInstance = (
  baseEnv: NodeJS.ProcessEnv = process.env,
  opts: { sandboxed?: boolean; password?: string } = {},
): NodeJS.ProcessEnv => {
  const {
    GH_TOKEN,
    GITHUB_TOKEN,
    OPENCODE_PASSWORD,
    OPENCODE_SERVER_PASSWORD,
    ...env
  } = baseEnv
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...(opts.password && { OPENCODE_PASSWORD: opts.password }),
    // Sandboxed instances extend (never replace) the base ruleset, so the
    // model pinning and guard rails stay identical and only gain denies.
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      instanceConfig(opts.sandboxed ?? false),
    ),
  }
}

export type FallbackRecord = {
  from: string
  to: string
  reason: string
  at: string
}

export type InstanceSessionRecord = {
  id: string
  title: string
  model: string
  startedAt: string
  fallbacks?: FallbackRecord[]
}

// Per-job fallback watchdog state. Started by `task`, independent of `wait`,
// so a stalled or failing model is switched even when nobody is polling.
type JobState = {
  port: number
  sessionId: string
  directory: string
  prompt: string
  agent: string
  models: string[]
  index: number
  fallbacks: FallbackRecord[]
  retrySince?: number
  timer?: NodeJS.Timeout
  settled: boolean
  exhaustedError: boolean
  checking: boolean
}

const jobs = new Map<string, JobState>()

const WATCHDOG_POLL_MS = 1000

const jobKey = (port: number, sessionId: string) => `${port}:${sessionId}`

export const clearJobWatchdogs = () => {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer)
  }
  jobs.clear()
}

const clearJob = (job: JobState) => {
  if (job.timer) {
    clearInterval(job.timer)
    job.timer = undefined
  }
  jobs.delete(jobKey(job.port, job.sessionId))
}

const clearJobsForPort = (port: number) => {
  for (const job of [...jobs.values()]) {
    if (job.port === port) clearJob(job)
  }
}

const updateRegistrySession = (
  port: number,
  sessionId: string,
  model: string,
  fallbacks: FallbackRecord[],
) => {
  writeRegistry(
    readRegistry().map((r) =>
      r.port === port
        ? {
            ...r,
            sessions: (r.sessions ?? []).map((s) =>
              s.id === sessionId ? { ...s, model, fallbacks } : s,
            ),
          }
        : r,
    ),
  )
}

// opencode v2 types provider failures as "provider.*" (e.g.
// provider.no-route for a model the provider does not serve).
export const isProviderError = (error?: {
  type?: string
  message?: string
}) => {
  if (!error) return false
  if (error.type?.startsWith("provider.")) return true
  return /model not found/i.test(String(error.message ?? ""))
}

const providerErrorReason = (error: SessionStructuredError) =>
  `provider error (${error.type}: ${error.message})`

const switchJobModel = async (job: JobState, reason: string) => {
  const from = job.models[job.index]
  const next = job.models[job.index + 1]
  const instance = findInstance(job.port)
  if (!next) {
    job.settled = true
    job.exhaustedError = true
    if (job.timer) {
      clearInterval(job.timer)
      job.timer = undefined
    }
    try {
      if (instance)
        await getClient(instanceServer(instance)).session.interrupt({
          sessionID: job.sessionId,
        })
    } catch {}
    return
  }
  if (!instance) {
    job.settled = true
    if (job.timer) clearInterval(job.timer)
    jobs.delete(jobKey(job.port, job.sessionId))
    return
  }
  const client = getClient(instanceServer(instance))
  try {
    await client.session.interrupt({ sessionID: job.sessionId }).catch(() => {})
    await client.session.switchModel({
      sessionID: job.sessionId,
      model: toModelRef(next),
    })
    await client.session.prompt({ sessionID: job.sessionId, text: job.prompt })
  } catch {}
  job.index += 1
  job.retrySince = undefined
  job.fallbacks.push({ from, to: next, reason, at: new Date().toISOString() })
  updateRegistrySession(job.port, job.sessionId, next, [...job.fallbacks])
}

const settledProviderError = (newestFirst: SessionMessageInfo[]) => {
  const error = runError(newestFirst)
  return newestFirst[0]?.type === "idle" && isProviderError(error)
    ? error
    : undefined
}

const checkJob = async (key: string) => {
  const job = jobs.get(key)
  if (!job || job.settled || job.checking) return
  job.checking = true
  try {
    const instance = findInstance(job.port)
    if (!instance) {
      clearJob(job)
      return
    }
    const client = getClient(instanceServer(instance))
    const { newestFirst, status } = await runSnapshot(client, job.sessionId)
    const providerError = settledProviderError(newestFirst)
    if (providerError) {
      await switchJobModel(job, providerErrorReason(providerError))
      return
    }
    if (status === "retry") {
      if (job.retrySince === undefined) {
        job.retrySince = Date.now()
      } else if (
        Date.now() - job.retrySince >=
        getRetryTimeoutSeconds() * 1000
      ) {
        const newest = newestFirst[0]
        const retry = newest && isAssistant(newest) ? newest.retry : undefined
        const detail = retry
          ? ` (attempt ${retry.attempt}: ${retry.error.message})`
          : ""
        await switchJobModel(
          job,
          `retry timeout after ${getRetryTimeoutSeconds()}s${detail}`,
        )
      }
    } else {
      job.retrySince = undefined
      if (status === "idle" || status === "error") {
        job.settled = true
        if (job.timer) {
          clearInterval(job.timer)
          job.timer = undefined
        }
      }
    }
  } catch {
    // Transient probe failures must not kill the watchdog.
  } finally {
    const current = jobs.get(key)
    if (current) current.checking = false
  }
}

const startJobWatchdog = (job: JobState) => {
  if (job.models.length <= 1) return
  job.timer = setInterval(() => {
    void checkJob(jobKey(job.port, job.sessionId))
  }, WATCHDOG_POLL_MS)
  job.timer.unref?.()
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
  // Basic-auth password (user "opencode") the instance was started with.
  // The registry is written owner-only (0600) because of it.
  password?: string
  // "srt" when the server was wrapped in an OS sandbox, null otherwise.
  // Optional so registries written before sandboxing existed still parse.
  sandbox?: SandboxKind | null
  // Per-instance temp dir holding the generated srt settings file.
  // Internal: used to clean up on stop/reap.
  sandboxSettingsDir?: string
}

// Best-effort removal of a per-instance sandbox temp dir.
const removeSandboxDir = (dir: string | undefined) => {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

const instanceUrl = (port: number) => `http://127.0.0.1:${port}`

const instanceServer = ({
  port,
  password,
}: Pick<InstanceRecord, "port" | "password">): OpencodeServer => ({
  port,
  url: instanceUrl(port),
  ...(password && { password }),
})

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
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 })
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

function isPidAlive(pid: number) {
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

// A private instance holds only its own sessions, so none are filtered out.
const instanceSessions = async (row: InstanceRecord) => {
  const client = getClient(instanceServer(row))
  const [sessions, active] = await Promise.all([
    client.session.list({ limit: RECENT_MESSAGES }),
    client.session.active(),
  ])
  return sessions.data.map((s) => ({
    id: s.id,
    title: s.title ?? "",
    updated: s.time.updated,
    status: active[s.id] ? ("busy" as const) : ("idle" as const),
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
      clearJobsForPort(row.port)
      removeSandboxDir(row.sandboxSettingsDir)
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
    clearJobsForPort(row.port)
    removeSandboxDir(row.sandboxSettingsDir)
    reaped.push(row.port)
  }
  return reaped
}

export const killOwnedInstances = () => {
  const rows = readRegistry()
  const owned = rows.filter((r) => r.mcpPid === process.pid)
  if (owned.length === 0) return
  owned.forEach((r) => terminate(r.pid))
  owned.forEach((r) => clearJobsForPort(r.port))
  owned.forEach((r) => removeSandboxDir(r.sandboxSettingsDir))
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

// v2 dropped `opencode attach`: the TUI joins a server with --server, and
// needs the server's password in OPENCODE_PASSWORD.
export const attachCommand = (row: InstanceRecord, sessionId: string) =>
  [
    ...(row.password ? [`OPENCODE_PASSWORD=${row.password}`] : []),
    `opencode --server ${instanceUrl(row.port)} --session ${sessionId}`,
  ].join(" ")

const newInstancePassword = () => randomBytes(24).toString("base64url")

export const startInstance = async ({ directory }: { directory: string }) => {
  if (!isModelAllowed(DEFAULT_MODEL))
    return textResult(
      `Error: the default model "${DEFAULT_MODEL}" is not allowed, so an instance can't be pinned to it. Set MCP_OPENCODE_MODEL to an allowed model.`,
    )
  // Declared outside try so the catch can clean up a settings dir that a
  // later failure leaves behind.
  let sandboxSettingsDir: string | undefined
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      return textResult(`Error: "${directory}" is not a directory`)

    // Throws on an unsupported MCP_OPENCODE_SANDBOX value or a missing
    // MCP_OPENCODE_SANDBOX_SETTINGS file.
    const sandbox = resolveSandbox()

    await reapInstances()
    mkdirSync(STATE_DIR, { recursive: true })

    let cmd = "opencode"
    let args = ["serve", "--port", "0", "--hostname", "127.0.0.1"]
    if (sandbox) {
      if (!isSrtAvailable()) return textResult(`Error: ${missingSrtError()}`)
      let settingsPath = sandbox.settingsOverride ?? null
      if (!settingsPath) {
        sandboxSettingsDir = mkdtempSync(join(STATE_DIR, "sandbox-"))
        let realDir = directory
        try {
          realDir = realpathSync(directory)
        } catch {}
        const settings = buildSrtSettings({
          directory: realDir,
          gitDirs: resolveGitDirs(realDir),
          tmpdirs: tmpdirsForSandbox(),
        })
        settings.filesystem.allowWrite = filterExistingPaths(
          settings.filesystem.allowWrite,
        )
        settingsPath = join(sandboxSettingsDir, "srt-settings.json")
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
      }
      // Same opencode serve invocation as unsandboxed, wrapped in srt.
      // --settings is always explicit: without it srt would read
      // ~/.srt-settings.json, which must never decide our policy.
      args = ["--settings", settingsPath, "--", cmd, ...args]
      cmd = "srt"
    }

    const password = newInstancePassword()
    const logPath = join(STATE_DIR, `instance-${Date.now()}.log`)
    const logFd = openSync(logPath, "a")
    const child = spawn(cmd, args, {
      cwd: directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: hardenedInstance(process.env, {
        sandboxed: sandbox !== null,
        password,
      }),
    })
    closeSync(logFd)
    child.unref()
    const pid = child.pid
    if (!pid) {
      removeSandboxDir(sandboxSettingsDir)
      return textResult("Error: failed to spawn opencode serve")
    }

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
      password,
      sandbox: sandbox ? "srt" : null,
      ...(sandboxSettingsDir && { sandboxSettingsDir }),
    })
    return jsonResult({ port, url: instanceUrl(port) })
  } catch (e) {
    removeSandboxDir(sandboxSettingsDir)
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
    const client = getClient(instanceServer(instance))
    // Sandboxed instances get the same extra shell denies as their
    // OPENCODE_CONFIG_CONTENT, so the session and the server agree.
    const created = await client.session.create({
      location: { directory: instance.directory },
      agent,
      model: toModelRef(chosenModel),
      permissions: rulesetFor(instance.sandbox === "srt"),
      ...(title && { title }),
    })
    const sessionId = created.id

    try {
      await client.session.prompt({ sessionID: sessionId, text: prompt })
    } catch (e) {
      return textResult(
        `Error: prompt was not accepted: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    const models = [chosenModel, ...getFallbackModels()].filter(
      (m, i, all) => all.indexOf(m) === i,
    )

    recordInstanceSession(port, {
      id: sessionId,
      title: created.title ?? title ?? "",
      model: chosenModel,
      startedAt: new Date().toISOString(),
      fallbacks: [],
    })

    const key = jobKey(port, sessionId)
    jobs.delete(key)
    const job: JobState = {
      port,
      sessionId,
      directory: instance.directory,
      prompt,
      agent,
      models,
      index: 0,
      fallbacks: [],
      settled: false,
      exhaustedError: false,
      checking: false,
    }
    jobs.set(key, job)
    startJobWatchdog(job)

    return jsonResult({
      session_id: sessionId,
      port,
      attach: attachCommand(instance, sessionId),
    })
  } catch (e) {
    return errorResult(e)
  }
}

const lastAssistantText = (newestFirst: SessionMessageInfo[]) => {
  const error = runError(newestFirst)
  if (error) return `Error: ${error.message}`
  const last = newestFirst.find(isAssistant)
  return last ? assistantText(last) : ""
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
  const client = getClient(instanceServer(instance))
  const deadline =
    Date.now() + Math.min(timeout_seconds, MAX_WAIT_SECONDS) * 1000

  try {
    const key = jobKey(port, session_id)
    const snapshot = () => runSnapshot(client, session_id)

    const jobReport = () => {
      const job = jobs.get(key)
      if (job) return { model: job.models[job.index], fallbacks: job.fallbacks }
      const stored = readRegistry()
        .find((r) => r.port === port)
        ?.sessions?.find((s) => s.id === session_id)
      return {
        ...(stored?.model !== undefined && { model: stored.model }),
        fallbacks: stored?.fallbacks ?? [],
      }
    }

    let current = await snapshot()
    while (Date.now() < deadline) {
      const job = jobs.get(key)
      if (
        current.status === "error" &&
        job &&
        !job.exhaustedError &&
        settledProviderError(current.newestFirst)
      ) {
        await checkJob(key)
        current = await snapshot()
        if (current.status === "busy" || current.status === "retry") {
          await sleep(Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()))
          current = await snapshot()
          continue
        }
      }
      if (current.status !== "busy" && current.status !== "retry") break
      await sleep(Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()))
      current = await snapshot()
    }

    const finalJob = jobs.get(key)
    if (finalJob?.exhaustedError && current.status !== "idle")
      current = { ...current, status: "error" as const }

    // Without bounds, a v2 session diff spans the whole session, so model
    // fallbacks re-prompting the same session don't re-base it.
    const diff = await client.session.diff({ sessionID: session_id })
    const files = diff.map((d) => ({
      file: d.file,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
    }))
    return jsonResult({
      session_id,
      port,
      status: current.status,
      ...jobReport(),
      ...((current.status === "busy" || current.status === "retry") && {
        note: `Still running at the timeout. Call wait again, or attach: ${attachCommand(instance, session_id)}`,
      }),
      last_assistant_text: lastAssistantText(current.newestFirst),
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
      readRegistry().map(async ({ password, ...row }) => {
        // Registries written before sandboxing existed lack the field.
        const sandbox = row.sandbox ?? null
        try {
          const live = new Map(
            (await instanceSessions({ ...row, password })).map((s) => [
              s.id,
              s,
            ]),
          )
          return {
            ...row,
            sandbox,
            sessions: (row.sessions ?? []).map((s) => ({
              fallbacks: [],
              ...s,
              status: live.get(s.id)?.status ?? "missing",
              updated: live.get(s.id)?.updated,
            })),
          }
        } catch (e) {
          return {
            ...row,
            sandbox,
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

// Any HTTP answer, even a 401, means the port is still open.
const isListening = async (url: string) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return true
  } catch {
    return false
  }
}

const waitForPortToClose = async (port: number) => {
  const deadline = Date.now() + INSTANCE_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!(await isListening(instanceUrl(port)))) return true
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
      const client = getClient(instanceServer(instance))
      for (const s of await instanceSessions(instance)) {
        if (s.status === "idle") continue
        await client.session.interrupt({ sessionID: s.id })
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
    clearJobsForPort(port)
    removeSandboxDir(instance.sandboxSettingsDir)
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
    description: `List sessions on opencode's background service (shared by every TUI window) and on the headless instances from start_instance, most recently updated first, with the port(s) each is served on. Use this to find a live session to talk to with send.`,
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
    description: `Send a message to an existing opencode session and return its reply. The session keeps its history and model, and the exchange appears live in any opencode TUI showing it. Never creates or deletes sessions. Uses the session's own agent and model unless \`agent\` or \`model\` is passed; either switches the session for later turns too, as picking it in the TUI does. The model must pass the allow/block filters (${filterSummary}).`,
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
          "Port of the opencode server to use (default: the server that holds the session)",
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
          "Port of the opencode server to read from (default: discovered)",
        ),
    },
  },
  read,
)

server.registerTool(
  "start_instance",
  {
    description: `Start a private, headless opencode server for one job, rooted in \`directory\`. It listens on a free localhost port behind a generated password, runs with git credentials and GitHub tokens stripped, and pins its model to ${DEFAULT_MODEL}. Returns { port, url }. Idle instances are reaped after ${INSTANCE_TTL_MS / 60000} minutes; use stop_instance when done. Set MCP_OPENCODE_SANDBOX=srt to wrap the server in an OS sandbox (needs \`srt\` on PATH).`,
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
    description: `Start a job on an instance from start_instance: creates a fresh session with the headless guard rails (no permission prompts; bash allowed except git push/remote, gh, npm publish and git reset --hard; no web fetch or search, no questions, nothing outside the directory) and prompts it in the background. Returns { session_id, port, attach } at once (attach is the command that opens the session in the TUI); use wait to collect the result. Model must pass the allow/block filters (${filterSummary}).`,
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
    description: `Wait for a task's session to finish, polling every ${WAIT_POLL_INTERVAL_MS / 1000}s. Returns its status (idle, busy, retry or error), the current model, the model fallbacks taken so far, the last assistant text, and the files it changed with line counts. Stops at the timeout with status busy or retry; call it again to keep waiting.`,
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
      "List the instances started by start_instance, with each session's live status, current model and model fallbacks. Reaps dead and idle instances first.",
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
