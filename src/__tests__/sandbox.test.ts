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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "fs"
import { join } from "path"

const stateDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/mcp-opencode-sandbox-test-${process.pid}-${Date.now()}`
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

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync, spawn } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  HEADLESS_PERMISSION_RULESET,
  hardenedInstance,
  listInstances,
  readRegistry,
  startInstance,
  stopInstance,
  task,
  type InstanceRecord,
} from "../index.js"
import {
  buildSrtSettings,
  filterExistingPaths,
  isSrtAvailable,
  resolveGitDirs,
  resolveOpencodeDirs,
  resolveSandbox,
  sandboxBashDenyEntries,
  SRT_DENY_READ,
  SRT_NETWORK_ALLOWED_DOMAINS,
} from "../sandbox.js"

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

let killSpy: MockInstance<typeof process.kill>
const savedPath = process.env.PATH

// A bin dir containing an executable `srt`, prepended to PATH.
const binWithSrt = () => {
  const bin = mkdtempSync(join(stateDir, "bin-"))
  const srt = join(bin, "srt")
  writeFileSync(srt, '#!/bin/sh\nexec opencode "$@"\n')
  chmodSync(srt, 0o755)
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${savedPath}`
  return bin
}

const binWithoutSrt = () => {
  const bin = mkdtempSync(join(stateDir, "empty-bin-"))
  process.env.PATH = bin
}

beforeEach(() => {
  vi.clearAllMocks()
  seedRegistry([])
  delete process.env.MCP_OPENCODE_SANDBOX
  delete process.env.MCP_OPENCODE_SANDBOX_SETTINGS
  process.env.PATH = savedPath
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
  process.env.PATH = savedPath
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

describe("resolveSandbox", () => {
  it("is off when the env is unset or blank", () => {
    expect(resolveSandbox({})).toBeNull()
    expect(resolveSandbox({ MCP_OPENCODE_SANDBOX: "" })).toBeNull()
    expect(resolveSandbox({ MCP_OPENCODE_SANDBOX: "  " })).toBeNull()
  })

  it("resolves srt without an override", () => {
    expect(resolveSandbox({ MCP_OPENCODE_SANDBOX: "srt" })).toEqual({
      kind: "srt",
      settingsOverride: null,
    })
  })

  it("rejects any other non-empty value with the supported list", () => {
    expect(() => resolveSandbox({ MCP_OPENCODE_SANDBOX: "docker" })).toThrow(
      /Unsupported sandbox "docker".*Supported values: srt/s,
    )
  })

  it("accepts an override file that exists", () => {
    const override = join(stateDir, "custom.json")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(override, "{}")
    expect(
      resolveSandbox({
        MCP_OPENCODE_SANDBOX: "srt",
        MCP_OPENCODE_SANDBOX_SETTINGS: override,
      }),
    ).toEqual({ kind: "srt", settingsOverride: override })
  })

  it("rejects an override file that does not exist", () => {
    expect(() =>
      resolveSandbox({
        MCP_OPENCODE_SANDBOX: "srt",
        MCP_OPENCODE_SANDBOX_SETTINGS: "/no/such/file.json",
      }),
    ).toThrow(/does not exist/)
  })
})

describe("resolveGitDirs", () => {
  it("resolves a worktree's git dir and common dir separately", () => {
    const run = (dir: string, flag: string) =>
      flag === "--git-common-dir" ? "/repo/.git" : ".git/worktrees/wt"
    expect(resolveGitDirs("/repo/wt", run)).toEqual([
      "/repo/.git",
      "/repo/wt/.git/worktrees/wt",
    ])
  })

  it("dedupes when both resolve to the same dir", () => {
    const run = () => "/repo/.git"
    expect(resolveGitDirs("/repo", run)).toEqual(["/repo/.git"])
  })

  it("returns [] silently outside a git repo", () => {
    const run = () => {
      throw new Error("not a git repository")
    }
    expect(resolveGitDirs("/tmp/not-a-repo", run)).toEqual([])
  })
})

describe("buildSrtSettings", () => {
  it("allows writes to the directory, git dirs, opencode dirs and tmp", () => {
    const settings = buildSrtSettings({
      directory: "/repo/wt",
      gitDirs: ["/repo/.git", "/repo/wt/.git/worktrees/wt"],
      opencode: {
        data: "/home/u/.local/share/opencode",
        config: "/home/u/.config/opencode",
        cache: "/home/u/.cache/opencode",
        state: "/home/u/.local/state/opencode",
      },
      tmpdirs: ["/tmp"],
    })
    expect(settings.filesystem.allowWrite).toEqual([
      "/repo/wt",
      "/repo/.git",
      "/repo/wt/.git/worktrees/wt",
      "/home/u/.local/share/opencode",
      "/home/u/.config/opencode",
      "/home/u/.cache/opencode",
      "/home/u/.local/state/opencode",
      "/tmp",
    ])
    expect(settings.filesystem.allowRead).toEqual([])
    expect(settings.filesystem.denyWrite).toEqual([])
    expect(settings.network.allowLocalBinding).toBe(true)
  })

  it("allows the provider and loopback domains", () => {
    const settings = buildSrtSettings({ directory: "/repo" })
    expect(settings.network.allowedDomains).toEqual(SRT_NETWORK_ALLOWED_DOMAINS)
    expect(settings.network.allowedDomains).toEqual(
      expect.arrayContaining([
        "opencode.ai",
        "*.opencode.ai",
        "models.dev",
        "api.githubcopilot.com",
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "localhost",
        "127.0.0.1",
      ]),
    )
    expect(settings.network.deniedDomains).toEqual([])
  })

  it("denies reads of credential paths but keeps opencode config readable", () => {
    const settings = buildSrtSettings({ directory: "/repo" })
    expect(settings.filesystem.denyRead).toEqual(SRT_DENY_READ)
    expect(settings.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        "~/.ssh",
        "~/.aws",
        "~/.config/gh",
        "~/.gnupg",
        "**/.env",
        "**/.env.*",
        "~/Library/Keychains",
        "~/.kube",
      ]),
    )
    // auth.json lives under the data dir: no denyRead entry may cover it.
    for (const denied of settings.filesystem.denyRead)
      expect(denied).not.toMatch(/local.share.opencode|share\/opencode/)
  })
})

describe("resolveOpencodeDirs", () => {
  it("honours XDG_* env vars", () => {
    expect(
      resolveOpencodeDirs({
        XDG_DATA_HOME: "/x/data",
        XDG_CONFIG_HOME: "/x/config",
        XDG_CACHE_HOME: "/x/cache",
        XDG_STATE_HOME: "/x/state",
      }),
    ).toEqual({
      data: "/x/data/opencode",
      config: "/x/config/opencode",
      cache: "/x/cache/opencode",
      state: "/x/state/opencode",
    })
  })

  it("falls back to ~/.local/share, ~/.config, ~/.cache, ~/.local/state", () => {
    expect(resolveOpencodeDirs({}, "/home/u")).toEqual({
      data: "/home/u/.local/share/opencode",
      config: "/home/u/.config/opencode",
      cache: "/home/u/.cache/opencode",
      state: "/home/u/.local/state/opencode",
    })
  })
})

describe("filterExistingPaths", () => {
  it("drops paths that do not exist", () => {
    expect(
      filterExistingPaths(["/exists", "/missing"], (p) => p === "/exists"),
    ).toEqual(["/exists"])
  })
})

describe("isSrtAvailable", () => {
  it("finds srt on PATH and misses it in an empty dir", () => {
    const bin = mkdtempSync(join(stateDir, "probe-"))
    const srt = join(bin, "srt")
    writeFileSync(srt, "#!/bin/sh\n")
    chmodSync(srt, 0o755)
    expect(isSrtAvailable(bin)).toBe(true)
    expect(isSrtAvailable(mkdtempSync(join(stateDir, "probe-empty-")))).toBe(
      false,
    )
    expect(isSrtAvailable("")).toBe(false)
  })
})

describe("sandboxed permission config", () => {
  it("extends the base ruleset with deny-only extras, still no ask", () => {
    const env = hardenedInstance({ PATH: "/usr/bin" }, { sandboxed: true })
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)
    expect(config.model).toBe("github-copilot/gpt-4.1")
    expect(config.small_model).toBe("github-copilot/gpt-4.1")
    // Base denies survive the merge…
    expect(config.permission.bash["git push*"]).toBe("deny")
    expect(config.permission.bash["gh *"]).toBe("deny")
    expect(config.permission.bash["*"]).toBe("allow")
    // …and the sandbox extras are deny, never ask.
    for (const pattern of ["rm -rf*", "sudo *", "curl *|*", "wget *|*"])
      expect(config.permission.bash[pattern]).toBe("deny")
    expect(Object.values(config.permission.bash)).not.toContain("ask")
    expect(config.permission.webfetch).toBe("deny")
    expect(config.permission.external_directory).toBe("deny")
  })

  it("leaves the unsandboxed config exactly as before", () => {
    const env = hardenedInstance({ PATH: "/usr/bin" })
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)
    expect(config.permission.bash).toEqual({
      "*": "allow",
      "git push*": "deny",
      "git remote*": "deny",
      "gh *": "deny",
      "npm publish*": "deny",
      "git reset --hard*": "deny",
    })
  })

  it("exposes the extras as session ruleset entries", () => {
    expect(sandboxBashDenyEntries()).toEqual([
      { permission: "bash", pattern: "rm -rf*", action: "deny" },
      { permission: "bash", pattern: "sudo *", action: "deny" },
      { permission: "bash", pattern: "curl *|*", action: "deny" },
      { permission: "bash", pattern: "wget *|*", action: "deny" },
    ])
  })
})

describe("startInstance sandbox wiring", () => {
  it("spawns opencode directly with sandbox: null when unset", async () => {
    spawnThatPrints("opencode server listening on http://127.0.0.1:53817\n")
    const directory = mkdtempSync(join(stateDir, "proj-"))

    const before = readdirSync(stateDir).filter((f) => f.startsWith("sandbox-"))
    await startInstance({ directory })

    const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]]
    expect(cmd).toBe("opencode")
    expect(args).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"])
    expect(readRegistry()).toEqual([
      expect.objectContaining({ port: 53817, sandbox: null }),
    ])
    expect(
      readdirSync(stateDir).filter((f) => f.startsWith("sandbox-")),
    ).toEqual(before)
  })

  it("wraps opencode in srt with a generated settings file", async () => {
    binWithSrt()
    process.env.MCP_OPENCODE_SANDBOX = "srt"
    spawnThatPrints("opencode server listening on http://127.0.0.1:53817\n")
    const directory = mkdtempSync(join(stateDir, "proj-"))

    await startInstance({ directory })

    const [cmd, args, options] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
    expect(cmd).toBe("srt")
    expect(args[0]).toBe("--settings")
    expect(args[1]).toMatch(/sandbox-.*\/srt-settings\.json$/)
    // `--` stops srt reading the wrapped command's flags (`-s` is srt's --settings)
    expect(args.slice(2)).toEqual([
      "--",
      "opencode",
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ])
    const settings = JSON.parse(readFileSync(args[1], "utf8"))
    expect(settings.filesystem.allowWrite).toContain(realpathSync(directory))
    expect(settings.network.allowLocalBinding).toBe(true)
    expect(settings.network.allowedDomains).toContain("opencode.ai")
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT as string)
    expect(config.permission.bash["rm -rf*"]).toBe("deny")
    expect(config.permission.bash["sudo *"]).toBe("deny")
    const rows = readRegistry()
    expect(rows).toEqual([
      expect.objectContaining({ port: 53817, sandbox: "srt" }),
    ])
    expect(rows[0].sandboxSettingsDir).toBeDefined()
    expect(existsSync(rows[0].sandboxSettingsDir as string)).toBe(true)
  })

  it("uses the override file as is and writes no settings dir", async () => {
    binWithSrt()
    const override = join(stateDir, "custom-srt.json")
    writeFileSync(override, JSON.stringify({ network: {}, filesystem: {} }))
    process.env.MCP_OPENCODE_SANDBOX = "srt"
    process.env.MCP_OPENCODE_SANDBOX_SETTINGS = override
    spawnThatPrints("opencode server listening on http://127.0.0.1:53817\n")
    const directory = mkdtempSync(join(stateDir, "proj-"))
    const before = readdirSync(stateDir).filter((f) => f.startsWith("sandbox-"))

    await startInstance({ directory })

    const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]]
    expect(cmd).toBe("srt")
    expect(args.slice(0, 2)).toEqual(["--settings", override])
    expect(readRegistry()[0]).toMatchObject({ sandbox: "srt" })
    expect(readRegistry()[0].sandboxSettingsDir).toBeUndefined()
    expect(
      readdirSync(stateDir).filter((f) => f.startsWith("sandbox-")),
    ).toEqual(before)
  })

  it("fails without spawning when srt is missing, never unsandboxed", async () => {
    binWithoutSrt()
    process.env.MCP_OPENCODE_SANDBOX = "srt"
    const directory = mkdtempSync(join(stateDir, "proj-"))

    const result = await startInstance({ directory })

    expect(result.content[0].text).toContain("not on PATH")
    expect(result.content[0].text).toContain(
      "npm i -g @anthropic-ai/sandbox-runtime",
    )
    expect(result.content[0].text).toContain("Refusing to start")
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(readRegistry()).toEqual([])
  })

  it("fails without spawning on an unsupported sandbox value", async () => {
    binWithSrt()
    process.env.MCP_OPENCODE_SANDBOX = "docker"
    const directory = mkdtempSync(join(stateDir, "proj-"))

    const result = await startInstance({ directory })

    expect(result.content[0].text).toContain('Unsupported sandbox "docker"')
    expect(result.content[0].text).toContain("Supported values: srt")
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(readRegistry()).toEqual([])
  })

  it("fails without spawning when the override file is missing", async () => {
    binWithSrt()
    process.env.MCP_OPENCODE_SANDBOX = "srt"
    process.env.MCP_OPENCODE_SANDBOX_SETTINGS = join(stateDir, "no-such.json")
    const directory = mkdtempSync(join(stateDir, "proj-"))

    const result = await startInstance({ directory })

    expect(result.content[0].text).toContain("does not exist")
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(readRegistry()).toEqual([])
  })
})

describe("sandbox lifecycle", () => {
  it("task uses the extended ruleset on a sandboxed instance", async () => {
    seedRegistry([row({ sandbox: "srt" })])
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    await task({ port: 51000, prompt: "add a file" })

    expect(client.session.create).toHaveBeenCalledWith({
      directory: "/tmp/project",
      permission: [...HEADLESS_PERMISSION_RULESET, ...sandboxBashDenyEntries()],
    })
  })

  it("stop_instance removes the per-instance settings dir", async () => {
    const sandboxSettingsDir = mkdtempSync(join(stateDir, "sandbox-"))
    writeFileSync(join(sandboxSettingsDir, "srt-settings.json"), "{}")
    seedRegistry([row({ sandbox: "srt", sandboxSettingsDir })])
    mockCreateClient.mockReturnValue(makeClient())

    const result = JSON.parse(
      (await stopInstance({ port: 51000 })).content[0].text,
    )

    expect(result.stopped).toBe(true)
    expect(existsSync(sandboxSettingsDir)).toBe(false)
    expect(readRegistry()).toEqual([])
  })

  it("list_instances reports sandbox: srt, and null for legacy rows", async () => {
    seedRegistry([row({ port: 51001, sandbox: "srt" }), row({ port: 51002 })])
    // Live sessions updated now, so the reaper keeps both instances.
    mockCreateClient.mockReturnValue(
      makeClient({
        list: vi.fn().mockResolvedValue({
          data: [{ id: "s", title: "t", time: { updated: Date.now() } }],
        }),
      }),
    )

    const rows = JSON.parse((await listInstances()).content[0].text)

    expect(rows.find((r: { port: number }) => r.port === 51001).sandbox).toBe(
      "srt",
    )
    expect(rows.find((r: { port: number }) => r.port === 51002).sandbox).toBe(
      null,
    )
  })
})
