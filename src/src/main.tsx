import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ChatPrototype from "./prototype/chat54/ChatPrototype";
import "./styles.css";

// PROTOTYPE JETABLE #54 (branche prototype/chat-maquette-54) : `?chatproto=a|b|c`
// monte la maquette du chat au lieu du Studio. Absent de main.
const chatProto = new URLSearchParams(window.location.search).has("chatproto");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {chatProto ? <ChatPrototype /> : <App />}
  </React.StrictMode>,
);
