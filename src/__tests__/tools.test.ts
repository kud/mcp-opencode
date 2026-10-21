import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

const stateDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/mcp-opencode-tools-test-${process.pid}-${Date.now()}`
  process.env.MCP_OPENCODE_STATE_DIR = dir
  process.env.MCP_OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.MCP_OPENCODE_MODEL_BLOCK = ""
  delete process.env.MCP_OPENCODE_MODEL
  delete process.env.MCP_OPENCODE_URL
  delete process.env.MCP_OPENCODE_PASSWORD
  return dir
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock("@opencode/client", () => ({
  OpenCode: { make: vi.fn() },
}))

vi.mock("@opencode/client/service", () => ({
  Service: { discover: vi.fn(), ensure: vi.fn() },
}))

import { spawn } from "child_process"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import {
  query,
  listModels,
  isModelAllowed,
  listSessions,
  send,
  read,
  discoverServers,
  toModelRef,
  type InstanceRecord,
} from "../index.js"
import {
  assistantMessage,
  FIXTURE_AUTH,
  history,
  idleMessage,
  makeClient,
  userMessage,
} from "./fake-client.js"

const mockSpawn = vi.mocked(spawn)
const mockMakeClient = vi.mocked(OpenCode.make)
const mockDiscover = vi.mocked(Service.discover)
const mockEnsure = vi.mocked(Service.ensure)

const SERVICE = {
  url: "http://127.0.0.1:4096",
  auth: {
    type: "basic" as const,
    username: "opencode",
    password: FIXTURE_AUTH.service,
  },
}

const authHeader = (password: string) => ({
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
})

const useClient = (client: ReturnType<typeof makeClient>) =>
  mockMakeClient.mockReturnValue(client as never)

const replyHistory = (text = "Hello!") =>
  history(
    userMessage("hello", "msg_prompt"),
    assistantMessage({ text }),
    idleMessage("succeeded"),
  )

const sessionInfo = (id: string, updated = 0, directory = "/proj") => ({
  id,
  title: "T",
  time: { created: 0, updated },
  location: { directory },
})

// A client whose session.list already holds the given session id, so the
// owner lookup succeeds against the background service.
const makeClientWithSession = (id = "session-1") =>
  makeClient({
    session: {
      list: vi.fn().mockResolvedValue({ data: [sessionInfo(id)], cursor: {} }),
    },
    message: { list: vi.fn().mockResolvedValue(replyHistory()) },
  })

const seedRegistry = (rows: InstanceRecord[]) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "instances.json"), JSON.stringify(rows))
}

beforeEach(() => {
  vi.clearAllMocks()
  seedRegistry([])
  mockDiscover.mockResolvedValue(SERVICE)
  mockEnsure.mockResolvedValue(SERVICE)
  useClient(
    makeClient({
      message: { list: vi.fn().mockResolvedValue(replyHistory()) },
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

describe("isModelAllowed", () => {
  it("allows matching wildcard pattern", () => {
    expect(isModelAllowed("github-copilot/gpt-4.1")).toBe(true)
  })

  it("rejects model not in allow list", () => {
    expect(isModelAllowed("anthropic/claude-3")).toBe(false)
  })
})

describe("toModelRef", () => {
  it("splits on the first slash only", () => {
    expect(toModelRef("openrouter/meta/llama-4")).toEqual({
      providerID: "openrouter",
      id: "meta/llama-4",
    })
  })
})

describe("query", () => {
  it("returns the reply and removes its throwaway session", async () => {
    const client = makeClient({
      message: { list: vi.fn().mockResolvedValue(replyHistory()) },
    })
    useClient(client)

    const result = await query({ prompt: "hello" })

    expect(result.content[0].text).toBe("Hello!")
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "ses_1",
      text: "hello",
    })
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  it("uses the background service with its password", async () => {
    await query({ prompt: "hello" })

    expect(mockEnsure).toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockMakeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      headers: authHeader(FIXTURE_AUTH.service),
    })
  })

  it("uses the default model when none is specified", async () => {
    const client = makeClient({
      message: { list: vi.fn().mockResolvedValue(replyHistory()) },
    })
    useClient(client)

    await query({ prompt: "hello" })

    expect(client.session.create).toHaveBeenCalledWith({
      model: { providerID: "github-copilot", id: "gpt-4.1" },
    })
  })

  it("rejects a disallowed model", async () => {
    const result = await query({
      prompt: "hello",
      model: "anthropic/claude-3",
    })
    expect(result.content[0].text).toContain("not allowed")
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it("surfaces the run's provider error", async () => {
    useClient(
      makeClient({
        message: {
          list: vi.fn().mockResolvedValue(
            history(
              userMessage("hello", "msg_prompt"),
              idleMessage("failed", {
                type: "provider.no-route",
                message: "Model unavailable: github-copilot/gpt-4.1",
              }),
            ),
          ),
        },
      }),
    )

    const result = await query({ prompt: "hello" })

    expect(result.content[0].text).toBe(
      "Error: Model unavailable: github-copilot/gpt-4.1",
    )
  })

  it("returns an error when session creation fails", async () => {
    useClient(
      makeClient({
        session: { create: vi.fn().mockRejectedValue(new Error("refused")) },
      }),
    )
    const result = await query({ prompt: "hello" })
    expect(result.content[0].text).toBe("Error: refused")
  })

  it("returns an error and still removes the session when the prompt throws", async () => {
    const client = makeClient({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
      },
    })
    useClient(client)

    const result = await query({ prompt: "hello" })

    expect(result.content[0].text).toBe("Error: connection refused")
    expect(client.session.remove).toHaveBeenCalled()
  })
})

describe("listModels", () => {
  it("returns only enabled, allowed models as provider/model", async () => {
    useClient(
      makeClient({
        model: {
          list: vi.fn().mockResolvedValue({
            data: [
              { providerID: "github-copilot", id: "gpt-4.1", enabled: true },
              { providerID: "github-copilot", id: "gpt-5", enabled: true },
              { providerID: "github-copilot", id: "old", enabled: false },
              { providerID: "anthropic", id: "claude-3", enabled: true },
            ],
          }),
        },
      }),
    )

    const result = await listModels()

    expect(result.content[0].text).toBe(
      "github-copilot/gpt-4.1\ngithub-copilot/gpt-5",
    )
  })

  it("returns an error when the model list throws", async () => {
    useClient(
      makeClient({
        model: { list: vi.fn().mockRejectedValue(new Error("down")) },
      }),
    )
    const result = await listModels()
    expect(result.content[0].text).toBe("Error: down")
  })
})

describe("discoverServers", () => {
  it("finds the background service with its password", async () => {
    expect(await discoverServers()).toEqual([
      {
        url: "http://127.0.0.1:4096",
        port: 4096,
        password: FIXTURE_AUTH.service,
      },
    ])
  })

  it("adds live headless instances and drops servers that fail the probe", async () => {
    seedRegistry([
      {
        runtime: "opencode",
        pid: process.pid,
        port: 51000,
        directory: "/proj",
        startedAt: new Date().toISOString(),
        mcpPid: process.pid,
        sessions: [],
        password: FIXTURE_AUTH.instance,
      },
    ])
    mockMakeClient.mockImplementation(((opts: { baseUrl: string }) =>
      makeClient({
        server: {
          info: opts.baseUrl.endsWith(":4096")
            ? vi.fn().mockRejectedValue(new Error("401"))
            : vi.fn().mockResolvedValue({ version: "2.1.2" }),
        },
      })) as unknown as typeof OpenCode.make)

    expect(await discoverServers()).toEqual([
      {
        url: "http://127.0.0.1:51000",
        port: 51000,
        password: FIXTURE_AUTH.instance,
      },
    ])
  })

  it("returns no servers when no service is registered", async () => {
    mockDiscover.mockResolvedValue(undefined)
    expect(await discoverServers()).toEqual([])
  })
})

describe("listSessions", () => {
  it("sorts sessions by most recently updated first", async () => {
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({
            data: [
              { ...sessionInfo("ses_old", 1000), title: "Old" },
              { ...sessionInfo("ses_new", 3000), title: "New" },
            ],
            cursor: {},
          }),
        },
      }),
    )

    const lines = (await listSessions()).content[0].text.split("\n")

    expect(lines[0]).toContain("ses_new")
    expect(lines[0]).toContain("/proj")
    expect(lines[0]).toContain("port 4096")
    expect(lines[1]).toContain("ses_old")
  })

  it("passes the directory filter through to session.list", async () => {
    const client = makeClient()
    useClient(client)

    await listSessions({ directory: "/proj" })

    expect(client.session.list).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/proj" }),
    )
  })

  it("reports when no sessions exist", async () => {
    const result = await listSessions()
    expect(result.content[0].text).toBe("No sessions found")
  })

  it("reports when no opencode server is found", async () => {
    mockDiscover.mockResolvedValue(undefined)
    const result = await listSessions()
    expect(result.content[0].text).toContain("No opencode server found")
    expect(result.content[0].text).toContain("opencode service start")
  })
})

describe("send", () => {
  it("prompts the existing session without creating or removing one", async () => {
    const client = makeClientWithSession()
    useClient(client)

    const result = await send({ session_id: "session-1", prompt: "hello" })

    expect(result.content[0].text).toBe("Hello!")
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      text: "hello",
    })
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.remove).not.toHaveBeenCalled()
    expect(client.session.switchAgent).not.toHaveBeenCalled()
    expect(client.session.switchModel).not.toHaveBeenCalled()
  })

  it("switches the agent and an allowed model before prompting", async () => {
    const client = makeClientWithSession()
    useClient(client)

    await send({
      session_id: "session-1",
      prompt: "hello",
      agent: "plan",
      model: "github-copilot/gpt-5",
    })

    expect(client.session.switchAgent).toHaveBeenCalledWith({
      sessionID: "session-1",
      agent: "plan",
    })
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: "session-1",
      model: { providerID: "github-copilot", id: "gpt-5" },
    })
  })

  it("condenses tool calls into the reply", async () => {
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({ data: [sessionInfo("session-1")] }),
        },
        message: {
          list: vi.fn().mockResolvedValue(
            history(
              userMessage("earlier", "msg_old"),
              assistantMessage({ text: "old reply" }),
              idleMessage(),
              userMessage("hello", "msg_prompt"),
              assistantMessage({
                text: "Done",
                tools: [{ name: "shell", status: "completed" }],
              }),
              idleMessage(),
            ),
          ),
        },
      }),
    )

    const result = await send({ session_id: "session-1", prompt: "hello" })

    expect(result.content[0].text).toBe("[tool: shell (completed)]\nDone")
  })

  it("rejects a model outside the allowlist without prompting", async () => {
    const client = makeClientWithSession()
    useClient(client)

    const result = await send({
      session_id: "session-1",
      prompt: "hello",
      model: "anthropic/claude-3",
    })

    expect(result.content[0].text).toContain("not allowed")
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("returns a still-running message when the timeout elapses", async () => {
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({ data: [sessionInfo("session-1")] }),
          active: vi
            .fn()
            .mockResolvedValue({ "session-1": { type: "running" } }),
        },
        message: {
          list: vi
            .fn()
            .mockResolvedValue(history(userMessage("hello", "msg_prompt"))),
        },
      }),
    )
    vi.useFakeTimers()

    const pending = send({
      session_id: "session-1",
      prompt: "hello",
      timeout_seconds: 2,
    })
    await vi.advanceTimersByTimeAsync(2500)
    const result = await pending

    expect(result.content[0].text).toContain("Still running after 2s")
    expect(result.content[0].text).toContain('read with session_id "session-1"')
  })

  it("surfaces a provider error from the run", async () => {
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({ data: [sessionInfo("session-1")] }),
        },
        message: {
          list: vi.fn().mockResolvedValue(
            history(
              userMessage("hello", "msg_prompt"),
              idleMessage("failed", {
                type: "provider.auth",
                message: "Bad credentials",
              }),
            ),
          ),
        },
      }),
    )

    const result = await send({ session_id: "session-1", prompt: "hello" })

    expect(result.content[0].text).toBe("Error: Bad credentials")
  })

  it("errors when the explicit port isn't served", async () => {
    const result = await send({
      session_id: "session-1",
      prompt: "hello",
      port: 9999,
    })
    expect(result.content[0].text).toContain(
      "no opencode server is listening on port 9999",
    )
  })
})

describe("read", () => {
  it("condenses the newest messages into an oldest-first transcript", async () => {
    const client = makeClient({
      session: {
        list: vi.fn().mockResolvedValue({ data: [sessionInfo("session-1")] }),
      },
      message: {
        list: vi.fn().mockResolvedValue(
          history(
            userMessage("hi"),
            assistantMessage({
              text: "Hello",
              tools: [{ name: "read", status: "error" }],
            }),
            idleMessage(),
          ),
        ),
      },
    })
    useClient(client)

    const result = await read({ session_id: "session-1", limit: 5 })

    expect(result.content[0].text).toBe(
      "── user ──\nhi\n\n── assistant ──\n[tool: read (error)]\nHello",
    )
    expect(client.message.list).toHaveBeenCalledWith({
      sessionID: "session-1",
      order: "desc",
      limit: 5,
    })
  })

  it("reports when the session has no messages", async () => {
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({ data: [sessionInfo("session-1")] }),
        },
      }),
    )
    const result = await read({ session_id: "session-1" })
    expect(result.content[0].text).toBe("No messages in this session")
  })

  it("errors when the session id isn't found on any server", async () => {
    const result = await read({ session_id: "nope" })
    expect(result.content[0].text).toContain(
      'session "nope" not found on any opencode server',
    )
  })
})

describe("session routing", () => {
  it("keeps a task's session on its own instance, though every server lists it", async () => {
    seedRegistry([
      {
        runtime: "opencode",
        pid: process.pid,
        port: 51000,
        directory: "/proj",
        startedAt: new Date().toISOString(),
        mcpPid: process.pid,
        sessions: [
          { id: "ses_job", title: "job", model: "m", startedAt: "2026-01-01" },
        ],
        password: FIXTURE_AUTH.instance,
      },
    ])
    const clients = new Map<string, ReturnType<typeof makeClient>>()
    mockMakeClient.mockImplementation(((opts: { baseUrl: string }) => {
      const client = makeClient({
        session: {
          list: vi.fn().mockResolvedValue({ data: [sessionInfo("ses_job")] }),
        },
        message: { list: vi.fn().mockResolvedValue(replyHistory()) },
      })
      clients.set(opts.baseUrl, client)
      return client
    }) as unknown as typeof OpenCode.make)

    await send({ session_id: "ses_job", prompt: "hello" })

    expect(
      clients.get("http://127.0.0.1:51000")?.session.prompt,
    ).toHaveBeenCalled()
    expect(
      clients.get("http://127.0.0.1:4096")?.session.prompt,
    ).not.toHaveBeenCalled()
  })
})
