import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTraexNativeTurns } from "../src/history.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = path.join(os.tmpdir(), `codexhost-traex-history-${randomUUID()}`);
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const directory = path.join(root, "cli", "sessions", "2026", "09", "18");
  mkdirSync(directory, { recursive: true });
  mkdirSync(cwd);
  const rows = [
    { type: "session_meta", payload: { id: sessionId, cwd } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: { type: "UserMessage", content: [{ type: "text", text: "hello" }] },
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  writeFileSync(
    path.join(directory, `rollout-2026-09-18T00-00-00-${sessionId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { root, cwd, sessionId, turnId };
}

describe("TraeX Native history", () => {
  it("uses task_started Turn ids and validates cwd", () => {
    const f = fixture();
    expect(readTraexNativeTurns(f.sessionId, f.cwd, { TRAE_HOME: f.root })).toEqual([
      { id: f.turnId, text: "hello" },
    ]);
    expect(() =>
      readTraexNativeTurns(f.sessionId, path.join(f.root, "other"), { TRAE_HOME: f.root }),
    ).toThrow("workspace");
  });
});
