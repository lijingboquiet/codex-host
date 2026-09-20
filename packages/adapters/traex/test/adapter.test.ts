import type { PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { TraexAdapter, TraexSession } from "../src/adapter.js";
import type { TraexTransport } from "../src/acp-transport.js";

const native = vi.hoisted(() => ({ completed: false }));

const transportStub = vi.hoisted(() => ({
  modes: [] as string[],
  configOptions: () => [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "DeepSeek-V4-Flash",
      options: [{ value: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" }],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    },
  ],
}));

vi.mock("../src/history.js", () => ({
  readTraexNativeTurns: () =>
    native.completed ? [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", text: "wait" }] : [],
}));

vi.mock("../src/acp-transport.js", () => ({
  TraexTransport: class {
    sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    replay = [];
    options: { permissionModeId: string };
    constructor(options: { permissionModeId: string }) {
      this.options = options;
      transportStub.modes.push(options.permissionModeId);
    }
    async open() {
      return { sessionId: this.sessionId, configOptions: transportStub.configOptions() };
    }
    async close() {}
  },
}));

function configOptions(thinking = "low"): SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "DeepSeek-V4-Flash",
      options: [{ value: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" }],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      type: "select",
      currentValue: thinking,
      options: [
        { value: "low", name: "Low" },
        { value: "max", name: "Max" },
      ],
    },
  ];
}

describe("TraeX Adapter lifecycle", () => {
  it("allows Thinking changes during an active Turn but rejects a second Turn", async () => {
    native.completed = false;
    let finishPrompt!: (response: PromptResponse) => void;
    let thinking = "low";
    const transport = {
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      options: { cwd: process.cwd(), environment: process.env },
      replay: [],
      configure: vi.fn(async (_configId: string, value: string) => {
        thinking = value;
        return { configOptions: configOptions(thinking) };
      }),
      prompt: vi.fn(
        () =>
          new Promise<PromptResponse>((resolve) => {
            finishPrompt = resolve;
          }),
      ),
      cancel: vi.fn(async () => {
        native.completed = true;
        finishPrompt({ stopReason: "cancelled" });
      }),
      close: vi.fn(async () => undefined),
    } as unknown as TraexTransport;
    const session = new TraexSession(
      transport,
      {
        sessionId: transport.sessionId,
        configOptions: configOptions(),
      },
      "default",
      () => undefined,
    );
    const turnId = hostTurnIdSchema.parse("host-turn-active");
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "wait" }],
      }),
    ).toEqual({ ok: true, value: { turnId } });
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("max"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });
    expect(transport.configure).toHaveBeenCalledWith("reasoning_effort", "max");
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("host-turn-second"),
        input: [{ type: "text", text: "second" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(await session.execute({ type: "turn.cancel", turnId })).toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await session.close();
  });

  it("closes the transport when native cancellation never finishes the Turn", async () => {
    vi.useFakeTimers();
    native.completed = false;
    let rejectPrompt!: (error: Error) => void;
    let rejectCancel!: (error: Error) => void;
    const transport = {
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      options: { cwd: process.cwd(), environment: process.env },
      replay: [],
      configure: vi.fn(),
      prompt: vi.fn(
        () =>
          new Promise<PromptResponse>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
      ),
      cancel: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCancel = reject;
          }),
      ),
      close: vi.fn(async () => {
        native.completed = true;
        rejectPrompt(new Error("closed"));
        rejectCancel(new Error("closed"));
      }),
    } as unknown as TraexTransport;
    const session = new TraexSession(
      transport,
      { sessionId: transport.sessionId, configOptions: configOptions() },
      "default",
      () => undefined,
    );
    const turnId = hostTurnIdSchema.parse("host-turn-stuck-cancel");

    try {
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "wait" }],
        }),
      ).toEqual({ ok: true, value: { turnId } });
      const cancelling = session.execute({ type: "turn.cancel", turnId });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(transport.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.close).toHaveBeenCalledTimes(1);
      await expect(cancelling).resolves.toEqual({
        ok: true,
        value: { cancellationRequested: true },
      });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TraeX Adapter create Permission Mode mapping", () => {
  async function openMode(input: Parameters<TraexAdapter["open"]>[0]): Promise<string> {
    native.completed = false;
    transportStub.modes.length = 0;
    const adapter = new TraexAdapter();
    const result = await adapter.open(input);
    expect(result.ok).toBe(true);
    await adapter.close();
    expect(transportStub.modes).toHaveLength(1);
    return transportStub.modes[0] ?? "";
  }

  it("maps unattended-full-access create to auto", async () => {
    expect(
      await openMode({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
      }),
    ).toBe("auto");
  });

  it("defaults plain create to default", async () => {
    expect(await openMode({ kind: "create", cwd: process.cwd() })).toBe("default");
  });

  it("honors an explicit Full Access create", async () => {
    expect(
      await openMode({
        kind: "create",
        cwd: process.cwd(),
        permissionModeId: harnessPermissionModeIdSchema.parse("bypass_permissions"),
      }),
    ).toBe("bypass_permissions");
  });
});
