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
//
// clientsClaim() fires this same controllerchange event on a page's very
// FIRST load too (going from no controller to one), not only on a later
// takeover by a newer worker -- reloading on that first, totally ordinary
// claim would silently refresh the page out from under whatever the user
// was doing within the first moments of any visit (mid-drag, mid a
// press-and-hold gesture, ...), wiping it with no visible explanation.
// Only reload when this page was ALREADY under a (now-superseded)
// controller's control -- a genuine update, not a first-ever claim.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RoomBuilder />
  </StrictMode>
);
