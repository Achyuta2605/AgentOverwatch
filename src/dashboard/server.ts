import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { formatDiff } from "../format.js";
import type { LogStore } from "../store.js";

export interface DashboardOptions {
  store: LogStore;
  port: number;
  /** Folder with the built page. Defaults to dist/dashboard next to this file. */
  staticDir?: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const int = (v: string | undefined, d: number, max = 1000) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d;
};

/**
 * The dashboard API. Read-only except approving pins, which needs the per-run token so that no other
 * web page can trigger it. Requests whose Host is not localhost are refused (DNS rebinding).
 */
export function createDashboardApp(store: LogStore, token: string, staticDir: string): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return c.text("forbidden host", 403);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });

  app.get("/api/overview", (c) => {
    const since = Date.now() - 24 * 3600_000;
    return c.json(store.stats(since));
  });

  app.get("/api/sessions", (c) =>
    c.json(
      store.listSessions(int(c.req.query("limit"), 50)).map((s) => ({ ...s, alive: !s.ended_at && alive(s.pid) })),
    ),
  );

  app.get("/api/calls", (c) =>
    c.json(
      store
        .listCalls({
          limit: int(c.req.query("limit"), 100),
          sessionId: c.req.query("session") || undefined,
          serverName: c.req.query("server") || undefined,
          toolName: c.req.query("tool") || undefined,
          onlyBlocked: c.req.query("filter") === "blocked",
          onlyProblems: c.req.query("filter") === "problems",
        })
        .map(({ request_json, response_json, ...row }) => ({
          ...row,
          request_preview: request_json?.slice(0, 200) ?? null,
        })),
    ),
  );

  app.get("/api/calls/:id", (c) => {
    const row = store.getCall(int(c.req.param("id"), 0, Number.MAX_SAFE_INTEGER));
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/events", (c) =>
    c.json(store.listEvents({ limit: int(c.req.query("limit"), 100), serverName: c.req.query("server") || undefined })),
  );

  app.get("/api/pins", (c) =>
    c.json(
      store.listPins(c.req.query("server") || undefined).map((p) => ({
        server_name: p.server_name,
        tool_name: p.tool_name,
        state: p.pending_hash ? (p.approved_hash ? "changed" : "new") : "pinned",
        diff: p.pending_hash ? formatDiff(p) : null,
        approved_at: p.approved_at,
      })),
    ),
  );

  app.post("/api/pins/approve", async (c) => {
    const given = Buffer.from(c.req.header("x-agentoverwatch-token") ?? "");
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "bad token" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { server?: unknown; tool?: unknown };
    if (typeof body.server !== "string" || (body.tool !== undefined && typeof body.tool !== "string"))
      return c.json({ error: "server (and optional tool) required" }, 400);
    const approved = store.approvePending(body.server, body.tool as string | undefined, Date.now());
    return c.json({ approved });
  });

  // The page itself. The token is injected so only this page can approve pins.
  app.get("*", (c) => {
    const rel = normalize(c.req.path).replace(/^([/\\])+/, "");
    const file = join(staticDir, rel);
    if (rel && !rel.includes("..") && file.startsWith(staticDir) && existsSync(file) && !file.endsWith(".html")) {
      return c.body(readFileSync(file), 200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    }
    const index = join(staticDir, "index.html");
    if (!existsSync(index)) return c.text("Dashboard page not built. Run: npm run build", 500);
    const html = readFileSync(index, "utf8").replace(
      "</head>",
      `<meta name="agentoverwatch-token" content="${token}"></head>`,
    );
    return c.html(html, 200, { "Cache-Control": "no-store" });
  });

  return app;
}

export function defaultStaticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

/** Starts the dashboard on 127.0.0.1 only. Resolves with the URL once listening. */
export function startDashboard(opts: DashboardOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(24).toString("hex");
  const app = createDashboardApp(opts.store, token, opts.staticDir ?? defaultStaticDir());
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}
