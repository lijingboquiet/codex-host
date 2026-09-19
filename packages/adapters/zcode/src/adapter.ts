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
  type HostCommand,
  type HostThreadSnapshot,
  type HostUsage,
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
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessPermissionModeId,
  type HostTurnId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { resolveZcodeExecutable } from "./command.js";
import { zcodeSnapshot } from "./history.js";
import { ZcodeInteractions } from "./interactions.js";
import {
  inspectZcodeModels,
  stateFromZcodeSnapshot,
  ZCODE_CAPABILITIES,
  ZCODE_PERMISSION_MODES,
  zcodeNativeModel,
} from "./models.js";
import { ZcodeTurnProjection } from "./projection.js";
import {
  ZcodeTransport,
  ZcodeTransportError,
  type ZcodeEvent,
  type ZcodeTransportOptions,
} from "./transport.js";

export interface ZcodeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
}

interface ActiveTurn {
  command: TurnStartCommand;
  projection: ZcodeTurnProjection;
  nativeTurnId?: string;
  cancelled: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error));
}

export function zcodeError(
  error: unknown,
  fallback: HarnessError["code"] = "protocolError",
): HarnessError {
  if (error instanceof ZcodeTransportError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: error.kind === "unavailable",
      ...(error.diagnostic ? { stderrTail: error.diagnostic } : {}),
    };
  }
  const message = errorMessage(error);
  const code = /not installed|not found|ENOENT/iu.test(message)
    ? "notInstalled"
    : /auth|login|credential/iu.test(message)
      ? "authenticationRequired"
      : fallback;
  return { code, message, retryable: code === "unavailable" };
}

function rejected<T>(code: HarnessError["code"], message: string): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

function selectedMode(
  input: Extract<OpenSessionInput, { kind: "create" | "resume" }>,
): HarnessPermissionModeId {
  const selected =
    input.kind === "create" && input.executionPolicy === "unattended-full-access"
      ? "yolo"
      : (input.permissionModeId ?? ZCODE_PERMISSION_MODES.defaultModeId);
  if (!ZCODE_PERMISSION_MODES.modes.some(({ id }) => id === selected)) {
    throw new Error(`Unsupported ZCode mode '${selected}'`);
  }
  return harnessPermissionModeIdSchema.parse(selected);
}

function usageFrom(value: JsonValue, snapshot?: JsonObject): HostUsage | null {
  const source = record(value);
  const runtime = record(snapshot?.runtime);
  const context = record(runtime.contextUsage);
  const usage: Record<string, number> = {};
  const copy = (target: string, sourceName: string) => {
    const candidate = source[sourceName];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
      usage[target] = candidate;
    }
  };
  copy("inputTokens", "inputTokens");
  copy("outputTokens", "outputTokens");
  copy("reasoningOutputTokens", "reasoningTokens");
  copy("cachedInputTokens", "cacheReadTokens");
  copy("cacheWriteInputTokens", "cacheCreationTokens");
  copy("totalTokens", "totalTokens");
  if (!("cacheWriteInputTokens" in usage)) {
    copy("cacheWriteInputTokens", "cacheWriteTokens");
  }
  if (typeof context.used === "number" && typeof context.size === "number" && context.size > 0) {
    usage.contextUsedTokens = context.used;
    usage.contextWindowTokens = context.size;
  }
  return Object.keys(usage).length ? parseHostUsage(usage) : null;
}

export class ZcodeAdapter implements HarnessAdapter {
  readonly harnessId = harnessIdSchema.parse("zcode");
  readonly #sessions = new Set<ZcodeSession>();
  #inspection: Promise<HarnessInspection> | undefined;
  #closed = false;

  constructor(readonly options: ZcodeAdapterOptions = {}) {}

  #environment(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return { ...(this.options.environment ?? process.env), ...extra };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return {
        status: "unavailable",
        error: { code: "unavailable", message: "ZCode Adapter is closed", retryable: false },
      };
    }
    if (this.#inspection && !input.refresh) return this.#inspection;
    this.#inspection = (async () => {
      try {
        resolveZcodeExecutable({
          ...(this.options.command ? { command: this.options.command } : {}),
          environment: this.#environment(),
        });
        return {
          status: "ready",
          catalog: await inspectZcodeModels(this.#environment()),
          capabilities: ZCODE_CAPABILITIES,
          permissionModes: ZCODE_PERMISSION_MODES,
        };
      } catch (error) {
        const failure = zcodeError(error, "unavailable");
        return {
          status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
          error: failure,
        };
      }
    })();
    return this.#inspection;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "ZCode Adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume") {
      return rejected("unsupported", "ZCode fork and rollback are not yet supported");
    }
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId) {
      return rejected("invalidRequest", "Session belongs to another Harness");
    }
    let mode: HarnessPermissionModeId;
    try {
      mode = selectedMode(input);
    } catch (error) {
      return { ok: false, error: zcodeError(error, "invalidRequest") };
    }
    const options: ZcodeTransportOptions = {
      cwd: path.resolve(input.cwd),
      environment: this.#environment(input.environment),
      ...(this.options.command ? { command: this.options.command } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.closeTimeoutMs ? { closeTimeoutMs: this.options.closeTimeoutMs } : {}),
    };
    const transport = new ZcodeTransport(options);
    let session: ZcodeSession | undefined;
    try {
      const workspace = { workspacePath: options.cwd, workspaceKey: options.cwd };
      const snapshot = await transport.open(
        input.kind === "create"
          ? {
              kind: "create",
              workspace,
              mode,
              ...(input.model ? { model: zcodeNativeModel(input.model) } : {}),
              ...(input.thinkingOptionId ? { thoughtLevel: input.thinkingOptionId } : {}),
            }
          : {
              kind: "resume",
              workspace,
              sessionId: input.nativeRef.nativeSessionId,
              ...(input.thinkingOptionId ? { thoughtLevel: input.thinkingOptionId } : {}),
            },
        {
          event: (event) => session?.handleEvent(event),
          permission: (params) =>
            session?.handlePermission(params) ?? Promise.resolve({ decision: "deny" }),
          userInput: (params) =>
            session?.handleUserInput(params) ?? Promise.resolve({ action: "cancel" }),
          fault: (error) => session?.handleFault(error),
        },
      );
      const nativeUsage = await transport.usage().catch(() => null);
      session = new ZcodeSession(
        transport,
        snapshot,
        nativeUsage ? usageFrom(nativeUsage, snapshot) : usageFrom({}, snapshot),
        () => {
          if (session) this.#sessions.delete(session);
        },
      );
      if (input.kind === "resume") {
        if (input.model) {
          const selected = await session.execute({ type: "model.select", model: input.model });
          if (!selected.ok) throw new Error(selected.error.message);
        }
        if (input.permissionModeId && session.initialState.effectivePermissionModeId !== mode) {
          const selected = await session.execute({
            type: "permissionMode.select",
            permissionModeId: mode,
          });
          if (!selected.ok) throw new Error(selected.error.message);
        }
        const history = await session.readSnapshot();
        if (!history.ok) throw new Error(history.error.message);
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== transport.sessionId ||
              !history.value.turns.some(
                ({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey === ref.nativeTurnKey,
              ),
          )
        ) {
          throw new Error("Saved ZCode Turn identity no longer exists in Native history");
        }
      }
      if (this.#closed) {
        await session.close();
        return rejected("invalidState", "ZCode Adapter closed during Session startup");
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await session?.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      return { ok: false, error: zcodeError(error) };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
  }
}

export class ZcodeSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("zcode");
  readonly capabilities = ZCODE_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new ZcodeInteractions((output) => this.#channel.emit(output));
  readonly #submitted = new Set<HostTurnId>();
  #usage: HostUsage | null;
  #active: ActiveTurn | undefined;
  #configuring = false;
  #closed = false;

  constructor(
    readonly transport: ZcodeTransport,
    snapshot: JsonObject,
    usage: HostUsage | null,
    readonly onClose: () => void,
  ) {
    this.initialState = this.#state(snapshot);
    this.initialUsage = usage;
    this.#usage = usage;
  }

  #state(snapshot: JsonObject): HarnessSessionState {
    return {
      ...stateFromZcodeSnapshot(snapshot),
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "zcode",
        nativeSessionId: this.transport.sessionId,
        formatVersion: 1,
      }),
    };
  }

  #apply(snapshot: JsonObject): void {
    Object.assign(this.initialState, this.#state(snapshot));
    this.#channel.emit({
      kind: "event",
      event: { type: "session.state.changed", state: structuredClone(this.initialState) },
    });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "ZCode Session is closed");
    if (this.#active || this.#configuring) return rejected("sessionBusy", "ZCode Session is busy");
    this.#configuring = true;
    try {
      const [snapshotValue, eventsValue] = await Promise.all([
        this.transport.read(),
        this.transport.historyEvents(),
      ]);
      const snapshot = record(snapshotValue);
      this.transport.snapshot = snapshot;
      this.#apply(snapshot);
      return {
        ok: true,
        value: {
          ...zcodeSnapshot(this.transport.sessionId, snapshot, record(eventsValue)),
          state: structuredClone(this.initialState),
        },
      };
    } catch (error) {
      return { ok: false, error: zcodeError(error) };
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
    if (this.#closed) return rejected("invalidState", "ZCode Session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (this.#configuring) return rejected("sessionBusy", "ZCode Session is busy");
    if (command.type === "turn.start") return this.#start(command);
    if (this.#active && command.type === "permissionMode.select") {
      return rejected("sessionBusy", "ZCode Permission Mode cannot change during an active Turn");
    }
    this.#configuring = true;
    try {
      let snapshot: JsonObject;
      if (command.type === "model.select") {
        snapshot = await this.transport.setModel(
          zcodeNativeModel(command.model),
          this.initialState.effectiveThinkingOptionId,
        );
      } else if (command.type === "thinking.select") {
        const thinking = harnessThinkingOptionIdSchema.parse(command.thinkingOptionId);
        const available = this.initialState.availableThinkingOptions?.some(
          ({ id }) => id === thinking,
        );
        if (available === false)
          return rejected("invalidRequest", "Thinking option is unavailable in ZCode");
        snapshot = await this.transport.setThoughtLevel(thinking);
      } else {
        const mode = harnessPermissionModeIdSchema.parse(command.permissionModeId);
        if (!ZCODE_PERMISSION_MODES.modes.some(({ id }) => id === mode)) {
          return rejected("invalidRequest", "Permission Mode is unavailable in ZCode");
        }
        snapshot = await this.transport.setMode(mode);
      }
      this.#apply(snapshot);
      const confirmed =
        command.type === "model.select"
          ? this.initialState.effectiveModel?.id === command.model.id
          : command.type === "thinking.select"
            ? this.initialState.effectiveThinkingOptionId === command.thinkingOptionId
            : this.initialState.effectivePermissionModeId === command.permissionModeId;
      return confirmed
        ? { ok: true, value: { completed: true } }
        : rejected("nativeFailure", "ZCode did not confirm the requested configuration");
    } catch (error) {
      return { ok: false, error: zcodeError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  async #start(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    const input = command.input.map(({ text }) => text).join("\n");
    if (!input.trim()) return rejected("invalidRequest", "ZCode requires nonempty text input");
    if (this.#submitted.has(command.turnId)) {
      return rejected("invalidState", "ZCode Turn was already submitted");
    }
    this.#submitted.add(command.turnId);
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveTurn = {
      command,
      projection: new ZcodeTurnProjection(command.turnId, (event) =>
        this.#channel.emit({ kind: "event", event }),
      ),
      cancelled: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    void this.transport.send(input).catch((error) => {
      if (this.#active === active) {
        this.#finish(active, { status: "failed", error: zcodeError(error, "nativeFailure") });
      }
    });
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return rejected("invalidState", "ZCode Turn Cancel must reference the active Turn");
    }
    if (active.cancelled) return { ok: true, value: { cancellationRequested: true } };
    active.cancelled = true;
    this.#interactions.cancel();
    let forcedClose = false;
    const timer = setTimeout(() => {
      if (this.#active !== active) return;
      forcedClose = true;
      this.#finish(active, { status: "cancelled", reason: "Cancelled by user" });
      void this.close().catch(() => undefined);
    }, 5_000);
    timer.unref();
    void active.completion.finally(() => clearTimeout(timer));
    try {
      await this.transport.stop();
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      if (forcedClose || this.#closed) {
        return { ok: true, value: { cancellationRequested: true } };
      }
      clearTimeout(timer);
      active.cancelled = false;
      return { ok: false, error: zcodeError(error, "nativeFailure") };
    }
  }

  handleEvent(event: ZcodeEvent): void {
    const active = this.#active;
    if (!active) return;
    if (event.type === "turn.started") {
      if (event.turnId) active.nativeTurnId = event.turnId;
      return;
    }
    if (active.nativeTurnId && event.turnId && event.turnId !== active.nativeTurnId) return;
    active.projection.update(event);
    if (event.type === "turn.completed") {
      const payload = record(event.payload);
      if (typeof payload.response === "string")
        active.projection.appendTerminalText(payload.response);
      const resultType = typeof payload.resultType === "string" ? payload.resultType : "unknown";
      const outcome: TurnOutcome =
        active.cancelled || resultType === "cancelled"
          ? { status: "cancelled", reason: "Cancelled by user" }
          : resultType === "success"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `ZCode stopped: ${resultType}`,
                  retryable: false,
                },
              };
      this.#updateUsageFromTerminal(payload, active.command.turnId);
      this.#finish(active, outcome, event.turnId);
    } else if (event.type === "turn.failed") {
      const error = record(record(event.payload).error);
      this.#finish(
        active,
        active.cancelled
          ? { status: "cancelled", reason: "Cancelled by user" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: typeof error.message === "string" ? error.message : "ZCode Turn failed",
                retryable: error.retryable === true,
              },
            },
        event.turnId,
      );
    }
  }

  handlePermission(params: JsonObject): Promise<JsonValue> {
    const active = this.#active;
    return active
      ? this.#interactions.permission(active.command.turnId, params)
      : Promise.resolve({ decision: "deny" });
  }

  handleUserInput(params: JsonObject): Promise<JsonValue> {
    const active = this.#active;
    return active
      ? this.#interactions.userInput(active.command.turnId, params)
      : Promise.resolve({ action: "cancel" });
  }

  handleFault(error: ZcodeTransportError): void {
    if (this.#closed) return;
    const active = this.#active;
    if (active) this.#finish(active, { status: "failed", error: zcodeError(error) });
    this.#channel.emit({
      kind: "event",
      event: { type: "session.faulted", error: zcodeError(error) },
    });
  }

  async refreshUsage(): Promise<void> {
    if (this.#closed) return;
    try {
      const usage = usageFrom(await this.transport.usage(), this.transport.snapshot);
      this.#usage = usage;
      this.#channel.emit({ kind: "event", event: { type: "session.usage.changed", usage } });
    } catch {
      // Usage is optional; preserve the last confirmed value on refresh failure.
    }
  }

  #updateUsageFromTerminal(payload: JsonObject, turnId: HostTurnId): void {
    const native = record(payload.usage);
    if (!Object.keys(native).length) {
      void this.refreshUsage();
      return;
    }
    const cache = record(native.cache);
    const usage: JsonObject = {};
    const copy = (target: string, value: JsonValue | undefined): void => {
      if (value !== undefined) usage[target] = value;
    };
    copy("inputTokens", native.input);
    copy("outputTokens", native.output);
    copy("reasoningTokens", native.reasoning);
    copy("cacheReadTokens", cache.read);
    copy("cacheCreationTokens", cache.write);
    copy("totalTokens", native.total);
    const mapped = usageFrom(usage, this.transport.snapshot);
    if (!mapped) return;
    this.#usage = mapped;
    this.#channel.emit({
      kind: "event",
      event: { type: "session.usage.changed", usage: mapped, observedForTurnId: turnId },
    });
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome, nativeTurnId?: string): void {
    if (this.#active !== active) return;
    this.#interactions.cancel();
    const itemOutcome =
      outcome.status === "succeeded"
        ? ({ status: "succeeded" } as const)
        : outcome.status === "cancelled"
          ? ({
              status: "cancelled",
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            } as const)
          : ({ status: "failed", error: outcome.error } as const);
    active.projection.finish(itemOutcome);
    const nativeId = nativeTurnId ?? active.nativeTurnId;
    this.#active = undefined;
    active.resolveCompletion();
    this.#channel.emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: active.command.turnId,
        outcome,
        ...(nativeId
          ? {
              nativeTurnRef: nativeTurnRefSchema.parse({
                harnessId: "zcode",
                nativeSessionId: this.transport.sessionId,
                nativeTurnKey: nativeId,
                formatVersion: 1,
              }),
            }
          : {}),
      },
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) {
      active.cancelled = true;
      this.#interactions.cancel();
      void this.transport.stop().catch(() => undefined);
    }
    try {
      await this.transport.close();
      await Promise.race([
        active?.completion ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (active && this.#active === active) {
        this.#finish(active, { status: "cancelled", reason: "Session closed" });
      }
    } finally {
      this.#channel.end();
      this.onClose();
    }
  }
}
