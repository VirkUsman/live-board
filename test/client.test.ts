import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardEvent, Card } from "../src/shared/protocol.ts";
import { BoardClient } from "../src/web/client.ts";
import { FakeImpl, FakeSocket } from "./fake-socket.ts";

const ana = { id: "ana", name: "Ana" };
const card = (id: string, over: Partial<Card> = {}): Card => ({ id, title: `Task ${id}`, column: "todo", version: 1, n: 1, ...over });
const ev = (seq: number, c: Card): BoardEvent => ({ seq, type: "card.created", card: c, by: "bo", at: 0 });

let client: BoardClient;
beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
  client = new BoardClient({ url: "ws://t", board: "main", user: ana, WebSocketImpl: FakeImpl, reconnectBaseMs: 50 });
  client.start();
});
afterEach(() => {
  client.stop();
  vi.useRealTimers();
});

function live(cards: Card[] = [card("a")], seq = 1) {
  FakeSocket.last().open();
  FakeSocket.last().receive({ type: "snapshot", seq, cards });
}

describe("BoardClient", () => {
  it("starts out connecting with an empty unsynced board", () => {
    expect(client.getView()).toMatchObject({ status: "connecting", notice: null });
    expect(client.getView().board.synced).toBe(false);
  });

  it("is synced and live after open and a snapshot", () => {
    live();
    expect(client.getView().status).toBe("open");
    expect(client.getView().board).toMatchObject({ synced: true, seq: 1 });
  });

  it("sends a move with the card's version and shows it before the server answers", () => {
    live();
    client.move(client.getView().board.cards.a!, "doing");
    expect(FakeSocket.last().of("move")[0]).toMatchObject({ id: "a", column: "doing", baseVersion: 1 });
    expect(client.getView().board.cards.a?.column).toBe("doing");
  });

  it("does nothing when a card is moved to the column it is in", () => {
    live();
    client.move(client.getView().board.cards.a!, "todo");
    expect(FakeSocket.last().of("move")).toEqual([]);
  });

  it("clears the pending mark on ack", () => {
    live();
    client.move(client.getView().board.cards.a!, "doing");
    const reqId = FakeSocket.last().of("move")[0]!.reqId;
    FakeSocket.last().receive({ type: "ack", reqId, seq: 2 });
    expect(client.getView().board.pending).toEqual({});
  });

  it("corrects the card and says why when the server rejects the move", () => {
    live();
    client.move(client.getView().board.cards.a!, "doing");
    const reqId = FakeSocket.last().of("move")[0]!.reqId;
    FakeSocket.last().receive({ type: "rejected", reqId, reason: "version", card: card("a", { column: "done", version: 2 }) });
    expect(client.getView().board.cards.a).toMatchObject({ column: "done", version: 2 });
    expect(client.getView().notice).toBe('Someone else changed "Task a" first. Showing their version.');
  });

  it("explains a missing card and a duplicate create in their own words", () => {
    live();
    client.move(client.getView().board.cards.a!, "doing");
    FakeSocket.last().receive({ type: "rejected", reqId: FakeSocket.last().of("move")[0]!.reqId, reason: "missing" });
    expect(client.getView().notice).toBe("That card no longer exists.");
    expect(client.getView().board.cards.a?.column).toBe("todo");
  });

  it("applies server events in order and ignores a repeat", () => {
    live();
    FakeSocket.last().receive({ type: "event", event: ev(2, card("b", { n: 2 })) });
    FakeSocket.last().receive({ type: "event", event: ev(2, card("b", { n: 2, title: "changed" })) });
    expect(client.getView().board.seq).toBe(2);
    expect(client.getView().board.cards.b?.title).toBe("Task b");
  });

  it("reconnects, and asks from where it was, when an event skips a number", () => {
    live();
    FakeSocket.last().receive({ type: "event", event: ev(5, card("b")) });
    expect(client.getView().board.seq).toBe(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.readyState).toBe(3);
    vi.advanceTimersByTime(50);
    FakeSocket.last().open();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.last().of("hello")[0]?.lastSeq).toBe(1);
  });

  it("rolls back what was unanswered when the socket drops", () => {
    live();
    client.move(client.getView().board.cards.a!, "doing");
    FakeSocket.last().drop();
    expect(client.getView().board.cards.a?.column).toBe("todo");
    expect(client.getView().board.pending).toEqual({});
    expect(client.getView().status).toBe("reconnecting");
  });

  it("refuses to move a card while disconnected and says so", () => {
    live();
    FakeSocket.last().drop();
    client.move(client.getView().board.cards.a!, "doing");
    expect(client.getView().notice).toMatch(/Not connected/);
    expect(client.getView().board.cards.a?.column).toBe("todo");
  });

  it("shows a new card at once and swaps in the server's copy when its event arrives", () => {
    live([]);
    client.create("  Write docs ", "todo");
    const msg = FakeSocket.last().of("create")[0]!;
    expect(msg.title).toBe("Write docs");
    expect(Object.values(client.getView().board.cards)).toHaveLength(1);
    FakeSocket.last().receive({ type: "ack", reqId: msg.reqId, seq: 2 });
    FakeSocket.last().receive({ type: "event", event: ev(2, card(msg.id, { title: "Write docs", n: 2 })) });
    expect(Object.values(client.getView().board.cards)).toHaveLength(1);
    expect(client.getView().board.cards[msg.id]?.n).toBe(2);
  });

  it("ignores an empty title", () => {
    live([]);
    client.create("   ", "todo");
    expect(FakeSocket.last().of("create")).toEqual([]);
  });

  it("stores who is present", () => {
    live();
    FakeSocket.last().receive({ type: "presence", users: [ana, { id: "bo", name: "Bo" }] });
    expect(client.getView().board.presence.map((u) => u.name)).toEqual(["Ana", "Bo"]);
  });

  it("shows a server error as a notice that can be dismissed", () => {
    live();
    FakeSocket.last().receive({ type: "error", message: "bad title" });
    expect(client.getView().notice).toBe("Server said: bad title");
    client.dismissNotice();
    expect(client.getView().notice).toBeNull();
  });

  it("tells subscribers about every change and stops after unsubscribe", () => {
    const fn = vi.fn();
    const off = client.subscribe(fn);
    live();
    const calls = fn.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    off();
    FakeSocket.last().receive({ type: "presence", users: [] });
    expect(fn.mock.calls.length).toBe(calls);
  });
});
