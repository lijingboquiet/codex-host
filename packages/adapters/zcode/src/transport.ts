import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import { jsonValueSchema, type JsonObject, type JsonValue } from "@codexhost/shared-contracts";
import { resolveZcodeExecutable, zcodeInvocation } from "./command.js";
import type { ZcodeModelSelection } from "./models.js";

export interface ZcodeWorkspace {
  workspacePath: string;
  workspaceKey: string;
}

export interface ZcodeEvent extends JsonObject {
  type: string;
  sessionId: string;
  turnId?: string;
  eventId: string;
  seq: number;
  timestamp: number;
  payload?: JsonValue;
}

export interface ZcodeTransportCallbacks {
  event(event: ZcodeEvent): void;
  permission(params: JsonObject): Promise<JsonValue>;
  userInput(params: JsonObject): Promise<JsonValue>;
  fault(error: ZcodeTransportError): void;
}

export interface ZcodeTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  runtimePreferences?: {
    nativeSearchEnhancementsEnabled?: boolean;
    memoryEnabled?: boolean;
  };
}

export class ZcodeTransportError extends Error {
  constructor(
    readonly kind: "notInstalled" | "unavailable" | "protocolError" | "processExited",
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "ZcodeTransportError";
  }
}

interface PendingRequest {
  method: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function record(value: unknown): JsonObject {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success &&
    parsed.data &&
    typeof parsed.data === "object" &&
    !Array.isArray(parsed.data)
    ? parsed.data
    : {};
}

function nonBlank(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function protocolError(message: string): ZcodeTransportError {
  return new ZcodeTransportError("protocolError", message);
}

function workspaceValue(workspace: ZcodeWorkspace): JsonObject {
  return { workspacePath: workspace.workspacePath, workspaceKey: workspace.workspaceKey };
}

function modelValue(model: ZcodeModelSelection, thoughtLevel?: string): JsonObject {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
  };
}

export class ZcodeTransport {
  sessionId = "";
  snapshot: JsonObject | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #callbacks: ZcodeTransportCallbacks | undefined;
  #buffer = "";
  #stderr = "";
  #nextId = 1;
  #closed = false;
  #faulted = false;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  readonly #ready = new Promise<void>((resolve, reject) => {
    this.#readyResolve = resolve;
    this.#readyReject = reject;
  });

  constructor(readonly options: ZcodeTransportOptions) {
    void this.#ready.catch(() => undefined);
  }

  async open(
    input:
      | {
          kind: "create";
          workspace: ZcodeWorkspace;
          model?: ZcodeModelSelection;
          thoughtLevel?: string;
          mode: string;
        }
      | { kind: "resume"; workspace: ZcodeWorkspace; sessionId: string; thoughtLevel?: string },
    callbacks: ZcodeTransportCallbacks,
  ): Promise<JsonObject> {
    if (this.#child || this.#closed) throw new Error("ZCode transport cannot be reopened");
    this.#callbacks = callbacks;
    const executable = resolveZcodeExecutable({
      ...(this.options.command ? { command: this.options.command } : {}),
      environment: this.options.environment,
    });
    const invocation = zcodeInvocation(
      executable,
      ["app-server", "--surface", "desktop", "--cwd", this.options.cwd],
      this.options.environment,
    );
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.options.cwd,
      env: this.options.environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: "pipe",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = sanitizeDiagnosticTail(`${this.#stderr}${chunk}`);
    });
    child.on("error", (error) =>
      this.#fault(new ZcodeTransportError("unavailable", error.message)),
    );
    child.on("exit", (code, signal) => {
      if (this.#closed) return;
      this.#fault(
        new ZcodeTransportError(
          "processExited",
          `ZCode app-server exited (${code ?? signal ?? "unknown"})`,
          this.#stderr,
        ),
      );
    });

    try {
      await this.#bounded(this.#ready, "ZCode storage initialization");
      const result = await this.request(
        input.kind === "create" ? "session/create" : "session/resume",
        input.kind === "create"
          ? {
              workspace: workspaceValue(input.workspace),
              mode: input.mode,
              ...(input.model ? { model: modelValue(input.model, input.thoughtLevel) } : {}),
              ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
            }
          : {
              sessionId: input.sessionId,
              workspace: workspaceValue(input.workspace),
              ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
            },
      );
      const snapshot = record(result);
      const session = record(snapshot.session);
      const sessionId = nonBlank(session.sessionId) ?? nonBlank(snapshot.sessionId);
      if (!sessionId) throw protocolError("ZCode returned no Native Session identity");
      if (input.kind === "resume" && sessionId !== input.sessionId) {
        throw protocolError("ZCode Resume changed the Native Session identity");
      }
      const workspace = record(session.workspace);
      if (nonBlank(workspace.workspacePath) !== input.workspace.workspacePath) {
        throw protocolError("ZCode Session workspace does not match the requested cwd");
      }
      this.sessionId = sessionId;
      this.snapshot = snapshot;
      const runtime = record(snapshot.runtime);
      const afterSeq = typeof runtime.eventSeq === "number" ? runtime.eventSeq : undefined;
      const subscribed = record(
        await this.request("session/subscribe", {
          sessionId,
          deliveryKind: "desktop-continuous",
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          includeSnapshot: true,
        }),
      );
      const subscribedSnapshot = record(subscribed.snapshot);
      if (Object.keys(subscribedSnapshot).length) this.snapshot = subscribedSnapshot;
      if (Array.isArray(subscribed.events)) {
        for (const event of subscribed.events) this.#handleEvent(record(event));
      }
      return this.snapshot ?? snapshot;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(method: string, params: JsonObject = {}): Promise<JsonValue> {
    const child = this.#child;
    if (!child || this.#closed || child.stdin.destroyed) {
      return Promise.reject(new ZcodeTransportError("processExited", "ZCode app-server is closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ZcodeTransportError("unavailable", `ZCode '${method}' timed out`, this.#stderr));
      }, this.options.timeoutMs ?? 30_000);
      this.#pending.set(id, { method, resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new ZcodeTransportError("processExited", error.message, this.#stderr));
      });
    });
  }

  read(): Promise<JsonValue> {
    return this.request("session/read", { sessionId: this.sessionId });
  }

  messages(): Promise<JsonValue> {
    return this.request("session/messages", { sessionId: this.sessionId });
  }

  historyEvents(): Promise<JsonValue> {
    return this.request("session/events", { sessionId: this.sessionId });
  }

  usage(): Promise<JsonValue> {
    return this.request("session/usage", { sessionId: this.sessionId });
  }

  send(content: string): Promise<JsonValue> {
    return this.request("session/send", { sessionId: this.sessionId, content });
  }

  stop(): Promise<JsonValue> {
    return this.request("session/stop", { sessionId: this.sessionId });
  }

  setModel(model: ZcodeModelSelection, thoughtLevel?: string): Promise<JsonObject> {
    return this.#configure("session/setModel", {
      sessionId: this.sessionId,
      model: modelValue(model, thoughtLevel),
    });
  }

  setThoughtLevel(thoughtLevel: string): Promise<JsonObject> {
    return this.#configure("session/setThoughtLevel", { sessionId: this.sessionId, thoughtLevel });
  }

  setMode(mode: string): Promise<JsonObject> {
    return this.#configure("session/setMode", { sessionId: this.sessionId, mode });
  }

  async #configure(method: string, params: JsonObject): Promise<JsonObject> {
    await this.request(method, params);
    const snapshot = record(await this.read());
    this.snapshot = snapshot;
    return snapshot;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const child = this.#child;
    if (child && this.sessionId && child.exitCode === null && !child.stdin.destroyed) {
      await Promise.race([
        this.request("session/close", { sessionId: this.sessionId }).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, this.options.closeTimeoutMs ?? 1_000)),
      ]);
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new ZcodeTransportError("processExited", "ZCode app-server closed"));
    }
    this.#pending.clear();
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, this.options.closeTimeoutMs ?? 1_000)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }

  async #bounded<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new ZcodeTransportError("unavailable", `${label} timed out`, this.#stderr)),
            this.options.timeoutMs ?? 30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame: JsonObject;
      try {
        frame = record(JSON.parse(line));
      } catch {
        this.#fault(protocolError("ZCode app-server returned invalid JSON"));
        return;
      }
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: JsonObject): void {
    if (typeof frame.id === "number" && typeof frame.method !== "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timeout);
      if (frame.error !== undefined) {
        const error = record(frame.error);
        pending.reject(
          new ZcodeTransportError(
            "protocolError",
            nonBlank(error.message) ?? `ZCode '${pending.method}' failed`,
            this.#stderr,
          ),
        );
      } else {
        pending.resolve(frame.result ?? null);
      }
      return;
    }
    if (typeof frame.id === "string" && typeof frame.method === "string") {
      void this.#handleServerRequest(frame);
      return;
    }
    if (frame.method === "startup/storageState") {
      const params = record(frame.params);
      if (params.phase === "ready") this.#readyResolve();
      else if (params.phase === "failed") {
        this.#readyReject(
          new ZcodeTransportError(
            "unavailable",
            `ZCode storage initialization failed${typeof params.errorCode === "string" ? `: ${params.errorCode}` : ""}`,
            this.#stderr,
          ),
        );
      }
      return;
    }
    if (frame.method === "session/event") this.#handleEvent(record(frame.params));
  }

  #handleEvent(value: JsonObject): void {
    if (value.sessionId !== this.sessionId || typeof value.type !== "string") return;
    const parsed = jsonValueSchema.safeParse(value);
    if (!parsed.success || Array.isArray(parsed.data) || parsed.data === null) return;
    const event = parsed.data as unknown as ZcodeEvent;
    this.#callbacks?.event(event);
  }

  async #handleServerRequest(frame: JsonObject): Promise<void> {
    const child = this.#child;
    if (!child || child.stdin.destroyed || typeof frame.id !== "string") return;
    const params = record(frame.params);
    try {
      let result: JsonValue;
      if (frame.method === "session/requestRuntimePreferences") {
        result = {
          nativeSearchEnhancementsEnabled:
            this.options.runtimePreferences?.nativeSearchEnhancementsEnabled ?? false,
          memoryEnabled: this.options.runtimePreferences?.memoryEnabled ?? false,
          askUserQuestionAutoResolutionEnabled: false,
          modelContextBudgetStrategy: "preflight-v1",
        };
      } else if (frame.method === "interaction/requestPermission") {
        result = this.#callbacks ? await this.#callbacks.permission(params) : { decision: "deny" };
      } else if (frame.method === "interaction/requestUserInput") {
        result = this.#callbacks ? await this.#callbacks.userInput(params) : { action: "cancel" };
      } else {
        child.stdin.write(
          `${JSON.stringify({ id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } })}\n`,
        );
        return;
      }
      child.stdin.write(`${JSON.stringify({ id: frame.id, result })}\n`);
    } catch (error) {
      child.stdin.write(
        `${JSON.stringify({ id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`,
      );
    }
  }

  #fault(error: ZcodeTransportError): void {
    if (this.#faulted || this.#closed) return;
    this.#faulted = true;
    this.#readyReject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#callbacks?.fault(error);
  }
}
