import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import WebSocket from "ws";
import type { BoardEvent, ClientMessage, ServerMessage, User } from "../src/shared/protocol.ts";
import { startBoardServer, type BoardServer, type ServerOptions } from "../src/server/server.ts";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const user = (name: string): User => ({ id: name.toLowerCase(), name });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 6000, step = 15): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(step);
  }
}

// One key prefix per test file run, so tests never see each other's boards
// and nothing has to be flushed from redis.
export class Rig {
  readonly prefix = `t${randomBytes(4).toString("hex")}`;
  servers: BoardServer[] = [];
  clients: TestClient[] = [];
  redises: Redis[] = [];

  async server(extra: Partial<ServerOptions> = {}): Promise<BoardServer> {
    const s = await startBoardServer({ redisUrl: REDIS_URL, keyPrefix: this.prefix, heartbeatMs: 5000, ...extra });
    this.servers.push(s);
    return s;
  }

  async client(server: BoardServer, opts: { autoPong?: boolean } = {}): Promise<TestClient> {
    const c = await TestClient.connect(server.port, opts);
    this.clients.push(c);
    return c;
  }

  redis(): Redis {
    const r = new Redis(REDIS_URL);
    this.redises.push(r);
    return r;
  }

  async cleanup(): Promise<void> {
    for (const c of this.clients) c.kill();
    for (const s of this.servers) await s.close();
    if (this.redises.length || this.servers.length) {
      const r = new Redis(REDIS_URL);
      const keys = await r.keys(`${this.prefix}:*`);
      if (keys.length) await r.del(...keys);
      r.disconnect();
    }
    for (const r of this.redises) r.disconnect();
    this.servers = [];
    this.clients = [];
    this.redises = [];
  }
}

export class TestClient {
  messages: ServerMessage[] = [];
  closeCode: number | undefined;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.messages.push(JSON.parse(d.toString()) as ServerMessage));
    ws.on("close", (code) => {
      this.closeCode = code;
    });
  }

  static async connect(port: number, opts: { autoPong?: boolean } = {}): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: opts.autoPong ?? true });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  hello(board: string, u: User, lastSeq: number | null = null): void {
    this.send({ type: "hello", board, user: u, lastSeq });
  }

  events(): BoardEvent[] {
    return this.messages.flatMap((m) => (m.type === "event" ? [m.event] : []));
  }

  seqs(): number[] {
    return this.events().map((e) => e.seq);
  }

  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  lastPresence(): string[] | undefined {
    const p = this.of("presence").at(-1);
    return p?.users.map((x) => x.name);
  }

  until(pred: (c: TestClient) => unknown, ms = 6000): Promise<void> {
    return waitFor(() => pred(this) || undefined, ms).then(() => undefined);
  }

  create(id: string, title: string, column: "todo" | "doing" | "done" = "todo"): void {
    this.send({ type: "create", reqId: `q${id}`, id, title, column });
  }

  close(): void {
    this.ws.close();
  }

  kill(): void {
    this.ws.terminate();
  }
}
