import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore } from "../src/server/board.ts";
import { REDIS_URL, Rig, waitFor } from "./helpers.ts";

let rig: Rig;
let redis: Redis;
let store: BoardStore;
beforeEach(() => {
  rig = new Rig();
  redis = rig.redis();
  store = new BoardStore(redis, rig.prefix);
});
afterEach(async () => {
  const keys = await redis.keys(`${rig.prefix}:*`);
  if (keys.length) await redis.del(...keys);
  await rig.cleanup();
});

const create = (id: string, title = "Task") => store.mutate("b", "ana", { kind: "create", id, title, column: "todo" });

describe("BoardStore.mutate", () => {
  it("creates a card at version 1 with sequence number 1", async () => {
    const r = await create("c1", "First");
    expect(r.ok && r.event).toMatchObject({
      seq: 1,
      type: "card.created",
      by: "ana",
      card: { id: "c1", title: "First", column: "todo", version: 1, n: 1 },
    });
  });

  it("numbers the second card 2", async () => {
    await create("c1");
    const r = await create("c2");
    expect(r.ok && r.event.seq).toBe(2);
    expect(r.ok && r.event.card.n).toBe(2);
  });

  it("refuses a second create with the same id and hands back the card", async () => {
    await create("c1", "First");
    const r = await create("c1", "Again");
    expect(r).toMatchObject({ ok: false, reason: "exists", card: { title: "First" } });
    expect(await store.currentSeq("b")).toBe(1);
  });

  it("moves a card when the base version matches, and records where it came from", async () => {
    await create("c1");
    const r = await store.mutate("b", "bo", { kind: "move", id: "c1", column: "doing", baseVersion: 1 });
    expect(r.ok && r.event).toMatchObject({ seq: 2, type: "card.moved", from: "todo", card: { column: "doing", version: 2 } });
  });

  it("refuses a stale move, returns the current card and uses no sequence number", async () => {
    await create("c1");
    await store.mutate("b", "bo", { kind: "move", id: "c1", column: "doing", baseVersion: 1 });
    const r = await store.mutate("b", "cy", { kind: "move", id: "c1", column: "done", baseVersion: 1 });
    expect(r).toMatchObject({ ok: false, reason: "version", card: { column: "doing", version: 2 } });
    expect(await store.currentSeq("b")).toBe(2);
  });

  it("says missing for a card that was never made", async () => {
    const r = await store.mutate("b", "ana", { kind: "move", id: "ghost", column: "done", baseVersion: 1 });
    expect(r).toEqual({ ok: false, reason: "missing" });
  });

  it("renames under the same version rule", async () => {
    await create("c1", "Old");
    const ok = await store.mutate("b", "ana", { kind: "rename", id: "c1", title: "New", baseVersion: 1 });
    const stale = await store.mutate("b", "ana", { kind: "rename", id: "c1", title: "Newer", baseVersion: 1 });
    expect(ok.ok && ok.event.card).toMatchObject({ title: "New", version: 2 });
    expect(stale).toMatchObject({ ok: false, reason: "version" });
  });

  it("lets only one of 20 simultaneous moves from the same version win", async () => {
    await create("c1");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.mutate("b", `u${i}`, { kind: "move", id: "c1", column: i % 2 ? "doing" : "done", baseVersion: 1 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "version")).toHaveLength(19);
    const snap = await store.snapshot("b");
    expect(snap.cards[0]?.version).toBe(2);
    expect(snap.seq).toBe(2);
  });

  it("gives 50 parallel creates the sequence numbers 1 to 50 with none missing", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => create(`c${i}`)));
    const seqs = results.map((r) => (r.ok ? r.event.seq : -1)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await store.eventsAfter("b", 0, 100)).map((e) => e.seq)).toEqual(seqs);
  });
});

describe("BoardStore reads", () => {
  it("returns events after a sequence number, oldest first", async () => {
    for (let i = 0; i < 5; i++) await create(`c${i}`);
    expect((await store.eventsAfter("b", 2)).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(await store.eventsAfter("b", 5)).toEqual([]);
  });

  it("pages the log by the limit", async () => {
    for (let i = 0; i < 5; i++) await create(`c${i}`);
    expect((await store.eventsAfter("b", 0, 2)).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("takes a snapshot whose sequence number matches its cards", async () => {
    for (let i = 0; i < 4; i++) await create(`c${i}`);
    const snap = await store.snapshot("b");
    expect(snap.seq).toBe(4);
    expect(snap.cards.map((c) => c.n).sort()).toEqual([1, 2, 3, 4]);
  });

  it("returns an empty snapshot for a board nobody used", async () => {
    expect(await store.snapshot("unused")).toEqual({ seq: 0, cards: [] });
  });

  it("publishes the sequence number on the events channel", async () => {
    const sub = new Redis(REDIS_URL);
    const got: string[] = [];
    await sub.subscribe(store.keys("b").events);
    sub.on("message", (_c, m) => got.push(m));
    await create("c1");
    await create("c2");
    await waitFor(() => got.length === 2);
    expect(got).toEqual(["1", "2"]);
    sub.disconnect();
  });

  it("keeps boards apart", async () => {
    await create("c1");
    await store.mutate("other", "ana", { kind: "create", id: "c1", title: "x", column: "todo" });
    expect((await store.snapshot("b")).seq).toBe(1);
    expect((await store.snapshot("other")).seq).toBe(1);
  });
});
