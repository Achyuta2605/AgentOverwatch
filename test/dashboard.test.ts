import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/dashboard/server.js";
import { LogStore } from "../src/store.js";
import { tempDir } from "./helpers.js";

let tmp: ReturnType<typeof tempDir>;
let store: LogStore;
let app: ReturnType<typeof createDashboardApp>;
const TOKEN = "t".repeat(48);
const host = { host: "127.0.0.1:4319" };

beforeEach(() => {
  tmp = tempDir();
  store = new LogStore(tmp.db);
  const ui = join(tmp.dir, "ui");
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<html><head><title>x</title></head><body></body></html>");
  writeFileSync(join(ui, "assets", "app.js"), "console.log(1)");
  app = createDashboardApp(store, TOKEN, ui);

  const now = Date.now();
  store.startSession({ id: "s1", serverName: "web", command: "node web.js", pid: undefined, startedAt: now });
  const id = store.recordRequest({
    sessionId: "s1",
    direction: "agent_to_server",
    jsonrpcId: "1",
    method: "tools/call",
    toolName: "fetch",
    params: { name: "fetch", arguments: { url: "https://example.com" } },
    startedAt: now,
  });
  store.finishRequest(id, {
    status: "blocked",
    response: { isError: true },
    errorMessage: "injection",
    durationMs: 1,
    blockedBy: "scan:injection",
  });
  store.recordEvent({
    sessionId: "s1",
    serverName: "web",
    kind: "injection_blocked",
    toolName: "fetch",
    detail: "x",
    at: now,
  });
  store.pinApproved("web", "fetch", "a", '{"description":"old"}', now);
  store.pinPending("web", "fetch", "b", '{"description":"new"}', now);
});

afterEach(() => {
  store.close();
  tmp.cleanup();
});

const get = async (path: string) => {
  const res = await app.request(path, { headers: host });
  return { status: res.status, body: (await res.json()) as unknown };
};

describe("dashboard API", () => {
  it("reports the last day's numbers", async () => {
    const { body } = await get("/api/overview");
    expect(body).toMatchObject({ toolCalls: 1, blocked: 1, events: { injection_blocked: 1 } });
  });

  it("lists calls without full payloads, and shows one call in full", async () => {
    const list = (await get("/api/calls?filter=blocked")).body as { id: number; response_json?: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("response_json");
    const one = (await get(`/api/calls/${list[0]?.id}`)).body as { request_json: string; blocked_by: string };
    expect(one.request_json).toContain("example.com");
    expect(one.blocked_by).toBe("scan:injection");
    expect((await get("/api/calls/999")).status).toBe(404);
  });

  it("lists sessions, events and pins with a diff", async () => {
    expect((await get("/api/sessions")).body).toMatchObject([{ id: "s1", alive: false }]);
    expect((await get("/api/events")).body).toMatchObject([{ kind: "injection_blocked" }]);
    const pins = (await get("/api/pins")).body as { state: string; diff: string }[];
    expect(pins[0]?.state).toBe("changed");
    expect(pins[0]?.diff).toContain('+ description: "new"');
  });

  it("approves a pin only with the page's token", async () => {
    const post = (headers: Record<string, string>) =>
      app.request("/api/pins/approve", {
        method: "POST",
        headers: { ...host, "content-type": "application/json", ...headers },
        body: JSON.stringify({ server: "web", tool: "fetch" }),
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-agentoverwatch-token": "wrong" })).status).toBe(403);
    const ok = await post({ "x-agentoverwatch-token": TOKEN });
    expect(await ok.json()).toEqual({ approved: ["fetch"] });
    expect(store.listPins("web")[0]?.pending_hash).toBeNull();
  });

  it("refuses requests for other host names (DNS rebinding)", async () => {
    const res = await app.request("/api/overview", { headers: { host: "attacker.example:4319" } });
    expect(res.status).toBe(403);
  });

  it("serves the page with the token, and assets, but never files outside the page folder", async () => {
    const page = await (await app.request("/", { headers: host })).text();
    expect(page).toContain(`<meta name="agentoverwatch-token" content="${TOKEN}">`);
    expect(await (await app.request("/assets/app.js", { headers: host })).text()).toBe("console.log(1)");
    const outside = await (await app.request("/../../package.json", { headers: host })).text();
    expect(outside).not.toContain('"name"');
  });
});
