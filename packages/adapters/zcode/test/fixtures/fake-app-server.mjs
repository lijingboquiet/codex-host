#!/usr/bin/env node
import readline from "node:readline";

const workspacePath = process.argv.at(-1);
let sessionId = "sess_fake";
let seq = 0;
let model = { providerId: "custom", modelId: "glm-test" };
let thoughtLevel = "max";
let mode = "build";
let activeTurnId = null;
let reverseOrdinal = 0;
const pendingReverse = new Map();
const events = [];
const messages = [];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function event(type, payload, turnId = activeTurnId) {
  const value = {
    type,
    sessionId,
    ...(turnId ? { turnId } : {}),
    eventId: `event-${++seq}`,
    seq,
    timestamp: Date.now(),
    ...(payload === undefined ? {} : { payload }),
  };
  events.push(value);
  write({ method: "session/event", params: value });
}

function snapshot() {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId,
      workspace: { workspacePath, workspaceKey: workspacePath },
    },
    settings: {
      model: { current: model, available: [], lastUsed: model },
      thoughtLevel: {
        enabled: true,
        current: thoughtLevel,
        defaultLevel: "max",
        available: [
          { value: "low", label: "Low" },
          { value: "max", label: "Max" },
        ],
      },
      mode: { current: mode },
    },
    projection: { sessionId, status: activeTurnId ? "running" : "idle" },
    runtime: {
      eventSeq: seq,
      stateRevision: seq,
      pendingRequestIds: [],
      ...(activeTurnId ? { activeTurnId } : {}),
      contextUsage: { used: 15, size: 1000 },
    },
    messages,
  };
}

function reverse(method, params) {
  const id = `server-${++reverseOrdinal}`;
  write({ id, method, params });
  return new Promise((resolve) => pendingReverse.set(id, resolve));
}

async function sendTurn(content) {
  activeTurnId = `turn-${seq + 1}`;
  const turnId = activeTurnId;
  const userMessageId = `user-${seq + 1}`;
  event("turn.started", { turnNumber: 1, input: content, messageId: userMessageId }, turnId);
  if (content === "wait") return;
  if (content === "approval") {
    const response = await reverse("interaction/requestPermission", {
      requestId: "permission-1",
      sessionId,
      turnId,
      toolCallId: "tool-1",
      toolName: "shell",
      reason: "Run a command",
      riskLevel: "medium",
      input: { command: "pwd" },
      options: [
        {
          optionId: "once",
          kind: "once",
          name: "Allow once",
          response: { decision: "allow" },
        },
        { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
    });
    if (response.decision !== "allow") {
      event("turn.failed", { error: { message: "Permission denied" }, turnPhase: "tool" }, turnId);
      activeTurnId = null;
      return;
    }
  }
  event("model.streaming", { kind: "text_start" }, turnId);
  event("model.streaming", { kind: "text_delta", delta: "hello from ZCode" }, turnId);
  event("model.streaming", { kind: "text_end" }, turnId);
  event(
    "turn.completed",
    {
      response: "hello from ZCode",
      tokenCount: 5,
      toolCallCount: 0,
      duration: 1,
      resultType: "success",
      usage: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 0 }, total: 6 },
    },
    turnId,
  );
  activeTurnId = null;
}

async function handle(frame) {
  if (typeof frame.id === "string" && typeof frame.method !== "string") {
    pendingReverse.get(frame.id)?.(frame.result ?? {});
    pendingReverse.delete(frame.id);
    return;
  }
  const params = frame.params ?? {};
  if (frame.method === "session/create") {
    await reverse("session/requestRuntimePreferences", { sessionId });
    if (params.model && params.model.options?.reasoningLevel !== params.thoughtLevel) {
      write({
        id: frame.id,
        error: {
          code: -32602,
          message: `Reasoning level is required for ${params.model.providerId}/${params.model.modelId}`,
        },
      });
      return;
    }
    model = params.model ?? model;
    thoughtLevel = params.thoughtLevel ?? thoughtLevel;
    mode = params.mode ?? mode;
    write({ id: frame.id, result: snapshot() });
  } else if (frame.method === "session/resume") {
    sessionId = params.sessionId;
    write({ id: frame.id, result: snapshot() });
  } else if (frame.method === "session/subscribe") {
    write({ id: frame.id, result: { sessionId, eventSeq: seq, events: [], snapshot: snapshot() } });
  } else if (frame.method === "session/read") {
    write({ id: frame.id, result: snapshot() });
  } else if (frame.method === "session/events") {
    write({ id: frame.id, result: { events } });
  } else if (frame.method === "session/messages") {
    write({ id: frame.id, result: { messages } });
  } else if (frame.method === "session/usage") {
    write({
      id: frame.id,
      result: {
        sessionId,
        totalTokens: 6,
        inputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 1,
      },
    });
  } else if (frame.method === "session/setModel") {
    if (!params.model?.options?.reasoningLevel) {
      write({
        id: frame.id,
        error: {
          code: -32602,
          message: `Reasoning level is required for ${params.model?.providerId}/${params.model?.modelId}`,
        },
      });
      return;
    }
    model = params.model;
    write({ id: frame.id, result: {} });
  } else if (frame.method === "session/setThoughtLevel") {
    thoughtLevel = params.thoughtLevel;
    write({ id: frame.id, result: {} });
  } else if (frame.method === "session/setMode") {
    mode = params.mode;
    write({ id: frame.id, result: {} });
  } else if (frame.method === "session/send") {
    write({ id: frame.id, result: { accepted: true, sessionId, stateRevision: ++seq } });
    void sendTurn(params.content);
  } else if (frame.method === "session/stop") {
    const turnId = activeTurnId;
    write({ id: frame.id, result: {} });
    if (turnId) {
      event(
        "turn.completed",
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" },
        turnId,
      );
      activeTurnId = null;
    }
  } else if (frame.method === "session/close") {
    write({ id: frame.id, result: {} });
    process.exitCode = 0;
    setImmediate(() => process.exit());
  } else {
    write({ id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } });
  }
}

write({ method: "startup/storageState", params: { phase: "ready" } });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  void handle(frame);
});
