// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card } from "../src/shared/protocol.ts";
import { Board } from "../src/web/Board.tsx";
import { FakeImpl, FakeSocket } from "./fake-socket.ts";

const ana = { id: "ana", name: "Ana" };
const card = (id: string, title: string, column: Card["column"] = "todo", n = 1): Card => ({ id, title, column, version: 1, n });

beforeEach(() => FakeSocket.reset());
afterEach(() => cleanup());

function mount() {
  return render(<Board url="ws://t" board="main" user={ana} WebSocketImpl={FakeImpl} reconnectBaseMs={20} />);
}

function goLive(cards: Card[] = []) {
  act(() => {
    FakeSocket.last().open();
    FakeSocket.last().receive({ type: "snapshot", seq: cards.length, cards });
  });
}

const column = (name: string) => screen.getByRole("region", { name });

describe("Board", () => {
  it("says Connecting, then Live once the socket opens", () => {
    mount();
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Connecting");
    goLive();
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Live");
  });

  it("puts each card in its column and counts them", () => {
    mount();
    goLive([card("a", "Draft spec", "todo", 1), card("b", "Fix login", "doing", 2), card("c", "Ship", "done", 3), card("d", "Review", "todo", 4)]);
    expect(within(column("To do")).getAllByRole("listitem").map((li) => li.textContent?.replace(/[<>]/g, ""))).toEqual(["Draft spec", "Review"]);
    expect(within(column("Doing")).getByText("Fix login")).toBeInTheDocument();
    expect(within(column("To do")).getByRole("heading")).toHaveTextContent("To do 2");
    expect(within(column("Done")).getByRole("heading")).toHaveTextContent("Done 1");
  });

  it("moves a card at once on click and sends the move with its version", async () => {
    mount();
    goLive([card("a", "Draft spec")]);
    await userEvent.click(screen.getByRole("button", { name: "Move Draft spec to Doing" }));
    expect(within(column("Doing")).getByText("Draft spec")).toBeInTheDocument();
    expect(FakeSocket.last().of("move")[0]).toMatchObject({ id: "a", column: "doing", baseVersion: 1 });
  });

  it("disables a card's buttons until the server answers, then frees them", async () => {
    mount();
    goLive([card("a", "Draft spec")]);
    await userEvent.click(screen.getByRole("button", { name: "Move Draft spec to Doing" }));
    expect(screen.getByRole("button", { name: "Move Draft spec to To do" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Draft spec to Done" })).toBeDisabled();
    const reqId = FakeSocket.last().of("move")[0]!.reqId;
    act(() => FakeSocket.last().receive({ type: "ack", reqId, seq: 2 }));
    expect(screen.getByRole("button", { name: "Move Draft spec to Done" })).toBeEnabled();
  });

  it("has no left button on the first column and no right button on the last", () => {
    mount();
    goLive([card("a", "First", "todo"), card("b", "Last", "done", 2)]);
    expect(screen.getByRole("button", { name: "Move First to nowhere" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Last to nowhere" })).toBeDisabled();
  });

  it("puts the card back and shows an alert when the server rejects the move", async () => {
    mount();
    goLive([card("a", "Draft spec")]);
    await userEvent.click(screen.getByRole("button", { name: "Move Draft spec to Doing" }));
    const reqId = FakeSocket.last().of("move")[0]!.reqId;
    act(() =>
      FakeSocket.last().receive({ type: "rejected", reqId, reason: "version", card: { ...card("a", "Draft spec", "done"), version: 2 } }),
    );
    expect(within(column("Done")).getByText("Draft spec")).toBeInTheDocument();
    expect(within(column("Doing")).queryByText("Draft spec")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent('Someone else changed "Draft spec" first');
  });

  it("clears the alert on Dismiss", async () => {
    mount();
    goLive([card("a", "Draft spec")]);
    act(() => FakeSocket.last().receive({ type: "error", message: "oops" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists who is here and updates when someone leaves", () => {
    mount();
    goLive();
    act(() => FakeSocket.last().receive({ type: "presence", users: [ana, { id: "bo", name: "Bo" }] }));
    const people = screen.getByRole("list", { name: "People on this board" });
    expect(within(people).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Ana", "Bo"]);
    act(() => FakeSocket.last().receive({ type: "presence", users: [ana] }));
    expect(within(people).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps Add card off for an empty title, then sends the create and clears the box", async () => {
    mount();
    goLive();
    const add = screen.getByRole("button", { name: "Add card" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "New card title" }), "Write docs");
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(FakeSocket.last().of("create")[0]).toMatchObject({ title: "Write docs", column: "todo" });
    expect(screen.getByRole("textbox", { name: "New card title" })).toHaveValue("");
    expect(within(column("To do")).getByText("Write docs")).toBeInTheDocument();
  });

  it("will not add a card while disconnected", async () => {
    mount();
    goLive();
    await userEvent.type(screen.getByRole("textbox", { name: "New card title" }), "x");
    act(() => FakeSocket.last().drop());
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Reconnecting");
    expect(screen.getByRole("button", { name: "Add card" })).toBeDisabled();
  });

  it("goes back to Live after the socket returns, asking from the last number it had", () => {
    mount();
    goLive([card("a", "Draft spec")]);
    act(() => FakeSocket.last().drop());
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        act(() => FakeSocket.last().open());
        expect(FakeSocket.last().of("hello")[0]?.lastSeq).toBe(1);
        expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Live");
        resolve();
      }, 60);
    });
  });

  it("keeps the same notice slot element whether or not a message is showing", () => {
    mount();
    goLive();
    const slot = document.querySelector(".notice-slot");
    expect(slot).toBeInTheDocument();
    act(() => FakeSocket.last().receive({ type: "error", message: "oops" }));
    expect(document.querySelector(".notice-slot")).toBe(slot);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".notice-slot")).toBe(slot);
  });
});
