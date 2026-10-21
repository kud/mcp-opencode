import { vi, type Mock } from "vitest"

type FakeGroup = Record<string, Mock>

export type FakeClient = {
  server: FakeGroup
  session: FakeGroup
  message: FakeGroup
  model: FakeGroup
}

// A stand-in for the @opencode/client promise client: every method the
// server calls, resolving to an empty-but-valid v2 answer by default.
export const makeClient = (
  overrides: {
    session?: Record<string, unknown>
    message?: Record<string, unknown>
    model?: Record<string, unknown>
    server?: Record<string, unknown>
  } = {},
) =>
  ({
    server: {
      info: vi.fn().mockResolvedValue({ version: "2.1.2" }),
      ...overrides.server,
    },
    session: {
      create: vi.fn().mockResolvedValue({ id: "ses_1", title: "New session" }),
      prompt: vi.fn().mockResolvedValue({ id: "msg_prompt", type: "user" }),
      list: vi.fn().mockResolvedValue({ data: [], cursor: {} }),
      active: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
      switchModel: vi.fn().mockResolvedValue(undefined),
      switchAgent: vi.fn().mockResolvedValue(undefined),
      diff: vi.fn().mockResolvedValue([]),
      ...overrides.session,
    },
    message: {
      list: vi.fn().mockResolvedValue({ data: [], cursor: {} }),
      ...overrides.message,
    },
    model: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      ...overrides.model,
    },
  }) as FakeClient

// message.list answers newest first; tests read better oldest first.
export const history = (...oldestFirst: unknown[]) => ({
  data: [...oldestFirst].reverse(),
  cursor: {},
})

export const userMessage = (text: string, id = "msg_prompt") => ({
  id,
  type: "user",
  text,
  time: { created: 1 },
})

export const assistantMessage = ({
  text,
  error,
  retry,
  completed = true,
  tools = [],
}: {
  text?: string
  error?: { type: string; message: string }
  retry?: { attempt: number; message: string }
  completed?: boolean
  tools?: Array<{ name: string; status: string }>
} = {}) => ({
  id: `msg_assistant_${Math.random().toString(36).slice(2)}`,
  type: "assistant",
  agent: "build",
  model: { providerID: "github-copilot", id: "gpt-4.1" },
  time: { created: 2, ...(completed && { completed: 3 }) },
  content: [
    ...tools.map(({ name, status }) => ({
      type: "tool",
      id: name,
      name,
      state: { status, input: {} },
      time: { created: 2 },
    })),
    ...(text ? [{ type: "text", text }] : []),
  ],
  ...(error && { error }),
  ...(retry && {
    retry: {
      attempt: retry.attempt,
      at: 2,
      error: { type: "provider.retry", message: retry.message },
    },
  }),
})

export const idleMessage = (
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
  error?: { type: string; message: string },
) => ({
  id: `msg_idle_${Math.random().toString(36).slice(2)}`,
  type: "idle",
  outcome,
  time: { created: 4 },
  ...(error && { error }),
})

// Stand-in server credentials. Named, so no test spells one out inline.
export const FIXTURE_AUTH = {
  instance: "fixture-instance",
  service: "fixture-service",
  inherited: "fixture-inherited",
  fresh: "fixture-fresh",
}
