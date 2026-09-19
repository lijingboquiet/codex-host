import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZcodeAdapter, ZcodeSession } from "../src/adapter.js";
import { zcodeModelRef } from "../src/models.js";
import type { ZcodeTransport } from "../src/transport.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = path.join(os.tmpdir(), `codexhost-zcode-adapter-${crypto.randomUUID()}`);
  const cwd = path.join(root, "workspace");
  const command = path.join(root, "fake-app-server.mjs");
  roots.push(root);
  mkdirSync(path.join(root, "v2"), { recursive: true });
  mkdirSync(cwd);
  copyFileSync(path.resolve(import.meta.dirname, "fixtures/fake-app-server.mjs"), command);
  chmodSync(command, 0o755);
  writeFileSync(
    path.join(root, "v2/provider_config.json"),
    JSON.stringify({
      config: {
        providerOrder: ["custom"],
        providerConfigRules: {
          providerRules: [{ providerId: "custom", providerName: "Personal relay" }],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "custom",
              modelId: "glm-test",
              config: {
                enabled: true,
                optionSpecs: { reasoningLevel: { values: ["low", "max"] } },
              },
            },
          ],
        },
      },
    }),
  );
  return { root, cwd, command };
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("ZCode output ended early");
  return result.value;
}

async function untilCompleted(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  for (;;) {
    const output = await nextOutput(iterator);
    outputs.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") return outputs;
  }
}

function sessionFixture() {
  const snapshot = {
    session: { sessionId: "sess_unit", workspace: { workspacePath: process.cwd() } },
    settings: {
      model: { current: { providerId: "custom", modelId: "glm-test" } },
      thoughtLevel: {
        enabled: true,
        current: "max",
        available: [{ value: "max", label: "Max" }],
      },
      mode: { current: "build" },
    },
  };
  const transport = {
    sessionId: "sess_unit",
    snapshot,
    send: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  } as unknown as ZcodeTransport;
  return {
    transport,
    session: new ZcodeSession(transport, snapshot, null, () => undefined),
  };
}

function stuckSessionFixture() {
  const fixture = sessionFixture();
  let rejectStop!: (error: Error) => void;
  vi.mocked(fixture.transport.stop).mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        void resolve;
        rejectStop = reject;
      }),
  );
  vi.mocked(fixture.transport.close).mockImplementation(async () => {
    rejectStop(new Error("closed"));
  });
  return fixture;
}

describe("ZCode Adapter lifecycle", () => {
  it("creates, configures, streams, approves, cancels, and resumes a Session", async () => {
    const f = fixture();
    const model = zcodeModelRef({ providerId: "custom", modelId: "glm-test" });
    const adapter = new ZcodeAdapter({
      command: f.command,
      environment: { ...process.env, HOME: f.root, ZCODE_HOME: f.root },
      timeoutMs: 5_000,
    });
    const inspection = await adapter.inspect();
    expect(inspection).toMatchObject({
      status: "ready",
      catalog: { models: [{ ref: model }] },
      capabilities: { configuration: { permissionModeScope: "live" } },
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: f.cwd,
      model,
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("max"),
      permissionModeId: harnessPermissionModeIdSchema.parse("build"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(session.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: "max",
      effectivePermissionModeId: "build",
    });
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("edit"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });

    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("host-turn-approval");
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "approval" }],
      }),
    ).toEqual({ ok: true, value: { turnId } });
    let interaction: Extract<HarnessOutput, { kind: "interaction" }> | undefined;
    for (;;) {
      const output = await nextOutput(iterator);
      if (output.kind === "interaction") {
        interaction = output;
        break;
      }
    }
    expect(interaction.interaction).toMatchObject({ type: "approval", title: "shell" });
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "approval", actionId: "once" },
      }),
    ).toEqual({ ok: true, value: { accepted: true } });
    const streamed = await untilCompleted(iterator);
    expect(streamed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.updated",
            update: { type: "text.append", text: "hello from ZCode" },
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "succeeded" },
          }),
        }),
      ]),
    );

    const cancelId = hostTurnIdSchema.parse("host-turn-cancel");
    expect(
      await session.execute({
        type: "turn.start",
        turnId: cancelId,
        input: [{ type: "text", text: "wait" }],
      }),
    ).toEqual({ ok: true, value: { turnId: cancelId } });
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("max"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });
    expect(await session.execute({ type: "model.select", model })).toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("build"),
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(await session.execute({ type: "turn.cancel", turnId: cancelId })).toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(await untilCompleted(iterator)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "cancelled", reason: "Cancelled by user" },
          }),
        }),
      ]),
    );

    const nativeRef = session.initialState.nativeRef;
    expect(nativeRef).toBeDefined();
    if (!nativeRef) throw new Error("ZCode Session has no Native Ref");
    await session.close();
    const resumed = await adapter.open({ kind: "resume", cwd: f.cwd, nativeRef });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed.value.initialState.nativeRef).toEqual(
      nativeSessionRefSchema.parse({
        harnessId: "zcode",
        nativeSessionId: "sess_fake",
        formatVersion: 1,
      }),
    );
    expect((await resumed.value.readSnapshot()).ok).toBe(true);
    await resumed.value.close();
    await adapter.close();
  });

  it("fails a terminal event whose result type is missing", async () => {
    const { session } = sessionFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("host-turn-unknown-result");
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toEqual({ ok: true, value: { turnId } });

    session.handleEvent({
      type: "turn.started",
      sessionId: "sess_unit",
      turnId: "native-turn-unknown",
      eventId: "event-1",
      seq: 1,
      timestamp: 1,
    });
    session.handleEvent({
      type: "turn.completed",
      sessionId: "sess_unit",
      turnId: "native-turn-unknown",
      eventId: "event-2",
      seq: 2,
      timestamp: 2,
      payload: { response: "partial" },
    });

    expect(await untilCompleted(iterator)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: expect.objectContaining({
              status: "failed",
              error: expect.objectContaining({ message: "ZCode stopped: unknown" }),
            }),
          }),
        }),
      ]),
    );
    await session.close();
  });

  it("finishes cancellation locally when ZCode never emits a terminal event", async () => {
    vi.useFakeTimers();
    const { session, transport } = stuckSessionFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
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

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(cancelling).resolves.toEqual({
        ok: true,
        value: { cancellationRequested: true },
      });
      expect(await untilCompleted(iterator)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "event",
            event: expect.objectContaining({
              type: "turn.completed",
              outcome: { status: "cancelled", reason: "Cancelled by user" },
            }),
          }),
        ]),
      );
      expect(transport.close).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  it("closes without waiting for a stuck native stop request", async () => {
    const { session, transport } = stuckSessionFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("host-turn-close-stuck-stop");
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "wait" }],
      }),
    ).toEqual({ ok: true, value: { turnId } });

    await session.close();

    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(await untilCompleted(iterator)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "cancelled", reason: "Session closed" },
          }),
        }),
      ]),
    );
  });
});
