import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rig, user, type TestClient } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(() => rig.cleanup());

async function setup(twoInstances = false) {
  const s1 = await rig.server();
  const s2 = twoInstances ? await rig.server() : s1;
  const a = await rig.client(s1);
  const b = await rig.client(s2);
  a.hello("main", user("Ana"));
  b.hello("main", user("Bo"));
  await a.until((x) => x.of("snapshot").length === 1);
  await b.until((x) => x.of("snapshot").length === 1);
  a.create("c1", "Shared card");
  await a.until((x) => x.events().length === 1);
  await b.until((x) => x.events().length === 1);
  return { a, b };
}

const decided = (c: TestClient, reqId: string) =>
  c.of("ack").some((m) => m.reqId === reqId) || c.of("rejected").some((m) => m.reqId === reqId);

const move = (c: TestClient, reqId: string, column: string, baseVersion = 1) =>
  c.send({ type: "move", reqId, id: "c1", column, baseVersion });

describe("two people move the same card at once", () => {
  it("accepts one move and rejects the other as a version conflict", async () => {
    const { a, b } = await setup();
    move(a, "ma", "doing");
    move(b, "mb", "done");
    await a.until((x) => decided(x, "ma"));
    await b.until((x) => decided(x, "mb"));
    const acks = [...a.of("ack"), ...b.of("ack")].filter((m) => m.reqId === "ma" || m.reqId === "mb");
    const rejects = [...a.of("rejected"), ...b.of("rejected")];
    expect(acks).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe("version");
  });

  it("hands the loser the winning card so the screen can correct itself", async () => {
    const { a, b } = await setup();
    move(a, "ma", "doing");
    move(b, "mb", "done");
    await a.until((x) => decided(x, "ma"));
    await b.until((x) => decided(x, "mb"));
    const rejected = [...a.of("rejected"), ...b.of("rejected")][0]!;
    const winnerEvent = a.events().find((e) => e.type === "card.moved")!;
    expect(rejected.card).toEqual(winnerEvent.card);
    expect(rejected.card?.version).toBe(2);
  });

  it("settles both clients on the same final column", async () => {
    const { a, b } = await setup();
    move(a, "ma", "doing");
    move(b, "mb", "done");
    await a.until((x) => x.events().length === 2);
    await b.until((x) => x.events().length === 2);
    expect(a.events()[1]?.card.column).toBe(b.events()[1]?.card.column);
    expect(a.events()).toHaveLength(2);
  });

  it("works the same when the two people are on different instances", async () => {
    const { a, b } = await setup(true);
    move(a, "ma", "doing");
    move(b, "mb", "done");
    await a.until((x) => decided(x, "ma"));
    await b.until((x) => decided(x, "mb"));
    expect([...a.of("ack"), ...b.of("ack")].filter((m) => m.reqId === "ma" || m.reqId === "mb")).toHaveLength(1);
    expect([...a.of("rejected"), ...b.of("rejected")]).toHaveLength(1);
  });

  it("lets the loser move again once it has the new version", async () => {
    const { a, b } = await setup();
    move(a, "ma", "doing");
    move(b, "mb", "done");
    await b.until((x) => x.of("rejected").length === 1 || x.of("ack").filter((m) => m.reqId === "mb").length === 1);
    await a.until((x) => x.events().length === 2);
    const loser = a.of("rejected").length ? a : b;
    loser.send({ type: "move", reqId: "retry", id: "c1", column: "done", baseVersion: 2 });
    await loser.until((x) => x.of("ack").some((m) => m.reqId === "retry"));
    await a.until((x) => x.events().length === 3);
    expect(a.events()[2]?.card).toMatchObject({ column: "done", version: 3 });
  });
});

describe("other refusals", () => {
  it("rejects a rename that was based on an old version", async () => {
    const { a, b } = await setup();
    move(a, "ma", "doing");
    await a.until((x) => x.events().length === 2);
    b.send({ type: "rename", reqId: "rn", id: "c1", title: "Late", baseVersion: 1 });
    await b.until((x) => x.of("rejected").length === 1);
    expect(b.of("rejected")[0]).toMatchObject({ reqId: "rn", reason: "version" });
  });

  it("rejects a move of a card that does not exist", async () => {
    const { a } = await setup();
    a.send({ type: "move", reqId: "g", id: "ghost", column: "done", baseVersion: 1 });
    await a.until((x) => x.of("rejected").length === 1);
    expect(a.of("rejected")[0]).toEqual({ type: "rejected", reqId: "g", reason: "missing" });
  });

  it("rejects creating a card id that is taken", async () => {
    const { b } = await setup();
    b.create("c1", "Copy");
    await b.until((x) => x.of("rejected").length === 1);
    expect(b.of("rejected")[0]).toMatchObject({ reason: "exists", card: { title: "Shared card" } });
  });
});
