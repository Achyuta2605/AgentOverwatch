import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { DB_ENV_VAR, HOME_DIR_NAME } from "./brand.js";

/** Payloads larger than this are cut before storage so one huge tool result cannot bloat the log. */
export const MAX_STORED_BYTES = 32 * 1024;

export type Direction = "agent_to_server" | "server_to_agent";
export type CallStatus = "pending" | "ok" | "error" | "tool_error" | "cancelled" | "no_response";

export interface SessionStart {
  id: string;
  serverName: string;
  command: string;
  pid?: number;
  startedAt: number;
}

export interface SessionRow {
  id: string;
  server_name: string;
  command: string;
  pid: number | null;
  client_name: string | null;
  client_version: string | null;
  server_info_name: string | null;
  server_info_version: string | null;
  protocol_version: string | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  call_count?: number;
  error_count?: number;
}

export interface CallRow {
  id: number;
  session_id: string;
  server_name: string;
  direction: Direction;
  jsonrpc_id: string;
  method: string;
  tool_name: string | null;
  request_json: string | null;
  response_json: string | null;
  status: CallStatus;
  error_message: string | null;
  started_at: number;
  duration_ms: number | null;
  request_bytes: number;
  response_bytes: number | null;
}

export interface CallQuery {
  limit?: number;
  sessionId?: string;
  serverName?: string;
  toolName?: string;
  onlyProblems?: boolean;
}

export function defaultDbPath(): string {
  return process.env[DB_ENV_VAR] || join(homedir(), HOME_DIR_NAME, "agentgate.db");
}

/** Serialises a value for storage, truncating very large payloads. Returns the text and the full size in bytes. */
export function encodePayload(value: unknown): { text: string | null; bytes: number } {
  if (value === undefined) return { text: null, bytes: 0 };
  const full = JSON.stringify(value);
  const bytes = Buffer.byteLength(full);
  if (bytes <= MAX_STORED_BYTES) return { text: full, bytes };
  const cut = Buffer.from(full).subarray(0, MAX_STORED_BYTES).toString("utf8");
  return { text: `${cut}…[truncated, ${bytes} bytes total]`, bytes };
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    server_name TEXT NOT NULL,
    command TEXT NOT NULL,
    pid INTEGER,
    client_name TEXT,
    client_version TEXT,
    server_info_name TEXT,
    server_info_version TEXT,
    protocol_version TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER
  );
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    direction TEXT NOT NULL,
    jsonrpc_id TEXT NOT NULL,
    method TEXT NOT NULL,
    tool_name TEXT,
    request_json TEXT,
    response_json TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    started_at INTEGER NOT NULL,
    duration_ms REAL,
    request_bytes INTEGER NOT NULL,
    response_bytes INTEGER
  );
  CREATE INDEX calls_session ON calls(session_id, started_at);
  CREATE INDEX calls_started ON calls(started_at);
  CREATE INDEX calls_tool ON calls(tool_name);
  `,
];

/**
 * Local SQLite log of every gateway session and every JSON-RPC request that crosses it.
 * WAL mode lets `agentgate logs` read while a gateway is writing.
 */
export class LogStore {
  readonly db: Database.Database;
  private readonly stmts: ReturnType<LogStore["prepare"]>;

  constructor(path: string = defaultDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.stmts = this.prepare();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS.at(v) as string;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  private prepare() {
    return {
      startSession: this.db.prepare(
        "INSERT INTO sessions (id, server_name, command, pid, started_at) VALUES (@id, @serverName, @command, @pid, @startedAt)",
      ),
      setClient: this.db.prepare(
        "UPDATE sessions SET client_name = ?, client_version = ?, protocol_version = COALESCE(?, protocol_version) WHERE id = ?",
      ),
      setServerInfo: this.db.prepare(
        "UPDATE sessions SET server_info_name = ?, server_info_version = ?, protocol_version = COALESCE(?, protocol_version) WHERE id = ?",
      ),
      endSession: this.db.prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ?"),
      insertCall: this.db.prepare(
        `INSERT INTO calls (session_id, direction, jsonrpc_id, method, tool_name, request_json, status, started_at, request_bytes)
         VALUES (@sessionId, @direction, @jsonrpcId, @method, @toolName, @requestJson, 'pending', @startedAt, @requestBytes)`,
      ),
      finishCall: this.db.prepare(
        `UPDATE calls SET status = @status, response_json = @responseJson, error_message = @errorMessage,
           duration_ms = @durationMs, response_bytes = @responseBytes WHERE id = @id`,
      ),
      abandonPending: this.db.prepare(
        "UPDATE calls SET status = 'no_response' WHERE session_id = ? AND status = 'pending'",
      ),
    };
  }

  startSession(s: SessionStart): void {
    this.stmts.startSession.run({ ...s, pid: s.pid ?? null });
  }

  setClientInfo(sessionId: string, name: string | null, version: string | null, protocol: string | null): void {
    this.stmts.setClient.run(name, version, protocol, sessionId);
  }

  setServerInfo(sessionId: string, name: string | null, version: string | null, protocol: string | null): void {
    this.stmts.setServerInfo.run(name, version, protocol, sessionId);
  }

  endSession(sessionId: string, endedAt: number, exitCode: number | null): void {
    this.db.transaction(() => {
      this.stmts.abandonPending.run(sessionId);
      this.stmts.endSession.run(endedAt, exitCode, sessionId);
    })();
  }

  /** Records a request when it is first seen. Returns the row id used to finish it later. */
  recordRequest(r: {
    sessionId: string;
    direction: Direction;
    jsonrpcId: string;
    method: string;
    toolName: string | null;
    params: unknown;
    startedAt: number;
  }): number {
    const { text, bytes } = encodePayload(r.params);
    const info = this.stmts.insertCall.run({
      sessionId: r.sessionId,
      direction: r.direction,
      jsonrpcId: r.jsonrpcId,
      method: r.method,
      toolName: r.toolName,
      requestJson: text,
      startedAt: r.startedAt,
      requestBytes: bytes,
    });
    return Number(info.lastInsertRowid);
  }

  finishRequest(
    rowId: number,
    r: { status: Exclude<CallStatus, "pending">; response?: unknown; errorMessage?: string | null; durationMs: number },
  ): void {
    const { text, bytes } = encodePayload(r.response);
    this.stmts.finishCall.run({
      id: rowId,
      status: r.status,
      responseJson: text,
      errorMessage: r.errorMessage ?? null,
      durationMs: r.durationMs,
      responseBytes: r.response === undefined ? null : bytes,
    });
  }

  listCalls(q: CallQuery = {}): CallRow[] {
    const where: string[] = [];
    const args: Record<string, unknown> = { limit: q.limit ?? 50 };
    if (q.sessionId) {
      where.push("c.session_id LIKE @session");
      args.session = `${q.sessionId}%`;
    }
    if (q.serverName) {
      where.push("s.server_name = @server");
      args.server = q.serverName;
    }
    if (q.toolName) {
      where.push("c.tool_name = @tool");
      args.tool = q.toolName;
    }
    if (q.onlyProblems) where.push("c.status NOT IN ('ok', 'pending')");
    const sql = `SELECT c.*, s.server_name FROM calls c JOIN sessions s ON s.id = c.session_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.started_at DESC, c.id DESC LIMIT @limit`;
    return this.db.prepare(sql).all(args) as CallRow[];
  }

  listSessions(limit = 20): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.*, COUNT(c.id) AS call_count,
           SUM(CASE WHEN c.status NOT IN ('ok', 'pending') THEN 1 ELSE 0 END) AS error_count
         FROM sessions s LEFT JOIN calls c ON c.session_id = s.id
         GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[];
  }

  close(): void {
    this.db.close();
  }
}
