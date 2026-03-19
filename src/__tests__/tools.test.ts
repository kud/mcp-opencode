import { describe, it, expect, vi, beforeEach } from "vitest"

vi.hoisted(() => {
  process.env.OPENCODE_MODEL_ALLOW = "github-copilot/*"
  process.env.OPENCODE_MODEL_BLOCK = ""
})

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: vi.fn(),
}))

import { execSync } from "child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { query, listModels, isModelAllowed } from "../index.js"

const mockExecSync = vi.mocked(execSync)
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
    const result = await query({ prompt: "hello", model: "anthropic/claude-3" })
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
