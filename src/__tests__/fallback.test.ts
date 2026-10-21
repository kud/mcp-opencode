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
  delete process.env.MCP_OPENCODE_SANDBOX
  delete process.env.MCP_OPENCODE_SANDBOX_SETTINGS
  return dir
})

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawn: vi.fn(),
}))

vi.mock("@opencode/client", () => ({
  OpenCode: { make: vi.fn() },
}))

vi.mock("@opencode/client/service", () => ({
  Service: { discover: vi.fn(), ensure: vi.fn() },
}))

import { execSync } from "child_process"
import { OpenCode } from "@opencode/client"
import {
  clearJobWatchdogs,
  getFallbackModels,
  getRetryTimeoutSeconds,
  isProviderError,
  listInstances,
  readRegistry,
  task,
  wait,
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

const mockExecSync = vi.mocked(execSync)
const mockMakeClient = vi.mocked(OpenCode.make)
const registryPath = join(stateDir, "instances.json")

const LIVE_PID = 4242
const DEAD_PID = 4343

const row = (overrides: Partial<InstanceRecord> = {}): InstanceRecord => ({
  runtime: "opencode",
  pid: LIVE_PID,
  port: 51000,
  directory: "/tmp/project",
  startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  mcpPid: 1,
  sessions: [],
  password: FIXTURE_AUTH.instance,
  ...overrides,
})

const seedRegistry = (rows: InstanceRecord[]) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(registryPath, JSON.stringify(rows))
}

const useClient = (client: ReturnType<typeof makeClient>) =>
  mockMakeClient.mockReturnValue(client as never)

const providerErrorHistory = (message = "Model unavailable") =>
  history(
    userMessage("go"),
    idleMessage("failed", { type: "provider.no-route", message }),
  )

const successHistory = (text = "done") =>
  history(
    userMessage("go"),
    assistantMessage({ text }),
    idleMessage("succeeded"),
  )

const retryHistory = (message = "rate limited") =>
  history(
    userMessage("go"),
    assistantMessage({ completed: false, retry: { attempt: 3, message } }),
  )

const running = () => vi.fn().mockResolvedValue({ ses_1: { type: "running" } })

let killSpy: MockInstance<typeof process.kill>

beforeEach(() => {
  vi.clearAllMocks()
  clearJobWatchdogs()
  seedRegistry([])
  useClient(makeClient())
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

describe("isProviderError", () => {
  it("recognises v2 provider.* errors and model-not-found messages", () => {
    expect(isProviderError({ type: "provider.no-route", message: "x" })).toBe(
      true,
    )
    expect(
      isProviderError({ type: "unknown", message: "Model not found: gpt" }),
    ).toBe(true)
    expect(isProviderError({ type: "tool.failed", message: "boom" })).toBe(
      false,
    )
    expect(isProviderError(undefined)).toBe(false)
  })
})

describe("provider error fallback", () => {
  it("interrupts, switches the model and re-prompts the same session", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    let messageCalls = 0
    const client = makeClient({
      message: {
        list: vi.fn().mockImplementation(async () => {
          messageCalls += 1
          return messageCalls <= 2 ? providerErrorHistory() : successHistory()
        }),
      },
    })
    useClient(client)

    const started = JSON.parse(
      (await task({ port: 51000, prompt: "add a file" })).content[0].text,
    )
    expect(started.session_id).toBe("ses_1")

    // The watchdog interval is frozen by fake timers; wait drives the switch.
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(client.session.create.mock.calls[0][0].model).toEqual({
      providerID: "github-copilot",
      id: "gpt-4.1",
    })
    expect(client.session.interrupt).toHaveBeenCalledWith({
      sessionID: "ses_1",
    })
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { providerID: "github-copilot", id: "gpt-5" },
    })
    // Same session, same prompt: history and worktree edits carry over.
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(client.session.prompt.mock.calls[1][0]).toEqual({
      sessionID: "ses_1",
      text: "add a file",
    })

    expect(result.status).toBe("idle")
    expect(result.model).toBe("github-copilot/gpt-5")
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks[0]).toMatchObject({
      from: "github-copilot/gpt-4.1",
      to: "github-copilot/gpt-5",
    })
    expect(result.fallbacks[0].reason).toContain("provider.no-route")
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
      message: {
        list: vi.fn().mockResolvedValue(
          history(
            userMessage("go"),
            idleMessage("failed", {
              type: "unknown",
              message: "Model not found: gpt-4.1",
            }),
          ),
        ),
      },
    })
    useClient(client)

    await task({ port: 51000, prompt: "hi" })
    await wait({ port: 51000, session_id: "ses_1" })

    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("does not fall back on a failure that is not the provider's", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      message: {
        list: vi
          .fn()
          .mockResolvedValue(
            history(
              userMessage("go"),
              idleMessage("failed", { type: "tool.failed", message: "boom" }),
            ),
          ),
      },
    })
    useClient(client)

    await task({ port: 51000, prompt: "hi" })
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(result.status).toBe("error")
    expect(result.fallbacks).toEqual([])
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
  })

  it("skips disallowed fallbacks when switching", async () => {
    vi.useFakeTimers()
    process.env.MCP_OPENCODE_MODEL_FALLBACK =
      "anthropic/claude-opus-5-5, github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      message: {
        list: vi.fn().mockImplementation(async () => providerErrorHistory()),
      },
    })
    useClient(client)

    await task({ port: 51000, prompt: "hi" })
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(client.session.switchModel.mock.calls[0][0].model).toEqual({
      providerID: "github-copilot",
      id: "gpt-5",
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
      session: { active: running() },
      message: { list: vi.fn().mockResolvedValue(retryHistory()) },
    })
    useClient(client)
    vi.useFakeTimers()

    await task({ port: 51000, prompt: "go" })
    expect(client.session.prompt).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(client.session.switchModel.mock.calls[0][0].model).toEqual({
      providerID: "github-copilot",
      id: "gpt-5",
    })
    expect(client.session.interrupt).toHaveBeenCalledWith({
      sessionID: "ses_1",
    })

    const stored = readRegistry()[0].sessions[0]
    expect(stored.model).toBe("github-copilot/gpt-5")
    expect(stored.fallbacks).toHaveLength(1)
    expect(stored.fallbacks?.[0].reason).toContain("retry timeout")
    expect(stored.fallbacks?.[0].reason).toContain("attempt 3: rate limited")
  })

  it("wait reports retry as its own status", async () => {
    seedRegistry([row()])
    useClient(
      makeClient({
        session: { active: running() },
        message: { list: vi.fn().mockResolvedValue(retryHistory("busy")) },
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
      message: {
        list: vi.fn().mockResolvedValue(providerErrorHistory("down")),
      },
    })
    useClient(client)

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
    expect(client.session.prompt.mock.calls).toHaveLength(2)
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
                reason: "provider error (provider.no-route: down)",
                at: "2026-01-01T00:00:01.000Z",
              },
            ],
          },
        ],
      }),
    ])
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: "ses_1", title: "job", time: { updated: Date.now() } },
            ],
          }),
        },
        message: { list: vi.fn().mockResolvedValue(successHistory("hi")) },
      }),
    )

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

  it("diffs the whole session, so a fallback re-prompt does not re-base it", async () => {
    seedRegistry([row()])
    const client = makeClient({
      message: {
        list: vi.fn().mockResolvedValue(
          history(
            userMessage("go", "msg_first"),
            idleMessage("failed", {
              type: "provider.no-route",
              message: "x",
            }),
            userMessage("go", "msg_second"),
            assistantMessage({ text: "done" }),
            idleMessage("succeeded"),
          ),
        ),
      },
    })
    useClient(client)

    await wait({ port: 51000, session_id: "ses_1" })

    expect(client.session.diff).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  it("leaves a passing job on its model with no fallbacks", async () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    seedRegistry([row()])
    const client = makeClient({
      message: { list: vi.fn().mockResolvedValue(successHistory()) },
    })
    useClient(client)

    await task({ port: 51000, prompt: "go" })
    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(result.status).toBe("idle")
    expect(result.model).toBe("github-copilot/gpt-4.1")
    expect(result.fallbacks).toEqual([])
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(client.session.interrupt).not.toHaveBeenCalled()
  })
})

describe("stopInstance", () => {
  it("clears the watchdog so a stopped job never switches", async () => {
    process.env.MCP_OPENCODE_MODEL_FALLBACK = "github-copilot/gpt-5"
    process.env.MCP_OPENCODE_RETRY_TIMEOUT_SECONDS = "10"
    const directory = mkdtempSync(join(stateDir, "proj-"))
    seedRegistry([row({ directory })])
    const client = makeClient({
      session: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: "ses_1", title: "t", time: { updated: 0 } }],
        }),
        active: running(),
      },
      message: { list: vi.fn().mockResolvedValue(retryHistory("stuck")) },
    })
    useClient(client)
    vi.useFakeTimers()

    await task({ port: 51000, prompt: "go" })
    // Stop before the retry timeout elapses; the timer must be gone.
    const { stopInstance } = await import("../index.js")
    await stopInstance({ port: 51000 })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(client.session.prompt.mock.calls).toHaveLength(1)
  })
})
