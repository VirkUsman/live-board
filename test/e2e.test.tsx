// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NodeSocket from "ws";
import { Board } from "../src/web/Board.tsx";
import { Rig, user, sleep } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(async () => {
  cleanup();
  await rig.cleanup();
});

// jsdom runs inside Node, whose own WebSocket refuses jsdom's Event objects,
// so the board is given the ws client, which has the same handler properties.
const sockets: NodeSocket[] = [];
class TrackedWS extends NodeSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}
const Impl = TrackedWS as unknown as new (url: string) => WebSocket;

function mountBoard(port: number, name: string) {
  const { container } = render(
    <div data-testid={name}>
      <Board url={`ws://127.0.0.1:${port}`} board="main" user={user(name)} WebSocketImpl={Impl} reconnectBaseMs={20} />
    </div>,
  );
  return within(container.querySelector(`[data-testid="${name}"]`) as HTMLElement);
}

describe("two real browsers' worth of board against a real server", () => {
  it("shows a card made by one board on the other", async () => {
    const s = await rig.server();
    const ana = mountBoard(s.port, "Ana");
    const bo = mountBoard(s.port, "Bo");
    await waitFor(() => expect(ana.getByRole("status", { name: "Connection" })).toHaveTextContent("Live"));
    await waitFor(() => expect(bo.getByRole("status", { name: "Connection" })).toHaveTextContent("Live"));
    fireEvent.change(ana.getByRole("textbox", { name: "New card title" }), { target: { value: "Write the plan" } });
    fireEvent.click(ana.getByRole("button", { name: "Add card" }));
    await waitFor(() => expect(bo.getByText("Write the plan")).toBeInTheDocument());
    await waitFor(() => expect(ana.queryAllByText("Write the plan")).toHaveLength(1));
  });

  it("lists both people on both boards", async () => {
    const s = await rig.server();
    const ana = mountBoard(s.port, "Ana");
    const bo = mountBoard(s.port, "Bo");
    await waitFor(() => expect(ana.getByRole("list", { name: "People on this board" }).textContent).toBe("AnaBo"));
    await waitFor(() => expect(bo.getByRole("list", { name: "People on this board" }).textContent).toBe("AnaBo"));
  });

  it("settles a simultaneous move on one column, and the loser sees a notice", async () => {
    const s = await rig.server();
    const seed = await rig.client(s);
    seed.hello("main", user("Seed"));
    await seed.until((x) => x.of("snapshot").length === 1);
    seed.create("c1", "Contested card");
    await seed.until((x) => x.events().length === 1);

    const ana = mountBoard(s.port, "Ana");
    const bo = mountBoard(s.port, "Bo");
    await waitFor(() => expect(ana.getByText("Contested card")).toBeInTheDocument());
    await waitFor(() => expect(bo.getByText("Contested card")).toBeInTheDocument());

    // fireEvent is synchronous, so both messages leave in the same tick
    fireEvent.click(ana.getByRole("button", { name: "Move Contested card to Doing" }));
    fireEvent.click(bo.getByRole("button", { name: "Move Contested card to Doing" }));
    await act(async () => {
      await sleep(0);
    });

    // both clicked the same direction, so use the contested version check
    await waitFor(() => {
      expect(ana.getByRole("region", { name: "Doing" })).toHaveTextContent("Contested card");
      expect(bo.getByRole("region", { name: "Doing" })).toHaveTextContent("Contested card");
    });
    await waitFor(() => {
      const alerts = [ana, bo].flatMap((b) => b.queryAllByRole("alert"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent('Someone else changed "Contested card" first');
    });
    expect(ana.getByRole("button", { name: "Move Contested card to Done" })).toBeEnabled();
    expect(bo.getByRole("button", { name: "Move Contested card to Done" })).toBeEnabled();
  });

  it("catches up after a dropped connection with every missed card once", async () => {
    const s = await rig.server();
    const writer = await rig.client(s);
    writer.hello("main", user("Writer"));
    await writer.until((x) => x.of("snapshot").length === 1);
    writer.create("c0", "Before the drop");
    await writer.until((x) => x.events().length === 1);

    const ana = mountBoard(s.port, "Ana");
    await waitFor(() => expect(ana.getByText("Before the drop")).toBeInTheDocument());
    const first = sockets.at(-1)!;
    first.close();
    for (let i = 1; i <= 4; i++) writer.create(`c${i}`, `While away ${i}`);
    await writer.until((x) => x.events().length === 5);

    await waitFor(() => expect(ana.getByText("While away 4")).toBeInTheDocument());
    const todo = ana.getByRole("region", { name: "To do" });
    expect(within(todo).getAllByRole("listitem").map((li) => li.textContent?.replace(/[<>]/g, ""))).toEqual([
      "Before the drop",
      "While away 1",
      "While away 2",
      "While away 3",
      "While away 4",
    ]);
    expect(ana.getByRole("status", { name: "Connection" })).toHaveTextContent("Live");
  });
});
