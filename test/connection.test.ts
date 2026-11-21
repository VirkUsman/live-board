import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveConnection, type Status } from "../src/web/connection.ts";
import { FakeImpl, FakeSocket } from "./fake-socket.ts";

const ana = { id: "ana", name: "Ana" };

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function make(lastSeq: () => number | null = () => null, extra: Partial<ConstructorParameters<typeof LiveConnection>[0]> = {}) {
  const statuses: Status[] = [];
  const messages: unknown[] = [];
  const conn = new LiveConnection({
    url: "ws://test/ws",
    board: "main",
    user: ana,
    getLastSeq: lastSeq,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeImpl,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
    random: () => 1,
    ...extra,
  });
  return { conn, statuses, messages };
}

describe("LiveConnection", () => {
  it("sends hello with no sequence number on the first open", () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().open();
    expect(FakeSocket.last().of("hello")).toEqual([{ type: "hello", board: "main", user: ana, lastSeq: null }]);
  });

  it("asks for the current sequence number every time it reopens", () => {
    let seq: number | null = null;
    const { conn } = make(() => seq);
    conn.start();
    FakeSocket.last().open();
    seq = 12;
    FakeSocket.last().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.last().open();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.last().of("hello")[0]?.lastSeq).toBe(12);
  });

  it("reports connecting, open, reconnecting, open", () => {
    const { conn, statuses } = make();
    conn.start();
    FakeSocket.last().open();
    FakeSocket.last().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.last().open();
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open"]);
  });

  it("doubles the wait after each failed attempt up to the cap", () => {
    const { conn } = make();
    expect([0, 1, 2, 3, 4, 5].map((n) => conn.delayFor(n))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("jitters between half and all of the wait", () => {
    const low = make(() => null, { random: () => 0 }).conn;
    expect(low.delayFor(2)).toBe(200);
  });

  it("keeps waiting longer while the server never answers", () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().drop();
    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.last().drop();
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("starts the wait over once the server has answered", () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.last().drop();
    vi.advanceTimersByTime(200);
    FakeSocket.last().open();
    FakeSocket.last().receive({ type: "snapshot", seq: 0, cards: [] });
    FakeSocket.last().drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("stops for good when stopped", () => {
    const { conn, statuses } = make();
    conn.start();
    FakeSocket.last().open();
    conn.stop();
    vi.advanceTimersByTime(10000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("refuses to send while the socket is not open and sends once it is", () => {
    const { conn } = make();
    conn.start();
    const msg = { type: "create", reqId: "r", id: "c", title: "t", column: "todo" } as const;
    expect(conn.send(msg)).toBe(false);
    FakeSocket.last().open();
    expect(conn.send(msg)).toBe(true);
    expect(FakeSocket.last().of("create")).toHaveLength(1);
  });

  it("passes server messages up and skips text that is not json", () => {
    const { conn, messages } = make();
    conn.start();
    FakeSocket.last().open();
    FakeSocket.last().onmessage?.({ data: "{oops" } as MessageEvent);
    FakeSocket.last().receive({ type: "presence", users: [ana] });
    expect(messages).toEqual([{ type: "presence", users: [ana] }]);
  });

  it("reconnects when asked to", () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().open();
    conn.reconnect();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
