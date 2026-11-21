import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ClientMessage, type ServerMessage, type User } from "../shared/protocol.ts";
import { BoardStore } from "./board.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  redisUrl: string;
  heartbeatMs?: number;
  instanceId?: string;
  keyPrefix?: string;
}

export interface BoardServer {
  port: number;
  instanceId: string;
  connectionCount(): number;
  close(): Promise<void>;
}

interface Conn {
  id: string;
  ws: WebSocket;
  board?: string;
  user?: User;
  sent: number;
  pumping: boolean;
  again: boolean;
  alive: boolean;
  joining: boolean;
  member?: string;
}

const MAX_PAYLOAD = 16 * 1024;

export async function startBoardServer(opts: ServerOptions): Promise<BoardServer> {
  const instanceId = opts.instanceId ?? randomUUID().slice(0, 8);
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const prefix = opts.keyPrefix ?? "lb";
  const redis = new Redis(opts.redisUrl);
  const sub = new Redis(opts.redisUrl);
  const store = new BoardStore(redis, prefix);
  const conns = new Set<Conn>();
  const lastPresence = new Map<string, string>();

  const http: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, instance: instanceId, connections: conns.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });

  const send = (c: Conn, msg: ServerMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };

  // ---- delivery: every connection is walked forward from its own pointer,
  // so a replay and a live event are the same code and cannot overlap.
  async function pump(c: Conn): Promise<void> {
    if (!c.board) return;
    if (c.pumping) {
      c.again = true;
      return;
    }
    c.pumping = true;
    try {
      do {
        c.again = false;
        for (;;) {
          const batch = await store.eventsAfter(c.board, c.sent);
          if (batch.length === 0) break;
          for (const ev of batch) {
            if (ev.seq !== c.sent + 1) throw new Error(`log gap at ${c.sent + 1}`);
            send(c, { type: "event", event: ev });
            c.sent = ev.seq;
          }
        }
      } while (c.again);
    } catch (err) {
      send(c, { type: "error", message: String(err instanceof Error ? err.message : err) });
    } finally {
      c.pumping = false;
    }
  }

  const ttl = () => heartbeatMs * 3;

  async function presenceList(board: string): Promise<User[]> {
    const k = store.keys(board).presence;
    const now = Date.now();
    await redis.zremrangebyscore(k, "-inf", now - ttl());
    const members = await redis.zrangebyscore(k, now - ttl(), "+inf");
    const byId = new Map<string, User>();
    for (const m of members) {
      const { user } = JSON.parse(m) as { user: User };
      byId.set(user.id, user);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async function broadcastPresence(board: string, force = false): Promise<void> {
    const users = await presenceList(board);
    const json = JSON.stringify(users);
    if (!force && lastPresence.get(board) === json) return;
    lastPresence.set(board, json);
    for (const c of conns) if (c.board === board && c.user) send(c, { type: "presence", users });
  }

  async function leave(c: Conn): Promise<void> {
    conns.delete(c);
    if (!c.board || !c.member) return;
    const board = c.board;
    const k = store.keys(board);
    await redis.zrem(k.presence, c.member);
    await redis.publish(k.presenceChange, instanceId);
    await broadcastPresence(board);
  }

  async function hello(c: Conn, m: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    if (c.board || c.joining) {
      send(c, { type: "error", message: "already joined" });
      return;
    }
    c.joining = true;
    // Work out where this connection starts before it is attached to the
    // board, so a live event cannot be pumped from the wrong place.
    const current = await store.currentSeq(m.board);
    let sent: number;
    if (m.lastSeq === null || m.lastSeq > current) {
      const snap = await store.snapshot(m.board);
      sent = snap.seq;
      send(c, { type: "snapshot", seq: snap.seq, cards: snap.cards });
    } else {
      sent = m.lastSeq;
    }
    c.sent = sent;
    c.board = m.board;
    c.user = m.user;
    const k = store.keys(m.board);
    c.member = JSON.stringify({ k: `${instanceId}:${c.id}`, user: m.user });
    await redis.zadd(k.presence, Date.now(), c.member);
    await redis.publish(k.presenceChange, instanceId);
    await pump(c);
    await broadcastPresence(m.board, true);
  }

  async function mutate(c: Conn, m: Exclude<ClientMessage, { type: "hello" }>): Promise<void> {
    if (!c.board || !c.user) {
      send(c, { type: "error", message: "say hello first" });
      return;
    }
    const result = await store.mutate(c.board, c.user.id, {
      kind: m.type,
      id: m.id,
      ...(m.type === "create" ? { column: m.column, title: m.title } : {}),
      ...(m.type === "move" ? { column: m.column, baseVersion: m.baseVersion } : {}),
      ...(m.type === "rename" ? { title: m.title, baseVersion: m.baseVersion } : {}),
    });
    if (result.ok) send(c, { type: "ack", reqId: m.reqId, seq: result.event.seq });
    else send(c, { type: "rejected", reqId: m.reqId, reason: result.reason, ...(result.card ? { card: result.card } : {}) });
  }

  wss.on("connection", (ws) => {
    const c: Conn = { id: randomUUID().slice(0, 8), ws, sent: 0, pumping: false, again: false, alive: true, joining: false };
    conns.add(c);
    ws.on("pong", () => {
      c.alive = true;
    });
    ws.on("message", (data) => {
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        send(c, { type: "error", message: parsed.error });
        return;
      }
      const task = parsed.message.type === "hello" ? hello(c, parsed.message) : mutate(c, parsed.message);
      task.catch((err: unknown) => send(c, { type: "error", message: String(err instanceof Error ? err.message : err) }));
    });
    ws.on("close", () => {
      void leave(c).catch(() => undefined);
    });
    ws.on("error", () => undefined);
  });

  // ---- fan out between instances
  await sub.psubscribe(`${prefix}:*:events`, `${prefix}:*:presencechange`);
  sub.on("pmessage", (_pattern, channel, message) => {
    const rest = channel.slice(prefix.length + 1);
    const board = rest.slice(0, rest.lastIndexOf(":"));
    const kind = rest.slice(rest.lastIndexOf(":") + 1);
    if (kind === "events") {
      for (const c of conns) if (c.board === board) void pump(c);
    } else if (message !== instanceId) {
      void broadcastPresence(board).catch(() => undefined);
    }
  });

  // ---- heartbeat: a socket that did not answer the last ping is dead, close
  // frame or not. Live sockets refresh their presence score.
  const timer = setInterval(() => {
    const live: Conn[] = [];
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
      live.push(c);
    }
    const boards = new Set<string>();
    const pipe = redis.pipeline();
    for (const c of live) {
      if (c.board && c.member) {
        pipe.zadd(store.keys(c.board).presence, Date.now(), c.member);
        boards.add(c.board);
      }
    }
    void pipe
      .exec()
      .then(() => Promise.all([...boards].map((b) => broadcastPresence(b))))
      .catch(() => undefined);
  }, heartbeatMs);

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    port,
    instanceId,
    connectionCount: () => conns.size,
    async close() {
      clearInterval(timer);
      for (const c of conns) c.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      sub.disconnect();
      redis.disconnect();
    },
  };
}
