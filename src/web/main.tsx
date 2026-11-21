import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./Board.tsx";
import "./styles.css";

const params = new URLSearchParams(location.search);
const name = params.get("name") ?? `guest-${Math.floor(Math.random() * 900 + 100)}`;
const user = { id: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) || "guest", name };
const scheme = location.protocol === "https:" ? "wss" : "ws";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Board url={`${scheme}://${location.host}/ws`} board={params.get("board") ?? "main"} user={user} />
  </StrictMode>,
);
