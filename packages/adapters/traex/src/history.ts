import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TraexNativeTurn {
  id: string;
  text: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function historyRoot(environment: NodeJS.ProcessEnv): string {
  const home = environment.TRAE_HOME ?? path.join(environment.HOME ?? os.homedir(), ".trae");
  return path.join(home, "cli", "sessions");
}

export function locateTraexHistory(
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) throw new Error("Invalid TraeX Session identity");
  const root = historyRoot(environment);
  let years: string[];
  try {
    years = readdirSync(root);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const year of years) {
    if (!/^\d{4}$/u.test(year)) continue;
    for (const month of readdirSync(path.join(root, year))) {
      if (!/^\d{2}$/u.test(month)) continue;
      for (const day of readdirSync(path.join(root, year, month))) {
        if (!/^\d{2}$/u.test(day)) continue;
        const directory = path.join(root, year, month, day);
        for (const filename of readdirSync(directory)) {
          if (filename.endsWith(`-${sessionId}.jsonl`))
            matches.push(path.join(directory, filename));
        }
      }
    }
  }
  if (matches.length > 1) throw new Error("TraeX Session history is ambiguous");
  return matches[0] ?? null;
}

export function readTraexNativeTurns(
  sessionId: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  allowMissing = false,
): TraexNativeTurn[] {
  const filename = locateTraexHistory(sessionId, environment);
  if (!filename) {
    if (allowMissing) return [];
    throw new Error("TraeX Session history was not found");
  }
  if (statSync(filename).size > 64_000_000) throw new Error("TraeX history exceeds 64 MB");
  const rows = readFileSync(filename, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => record(JSON.parse(line)));
  const metadata = rows
    .filter(({ type }) => type === "session_meta")
    .map(({ payload }) => record(payload));
  if (
    !metadata.length ||
    metadata.some(
      (entry) =>
        entry.id !== sessionId ||
        typeof entry.cwd !== "string" ||
        path.resolve(entry.cwd) !== path.resolve(cwd),
    )
  ) {
    throw new Error("TraeX Session workspace or identity does not match");
  }
  const turns: TraexNativeTurn[] = [];
  const pending = new Map<string, TraexNativeTurn>();
  for (const row of rows) {
    if (row.type !== "event_msg") continue;
    const payload = record(row.payload);
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      if (turns.some(({ id }) => id === payload.turn_id) || pending.has(payload.turn_id))
        throw new Error("TraeX history contains a duplicate Turn identity");
      const turn = { id: payload.turn_id, text: "" };
      turns.push(turn);
      pending.set(payload.turn_id, turn);
      continue;
    }
    if (
      payload.type === "item_completed" &&
      typeof payload.turn_id === "string" &&
      record(payload.item).type === "UserMessage"
    ) {
      const turn = pending.get(payload.turn_id);
      const content = record(payload.item).content;
      if (!turn || !Array.isArray(content)) continue;
      turn.text = content
        .map((part) => record(part))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
    }
  }
  if (turns.some(({ id, text }) => !/^[0-9a-f-]{36}$/iu.test(id) || !text))
    throw new Error("TraeX history is missing a stable Turn prompt or identity");
  return turns;
}
