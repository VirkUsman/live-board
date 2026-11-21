import type { BoardEvent, Card, Column, ServerMessage, User } from "../shared/protocol.ts";
import {
  acknowledge,
  applyEvent,
  applySnapshot,
  emptyState,
  optimistic,
  reject,
  type BoardState,
} from "../shared/store.ts";
import { LiveConnection, type Status } from "./connection.ts";

export interface ClientView {
  board: BoardState;
  status: Status;
  notice: string | null;
}

export interface ClientOptions {
  url: string;
  board: string;
  user: User;
  WebSocketImpl?: new (url: string) => WebSocket;
  reconnectBaseMs?: number;
}

let counter = 0;
const newReqId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`;

// The board's state machine with no React in it. The hook below only
// subscribes to it.
export class BoardClient {
  private view: ClientView = { board: emptyState, status: "connecting", notice: null };
  private listeners = new Set<() => void>();
  private readonly conn: LiveConnection;

  constructor(opts: ClientOptions) {
    this.conn = new LiveConnection({
      url: opts.url,
      board: opts.board,
      user: opts.user,
      getLastSeq: () => (this.view.board.synced ? this.view.board.seq : null),
      onMessage: (m) => this.handle(m),
      onStatus: (s) => this.setStatus(s),
      ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
      ...(opts.reconnectBaseMs !== undefined ? { reconnectBaseMs: opts.reconnectBaseMs } : {}),
    });
  }

  start(): void {
    this.conn.start();
  }

  stop(): void {
    this.conn.stop();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = (): ClientView => this.view;

  dismissNotice(): void {
    this.set({ notice: null });
  }

  move(card: Card, column: Column): void {
    if (card.column === column) return;
    const reqId = newReqId();
    if (!this.conn.send({ type: "move", reqId, id: card.id, column, baseVersion: card.version })) {
      this.set({ notice: "Not connected. Try again in a moment." });
      return;
    }
    this.set({ board: optimistic(this.view.board, reqId, { ...card, column }) });
  }

  rename(card: Card, title: string): void {
    const clean = title.trim();
    if (!clean || clean === card.title) return;
    const reqId = newReqId();
    if (!this.conn.send({ type: "rename", reqId, id: card.id, title: clean, baseVersion: card.version })) {
      this.set({ notice: "Not connected. Try again in a moment." });
      return;
    }
    this.set({ board: optimistic(this.view.board, reqId, { ...card, title: clean }) });
  }

  create(title: string, column: Column): void {
    const clean = title.trim();
    if (!clean) return;
    const reqId = newReqId();
    const id = crypto.randomUUID();
    if (!this.conn.send({ type: "create", reqId, id, title: clean, column })) {
      this.set({ notice: "Not connected. Try again in a moment." });
      return;
    }
    const n = this.view.board.seq + 1 + Object.keys(this.view.board.pending).length;
    this.set({ board: optimistic(this.view.board, reqId, { id, title: clean, column, version: 1, n }) });
  }

  private set(patch: Partial<ClientView>): void {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  private setStatus(status: Status): void {
    let board = this.view.board;
    if (status !== "open") {
      // Anything unanswered when the socket went away is rolled back. If the
      // server did apply it, the replay after reconnecting brings it back.
      for (const reqId of Object.keys(board.pending)) board = reject(board, reqId);
    }
    this.set({ status, board });
  }

  private handle(msg: ServerMessage): void {
    const b = this.view.board;
    switch (msg.type) {
      case "snapshot":
        this.set({ board: applySnapshot(b, msg.seq, msg.cards) });
        return;
      case "event": {
        const r = applyEvent(b, msg.event as BoardEvent);
        if (r.outcome === "gap") this.conn.reconnect();
        else if (r.outcome === "applied") this.set({ board: r.state });
        return;
      }
      case "ack":
        this.set({ board: acknowledge(b, msg.reqId) });
        return;
      case "rejected": {
        const title = msg.card?.title ?? b.pending[msg.reqId]?.before?.title ?? "that card";
        const text =
          msg.reason === "version"
            ? `Someone else changed "${title}" first. Showing their version.`
            : msg.reason === "missing"
              ? "That card no longer exists."
              : "That card already exists.";
        this.set({ board: reject(b, msg.reqId, msg.card), notice: text });
        return;
      }
      case "presence":
        this.set({ board: { ...b, presence: msg.users } });
        return;
      case "error":
        this.set({ notice: `Server said: ${msg.message}` });
        return;
    }
  }
}
