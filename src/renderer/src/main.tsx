import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmHost } from "./confirm";
import { TrayPanel } from "./TrayPanel";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        {/* The tray panel is the same app on another route, so it shares the API, styles and icons. */}
        {location.hash === "#tray" ? <TrayPanel /> : <App />}
        <ConfirmHost />
    </StrictMode>,
);
