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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "fs"
import { join } from "path"

const stateDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/mcp-opencode-test-${process.pid}-${Date.now()}`
  process.env.MCP_OPENCODE_STATE_DIR = dir
  process.env.MCP_OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.MCP_OPENCODE_MODEL_BLOCK = ""
  process.env.MCP_OPENCODE_INSTANCE_TTL = "60"
  delete process.env.MCP_OPENCODE_MODEL
  return dir
})

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawn: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync, spawn } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  HEADLESS_PERMISSION_RULESET,
  hardenedInstance,
  listInstances,
  parseListeningPort,
  reapInstances,
  readRegistry,
  startInstance,
  stopInstance,
  task,
  wait,
  type InstanceRecord,
} from "../index.js"

const mockExecSync = vi.mocked(execSync)
const mockSpawn = vi.mocked(spawn)
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

// opencode resolves a permission with `rules.findLast(match) ?? ask`.
const wildcard = (pattern: string) =>
  new RegExp(
    "^" +
      pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  )
const evaluate = (permission: string, input: string) =>
  HEADLESS_PERMISSION_RULESET.findLast(
    (r) =>
      wildcard(r.permission).test(permission) &&
      wildcard(r.pattern).test(input),
  )?.action ?? "ask"

let killSpy: MockInstance<typeof process.kill>

beforeEach(() => {
  vi.clearAllMocks()
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
})

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  killSpy.mockRestore()
})

const spawnThatPrints = (output: string) =>
  mockSpawn.mockImplementation(((
    _cmd: string,
    _args: string[],
    options: { stdio: [unknown, number, number] },
  ) => {
    if (output) writeSync(options.stdio[1], output)
    return { pid: LIVE_PID, unref: vi.fn() }
  }) as unknown as typeof spawn)

describe("parseListeningPort", () => {
  it("reads the port from opencode's listening line", () => {
    expect(
      parseListeningPort(
        "Warning: OPENCODE_SERVER_PASSWORD is not set\nopencode server listening on http://127.0.0.1:53817\n",
      ),
    ).toBe(53817)
  })

  it("returns undefined until the line appears", () => {
    expect(parseListeningPort("booting...\n")).toBeUndefined()
  })
})

describe("startInstance", () => {
  it("spawns a detached hardened server on port 0 and registers it", async () => {
    spawnThatPrints("opencode server listening on http://127.0.0.1:53817\n")
    const directory = mkdtempSync(join(stateDir, "proj-"))

    const result = await startInstance({ directory })

    expect(JSON.parse(result.content[0].text)).toEqual({
      port: 53817,
      url: "http://127.0.0.1:53817",
    })
    const [cmd, args, options] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean; env: NodeJS.ProcessEnv },
    ]
    expect(cmd).toBe("opencode")
    expect(args).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"])
    expect(options.cwd).toBe(directory)
    expect(options.detached).toBe(true)
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(options.env.GIT_SSH_COMMAND).toBe("false")
    expect(readRegistry()).toEqual([
      expect.objectContaining({
        runtime: "opencode",
        pid: LIVE_PID,
        port: 53817,
        directory,
        mcpPid: process.pid,
        sessions: [],
      }),
    ])
  })

  it("times out and kills the server when no listening line appears", async () => {
    spawnThatPrints("")
    const directory = mkdtempSync(join(stateDir, "proj-"))
    vi.useFakeTimers()

    const pending = startInstance({ directory })
    await vi.advanceTimersByTimeAsync(10_500)
    const result = await pending

    expect(result.content[0].text).toContain(
      "did not report a listening port within 10s",
    )
    expect(killSpy).toHaveBeenCalledWith(-LIVE_PID, "SIGTERM")
    expect(readRegistry()).toEqual([])
  })

  it("rejects a directory that does not exist", async () => {
    const result = await startInstance({ directory: "/no/such/dir" })
    expect(result.content[0].text).toContain("is not a directory")
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe("hardenedInstance", () => {
  it("strips GitHub tokens, disables git credentials and pins the model", () => {
    const env = hardenedInstance({
      PATH: "/usr/bin",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "y",
    })

    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    })
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)
    expect(config.model).toBe("github-copilot/gpt-4.1")
    expect(config.small_model).toBe("github-copilot/gpt-4.1")
    expect(config.permission.bash).toEqual({
      "*": "allow",
      "git push*": "deny",
      "git remote*": "deny",
      "gh *": "deny",
      "npm publish*": "deny",
      "git reset --hard*": "deny",
    })
    expect(config.permission.webfetch).toBe("deny")
  })
})

describe("HEADLESS_PERMISSION_RULESET", () => {
  it("never asks", () => {
    expect(HEADLESS_PERMISSION_RULESET.map((r) => r.action)).not.toContain(
      "ask",
    )
  })

  it("lets the later bash denies win over the bash allow", () => {
    expect(evaluate("bash", "ls -la")).toBe("allow")
    expect(evaluate("bash", "git commit -m wip")).toBe("allow")
    expect(evaluate("bash", "git push origin main")).toBe("deny")
    expect(evaluate("bash", "git remote add x y")).toBe("deny")
    expect(evaluate("bash", "gh pr create")).toBe("deny")
    expect(evaluate("bash", "npm publish --access public")).toBe("deny")
    expect(evaluate("bash", "git reset --hard HEAD~1")).toBe("deny")
  })

  it("allows the editing tools and denies the escape hatches", () => {
    for (const p of [
      "read",
      "edit",
      "glob",
      "grep",
      "list",
      "todowrite",
      "task",
    ])
      expect(evaluate(p, "anything")).toBe("allow")
    for (const p of ["external_directory", "question", "doom_loop", "webfetch"])
      expect(evaluate(p, "anything")).toBe("deny")
  })
})

describe("task", () => {
  it("creates a guarded session, prompts it async and records it", async () => {
    seedRegistry([row()])
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    const result = await task({ port: 51000, prompt: "add a file" })

    expect(JSON.parse(result.content[0].text)).toEqual({
      session_id: "ses_1",
      port: 51000,
      attach: "opencode attach http://127.0.0.1:51000 --session ses_1",
    })
    expect(client.session.create).toHaveBeenCalledWith({
      directory: "/tmp/project",
      permission: HEADLESS_PERMISSION_RULESET,
    })
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
      agent: "build",
      model: { providerID: "github-copilot", modelID: "gpt-4.1" },
      parts: [{ type: "text", text: "add a file" }],
    })
    expect(client.session.delete).toBeUndefined()
    expect(readRegistry()[0].sessions).toEqual([
      expect.objectContaining({
        id: "ses_1",
        title: "New session",
        model: "github-copilot/gpt-4.1",
      }),
    ])
  })

  it("rejects a model outside the allowlist before creating a session", async () => {
    seedRegistry([row()])
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    const result = await task({
      port: 51000,
      prompt: "hi",
      model: "anthropic/claude-opus-5-5",
    })

    expect(result.content[0].text).toContain("is not allowed")
    expect(client.session.create).not.toHaveBeenCalled()
  })

  it("rejects a port that is not a registered instance", async () => {
    const result = await task({ port: 4096, prompt: "hi" })
    expect(result.content[0].text).toContain(
      "port 4096 is not a registered instance",
    )
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe("wait", () => {
  it("returns busy with a note when the timeout elapses", async () => {
    seedRegistry([row()])
    const client = makeClient({
      status: vi.fn().mockResolvedValue({ data: { ses_1: { type: "busy" } } }),
    })
    mockCreateClient.mockReturnValue(client)
    vi.useFakeTimers()

    const pending = wait({
      port: 51000,
      session_id: "ses_1",
      timeout_seconds: 5,
    })
    await vi.advanceTimersByTimeAsync(6000)
    const result = JSON.parse((await pending).content[0].text)

    expect(result.status).toBe("busy")
    expect(result.note).toContain("Still running")
    expect(client.session.status).toHaveBeenCalledTimes(4)
  })

  it("returns idle with the last assistant text and diff stats", async () => {
    seedRegistry([row()])
    const client = makeClient({
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { role: "user", id: "msg_prompt" },
            parts: [{ type: "text", text: "go" }],
          },
          {
            info: { role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Created hello.txt" }],
          },
        ],
      }),
      diff: vi.fn().mockResolvedValue({
        data: [
          {
            file: "hello.txt",
            patch: "…",
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ],
      }),
    })
    mockCreateClient.mockReturnValue(client)

    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(result).toMatchObject({
      status: "idle",
      last_assistant_text: "Created hello.txt",
      files: [
        { file: "hello.txt", status: "added", additions: 1, deletions: 0 },
      ],
    })
    expect(client.session.diff).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
      messageID: "msg_prompt",
    })
  })

  it("reports error when the last assistant message failed", async () => {
    seedRegistry([row()])
    mockCreateClient.mockReturnValue(
      makeClient({
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: {
                role: "assistant",
                error: { name: "APIError", data: { message: "rate limited" } },
              },
              parts: [],
            },
          ],
        }),
      }),
    )

    const result = JSON.parse(
      (await wait({ port: 51000, session_id: "ses_1" })).content[0].text,
    )

    expect(result.status).toBe("error")
    expect(result.last_assistant_text).toBe("Error: rate limited")
  })
})

describe("reapInstances", () => {
  it("drops dead pids, kills idle-past-TTL, spares busy, ignores unregistered", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    seedRegistry([
      row({ port: 51001, pid: DEAD_PID }),
      row({ port: 51002, pid: 5002, startedAt: old }),
      row({ port: 51003, pid: 5003, startedAt: old }),
    ])
    mockCreateClient.mockImplementation(((opts: { baseUrl: string }) =>
      opts.baseUrl.endsWith(":51003")
        ? makeClient({
            status: vi
              .fn()
              .mockResolvedValue({ data: { ses_busy: { type: "busy" } } }),
            list: vi.fn().mockResolvedValue({
              data: [{ id: "ses_busy", title: "t", time: { updated: 0 } }],
            }),
          })
        : makeClient()) as unknown as typeof createOpencodeClient)

    const reaped = await reapInstances()

    expect(reaped.sort()).toEqual([51001, 51002])
    expect(readRegistry().map((r) => r.port)).toEqual([51003])
    expect(killSpy).toHaveBeenCalledWith(-5002, "SIGTERM")
    const signalled = killSpy.mock.calls
      .filter(([, signal]) => signal === "SIGTERM")
      .map(([pid]) => Math.abs(pid as number))
    expect(signalled).toEqual([5002])
  })

  it("keeps an idle instance whose last activity is within the TTL", async () => {
    seedRegistry([row({ port: 51004, pid: 5004 })])
    mockCreateClient.mockReturnValue(
      makeClient({
        list: vi.fn().mockResolvedValue({
          data: [{ id: "s", title: "t", time: { updated: Date.now() } }],
        }),
      }),
    )
    const reaped = await reapInstances(Date.now() + 30_000)
    expect(reaped).toEqual([])
  })
})

describe("stopInstance", () => {
  it("refuses an unknown port", async () => {
    const result = await stopInstance({ port: 4096 })
    expect(result.content[0].text).toContain(
      "port 4096 is not a registered instance",
    )
    expect(killSpy).not.toHaveBeenCalledWith(expect.anything(), "SIGTERM")
  })

  it("aborts busy sessions, terminates and deregisters", async () => {
    seedRegistry([row()])
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [{ id: "ses_1", title: "t", time: { updated: 0 } }],
      }),
      status: vi.fn().mockResolvedValue({ data: { ses_1: { type: "busy" } } }),
    })
    mockCreateClient.mockReturnValue(client)

    const result = JSON.parse(
      (await stopInstance({ port: 51000 })).content[0].text,
    )

    expect(result).toEqual({
      port: 51000,
      stopped: true,
      aborted_sessions: ["ses_1"],
    })
    expect(client.session.abort).toHaveBeenCalledWith({
      sessionID: "ses_1",
      directory: "/tmp/project",
    })
    expect(killSpy).toHaveBeenCalledWith(-LIVE_PID, "SIGTERM")
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([])
  })
})

describe("listInstances", () => {
  it("shows the registered task sessions with their live status", async () => {
    seedRegistry([
      row({
        sessions: [
          { id: "ses_1", title: "job", model: "m", startedAt: "2026-01-01" },
        ],
      }),
    ])
    mockCreateClient.mockReturnValue(
      makeClient({
        list: vi.fn().mockResolvedValue({
          data: [
            { id: "ses_1", title: "job", time: { updated: Date.now() } },
            { id: "ses_other", title: "tui", time: { updated: Date.now() } },
          ],
        }),
        status: vi
          .fn()
          .mockResolvedValue({ data: { ses_1: { type: "busy" } } }),
      }),
    )

    const [instance] = JSON.parse((await listInstances()).content[0].text)

    expect(instance.sessions).toEqual([
      expect.objectContaining({ id: "ses_1", status: "busy" }),
    ])
  })
})
