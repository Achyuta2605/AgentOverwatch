import type { ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import spawn from "cross-spawn";

export interface UpstreamOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Spawns the real MCP server as a child process and speaks newline-delimited
 * JSON-RPC over its stdin/stdout. Unlike the SDK's StdioClientTransport, it
 * passes the full parent environment through and reports the exit code.
 * The child's stderr is inherited, so server logs reach the agent's log as before.
 */
export class UpstreamProcess implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  /** Called once when the child exits, with its exit code (null if killed by a signal). */
  onexit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  private exited = false;

  constructor(private readonly options: UpstreamOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        env: this.options.env ?? process.env,
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
      this.child = child;

      child.once("error", (err) => {
        if (!child.pid) {
          reject(err);
          return;
        }
        this.onerror?.(err);
      });
      child.once("spawn", () => resolve());
      child.once("exit", (code, signal) => {
        this.exited = true;
        this.onexit?.(code, signal);
        this.onclose?.();
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
      child.stdin?.on("error", (err) => this.onerror?.(err));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error("Upstream server is not running"));
        return;
      }
      const ok = stdin.write(serializeMessage(message), (err) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else stdin.once("drain", resolve);
    });
  }

  /** Ends stdin, then escalates to SIGTERM and SIGKILL if the child does not exit. */
  async close(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const wait = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);

    child.stdin?.end();
    if (await wait(graceMs)) return;
    child.kill("SIGTERM");
    if (await wait(graceMs)) return;
    child.kill("SIGKILL");
    await wait(graceMs);
  }
}
