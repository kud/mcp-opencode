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
  statSync,
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

import { execSync, spawn } from "child_process"
import { OpenCode } from "@opencode/client"
import {
  HEADLESS_PERMISSION_RULESET,
  attachCommand,
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
import {
  assistantMessage,
  FIXTURE_AUTH,
  history,
  idleMessage,
  makeClient,
  userMessage,
} from "./fake-client.js"

const mockExecSync = vi.mocked(execSync)
const mockSpawn = vi.mocked(spawn)
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

// opencode v2 resolves a permission with the last matching rule, after an
// agent base policy that allows everything.
const wildcard = (pattern: string) =>
  new RegExp(
    "^" +
      pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  )
const evaluate = (action: string, input: string) =>
  [
    { action: "*", resource: "*", effect: "allow" },
    ...HEADLESS_PERMISSION_RULESET,
  ].findLast(
    (r) => wildcard(r.action).test(action) && wildcard(r.resource).test(input),
  )?.effect ?? "ask"

let killSpy: MockInstance<typeof process.kill>

beforeEach(() => {
  vi.clearAllMocks()
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
      parseListeningPort("server listening on http://127.0.0.1:53817\n"),
    ).toBe(53817)
  })

  it("returns undefined until the line appears", () => {
    expect(parseListeningPort("booting...\n")).toBeUndefined()
  })
})

describe("startInstance", () => {
  it("spawns a detached hardened server on port 0 and registers it", async () => {
    spawnThatPrints("server listening on http://127.0.0.1:53817\n")
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
    const [registered] = readRegistry()
    expect(registered).toEqual(
      expect.objectContaining({
        runtime: "opencode",
        pid: LIVE_PID,
        port: 53817,
        directory,
        mcpPid: process.pid,
        sessions: [],
      }),
    )
    expect(registered.password).toBe(options.env.OPENCODE_PASSWORD)
    expect(registered.password?.length).toBeGreaterThanOrEqual(32)
    expect(statSync(registryPath).mode & 0o777).toBe(0o600)
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
  it("strips GitHub tokens and inherited passwords, disables git credentials", () => {
    const env = hardenedInstance(
      {
        PATH: "/usr/bin",
        GH_TOKEN: "x",
        GITHUB_TOKEN: "y",
        OPENCODE_PASSWORD: FIXTURE_AUTH.inherited,
        OPENCODE_SERVER_PASSWORD: FIXTURE_AUTH.inherited,
      },
      { password: FIXTURE_AUTH.fresh },
    )

    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.OPENCODE_PASSWORD).toBe(FIXTURE_AUTH.fresh)
    expect(env.PATH).toBe("/usr/bin")
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    })
  })

  it("injects a native v2 config: model, title agent, permissions, policies", () => {
    const config = JSON.parse(
      hardenedInstance({ PATH: "/usr/bin" }).OPENCODE_CONFIG_CONTENT as string,
    )

    expect(config.model).toBe("github-copilot/gpt-4.1")
    expect(config.agents).toEqual({
      title: { model: "github-copilot/gpt-4.1" },
    })
    expect(config.small_model).toBeUndefined()
    expect(config.permission).toBeUndefined()
    expect(config.permissions).toEqual(HEADLESS_PERMISSION_RULESET)
    expect(config.policies).toContainEqual({
      action: "tool.use",
      resource: "shell:*git* push*",
      effect: "deny",
    })
    expect(config.policies).toContainEqual({
      action: "tool.use",
      resource: "webfetch:*",
      effect: "deny",
    })
    expect(
      config.policies.every(
        (p: { action: string; effect: string }) =>
          p.action === "tool.use" && p.effect === "deny",
      ),
    ).toBe(true)
  })
})

describe("HEADLESS_PERMISSION_RULESET", () => {
  it("never asks", () => {
    expect(HEADLESS_PERMISSION_RULESET.map((r) => r.effect)).not.toContain(
      "ask",
    )
  })

  it("uses v2 action names only", () => {
    const actions = HEADLESS_PERMISSION_RULESET.map((r) => r.action)
    for (const v1 of ["bash", "task", "list", "todowrite", "doom_loop"])
      expect(actions).not.toContain(v1)
  })

  it("lets the later shell denies win over the shell allow", () => {
    expect(evaluate("shell", "ls -la")).toBe("allow")
    expect(evaluate("shell", "git commit -m wip")).toBe("allow")
    expect(evaluate("shell", "git push origin main")).toBe("deny")
    expect(evaluate("shell", "git remote add x y")).toBe("deny")
    expect(evaluate("shell", "gh pr create")).toBe("deny")
    expect(evaluate("shell", "npm publish --access public")).toBe("deny")
    expect(evaluate("shell", "git reset --hard HEAD~1")).toBe("deny")
  })

  it("catches the push and publish forms that dodge a leading glob", () => {
    for (const command of [
      "git -C /tmp/project push origin main",
      "git --git-dir=/tmp/project/.git push",
      "env GIT_TRACE=1 git push",
      "cd /tmp/project && git push --force",
      "/usr/bin/git push",
      "git -c user.name=x push origin HEAD",
      "git -C /tmp/project remote add origin x",
      "git -C /tmp/project reset --hard HEAD~1",
      "git reset -q --hard",
      "cd /tmp/project && gh pr create",
      "npm --prefix /tmp/project publish",
    ])
      expect(evaluate("shell", command)).toBe("deny")
  })

  it("still allows ordinary git and npm work", () => {
    for (const command of [
      "git status",
      "git -C /tmp/project log --oneline",
      "git add -A",
      "git reset --soft HEAD~1",
      "npm test",
      "npm run build",
    ])
      expect(evaluate("shell", command)).toBe("allow")
  })

  it("allows the editing tools and denies the escape hatches", () => {
    for (const action of ["read", "edit", "glob", "grep", "subagent"])
      expect(evaluate(action, "anything")).toBe("allow")
    for (const action of [
      "external_directory",
      "question",
      "webfetch",
      "websearch",
    ])
      expect(evaluate(action, "anything")).toBe("deny")
  })
})

describe("task", () => {
  it("creates a guarded session in the directory, prompts it and records it", async () => {
    seedRegistry([row()])
    const client = makeClient()
    useClient(client)

    const result = await task({ port: 51000, prompt: "add a file" })

    expect(JSON.parse(result.content[0].text)).toEqual({
      session_id: "ses_1",
      port: 51000,
      attach: `OPENCODE_PASSWORD=${FIXTURE_AUTH.instance} opencode --server http://127.0.0.1:51000 --session ses_1`,
    })
    expect(mockMakeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:51000",
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${FIXTURE_AUTH.instance}`).toString("base64")}`,
      },
    })
    expect(client.session.create).toHaveBeenCalledWith({
      location: { directory: "/tmp/project" },
      agent: "build",
      model: { providerID: "github-copilot", id: "gpt-4.1" },
      permissions: HEADLESS_PERMISSION_RULESET,
    })
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "ses_1",
      text: "add a file",
    })
    expect(client.session.remove).not.toHaveBeenCalled()
    expect(readRegistry()[0].sessions).toEqual([
      expect.objectContaining({
        id: "ses_1",
        title: "New session",
        model: "github-copilot/gpt-4.1",
      }),
    ])
  })

  it("reports a prompt the server refused", async () => {
    seedRegistry([row()])
    useClient(
      makeClient({
        session: { prompt: vi.fn().mockRejectedValue(new Error("409")) },
      }),
    )

    const result = await task({ port: 51000, prompt: "hi" })

    expect(result.content[0].text).toBe("Error: prompt was not accepted: 409")
  })

  it("rejects a model outside the allowlist before creating a session", async () => {
    seedRegistry([row()])
    const client = makeClient()
    useClient(client)

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
    expect(mockMakeClient).not.toHaveBeenCalled()
  })
})

describe("attachCommand", () => {
  it("joins the instance with --server and its password", () => {
    expect(attachCommand(row({ password: FIXTURE_AUTH.fresh }), "ses_9")).toBe(
      `OPENCODE_PASSWORD=${FIXTURE_AUTH.fresh} opencode --server http://127.0.0.1:51000 --session ses_9`,
    )
  })
})

describe("wait", () => {
  it("returns busy with a note when the timeout elapses", async () => {
    seedRegistry([row()])
    const client = makeClient({
      session: {
        active: vi.fn().mockResolvedValue({ ses_1: { type: "running" } }),
      },
      message: {
        list: vi.fn().mockResolvedValue(history(userMessage("go"))),
      },
    })
    useClient(client)
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
    expect(result.note).toContain("opencode --server http://127.0.0.1:51000")
    expect(client.session.active).toHaveBeenCalledTimes(4)
  })

  it("returns idle with the last assistant text and diff stats", async () => {
    seedRegistry([row()])
    const client = makeClient({
      message: {
        list: vi
          .fn()
          .mockResolvedValue(
            history(
              userMessage("go"),
              assistantMessage({ text: "Created hello.txt" }),
              idleMessage("succeeded"),
            ),
          ),
      },
      session: {
        diff: vi.fn().mockResolvedValue([
          {
            file: "hello.txt",
            patch: "…",
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ]),
      },
    })
    useClient(client)

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
    expect(client.session.diff).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  it("reports error when the run ended failed", async () => {
    seedRegistry([row()])
    useClient(
      makeClient({
        message: {
          list: vi.fn().mockResolvedValue(
            history(
              userMessage("go"),
              idleMessage("failed", {
                type: "session.error",
                message: "rate limited",
              }),
            ),
          ),
        },
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
    mockMakeClient.mockImplementation(((opts: { baseUrl: string }) =>
      opts.baseUrl.endsWith(":51003")
        ? makeClient({
            session: {
              active: vi
                .fn()
                .mockResolvedValue({ ses_busy: { type: "running" } }),
              list: vi.fn().mockResolvedValue({
                data: [{ id: "ses_busy", title: "t", time: { updated: 0 } }],
              }),
            },
          })
        : makeClient()) as unknown as typeof OpenCode.make)

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
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: "s", title: "t", time: { updated: Date.now() } }],
          }),
        },
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

  it("interrupts busy sessions, terminates and deregisters", async () => {
    seedRegistry([row()])
    const client = makeClient({
      session: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: "ses_1", title: "t", time: { updated: 0 } }],
        }),
        active: vi.fn().mockResolvedValue({ ses_1: { type: "running" } }),
      },
    })
    useClient(client)

    const result = JSON.parse(
      (await stopInstance({ port: 51000 })).content[0].text,
    )

    expect(result).toEqual({
      port: 51000,
      stopped: true,
      aborted_sessions: ["ses_1"],
    })
    expect(client.session.interrupt).toHaveBeenCalledWith({
      sessionID: "ses_1",
    })
    expect(killSpy).toHaveBeenCalledWith(-LIVE_PID, "SIGTERM")
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([])
  })
})

describe("listInstances", () => {
  it("shows the registered task sessions with their live status, never the password", async () => {
    seedRegistry([
      row({
        sessions: [
          { id: "ses_1", title: "job", model: "m", startedAt: "2026-01-01" },
        ],
      }),
    ])
    useClient(
      makeClient({
        session: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: "ses_1", title: "job", time: { updated: Date.now() } },
              { id: "ses_other", title: "tui", time: { updated: Date.now() } },
            ],
          }),
          active: vi.fn().mockResolvedValue({ ses_1: { type: "running" } }),
        },
      }),
    )

    const [instance] = JSON.parse((await listInstances()).content[0].text)

    expect(instance.sessions).toEqual([
      expect.objectContaining({ id: "ses_1", status: "busy" }),
    ])
    expect(instance.password).toBeUndefined()
  })
})
