import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import RoomBuilder from "./RoomBuilder.jsx";

// The app's layout (side panels, ribbon toolbar) is built against a fixed
// desktop-sized canvas and isn't responsive -- on a phone screen it just
// renders at full size and gets clipped/oversized rather than shrinking.
// Rather than rework every panel's CSS, scale the whole app uniformly to
// fit whatever viewport it's actually given, the same trick games/kiosk
// UIs use: the app itself always sees this fixed DESIGN size (Three.js
// measures the canvas's own layout box via ResizeObserver, which is
// unaffected by an ancestor's CSS transform), while a wrapper scales that
// down to fit. Never scales *up* past 1, so normal desktop/dev use is
// untouched.
const DESIGN_WIDTH = 1400;
const DESIGN_HEIGHT = 900;

function ScaledApp() {
  const outerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const recompute = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      setScale(Math.min(1, w / DESIGN_WIDTH, h / DESIGN_HEIGHT));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={outerRef}
      style={{
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#1a1a1a",
      }}
    >
      <div
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          flex: "none",
          transform: `scale(${scale})`,
        }}
      >
        <RoomBuilder />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ScaledApp />
  </StrictMode>
);
