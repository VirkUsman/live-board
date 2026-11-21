import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rig, user } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(() => rig.cleanup());

async function pair() {
  const s1 = await rig.server({ instanceId: "one" });
  const s2 = await rig.server({ instanceId: "two" });
  const a = await rig.client(s1);
  const b = await rig.client(s2);
  a.hello("main", user("Ana"));
  b.hello("main", user("Bo"));
  await a.until((x) => x.of("snapshot").length === 1);
  await b.until((x) => x.of("snapshot").length === 1);
  return { s1, s2, a, b };
}

describe("two server instances on one redis", () => {
  it("shows a card made through one instance to a client on the other", async () => {
    const { a, b } = await pair();
    a.create("c1", "From one");
    await b.until((x) => x.events().length === 1);
    expect(b.events()[0]).toMatchObject({ seq: 1, type: "card.created", card: { title: "From one" } });
  });

  it("gives clients on both instances the same 1 to 20 run when both write at once", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 10; i++) {
      a.create(`a${i}`, `A ${i}`);
      b.create(`b${i}`, `B ${i}`);
    }
    await a.until((x) => x.events().length === 20);
    await b.until((x) => x.events().length === 20);
    const want = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(a.seqs()).toEqual(want);
    expect(b.seqs()).toEqual(want);
    expect(a.events().map((e) => e.card.id)).toEqual(b.events().map((e) => e.card.id));
  });

  it("replays to a reconnecting client that comes back on the other instance", async () => {
    const { s2, a, b } = await pair();
    a.create("c1", "One");
    await a.until((x) => x.events().length === 1);
    a.kill();
    b.create("c2", "Two");
    b.create("c3", "Three");
    await b.until((x) => x.events().length === 3);

    const a2 = await rig.client(s2);
    a2.hello("main", user("Ana"), 1);
    await a2.until((x) => x.events().length === 2);
    expect(a2.seqs()).toEqual([2, 3]);
  });

  it("lists people from both instances in presence", async () => {
    const { a, b } = await pair();
    await a.until((x) => x.lastPresence()?.length === 2);
    await b.until((x) => x.lastPresence()?.length === 2);
    expect(a.lastPresence()).toEqual(["Ana", "Bo"]);
    expect(b.lastPresence()).toEqual(["Ana", "Bo"]);
  });

  it("clears a person from the other instance when their socket closes", async () => {
    const { a, b } = await pair();
    await b.until((x) => x.lastPresence()?.length === 2);
    a.close();
    await b.until((x) => x.lastPresence()?.length === 1);
    expect(b.lastPresence()).toEqual(["Bo"]);
  });
});
