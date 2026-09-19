import path from "node:path";
import {
  HarnessOutputChannel,
  parseHostUsage,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostUsage,
  type HostCommand,
  type HostThreadSnapshot,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  TraexTransport,
  type TraexSessionInfo,
  type TraexTransportOptions,
} from "./acp-transport.js";
import { readTraexNativeTurns, type TraexNativeTurn } from "./history.js";
import { TraexInteractions } from "./interactions.js";
import {
  inspectTraexModels,
  TRAEX_CAPABILITIES,
  TRAEX_PERMISSION_MODES,
  traexConfiguration,
  traexNativeModel,
} from "./models.js";
import { TraexTurnOutput, traexSnapshot } from "./projection.js";

export interface TraexAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}

export function traexError(error: unknown): HarnessError {
  const message = sanitizeDiagnosticTail(
    error instanceof Error ? error.message : "TraeX operation failed",
  );
  const code = /not installed|not found|ENOENT/iu.test(message)
    ? "notInstalled"
    : /auth|login|credential/iu.test(message)
      ? "authenticationRequired"
      : /exited|closed/iu.test(message)
        ? "processExited"
        : /history was not found/iu.test(message)
          ? "sessionNotFound"
          : "protocolError";
  return { code, message, retryable: false };
}

function rejected<T>(code: HarnessError["code"], message: string): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

function permissionMode(input: Extract<OpenSessionInput, { kind: "create" | "resume" }>): string {
  const selected =
    input.kind === "create" && input.executionPolicy === "unattended-full-access"
      ? "bypass_permissions"
      : (input.permissionModeId ?? TRAEX_PERMISSION_MODES.defaultModeId);
  if (!TRAEX_PERMISSION_MODES.modes.some(({ id }) => id === selected))
    throw new Error("Unknown TraeX Permission Mode");
  return selected;
}

export class TraexAdapter implements HarnessAdapter {
  readonly harnessId = harnessIdSchema.parse("traex");
  readonly #sessions = new Set<TraexSession>();
  #inspection: Promise<HarnessInspection> | undefined;
  #closed = false;

  constructor(readonly options: TraexAdapterOptions = {}) {}

  #environment(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return { ...(this.options.environment ?? process.env), ...extra };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return {
        status: "unavailable",
        error: { code: "unavailable", message: "TraeX Adapter is closed", retryable: false },
      };
    }
    if (this.#inspection && !input.refresh) return this.#inspection;
    this.#inspection = (async () => {
      try {
        return {
          status: "ready",
          catalog: await inspectTraexModels({
            ...(this.options.command ? { command: this.options.command } : {}),
            environment: this.#environment(),
            ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
          }),
          capabilities: TRAEX_CAPABILITIES,
          permissionModes: TRAEX_PERMISSION_MODES,
        };
      } catch (error) {
        const failure = traexError(error);
        return {
          status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
          error: failure,
        };
      }
    })();
    return this.#inspection;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "TraeX Adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return rejected("unsupported", "TraeX fork and rollback are not supported");
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    let selectedMode: string;
    try {
      selectedMode = permissionMode(input);
    } catch (error) {
      return { ok: false, error: traexError(error) };
    }
    const options: TraexTransportOptions = {
      cwd: path.resolve(input.cwd),
      environment: this.#environment(input.environment),
      permissionModeId: selectedMode,
      ...(this.options.command ? { command: this.options.command } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    };
    const transport = new TraexTransport(options);
    try {
      if (input.kind === "resume") {
        readTraexNativeTurns(input.nativeRef.nativeSessionId, options.cwd, options.environment);
      }
      const info = await transport.open(
        input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
      );
      const session = new TraexSession(
        transport,
        info,
        selectedMode,
        () => this.#sessions.delete(session),
        input.kind === "create",
      );
      if (input.kind === "resume") {
        const native = readTraexNativeTurns(transport.sessionId, options.cwd, options.environment);
        traexSnapshot(transport.sessionId, native, transport.replay);
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== transport.sessionId ||
              !native.some(({ id }) => id === ref.nativeTurnKey),
          )
        ) {
          throw new Error("Saved TraeX Turn identity no longer exists in Native history");
        }
      }
      if (input.model) {
        const result = await session.execute({ type: "model.select", model: input.model });
        if (!result.ok) throw new Error(result.error.message);
      }
      if (input.thinkingOptionId) {
        const result = await session.execute({
          type: "thinking.select",
          thinkingOptionId: input.thinkingOptionId,
        });
        if (!result.ok) throw new Error(result.error.message);
      }
      if (this.#closed) {
        await session.close();
        return rejected("invalidState", "TraeX Adapter closed during Session startup");
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport.close();
      return { ok: false, error: traexError(error) };
    }
  }

  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
  }
}

export class TraexSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("traex");
  readonly capabilities = TRAEX_CAPABILITIES;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new TraexInteractions((output) => this.#channel.emit(output));
  #configuration: ReturnType<typeof traexConfiguration>;
  #usage: HostUsage | null = null;
  readonly #submitted = new Set<string>();
  #active: { command: TurnStartCommand; cancelled: boolean; task: Promise<void> } | undefined;
  #configuring = false;
  #closed = false;
  #fresh: boolean;

  constructor(
    readonly transport: TraexTransport,
    info: TraexSessionInfo,
    readonly permissionModeId: string,
    readonly onClose: () => void,
    created = true,
  ) {
    this.#fresh = created;
    this.#configuration = traexConfiguration(info.configOptions ?? undefined, permissionModeId);
    this.initialState = {
      ...this.#configuration.state,
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "traex",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
    };
  }

  #native(allowMissing = false) {
    return readTraexNativeTurns(
      this.transport.sessionId,
      this.transport.options.cwd,
      this.transport.options.environment,
      allowMissing,
    );
  }

  #apply(info: TraexSessionInfo) {
    this.#configuration = traexConfiguration(
      info.configOptions ?? undefined,
      this.permissionModeId,
    );
    Object.assign(this.initialState, this.#configuration.state);
    this.#channel.emit({
      kind: "event",
      event: { type: "session.state.changed", state: { ...this.initialState } },
    });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "TraeX Session is closed");
    if (this.#active || this.#configuring) return rejected("sessionBusy", "TraeX Session is busy");
    this.#configuring = true;
    try {
      const native = this.#native(this.#fresh);
      if (!native.length && this.#fresh)
        return { ok: true, value: { turns: [], state: structuredClone(this.initialState) } };
      return {
        ok: true,
        value: {
          ...traexSnapshot(this.transport.sessionId, native, this.transport.replay),
          state: structuredClone(this.initialState),
        },
      };
    } catch (error) {
      return { ok: false, error: traexError(error) };
    } finally {
      this.#configuring = false;
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return rejected("invalidState", "TraeX Session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.command.turnId !== command.turnId)
        return rejected("invalidState", "TraeX Turn is not active");
      const active = this.#active;
      active.cancelled = true;
      this.#interactions.cancel();
      let forcedClose = false;
      const timer = setTimeout(() => {
        if (this.#active !== active) return;
        forcedClose = true;
        void this.close().catch(() => undefined);
      }, 5_000);
      timer.unref();
      void active.task.finally(() => clearTimeout(timer));
      try {
        await this.transport.cancel();
      } catch (error) {
        if (forcedClose || this.#closed) {
          return { ok: true, value: { cancellationRequested: true } };
        }
        clearTimeout(timer);
        active.cancelled = false;
        return { ok: false, error: traexError(error) };
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (command.type === "permissionMode.select")
      return rejected("unsupported", "TraeX Permission Mode is fixed when a Session is created");
    if (this.#configuring) return rejected("sessionBusy", "TraeX Session is busy");
    if (command.type === "turn.start") {
      if (this.#active) return rejected("sessionBusy", "TraeX Session is busy");
      const text = command.input.map((part) => part.text).join("\n");
      if (!text.trim()) return rejected("invalidRequest", "TraeX requires nonempty text input");
      if (this.#submitted.has(command.turnId))
        return rejected("invalidState", "TraeX Turn was already submitted");
      let before: TraexNativeTurn[];
      try {
        before = this.#fresh ? [] : this.#native();
      } catch (error) {
        return { ok: false, error: traexError(error) };
      }
      this.#submitted.add(command.turnId);
      const active = { command, cancelled: false, task: Promise.resolve() };
      this.#active = active;
      active.task = this.#run(command, before);
      return { ok: true, value: { turnId: command.turnId } };
    }
    this.#configuring = true;
    try {
      const configId = command.type === "model.select" ? "model" : "reasoning_effort";
      const value =
        command.type === "model.select"
          ? traexNativeModel(command.model)
          : command.thinkingOptionId;
      const available =
        command.type === "model.select"
          ? this.#configuration.modelIds
          : this.#configuration.thinkingIds;
      if (!available.has(value))
        return rejected("invalidRequest", "Selection is unavailable in TraeX");
      const result = await this.transport.configure(configId, value);
      this.#apply(result);
      const confirmed =
        command.type === "model.select"
          ? this.initialState.effectiveModel?.id === command.model.id
          : this.initialState.effectiveThinkingOptionId === command.thinkingOptionId;
      if (!confirmed) throw new Error(`TraeX did not confirm ${configId}`);
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: traexError(error) };
    } finally {
      this.#configuring = false;
    }
  }

  async #run(command: TurnStartCommand, before: TraexNativeTurn[]) {
    const output = new TraexTurnOutput(command.turnId, (event) =>
      this.#channel.emit({ kind: "event", event }),
    );
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    let outcome: TurnOutcome = {
      status: "failed",
      error: { code: "nativeFailure", message: "TraeX Turn failed", retryable: false },
    };
    let nativeTurnRef: ReturnType<typeof nativeTurnRefSchema.parse> | undefined;
    try {
      const response = await this.transport.prompt(
        command.input.map((part) => part.text).join("\n"),
        {
          update: (event) => {
            output.update(event);
            if (event.update.sessionUpdate !== "usage_update") return;
            const usage = parseHostUsage({
              ...this.#usage,
              contextUsedTokens: event.update.used,
              contextWindowTokens: event.update.size,
              ...(event.update.cost?.currency === "USD"
                ? { totalCostUsd: event.update.cost.amount }
                : {}),
            });
            this.#usage = usage;
            this.#channel.emit({
              kind: "event",
              event: {
                type: "session.usage.changed",
                usage,
                observedForTurnId: command.turnId,
              },
            });
          },
          permission: (request) => this.#interactions.permission(command.turnId, request),
          elicitation: (request) => this.#interactions.elicitation(command.turnId, request),
        },
      );
      if (response.usage) {
        this.#usage = parseHostUsage({
          ...this.#usage,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          ...(response.usage.cachedReadTokens != null
            ? { cachedInputTokens: response.usage.cachedReadTokens }
            : {}),
          ...(response.usage.cachedWriteTokens != null
            ? { cacheWriteInputTokens: response.usage.cachedWriteTokens }
            : {}),
          ...(response.usage.thoughtTokens != null
            ? { reasoningOutputTokens: response.usage.thoughtTokens }
            : {}),
        });
        this.#channel.emit({
          kind: "event",
          event: {
            type: "session.usage.changed",
            usage: this.#usage,
            observedForTurnId: command.turnId,
          },
        });
      }
      outcome =
        this.#active?.cancelled || response.stopReason === "cancelled"
          ? { status: "cancelled" }
          : response.stopReason === "end_turn"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `TraeX stopped: ${response.stopReason}`,
                  retryable: false,
                },
              };
    } catch (error) {
      outcome = this.#active?.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: traexError(error) };
    }
    try {
      const after = this.#native();
      const added = after.filter((turn) => !before.some(({ id }) => id === turn.id));
      if (
        added.length !== 1 ||
        after.length !== before.length + 1 ||
        before.some((turn, index) => after[index]?.id !== turn.id) ||
        added[0]?.text !== command.input.map((part) => part.text).join("\n")
      ) {
        throw new Error("TraeX terminal has no unique, verified Native Turn identity");
      }
      nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: "traex",
        nativeSessionId: this.transport.sessionId,
        nativeTurnKey: added[0].id,
        formatVersion: 1,
      });
      this.#fresh = false;
    } catch (error) {
      if (outcome.status === "succeeded") outcome = { status: "failed", error: traexError(error) };
    }
    this.#interactions.cancel();
    output.finish(outcome);
    this.#active = undefined;
    this.#channel.emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: command.turnId,
        outcome,
        ...(nativeTurnRef ? { nativeTurnRef } : {}),
      },
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) active.cancelled = true;
    this.#interactions.cancel();
    try {
      await this.transport.close();
      await active?.task;
    } finally {
      this.#channel.end();
      this.onClose();
    }
  }
}
