import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RoomBuilder from "./RoomBuilder.jsx";

// the service worker (see vite.config.js) is set to skipWaiting/clientsClaim
// so a new deploy takes over this tab's network requests immediately --
// but the JS already sitting in this tab's memory doesn't magically swap
// out on its own, so without this listener a tab left open across a
// redeploy keeps running yesterday's code indefinitely, even though the
// service worker underneath it has already moved on. Reloading once when
// control actually changes hands is what makes a visit reliably pick up
// whatever was just published, instead of only "sometimes, after enough
// manual refreshes."
if ("serviceWorker" in navigator) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RoomBuilder />
  </StrictMode>
);
