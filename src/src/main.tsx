import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import ChatPrototype from "./prototype/chat54/ChatPrototype";
import "./styles.css";

// App chargée en lazy : la route prototype `?chatproto=` ne doit jamais évaluer
// le graphe du Studio (dont `lib/manifold.ts`, cassé en `vite dev` — voir #54).
const App = lazy(() => import("./App"));

// PROTOTYPE JETABLE #54 (branche prototype/chat-maquette-54) : `?chatproto=a|b|c`
// monte la maquette du chat au lieu du Studio. Absent de main.
const chatProto = new URLSearchParams(window.location.search).has("chatproto");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {chatProto ? <ChatPrototype /> : <Suspense fallback={<div>Chargement…</div>}><App /></Suspense>}
  </React.StrictMode>,
);
