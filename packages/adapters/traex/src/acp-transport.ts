import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  CreateElicitationRequest,
  RequestError,
  ndJsonStream,
  type CreateElicitationResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { resolveTraexExecutable, traexInvocation } from "./command.js";

export interface TraexTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  permissionModeId: string;
  command?: string;
  timeoutMs?: number;
}

export type TraexSessionInfo = NewSessionResponse | LoadSessionResponse;

export interface TraexCallbacks {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  elicitation(value: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export class TraexTransport {
  sessionId = "";
  replay: SessionNotification[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #callbacks: TraexCallbacks | undefined;
  #closed = false;
  #fault: Error | undefined;
  #rejectFault!: (error: Error) => void;
  readonly #failed = new Promise<never>((_, reject) => {
    this.#rejectFault = reject;
  });

  constructor(readonly options: TraexTransportOptions) {
    void this.#failed.catch(() => undefined);
  }

  async #bounded<T>(work: Promise<T>, label: string): Promise<T> {
    if (this.#fault) throw this.#fault;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        this.#failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} timed out`));
            void this.close();
          }, this.options.timeoutMs ?? 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async open(sessionId?: string): Promise<TraexSessionInfo> {
    if (this.#closed || this.#connection) throw new Error("TraeX transport cannot be reopened");
    const executable = resolveTraexExecutable({
      ...(this.options.command ? { command: this.options.command } : {}),
      environment: this.options.environment,
    });
    const invocation = traexInvocation(
      executable,
      ["--permission-mode", this.options.permissionModeId, "acp", "serve"],
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
    const fault = (message: string) => {
      if (this.#closed || this.#fault) return;
      this.#fault = new Error(message);
      this.#rejectFault(this.#fault);
    };
    child.on("error", () => fault("TraeX ACP process could not start"));
    child.on("exit", (code, signal) =>
      fault(`TraeX ACP process exited (${code ?? signal ?? "unknown"})`),
    );
    child.stderr.resume();
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (value) => {
          if (this.sessionId && value.sessionId !== this.sessionId) return;
          if (this.replay.length >= 100_000) {
            fault("TraeX replay exceeds the supported history limit");
            return;
          }
          this.replay.push(value);
          this.#callbacks?.update(value);
        },
        requestPermission: (value) =>
          this.#callbacks && value.sessionId === this.sessionId
            ? this.#callbacks.permission(value)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        unstable_createElicitation: (value) =>
          this.#callbacks &&
          CreateElicitationRequest.isForm(value) &&
          "sessionId" in value &&
          value.sessionId === this.sessionId
            ? this.#callbacks.elicitation(value)
            : Promise.resolve({ action: "cancel" }),
        extMethod: (method) => {
          throw RequestError.methodNotFound(method);
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    try {
      const initialized = await this.#bounded(
        this.#connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "codexhost", version: "0.6.2" },
        }),
        "TraeX ACP initialize",
      );
      if (
        initialized.protocolVersion !== 1 ||
        (sessionId && !initialized.agentCapabilities?.loadSession)
      )
        throw new Error("TraeX does not support the required ACP session protocol");
      this.sessionId = sessionId ?? "";
      const info = sessionId
        ? await this.#bounded(
            this.#connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers: [] }),
            "TraeX Session load",
          )
        : await this.#bounded(
            this.#connection.newSession({ cwd: this.options.cwd, mcpServers: [] }),
            "TraeX Session create",
          );
      if ("sessionId" in info && typeof info.sessionId === "string")
        this.sessionId = info.sessionId;
      if (!this.sessionId) throw new Error("TraeX returned no Native Session identity");
      return info;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async configure(configId: string, value: string) {
    if (!this.#connection || this.#closed) throw new Error("TraeX Session is closed");
    return this.#bounded(
      this.#connection.setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
      "TraeX configuration",
    );
  }

  async prompt(text: string, callbacks: TraexCallbacks): Promise<PromptResponse> {
    if (!this.#connection || this.#closed || this.#callbacks)
      throw new Error("TraeX Session is closed or busy");
    this.#callbacks = callbacks;
    try {
      return await Promise.race([
        this.#connection.prompt({
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        }),
        this.#failed,
      ]);
    } finally {
      this.#callbacks = undefined;
    }
  }

  async cancel() {
    if (this.#connection && !this.#closed)
      await this.#bounded(
        this.#connection.cancel({ sessionId: this.sessionId }),
        "TraeX cancellation",
      );
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#fault = new Error("TraeX Session closed");
    this.#rejectFault(this.#fault);
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 750)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await Promise.race([
          new Promise<void>((resolve) => killer.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
