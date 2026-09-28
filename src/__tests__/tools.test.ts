import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.hoisted(() => {
  process.env.MCP_OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.MCP_OPENCODE_MODEL_BLOCK = ""
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync, spawn } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import {
  query,
  listModels,
  isModelAllowed,
  listSessions,
  send,
  read,
} from "../index.js"

const mockExecSync = vi.mocked(execSync)
const mockSpawn = vi.mocked(spawn)
const mockCreateClient = vi.mocked(createOpencodeClient)

const makeClient = () =>
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

beforeEach(() => {
  vi.clearAllMocks()
  mockExecSync.mockImplementation(() => Buffer.from(""))
  mockCreateClient.mockReturnValue(makeClient())
})

afterEach(() => {
  vi.useRealTimers()
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
      (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0].body
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

describe("ensureServer", () => {
  it("spawns opencode serve with the configured port when nothing is listening", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no listener")
    })
    vi.useFakeTimers()

    const listPromise = listSessions({})
    await vi.advanceTimersByTimeAsync(2000)
    await listPromise

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
      { detached: true, stdio: "ignore" },
    )
  })

  it("does not spawn a server when one is already listening", async () => {
    mockExecSync.mockImplementation(() => Buffer.from(""))

    await listSessions({})

    expect(mockSpawn).not.toHaveBeenCalled()
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
      query: { directory: "/some/project" },
    })
  })

  it("reports when no sessions exist", async () => {
    const result = await listSessions({})
    expect(result.content[0].text).toBe("No sessions found")
  })
})

describe("send", () => {
  it("prompts the existing session without creating or deleting one", async () => {
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    await send({ session_id: "session-1", prompt: "hi" })

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "hi" }] },
    })
  })

  it("passes the agent through when provided", async () => {
    const client = makeClient()
    mockCreateClient.mockReturnValue(client)

    await send({ session_id: "session-1", prompt: "hi", agent: "plan" })

    expect(
      (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0].body
        .agent,
    ).toBe("plan")
  })

  it("returns a still-running message when the timeout elapses", async () => {
    const client = makeClient()
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
    const client = makeClient()
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
})

describe("read", () => {
  it("condenses session messages into a transcript", async () => {
    const client = makeClient()
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
    const result = await read({ session_id: "session-1" })
    expect(result.content[0].text).toBe("No messages in this session")
  })
})
