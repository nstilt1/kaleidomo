import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFullscreenExitGuards } from "./lib/install-fullscreen-exit-guards";

installFullscreenExitGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
