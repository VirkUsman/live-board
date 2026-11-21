import { describe, expect, it } from "vitest";
import type { BoardEvent, Card } from "../src/shared/protocol.ts";
import {
  acknowledge,
  applyEvent,
  applySnapshot,
  cardsIn,
  emptyState,
  isPending,
  optimistic,
  reject,
} from "../src/shared/store.ts";

const card = (id: string, over: Partial<Card> = {}): Card => ({ id, title: id, column: "todo", version: 1, n: 1, ...over });
const created = (seq: number, c: Card): BoardEvent => ({ seq, type: "card.created", card: c, by: "ana", at: 0 });
const moved = (seq: number, c: Card): BoardEvent => ({ seq, type: "card.moved", card: c, from: "todo", by: "ana", at: 0 });

describe("applySnapshot", () => {
  it("replaces the cards and sets the sequence number", () => {
    const s = applySnapshot(emptyState, 7, [card("a"), card("b")]);
    expect(s.seq).toBe(7);
    expect(s.synced).toBe(true);
    expect(Object.keys(s.cards)).toEqual(["a", "b"]);
  });

  it("drops pending work and keeps who is present", () => {
    const withPending = optimistic({ ...emptyState, presence: [{ id: "ana", name: "Ana" }] }, "r1", card("a"));
    const s = applySnapshot(withPending, 1, []);
    expect(s.pending).toEqual({});
    expect(s.presence).toEqual([{ id: "ana", name: "Ana" }]);
  });
});

describe("applyEvent", () => {
  const base = applySnapshot(emptyState, 3, [card("a", { n: 1 })]);

  it("applies the next event", () => {
    const r = applyEvent(base, created(4, card("b", { n: 4 })));
    expect(r.outcome).toBe("applied");
    expect(r.state.seq).toBe(4);
    expect(r.state.cards.b).toBeDefined();
  });

  it("drops an event it has already seen, without changing anything", () => {
    const r = applyEvent(base, created(3, card("zzz")));
    expect(r.outcome).toBe("duplicate");
    expect(r.state).toBe(base);
  });

  it("drops an older event", () => {
    expect(applyEvent(base, created(1, card("zzz"))).outcome).toBe("duplicate");
  });

  it("reports a hole instead of applying past it", () => {
    const r = applyEvent(base, created(6, card("b")));
    expect(r.outcome).toBe("gap");
    expect(r.state.seq).toBe(3);
    expect(r.state.cards.b).toBeUndefined();
  });

  it("overwrites a card with the server's version of it", () => {
    const r = applyEvent(base, moved(4, card("a", { column: "done", version: 2 })));
    expect(r.state.cards.a).toMatchObject({ column: "done", version: 2 });
  });

  it("applies a run of events in order", () => {
    let s = base;
    for (let i = 4; i <= 9; i++) s = applyEvent(s, created(i, card(`c${i}`, { n: i }))).state;
    expect(s.seq).toBe(9);
    expect(Object.keys(s.cards)).toHaveLength(7);
  });
});

describe("optimistic changes", () => {
  const base = applySnapshot(emptyState, 1, [card("a")]);

  it("shows the change at once and marks the card pending", () => {
    const s = optimistic(base, "r1", card("a", { column: "doing" }));
    expect(s.cards.a?.column).toBe("doing");
    expect(isPending(s, "a")).toBe(true);
    expect(isPending(s, "b")).toBe(false);
  });

  it("keeps the change and clears the mark on ack", () => {
    const s = acknowledge(optimistic(base, "r1", card("a", { column: "doing" })), "r1");
    expect(s.cards.a?.column).toBe("doing");
    expect(isPending(s, "a")).toBe(false);
  });

  it("puts the old card back when rejected with nothing newer to show", () => {
    const s = reject(optimistic(base, "r1", card("a", { column: "doing" })), "r1");
    expect(s.cards.a?.column).toBe("todo");
    expect(isPending(s, "a")).toBe(false);
  });

  it("shows the server's card when rejected with one", () => {
    const s = reject(optimistic(base, "r1", card("a", { column: "doing" })), "r1", card("a", { column: "done", version: 2 }));
    expect(s.cards.a).toMatchObject({ column: "done", version: 2 });
  });

  it("does not replace a newer card on screen with an older one from a rejection", () => {
    const pending = optimistic(base, "r1", card("a", { column: "doing" }));
    const newer = applyEvent(pending, moved(2, card("a", { column: "done", version: 3 }))).state;
    const s = reject(newer, "r1", card("a", { column: "doing", version: 2 }));
    expect(s.cards.a).toMatchObject({ column: "done", version: 3 });
  });

  it("removes a card that was optimistic and never existed on the server", () => {
    const s = reject(optimistic(base, "r2", card("new")), "r2");
    expect(s.cards.new).toBeUndefined();
  });

  it("ignores a rejection for a request it does not know", () => {
    expect(reject(base, "nope").cards).toEqual(base.cards);
  });
});

describe("cardsIn", () => {
  it("lists a column in creation order", () => {
    const s = applySnapshot(emptyState, 3, [card("z", { n: 1 }), card("m", { n: 3 }), card("a", { n: 2 }), card("d", { column: "done", n: 4 })]);
    expect(cardsIn(s, "todo").map((c) => c.id)).toEqual(["z", "a", "m"]);
    expect(cardsIn(s, "done").map((c) => c.id)).toEqual(["d"]);
    expect(cardsIn(s, "doing")).toEqual([]);
  });
});
