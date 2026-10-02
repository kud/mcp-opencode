import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.hoisted(() => {
  process.env.MCP_OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.MCP_OPENCODE_MODEL_BLOCK = ""
  delete process.env.MCP_OPENCODE_MODEL
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync, spawn } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  query,
  listModels,
  isModelAllowed,
  listSessions,
  send,
  read,
  discoverServers,
} from "../index.js"

const mockExecSync = vi.mocked(execSync)
const mockSpawn = vi.mocked(spawn)
const mockCreateClient = vi.mocked(createOpencodeClient)

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          info: { id: "msg-1" },
          parts: [{ type: "text", text: "Hello!" }],
        },
      }),
      delete: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      ...(overrides.session as Record<string, unknown>),
    },
    config: {
      providers: vi.fn().mockResolvedValue({
        data: {
          providers: [
            { id: "github-copilot", models: { "gpt-4.1": {}, "gpt-5": {} } },
            { id: "openrouter", models: { "mistral-7b": {} } },
            { id: "anthropic", models: { "claude-3": {} } },
          ],
        },
      }),
    },
  }) as unknown as ReturnType<typeof createOpencodeClient>

// Builds the "n<host>:<port>" lines `lsof -Fn` prints for LISTEN sockets.
const lsofOutput = (entries: Array<{ host?: string; port: number }>) =>
  Buffer.from(
    entries
      .map(({ host = "127.0.0.1", port }) => `n${host}:${port}`)
      .join("\n"),
  )

// The generic `lsof -i :PORT -sTCP:LISTEN -t` call `ensureServer` still uses.
const isServerRunningCmd = (cmd: unknown) =>
  typeof cmd === "string" && cmd.includes("-sTCP:LISTEN -t")

const mockDiscovery = (
  entries: Array<{ host?: string; port: number }>,
  { serverRunningThrows = false }: { serverRunningThrows?: boolean } = {},
) => {
  mockExecSync.mockImplementation((cmd: unknown) => {
    if (isServerRunningCmd(cmd)) {
      if (serverRunningThrows) throw new Error("no listener")
      return Buffer.from("")
    }
    return lsofOutput(entries)
  })
}

// A client whose session.list already contains the given session id, so
// resolveSessionServer's owner lookup succeeds against the default (single,
// port-4096) discovered server.
const makeClientWithSession = (id = "session-1") => {
  const client = makeClient()
  ;(client.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: [{ id, title: "T", directory: "/proj", time: { updated: 0 } }],
  })
  return client
}

// Stubs global fetch so the discovery probe succeeds only for the given ports.
const stubProbe = (livePorts: number[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = /:(\d+)\/session$/.exec(url)
      const port = match ? Number(match[1]) : -1
      if (!livePorts.includes(port))
        return { ok: false, json: async () => ({}) }
      return { ok: true, json: async () => [] }
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: a single opencode window on the default port, probe passes.
  mockDiscovery([{ port: 4096 }])
  stubProbe([4096])
  mockCreateClient.mockReturnValue(makeClient())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("isModelAllowed", () => {
  it("allows matching wildcard pattern", () => {
    expect(isModelAllowed("github-copilot/gpt-4.1")).toBe(true)
  })

  it("rejects model not in allow list", () => {
    expect(isModelAllowed("anthropic/claude-3")).toBe(false)
  })
})

describe("query", () => {
  it("returns response on success", async () => {
    const result = await query({ prompt: "hello" })
    expect(result.content[0].text).toBe("Hello!")
  })

  it("uses default model when none specified", async () => {
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    await query({ prompt: "hello" })

    expect(
      (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .model,
    ).toEqual({ providerID: "github-copilot", modelID: "gpt-4.1" })
  })

  it("rejects disallowed model", async () => {
    const result = await query({
      prompt: "hello",
      model: "anthropic/claude-3",
    })
    expect(result.content[0].text).toContain("Error:")
    expect(result.content[0].text).toContain("list_models")
  })

  it("returns error when session creation fails", async () => {
    const client = makeClient()
    ;(client.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
    })
    mockCreateClient.mockReturnValue(client)

    const result = await query({ prompt: "hello" })
    expect(result.content[0].text).toContain("Error:")
  })

  it("returns error when prompt throws", async () => {
    const client = makeClient()
    ;(client.session.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    )
    mockCreateClient.mockReturnValue(client)

    const result = await query({ prompt: "hello" })
    expect(result.content[0].text).toContain("Error:")
  })
})

describe("listModels", () => {
  it("returns only allowed models", async () => {
    const result = await listModels()
    expect(result.content[0].text).toContain("github-copilot/gpt-4.1")
    expect(result.content[0].text).toContain("github-copilot/gpt-5")
    expect(result.content[0].text).not.toContain("anthropic/")
    expect(result.content[0].text).not.toContain("openrouter/")
  })

  it("returns error when provider list throws", async () => {
    const client = makeClient()
    ;(client.config.providers as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("server unreachable"),
    )
    mockCreateClient.mockReturnValue(client)

    const result = await listModels()
    expect(result.content[0].text).toContain("Error:")
  })
})

describe("ensureServer (query/list_models only)", () => {
  it("spawns opencode serve with the configured port when nothing is listening", async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (isServerRunningCmd(cmd)) throw new Error("no listener")
      return lsofOutput([])
    })
    vi.useFakeTimers()

    const queryPromise = query({ prompt: "hello" })
    await vi.advanceTimersByTimeAsync(2000)
    await queryPromise

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
      { detached: true, stdio: "ignore" },
    )
  })

  it("does not spawn a server when one is already listening", async () => {
    await query({ prompt: "hello" })

    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe("discoverServers", () => {
  it("filters non-local and duplicate ports, and drops servers that fail the probe", async () => {
    mockDiscovery([
      { host: "127.0.0.1", port: 4097 },
      { host: "[::1]", port: 4097 }, // duplicate port, different host form
      { host: "192.168.1.20", port: 4098 }, // non-local, filtered out
      { host: "*", port: 4099 }, // probe will fail this one
    ])
    stubProbe([4097])

    const servers = await discoverServers()

    expect(servers).toEqual([{ port: 4097, url: "http://127.0.0.1:4097" }])
  })

  it("returns no servers when lsof throws", async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (isServerRunningCmd(cmd)) return Buffer.from("")
      throw new Error("lsof: command not found")
    })

    const servers = await discoverServers()

    expect(servers).toEqual([])
  })
})

describe("listSessions", () => {
  it("sorts sessions by most recently updated first", async () => {
    const client = makeClient()
    ;(client.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "old",
          title: "Old",
          directory: "/proj",
          time: { updated: 100 },
        },
        {
          id: "new",
          title: "New",
          directory: "/proj",
          time: { updated: 300 },
        },
        {
          id: "mid",
          title: "Mid",
          directory: "/proj",
          time: { updated: 200 },
        },
      ],
    })
    mockCreateClient.mockReturnValue(client)

    const result = await listSessions({})
    const lines = result.content[0].text.split("\n")

    expect(lines[0]).toContain("new")
    expect(lines[1]).toContain("mid")
    expect(lines[2]).toContain("old")
  })

  it("passes the directory filter through to session.list", async () => {
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    await listSessions({ directory: "/some/project" })

    expect(client.session.list).toHaveBeenCalledWith({
      directory: "/some/project",
    })
  })

  it("reports when no sessions exist", async () => {
    const result = await listSessions({})
    expect(result.content[0].text).toBe("No sessions found")
  })

  it("reports when no opencode windows are found", async () => {
    mockDiscovery([])
    stubProbe([])

    const result = await listSessions({})

    expect(result.content[0].text).toContain("No opencode windows found")
  })

  it("merges a session's ports across two servers", async () => {
    mockDiscovery([{ port: 4097 }, { port: 4098 }])
    stubProbe([4097, 4098])

    const client97 = makeClient()
    ;(client97.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "s1",
          title: "Shared",
          directory: "/proj",
          time: { updated: 200 },
        },
      ],
    })
    const client98 = makeClient()
    ;(client98.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "s1",
          title: "Shared",
          directory: "/proj",
          time: { updated: 200 },
        },
        { id: "s2", title: "Solo", directory: "/proj", time: { updated: 100 } },
      ],
    })
    mockCreateClient.mockImplementation((opts?: { baseUrl?: string }) =>
      opts?.baseUrl === "http://127.0.0.1:4097" ? client97 : client98,
    )

    const result = await listSessions({})
    const lines = result.content[0].text.split("\n")

    expect(lines.find((l) => l.startsWith("s1"))).toContain("port 4097, 4098")
    expect(lines.find((l) => l.startsWith("s2"))).toContain("port 4098")
  })
})

describe("send", () => {
  it("prompts the existing session without creating or deleting one", async () => {
    const client = makeClientWithSession()
    mockCreateClient.mockReturnValue(client)

    await send({ session_id: "session-1", prompt: "hi" })

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      parts: [{ type: "text", text: "hi" }],
    })
  })

  it("passes the agent through when provided", async () => {
    const client = makeClientWithSession()
    mockCreateClient.mockReturnValue(client)

    await send({ session_id: "session-1", prompt: "hi", agent: "plan" })

    expect(
      (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .agent,
    ).toBe("plan")
  })

  it("passes an allowed model through as providerID/modelID", async () => {
    const client = makeClientWithSession()
    mockCreateClient.mockReturnValue(client)

    await send({
      session_id: "session-1",
      prompt: "hi",
      model: "github-copilot/gpt-5.4",
    })

    expect(
      (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .model,
    ).toEqual({ providerID: "github-copilot", modelID: "gpt-5.4" })
  })

  it("rejects a model outside the allowlist without prompting", async () => {
    const client = makeClientWithSession()
    mockCreateClient.mockReturnValue(client)

    const result = await send({
      session_id: "session-1",
      prompt: "hi",
      model: "anthropic/claude-opus-5-5",
    })

    expect(result.content[0].text).toContain("is not allowed")
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("returns a still-running message when the timeout elapses", async () => {
    const client = makeClientWithSession()
    ;(client.session.prompt as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )
    mockCreateClient.mockReturnValue(client)
    vi.useFakeTimers()

    const sendPromise = send({
      session_id: "session-1",
      prompt: "hi",
      timeout_seconds: 5,
    })
    await vi.advanceTimersByTimeAsync(5000)
    const result = await sendPromise

    expect(result.content[0].text).toContain("Still running after 5s")
    expect(result.content[0].text).toContain("session-1")
    expect(result.content[0].text).toContain("read")
  })

  it("surfaces a provider error from the response", async () => {
    const client = makeClientWithSession()
    ;(client.session.prompt as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        info: {
          error: { name: "ProviderError", data: { message: "rate limited" } },
        },
        parts: [],
      },
    })
    mockCreateClient.mockReturnValue(client)

    const result = await send({ session_id: "session-1", prompt: "hi" })

    expect(result.content[0].text).toBe("Error: rate limited")
  })

  it("routes to the server that owns the session, using that server's baseUrl", async () => {
    mockDiscovery([{ port: 4097 }, { port: 4098 }])
    stubProbe([4097, 4098])

    const owner = makeClient()
    ;(owner.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "s1", title: "T", directory: "/p", time: { updated: 1 } }],
    })
    const other = makeClient()
    ;(other.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
    })
    mockCreateClient.mockImplementation((opts?: { baseUrl?: string }) =>
      opts?.baseUrl === "http://127.0.0.1:4097" ? owner : other,
    )

    await send({ session_id: "s1", prompt: "hi" })

    expect(owner.session.prompt).toHaveBeenCalledWith({
      sessionID: "s1",
      parts: [{ type: "text", text: "hi" }],
    })
    expect(other.session.prompt).not.toHaveBeenCalled()
  })

  it("notes the other windows when the session is open in several", async () => {
    mockDiscovery([{ port: 4097 }, { port: 4098 }])
    stubProbe([4097, 4098])

    const sameSession = {
      id: "s1",
      title: "T",
      directory: "/p",
      time: { updated: 1 },
    }
    const client97 = makeClient()
    ;(client97.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [sameSession],
    })
    const client98 = makeClient()
    ;(client98.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [sameSession],
    })
    mockCreateClient.mockImplementation((opts?: { baseUrl?: string }) =>
      opts?.baseUrl === "http://127.0.0.1:4097" ? client97 : client98,
    )

    const result = await send({ session_id: "s1", prompt: "hi" })

    expect(result.content[0].text).toContain("port 4097")
    expect(result.content[0].text).toContain("4098")
  })

  it("errors when the explicit port isn't listening", async () => {
    mockDiscovery([{ port: 4097 }])
    stubProbe([4097])

    const result = await send({ session_id: "s1", prompt: "hi", port: 5000 })

    expect(result.content[0].text).toContain("Error:")
    expect(result.content[0].text).toContain(
      "no opencode window is listening on port 5000",
    )
  })
})

describe("read", () => {
  it("condenses session messages into a transcript", async () => {
    const client = makeClientWithSession()
    ;(client.session.messages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "What's the plan?" }],
        },
        {
          info: { role: "assistant" },
          parts: [
            { type: "tool", tool: "read_file", state: { status: "done" } },
            { type: "text", text: "Here's the plan." },
          ],
        },
      ],
    })
    mockCreateClient.mockReturnValue(client)

    const result = await read({ session_id: "session-1" })

    expect(result.content[0].text).toBe(
      "── user ──\nWhat's the plan?\n\n── assistant ──\n[tool: read_file (done)]\nHere's the plan.",
    )
  })

  it("reports when the session has no messages", async () => {
    mockCreateClient.mockReturnValue(makeClientWithSession())

    const result = await read({ session_id: "session-1" })
    expect(result.content[0].text).toBe("No messages in this session")
  })

  it("errors when the session id isn't found in any window", async () => {
    mockDiscovery([{ port: 4097 }])
    stubProbe([4097])
    const client = makeClient()
    ;(client.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
    })
    mockCreateClient.mockReturnValue(client)

    const result = await read({ session_id: "ghost" })

    expect(result.content[0].text).toContain("Error:")
    expect(result.content[0].text).toContain(
      'session "ghost" not found in any opencode window',
    )
  })
})
