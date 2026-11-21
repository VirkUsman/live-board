import { useState, type FormEvent } from "react";
import { COLUMNS, type Column, type User } from "../shared/protocol.ts";
import { cardsIn, isPending } from "../shared/store.ts";
import { useBoard, type UseBoardOptions } from "./useBoard.ts";

const LABEL: Record<Column, string> = { todo: "To do", doing: "Doing", done: "Done" };
const STATUS_TEXT = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
} as const;

export function Board(props: UseBoardOptions): React.JSX.Element {
  const { client, view } = useBoard(props);
  const [title, setTitle] = useState("");
  const { board } = view;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    client.create(title, "todo");
    setTitle("");
  };

  return (
    <main className="board">
      <header className="bar">
        <h1>{props.board}</h1>
        <p className={`status status-${view.status}`} role="status" aria-label="Connection">
          {STATUS_TEXT[view.status]}
        </p>
        <ul className="people" aria-label="People on this board">
          {board.presence.map((u: User) => (
            <li key={u.id}>{u.name}</li>
          ))}
        </ul>
      </header>

      <div className="notice-slot">
        {view.notice && (
          <p className="notice" role="alert">
            <span>{view.notice}</span>
            <button type="button" onClick={() => client.dismissNotice()}>
              Dismiss
            </button>
          </p>
        )}
      </div>

      <form className="add" onSubmit={submit}>
        <input aria-label="New card title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" disabled={!title.trim() || view.status !== "open"}>
          Add card
        </button>
      </form>

      <div className="columns">
        {COLUMNS.map((col, i) => (
          <section key={col} className="column" aria-label={LABEL[col]}>
            <h2>
              {LABEL[col]} <span className="count">{cardsIn(board, col).length}</span>
            </h2>
            <ul>
              {cardsIn(board, col).map((card) => {
                const busy = isPending(board, card.id);
                const left = COLUMNS[i - 1];
                const right = COLUMNS[i + 1];
                return (
                  <li key={card.id} className={busy ? "card busy" : "card"}>
                    <span className="title">{card.title}</span>
                    <span className="moves">
                      <button
                        type="button"
                        aria-label={`Move ${card.title} to ${left ? LABEL[left] : "nowhere"}`}
                        disabled={!left || busy}
                        onClick={() => left && client.move(card, left)}
                      >
                        {"<"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${card.title} to ${right ? LABEL[right] : "nowhere"}`}
                        disabled={!right || busy}
                        onClick={() => right && client.move(card, right)}
                      >
                        {">"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
