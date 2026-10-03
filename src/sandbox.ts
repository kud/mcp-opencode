import { execSync } from "child_process"
import { accessSync, constants, existsSync, realpathSync } from "fs"
import { homedir } from "os"
import { delimiter, isAbsolute, join, resolve } from "path"

// Opt-in OS sandboxing for headless opencode instances, via srt
// (@anthropic-ai/sandbox-runtime, npm bin `srt`). Off unless
// MCP_OPENCODE_SANDBOX requests it; see README "Sandboxing".

export const SANDBOX_ENV_VAR = "MCP_OPENCODE_SANDBOX"
export const SANDBOX_SETTINGS_ENV_VAR = "MCP_OPENCODE_SANDBOX_SETTINGS"
export const SUPPORTED_SANDBOXES = ["srt"] as const
export type SandboxKind = (typeof SUPPORTED_SANDBOXES)[number]
export const SRT_INSTALL_HINT =
  "npm i -g @anthropic-ai/sandbox-runtime"

export type SandboxRequest = {
  kind: SandboxKind
  // MCP_OPENCODE_SANDBOX_SETTINGS: use this file as --settings verbatim.
  settingsOverride: string | null
}

// Reads env at call time (never at import) so tests and long-lived
// servers see the current configuration.
export const resolveSandbox = (
  env: NodeJS.ProcessEnv = process.env,
): SandboxRequest | null => {
  const raw = (env[SANDBOX_ENV_VAR] ?? "").trim()
  const override = (env[SANDBOX_SETTINGS_ENV_VAR] ?? "").trim() || null
  if (!raw) {
    // An override on its own implies srt: it only makes sense sandboxed.
    if (!override) return null
    if (!existsSync(override))
      throw new Error(
        `${SANDBOX_SETTINGS_ENV_VAR} points at "${override}", which does not exist.`,
      )
    return { kind: "srt", settingsOverride: override }
  }
  if (!(SUPPORTED_SANDBOXES as readonly string[]).includes(raw))
    throw new Error(
      `Unsupported sandbox "${raw}" in ${SANDBOX_ENV_VAR}. ` +
        `Supported values: ${SUPPORTED_SANDBOXES.join(", ")}. ` +
        `Unset ${SANDBOX_ENV_VAR} to run without sandboxing.`,
    )
  if (override && !existsSync(override))
    throw new Error(
      `${SANDBOX_SETTINGS_ENV_VAR} points at "${override}", which does not exist.`,
    )
  return { kind: raw as SandboxKind, settingsOverride: override }
}

export const isSrtAvailable = (
  pathEnv: string | undefined = process.env.PATH,
): boolean => {
  if (!pathEnv) return false
  const names =
    process.platform === "win32" ? ["srt", "srt.exe", "srt.cmd"] : ["srt"]
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return true
      } catch {}
    }
  }
  return false
}

export const missingSrtError = () =>
  `MCP_OPENCODE_SANDBOX=srt was requested but \`srt\` is not on PATH. ` +
  `Install it (${SRT_INSTALL_HINT}) or unset ${SANDBOX_ENV_VAR} to run without sandboxing. ` +
  `Refusing to start the instance unsandboxed.`

// ─── srt settings ───

// Network allowlist. Verified against the strings of the installed
// opencode 1.18.34 binary: opencode.ai (+ api./models. subdomains via
// the wildcard) serves the Zen API behind the free "opencode/*"
// models, models.dev is the model registry, and api.githubcopilot.com
// serves the default github-copilot/* models. github.com,
// api.github.com and registry.npmjs.org are assumed useful (public
// clones, npm installs); localhost/loopback plus allowLocalBinding
// let the instance serve on 127.0.0.1. Everything else stays denied:
// srt is deny-all by default.
export const SRT_NETWORK_ALLOWED_DOMAINS = [
  "opencode.ai",
  "*.opencode.ai",
  "models.dev",
  "api.githubcopilot.com",
  "github.com",
  "*.github.com",
  "api.github.com",
  "registry.npmjs.org",
  "localhost",
  "127.0.0.1",
]

// Reads stay open everywhere except these credential-bearing paths.
// opencode's own data dir (~/.local/share/opencode, home of auth.json)
// is deliberately NOT denied: the instance needs its provider auth.
export const SRT_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gh",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "**/.env",
  "**/.env.*",
  "~/Library/Keychains",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker/config.json",
]

export type SrtSettings = {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowLocalBinding: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

export type OpencodeDirs = {
  data: string
  config: string
  cache: string
  state: string
}

// Where opencode keeps state/cache/config, honouring XDG_*.
export const resolveOpencodeDirs = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): OpencodeDirs => ({
  data: env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, "opencode")
    : join(home, ".local", "share", "opencode"),
  config: env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "opencode")
    : join(home, ".config", "opencode"),
  cache: env.XDG_CACHE_HOME
    ? join(env.XDG_CACHE_HOME, "opencode")
    : join(home, ".cache", "opencode"),
  state: env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "opencode")
    : join(home, ".local", "state", "opencode"),
})

const defaultGitRun = (directory: string, flag: string) =>
  execSync("git rev-parse " + flag, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

// The instance's git dir(s), realpath'd. In a worktree --git-dir
// (e.g. .git/worktrees/name) differs from --git-common-dir, and both
// need writes; outside a repo this returns [] silently.
export const resolveGitDirs = (
  directory: string,
  run: (directory: string, flag: string) => string = defaultGitRun,
): string[] => {
  let common: string
  let dir: string
  try {
    common = run(directory, "--git-common-dir")
    dir = run(directory, "--git-dir")
  } catch {
    return []
  }
  const out: string[] = []
  for (const raw of [common, dir]) {
    if (!raw) continue
    const abs = isAbsolute(raw) ? raw : resolve(directory, raw)
    // realpath when possible (symlinked git dirs); keep the unresolved
    // path otherwise — nonexistent entries are dropped later by
    // filterExistingPaths at settings-write time.
    let real = abs
    try {
      real = realpathSync(abs)
    } catch {}
    if (!out.includes(real)) out.push(real)
  }
  return out
}

export const buildSrtSettings = ({
  directory,
  gitDirs = [],
  opencode = resolveOpencodeDirs(),
  tmpdirs = [],
}: {
  directory: string
  gitDirs?: string[]
  opencode?: OpencodeDirs
  tmpdirs?: string[]
}): SrtSettings => {
  const allowWrite = [
    directory,
    ...gitDirs,
    opencode.data,
    opencode.config,
    opencode.cache,
    opencode.state,
    ...tmpdirs,
  ].filter((p, i, all) => p && all.indexOf(p) === i)
  return {
    network: {
      allowedDomains: [...SRT_NETWORK_ALLOWED_DOMAINS],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [...SRT_DENY_READ],
      allowRead: [],
      allowWrite,
      denyWrite: [],
    },
  }
}

// srt binds allowWrite paths, so drop entries that do not exist rather
// than fail the wrap (e.g. an opencode dir on a fresh machine).
export const filterExistingPaths = (
  paths: string[],
  exists: (p: string) => boolean = existsSync,
) => paths.filter(exists)

export const tmpdirsForSandbox = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const out: string[] = []
  const tmp = (env.TMPDIR ?? "").replace(/\/+$/, "")
  if (tmp) out.push(tmp)
  if (!out.includes("/tmp")) out.push("/tmp")
  return out
}

// ─── Layer 2: opencode permission extras ───

// Extra bash denies applied only when sandboxed, appended after the
// base ruleset's bash allow (opencode applies the last matching rule).
// deny, never ask: headless cannot answer and would hang. These are
// heuristic glob matches (* spans any characters), defence in depth
// behind the OS sandbox, not a guarantee.
export const SANDBOX_BASH_DENY_PATTERNS = [
  "rm -rf*",
  "sudo *",
  "curl *|*",
  "wget *|*",
]

export type BashDenyEntry = {
  permission: "bash"
  pattern: string
  action: "deny"
}

export const sandboxBashDenyEntries = (): BashDenyEntry[] =>
  SANDBOX_BASH_DENY_PATTERNS.map((pattern) => ({
    permission: "bash" as const,
    pattern,
    action: "deny" as const,
  }))
