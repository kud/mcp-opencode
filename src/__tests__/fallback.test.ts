import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
  type MockInstance,
} from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

const stateDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/mcp-opencode-fallback-test-${process.pid}-${Date.now()}`
  process.env.MCP_OPENCODE_STATE_DIR = dir
  process.env.MCP_OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.MCP_OPENCODE_MODEL_BLOCK = ""
  process.env.MCP_OPENCODE_INSTANCE_TTL = "60"
  delete process.env.MCP_OPENCODE_MODEL
  delete process.env.MCP_OPENCODE_MODEL_FALLBACK
  delete process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS
  return dir
})

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawn: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  clearJobWatchdogs,
  getFallbackModels,
  getRetryTimeoutSeconds,
  listInstances,
  readRegistry,
  task,
  wait,
  type InstanceRecord,
} from "../index.js"

const mockExecSync = vi.mocked(execSync)
const mockCreateClient = vi.mocked(createOpencodeClient)
const registryPath = join(stateDir, "instances.json")

const LIVE_PID = 4242
const DEAD_PID = 4343

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    session: {
      create: vi
        .fn()
        .mockResolvedValue({ data: { id: "ses_1", title: "New session" } }),
      promptAsync: vi.fn().mockResolvedValue({ data: undefined }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      diff: vi.fn().mockResolvedValue({ data: [] }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      ...overrides,
    },
  }) as unknown as ReturnType<typeof createOpencodeClient>

const row = (overrides: Partial<InstanceRecord> = {}): InstanceRecord => ({
  runtime: "opencode",
  pid: LIVE_PID,
  port: 51000,
  directory: "/tmp/project",
  startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  mcpPid: 1,
  sessions: [],
  ...overrides,
})

const seedRegistry = (rows: InstanceRecord[]) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(registryPath, JSON.stringify(rows))
}

const providerErrorMessages = (message = "rate limited") => [
  {
    info: {
      role: "assistant",
      error: { name: "APIError", data: { message } },
    },
    parts: [],
  },
]

const idleSuccessMessages = (text = "done") => [
  {
    info: { role: "user", id: "msg_first" },
    parts: [{ type: "text", text: "go" }],
  },
  {
    info: { role: "assistant", time: { completed: 1 } },
    parts: [{ type: "text", text }],
  },
]

let killSpy: MockInstance<typeof process.kill>

beforeEach(() => {
  vi.clearAllMocks()
  clearJobWatchdogs()
  seedRegistry([])
  mockCreateClient.mockReturnValue(makeClient())
  mockExecSync.mockReturnValue(Buffer.from("opencode serve"))
  killSpy = vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    if (signal === 0 && Math.abs(pid) === DEAD_PID) {
      const error = new Error("ESRCH") as NodeJS.ErrnoException
      error.code = "ESRCH"
      throw error
    }
    return true
  }) as typeof process.kill)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused")
    }),
  )
  delete process.env.MCP_OPENCODE_MODEL_FALLBACK
  delete process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS
})

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  killSpy.mockRestore()
  clearJobWatchdogs()
  delete process.env.MCP_OPENCODE_MODEL_FALLBACK
  delete process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS
})

describe("fallback config", () => {
  it("filters the fallback list through the allowlist, preserving order", () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK =
      "github-copilot/gpt-5, anthropic/claude-opus-5-5, github-copilot/gpt-4.1"
    expect(getFallbackModels()).toEqual([
      "github-copilot/gpt-5",
      "github-copilot/gpt-4.1",
    ])
  })

  it("dedupes the fallback list", () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK =
      "github-copilot/gpt-5, github-copilot/gpt-5"
    expect(getFallbackModels()).toEqual(["github-copilot/gpt-5"])
  })

  it("defaults the retry timeout to 90s", () => {
    expect(getRetryTimeoutSeconds()).toBe(90)
    process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS = "10"
    expect(getRetryTimeoutSeconds()).toBe(10)
  })
})

describe("provider error fallback", () => {
  it("aborts and re-prompts the same session on the next model", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    let messageCalls = 0
    const client = makeClient({
      messages: vi.fn().mockImplementation(async () => {
        messageCalls += 1
        return {
          data:
            messageCalls <= 2 ? providerErrorMessages() : idleSuccessMessages(),
        }
      }),
    })
    mockCreateClient.mockReturnValue(client)

    const started = JSON.parse(
      (await task({ port: 51000, prompt: "add a file" })).content[0].text,
    )
    expect(started.session_id).toBe("ses_1")

    // The watchdog interval is frozen by fake timers; wait drives the switch.
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(promptAsync.mock.calls[0][0].model).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-4.1",
    })
    expect(promptAsync.mock.calls[1][0]).toMatchObject({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "github-copilot", modelID: "gpt-5" },
    })
    // Same session, same prompt: history and worktree edits carry over.
    expect(promptAsync.mock.calls[1][0].parts).toEqual([
      { type: "text", text: "add a file" },
    ])
    expect(client.session.abort).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
    })

    expect(result.status).toBe("idle")
    expect(result.model).toBe("github-copilot/gpt-5")
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks[0]).toMatchObject({
      from: "github-copilot/gpt-4.1",
      to: "github-copilot/gpt-5",
    })
    expect(typeof result.fallbacks[0].reason).toBe("string")
    expect(typeof result.fallbacks[0].at).toBe("string")

    const stored = readRegistry()[0].sessions[0]
    expect(stored.model).toBe("github-copilot/gpt-5")
    expect(stored.fallbacks).toHaveLength(1)
  })

  it("treats a model-not-found message as a provider error", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              error: {
                name: "UnknownError",
                data: { message: "Model not found: gpt-4.1" },
              },
            },
            parts: [],
          },
        ],
      }),
    })
    mockCreateClient.mockReturnValue(client)

    await task({ port: 51000, prompt: "hi" })
    await wait({ port: 51000, session_id: "ses_1" })

    expect(
      client.session.promptAsync as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(2)
  })

  it("skips disallowed fallbacks when switching", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK =
      "anthropic/claude-opus-5-5, github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      messages: vi.fn().mockImplementation(async () => ({
        data: providerErrorMessages(),
      })),
    })
    mockCreateClient.mockReturnValue(client)

    await task({ port: 51000, prompt: "hi" })
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(promptAsync.mock.calls[1][0].model).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-5",
    })
    expect(result.fallbacks[0]).toMatchObject({
      from: "github-copilot/gpt-4.1",
      to: "github-copilot/gpt-5",
    })
  })
})

describe("retry timeout fallback", () => {
  it("switches after the session stays in retry past the timeout, without wait", async () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS = "10"
    seedRegistry([row()])
    const client = makeClient({
      status: vi.fn().mockResolvedValue({
        data: {
          ses_1: {
            type: "retry",
            attempt: 3,
            message: "rate limited",
            next: 5,
          },
        },
      }),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { role: "user", id: "msg_first" },
            parts: [{ type: "text", text: "go" }],
          },
        ],
      }),
    })
    mockCreateClient.mockReturnValue(client)
    vi.useFakeTimers()

    await task({ port: 51000, prompt: "go" })
    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(promptAsync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(promptAsync.mock.calls[1][0].model).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-5",
    })
    expect(client.session.abort).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
    })

    const stored = readRegistry()[0].sessions[0]
    expect(stored.model).toBe("github-copilot/gpt-5")
    expect(stored.fallbacks).toHaveLength(1)
    expect(stored.fallbacks?.[0].reason).toContain("retry timeout")
  })

  it("wait reports retry as its own status", async () => {
    seedRegistry([row()])
    mockCreateClient.mockReturnValue(
      makeClient({
        status: vi.fn().mockResolvedValue({
          data: {
            ses_1: { type: "retry", attempt: 1, message: "busy", next: 5 },
          },
        }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "user", id: "msg_1" },
              parts: [{ type: "text", text: "go" }],
            },
          ],
        }),
      }),
    )
    vi.useFakeTimers()

    const pending = wait({
      port: 51000,
      session_id: "ses_1",
      timeout_seconds: 5,
    })
    await vi.advanceTimersByTimeAsync(6000)
    const result = JSON.parse((await pending).content[0].text)

    expect(result.status).toBe("retry")
  })
})

describe("exhausted fallbacks", () => {
  it("settles as error when every model has failed", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      messages: vi.fn().mockResolvedValue({
        data: providerErrorMessages("down"),
      }),
    })
    mockCreateClient.mockReturnValue(client)

    await task({ port: 51000, prompt: "hi" })

    const first = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )
    expect(first.status).toBe("error")
    expect(first.model).toBe("github-copilot/gpt-5")
    expect(first.fallbacks).toHaveLength(1)

    const second = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )
    expect(second.status).toBe("error")
    expect(second.model).toBe("github-copilot/gpt-5")
    expect(second.fallbacks).toHaveLength(1)

    // Each model tried once: the original plus the single fallback.
    expect(
      (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2)
  })
})

describe("fallback reporting", () => {
  it("returns model and fallbacks from wait and list_instances", async () => {
    seedRegistry([
      row({
        sessions: [
          {
            id: "ses_1",
            title: "job",
            model: "github-copilot/gpt-5",
            startedAt: "2026-01-01",
            fallbacks: [
              {
                from: "github-copilot/gpt-4.1",
                to: "github-copilot/gpt-5",
                reason: "provider error (APIError: down)",
                at: "2026-01-01T00:00:01.000Z",
              },
            ],
          },
        ],
      }),
    ])
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [{ id: "ses_1", title: "job", time: { updated: Date.now() } }],
      }),
      status: vi.fn().mockResolvedValue({ data: { ses_1: { type: "idle" } } }),
      messages: vi.fn().mockResolvedValue({ data: idleSuccessMessages("hi") }),
    })
    mockCreateClient.mockReturnValue(client)

    const waited = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )
    expect(waited.model).toBe("github-copilot/gpt-5")
    expect(waited.fallbacks).toEqual([
      expect.objectContaining({
        from: "github-copilot/gpt-4.1",
        to: "github-copilot/gpt-5",
      }),
    ])

    const [instance] = JSON.parse((await listInstances()).content[0].text)
    expect(instance.sessions).toEqual([
      expect.objectContaining({
        id: "ses_1",
        model: "github-copilot/gpt-5",
        status: "idle",
        fallbacks: [
          expect.objectContaining({
            from: "github-copilot/gpt-4.1",
            to: "github-copilot/gpt-5",
          }),
        ],
      }),
    ])
  })

  it("takes the diff from the first prompt, not the fallback re-prompt", async () => {
    seedRegistry([row()])
    const messages = vi.fn().mockResolvedValue({
      data: [
        {
          info: { role: "user", id: "msg_first" },
          parts: [{ type: "text", text: "go" }],
        },
        {
          info: { role: "user", id: "msg_second" },
          parts: [{ type: "text", text: "go" }],
        },
        {
          info: { role: "assistant", time: { completed: 1 } },
          parts: [{ type: "text", text: "done" }],
        },
      ],
    })
    const diff = vi.fn().mockResolvedValue({ data: [] })
    mockCreateClient.mockReturnValue(makeClient({ messages, diff }))

    await wait({ port: 51000, session_id: "ses_1" })

    expect(diff).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
      messageID: "msg_first",
    })
  })

  it("leaves a passing job on its model with no fallbacks", async () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      messages: vi.fn().mockResolvedValue({ data: idleSuccessMessages() }),
    })
    mockCreateClient.mockReturnValue(client)

    await task({ port: 51000, prompt: "go" })
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(result.status).toBe("idle")
    expect(result.model).toBe("github-copilot/gpt-4.1")
    expect(result.fallbacks).toEqual([])
    expect(
      client.session.promptAsync as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1)
    expect(client.session.abort).not.toHaveBeenCalled()
  })
})

describe("stopInstance", () => {
  it("clears the watchdog so a stopped job never switches", async () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS = "10"
    const directory = mkdtempSync(join(stateDir, "proj-"))
    seedRegistry([row({ directory })])
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [{ id: "ses_1", title: "t", time: { updated: 0 } }],
      }),
      status: vi.fn().mockResolvedValue({
        data: {
          ses_1: { type: "retry", attempt: 1, message: "stuck", next: 5 },
        },
      }),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { role: "user", id: "msg_1" },
            parts: [{ type: "text", text: "go" }],
          },
        ],
      }),
    })
    mockCreateClient.mockReturnValue(client)
    vi.useFakeTimers()

    await task({ port: 51000, prompt: "go" })
    // Stop before the retry timeout elapses; the timer must be gone.
    const { stopInstance } = await import("../index.js")
    await stopInstance({ port: 51000 })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(
      (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1)
  })
})
