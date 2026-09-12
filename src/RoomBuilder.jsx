import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Undo2, Redo2, Camera as CameraIcon, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Mic, Sun, Moon, Send } from "lucide-react";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";

const WALL_HEIGHT = 3.6576; // 12 ft
const MIN_WALL_HEIGHT = 0.5;
const MAX_WALL_HEIGHT = 50;
const MIN_SIZE = 1.0;             // smallest a room dimension can shrink to
const MAX_COORD = 40;             // how far any base wall can travel from center
const MAX_DEPTH = 30;             // how far a pulled-out section can extrude
const OUTWARD_PARTITION_MAX = 20; // how far a partition can reach when there's no opposite wall to meet
const MIN_RADIUS = 4;             // closest the camera can zoom in
const MAX_RADIUS = 250;           // farthest the camera can zoom out (tall buildings need more room)
const MIN_OPENING = 0.5;          // smallest opening you can cut
const MIN_HIGHLIGHT = 0.15;       // smallest highlight worth keeping
const HOLD_MS = 420;              // press-and-hold duration to arm a partition/cut
const MOVE_PX = 6;                // pixels of movement that resolves a quick drag
const DEFAULT_OPENING_HEIGHT = +(WALL_HEIGHT * 0.8).toFixed(2);
const FT = 0.3048;                // grid/measurement units are shown in feet
const DEFAULT_ROOM_HALF_X = 12.5; // default room is 25m x 15m
const DEFAULT_ROOM_HALF_Z = 7.5;
const MIN_STAIR_SIZE = FT;         // smallest footprint that commits as a staircase
const VIEW_SHIFT = 1.28;          // widen the virtual frame this much to push the model right, clear of the side panel
const BALCONY_CEILING_DROP = 2 * FT;   // the balcony ceiling/roof sits this far below the room's own default height
const BALCONY_CEILING_THICKNESS = 0.45; // roof slab thickness

const COLORS = {
  bg: 0x14171c,
  wall: 0xf2f0ea,
  wallEdge: 0x2a271f,
  floor: 0xe6e4dc,
  accent: 0xbd6640,
  highlight: 0xff2d6e,
};

// a representative Teenage Engineering-style palette (orange, white, blue,
// yellow, red) for the tint swatches -- couldn't find a documented "Apple
// keyboard" collab palette specifically, so this uses their well-known
// saturated accent-color approach instead (green swapped for white, which
// gets more use).
const TE_SWATCHES = [0xff6b1a, 0xffffff, 0x4a90d9, 0xf2c230, 0xe5484d];

// the fixed per-shape prop colors, used both as the initial defaults and
// as what a prop reverts to if a theme's color is ever cleared.
const PROP_DEFAULT_COLORS = { sphere: 0xd6453c, cone: 0x3f9d5c, cube: 0x3a6bc9, cylinder: 0xd6453c };

// Theme color wheel: a full filled disc -- a small greyscale ring at the
// hub (15 greys plus pure white and pure black) surrounded by a hue/tint
// wheel (angle = one of twelve hues, radius = a tint gradient from vivid at
// the rim to near-white near the hub), modeled directly on Teenage
// Engineering's color-wheel tool. Tapping any cell selects that hue (or,
// on the grey ring, that lightness) as the room's theme; themeColorsFor
// then derives a small palette of related-but-distinct tones from that one
// anchor and hands one to each of the wall, floor, stairs, balcony
// platform, balcony railings, and every prop kind.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(x * 255);
  return (toHex(f(0)) << 16) | (toHex(f(4)) << 8) | toHex(f(8));
}
function hexToCss(hex) { return `#${hex.toString(16).padStart(6, "0")}`; }
const THEME_SAT = 58; // the fixed saturation every hue theme derives its palette at
const THEME_WALL_MIDLIGHT = 56; // the wall's lightness anchor for a hue theme
function clampL(l) { return Math.max(4, Math.min(96, l)); }
// derives the room's whole palette from one anchor point -- hueDeg/sat pick
// the family, midLight pivots the whole palette lighter or darker (used by
// the grey ring to get a distinct light-to-dark monochrome theme from
// every step). Offsets are deliberately uneven (not a plain linear ramp)
// so mid-palette objects (walls, stairs) stay closer together while
// floor/cube bracket the extremes.
function themeColorsFor(hueDeg, sat, midLight = THEME_WALL_MIDLIGHT) {
  const at = (dl) => hslToHex(hueDeg, sat, clampL(midLight + dl));
  return {
    floor: at(32),
    platform: at(22),
    stairs: at(14),
    wall: at(0),
    sphere: at(-14),
    cylinder: hslToHex((hueDeg + 16) % 360, Math.max(0, sat - 10), clampL(midLight - 6)),
    railing: hslToHex((hueDeg - 10 + 360) % 360, sat, clampL(midLight - 18)),
    cone: hslToHex((hueDeg - 18 + 360) % 360, sat, clampL(midLight - 30)),
    cube: at(-38),
  };
}
const WHEEL_HUE_COUNT = 12;
const WHEEL_TINT_RINGS = 10;
const WHEEL_GREY_STEPS = 17; // 15 greys + pure white + pure black
// the hue/tint disc -- twelve 30-degree hue sectors, each with ten tint
// cells running from a vivid, near-fully-saturated color at the rim to a
// pale near-white tint approaching the hub.
const WHEEL_DISC_CELLS = (() => {
  const cells = [];
  for (let h = 0; h < WHEEL_HUE_COUNT; h++) {
    const hueDeg = (h / WHEEL_HUE_COUNT) * 360;
    for (let r = 0; r < WHEEL_TINT_RINGS; r++) {
      const t = r / (WHEEL_TINT_RINGS - 1);
      const lightness = 48 + t * 45;
      cells.push({ hue: h, ring: r, hueDeg, hex: hslToHex(hueDeg, 92, lightness) });
    }
  }
  return cells;
})();
// the small hub-side greyscale ring, black at one end, white at the other.
const WHEEL_GREY_CELLS = Array.from({ length: WHEEL_GREY_STEPS }, (_, i) => {
  const midLight = clampL((i / (WHEEL_GREY_STEPS - 1)) * 100);
  return { step: i, midLight, hex: hslToHex(0, 0, midLight) };
});

// Curated, hand-picked palettes representing recognizable color-scheme
// styles (as opposed to the generic hue wheel's one-anchor-point math) --
// each already defines every target color so they're guaranteed to work
// together, rather than being derived. `wheel` is what repopulates the
// disc while this preset is active (one flat color per hue sector,
// replacing the vivid-to-pale gradient) so adjacent, related colors are
// visible at a glance; tapping any lit cell applies the full preset.
const CURATED_PALETTES = [
  {
    name: "Cool",
    wall: 0x5b7c99, floor: 0xd7e4ec, stairs: 0x9fb8c9, platform: 0x3f6a82,
    railing: 0x27435a, sphere: 0x4a90d9, cube: 0x1f3b52, cone: 0x6fb8b0, cylinder: 0x8aa9c9,
    wheel: [0xd7e4ec, 0x9fb8c9, 0x6fb8b0, 0x5b7c99, 0x4a90d9, 0x3f6a82, 0x27435a, 0x1f3b52, 0x2c5b6b, 0x8aa9c9, 0xaecbd6, 0x7ea0b8],
  },
  {
    name: "Warm",
    wall: 0xc9764a, floor: 0xf2ddc4, stairs: 0xe0a877, platform: 0xa8532f,
    railing: 0x6b3420, sphere: 0xe0562e, cube: 0x7a2e18, cone: 0xf2b74a, cylinder: 0xd88f5c,
    wheel: [0xf2ddc4, 0xe0a877, 0xf2b74a, 0xc9764a, 0xe0562e, 0xa8532f, 0x6b3420, 0x7a2e18, 0x954020, 0xd88f5c, 0xe8c49a, 0xcc8a5a],
  },
  {
    name: "Korean",
    wall: 0xd9a9a0, floor: 0xf5e6dc, stairs: 0xe6c3bb, platform: 0xb8827c,
    railing: 0x7a5a56, sphere: 0xc79a8f, cube: 0x8fa593, cone: 0xe0c9a6, cylinder: 0xcbb2a8,
    wheel: [0xf5e6dc, 0xe6c3bb, 0xd9a9a0, 0xcbb2a8, 0xc79a8f, 0xb8827c, 0x8fa593, 0x7a5a56, 0xe0c9a6, 0xd6bfae, 0xa88a80, 0xefd9cd],
  },
  {
    name: "Earth",
    wall: 0x8a6f4e, floor: 0xd9c8a8, stairs: 0xb39d76, platform: 0x6b5636,
    railing: 0x3f3322, sphere: 0x9c7b45, cube: 0x556b3a, cone: 0xc4914f, cylinder: 0x7a8a5c,
    wheel: [0xd9c8a8, 0xb39d76, 0xc4914f, 0x8a6f4e, 0x9c7b45, 0x6b5636, 0x3f3322, 0x556b3a, 0x7a8a5c, 0xa68a5f, 0x4d4530, 0xbfa878],
  },
  {
    name: "Pastel",
    wall: 0xb8c9e0, floor: 0xfaf1e4, stairs: 0xf2c9d4, platform: 0xc9e0c4,
    railing: 0x9ba8c9, sphere: 0xe8d4ec, cube: 0xf5e0a8, cone: 0xc4e0dc, cylinder: 0xf2c9d4,
    wheel: [0xfaf1e4, 0xf2c9d4, 0xe8d4ec, 0xb8c9e0, 0xc4e0dc, 0xc9e0c4, 0xf5e0a8, 0x9ba8c9, 0xe0c4d0, 0xd4e0f2, 0xf5d9c4, 0xd0e8d8],
  },
  {
    name: "Jewel",
    wall: 0x2e6b5e, floor: 0xc9b8e0, stairs: 0x4a8577, platform: 0x1f4a40,
    railing: 0x121f1c, sphere: 0x8b2942, cube: 0x1a3a6b, cone: 0x6b1a8b, cylinder: 0x9c2f4a,
    wheel: [0x2e6b5e, 0x4a8577, 0x1f4a40, 0x8b2942, 0x9c2f4a, 0x1a3a6b, 0x6b1a8b, 0x121f1c, 0x2e4a8b, 0x7a1f5e, 0xc9b8e0, 0x0f5c4a],
  },
  {
    name: "Scandinavian",
    wall: 0xece6dc, floor: 0xc9b599, stairs: 0xdcd3c4, platform: 0xa88f6e,
    railing: 0x2a2a28, sphere: 0x8a9baa, cube: 0x1c1c1a, cone: 0xd9d0c0, cylinder: 0xb8a488,
    wheel: [0xece6dc, 0xdcd3c4, 0xc9b599, 0xa88f6e, 0x8a9baa, 0x6b7a88, 0x2a2a28, 0x1c1c1a, 0xd9d0c0, 0xb8a488, 0xf5f0e8, 0x9c8f7a],
  },
  {
    name: "Monochrome",
    wall: 0x8a8a8a, floor: 0xe4e4e4, stairs: 0xb8b8b8, platform: 0x5a5a5a,
    railing: 0x2a2a2a, sphere: 0x707070, cube: 0x1a1a1a, cone: 0xc4c4c4, cylinder: 0x9c9c9c,
    wheel: [0xf5f5f5, 0xe4e4e4, 0xc4c4c4, 0xb8b8b8, 0x9c9c9c, 0x8a8a8a, 0x707070, 0x5a5a5a, 0x4a4a4a, 0x2a2a2a, 0x1a1a1a, 0x0a0a0a],
  },
];

// a short synthesized click (Web Audio, no audio file to fetch) for wall/
// partition contact feedback -- one shared AudioContext, created lazily on
// first use since browsers refuse to start one before a user gesture.
let clickAudioCtx = null;
function playClickSound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!clickAudioCtx) clickAudioCtx = new AC();
    if (clickAudioCtx.state === "suspended") clickAudioCtx.resume();
    const ctx = clickAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  } catch {
    // audio is a nice-to-have here -- never let it break editing
  }
}

function SingleViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function QuadViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function polarPoint(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
// an annular-sector (ring wedge) path, from r0 to r1, spanning `span`
// degrees starting at `angleDeg`, with a small gap shaved off each side.
function ringWedgePath(cx, cy, r0, r1, angleDeg, span, gapDeg) {
  const a0 = angleDeg + gapDeg / 2, a1 = angleDeg + span - gapDeg / 2;
  const p0 = polarPoint(cx, cy, r0, a0), p1 = polarPoint(cx, cy, r1, a0);
  const p2 = polarPoint(cx, cy, r1, a1), p3 = polarPoint(cx, cy, r0, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} L ${p1.x} ${p1.y} A ${r1} ${r1} 0 ${large} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${r0} ${r0} 0 ${large} 0 ${p0.x} ${p0.y} Z`;
}

function angleDiffDeg(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// The color-theme wheel: a persistent, draggable, spinnable floating disc
// (not a modal -- no backdrop, so the 3D view stays interactive while it's
// open), modeled on Teenage Engineering's color-wheel tool: a small
// greyscale ring at the hub, surrounded by a full hue/tint disc (angle =
// hue, radius = a vivid-at-the-rim-to-pale-near-the-hub tint gradient).
// Three distinct gestures: drag the hub to reposition the whole widget;
// tap the hub (no real movement) to cycle through curated named palettes,
// which repopulate the disc with that palette's own colors; drag anywhere
// on the colorful disc itself to spin it, with a bit of momentum once
// released, like a real dial.
function ThemeWheelOverlay({ pos, onPosChange, onPick, onClose, activeTheme, presetIndex, onCyclePreset }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // --- hub: drag to move, tap (little/no movement) to cycle presets ---
  function startHubGesture(e) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, startPos = pos;
    let moved = 0;
    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      moved = Math.max(moved, Math.hypot(dx, dy));
      onPosChange({ x: startPos.x + dx, y: startPos.y + dy });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved < 6) onCyclePreset();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // --- disc: drag to spin, with momentum on release ---
  const svgRef = useRef(null);
  const rotRef = useRef(0);
  const [rotation, setRotation] = useState(0);
  const rafRef = useRef(null);
  const gestureMovedRef = useRef(0); // total |degrees| rotated this gesture -- suppresses an accidental pick on release
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  function angleFromCenter(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect();
    return Math.atan2(clientY - (rect.top + rect.height / 2), clientX - (rect.left + rect.width / 2)) * 180 / Math.PI;
  }
  function startSpin(e) {
    e.preventDefault();
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    gestureMovedRef.current = 0;
    let lastAngle = angleFromCenter(e.clientX, e.clientY);
    let lastTime = performance.now();
    let velocity = 0;
    function onMove(ev) {
      const now = performance.now();
      const angle = angleFromCenter(ev.clientX, ev.clientY);
      const d = angleDiffDeg(angle, lastAngle);
      velocity = d / Math.max(1, now - lastTime);
      rotRef.current += d;
      gestureMovedRef.current += Math.abs(d);
      setRotation(rotRef.current);
      lastAngle = angle;
      lastTime = now;
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      function spin() {
        velocity *= 0.94;
        rotRef.current += velocity * 16;
        setRotation(rotRef.current);
        if (Math.abs(velocity) > 0.006) rafRef.current = requestAnimationFrame(spin);
        else rafRef.current = null;
      }
      if (Math.abs(velocity) > 0.015) rafRef.current = requestAnimationFrame(spin);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  function pick(payload) {
    if (gestureMovedRef.current > 3) return; // a spin gesture ending on a cell isn't a pick
    onPick(payload);
  }

  const size = 340;
  const cx = size / 2, cy = size / 2;
  const hubR = 24;
  const greyR0 = 24, greyR1 = 42;
  const discR0 = 42, discR1 = 165;
  const hueSpan = 360 / WHEEL_HUE_COUNT;
  const greySpan = 360 / WHEEL_GREY_STEPS;
  const ringDepth = (discR1 - discR0) / WHEEL_TINT_RINGS;

  const preset = presetIndex > 0 ? CURATED_PALETTES[presetIndex - 1] : null;
  const isActiveCell = (hueDeg, ring) => activeTheme && activeTheme.type === "hue" && activeTheme.hueDeg === hueDeg && activeTheme.ring === ring;
  const isActiveGrey = (step) => activeTheme && activeTheme.type === "grey" && activeTheme.step === step;
  const isActivePreset = () => activeTheme && activeTheme.type === "preset" && activeTheme.name === (preset && preset.name);

  return (
    <div
      style={{
        position: "absolute", left: pos.x, top: pos.y, zIndex: 200, width: size, height: size,
        transform: `translate(-50%, -50%) scale(${entered ? 1 : 0.35})`,
        opacity: entered ? 1 : 0,
        transition: "transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.25s ease",
        filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.35))",
        userSelect: "none", WebkitUserSelect: "none",
      }}
    >
      <svg
        ref={svgRef} width={size} height={size}
        style={{ overflow: "visible", position: "absolute", inset: 0, touchAction: "none" }}
        onPointerDown={startSpin}
        onMouseDown={(e) => e.preventDefault()}
      >
        <circle cx={cx} cy={cy} r={discR1} fill="transparent" style={{ cursor: "grab" }} />
        <g transform={`rotate(${rotation} ${cx} ${cy})`} style={{ cursor: "grab", touchAction: "none" }}>
          {preset
            ? Array.from({ length: WHEEL_HUE_COUNT }, (_, h) => {
                const hueDeg = (h / WHEEL_HUE_COUNT) * 360;
                const hex = preset.wheel[h % preset.wheel.length];
                return (
                  <path
                    key={`preset${h}`}
                    d={ringWedgePath(cx, cy, discR0, discR1, hueDeg - 90, hueSpan, 2)}
                    fill={hexToCss(hex)}
                    stroke={isActivePreset() ? "var(--accent)" : "rgba(0,0,0,0.15)"}
                    strokeWidth={isActivePreset() ? 1.5 : 0.75}
                    style={{ cursor: "pointer" }}
                    onClick={() => pick({ type: "preset", name: preset.name })}
                  >
                    <title>{`${preset.name} theme`}</title>
                  </path>
                );
              })
            : WHEEL_DISC_CELLS.map((cell) => (
                <path
                  key={`h${cell.hue}-r${cell.ring}`}
                  d={ringWedgePath(cx, cy, discR0 + cell.ring * ringDepth, discR0 + (cell.ring + 1) * ringDepth, cell.hueDeg - 90, hueSpan, 1.5)}
                  fill={hexToCss(cell.hex)}
                  stroke={isActiveCell(cell.hueDeg, cell.ring) ? "var(--accent)" : "rgba(0,0,0,0.08)"}
                  strokeWidth={isActiveCell(cell.hueDeg, cell.ring) ? 1.75 : 0.4}
                  style={{ cursor: "pointer" }}
                  onClick={() => pick({ type: "hue", hueDeg: cell.hueDeg, ring: cell.ring })}
                >
                  <title>{hexToCss(cell.hex)}</title>
                </path>
              ))}
          {WHEEL_GREY_CELLS.map((g) => (
            <path
              key={`grey${g.step}`}
              d={ringWedgePath(cx, cy, greyR0, greyR1, g.step * greySpan - 90, greySpan, 1)}
              fill={hexToCss(g.hex)}
              stroke={isActiveGrey(g.step) ? "var(--accent)" : "rgba(0,0,0,0.15)"}
              strokeWidth={isActiveGrey(g.step) ? 1.5 : 0.35}
              style={{ cursor: "pointer" }}
              onClick={() => pick({ type: "grey", step: g.step, midLight: g.midLight })}
            >
              <title>{hexToCss(g.hex)}</title>
            </path>
          ))}
        </g>
      </svg>
      <div
        onPointerDown={startHubGesture}
        title="Drag to move, tap to cycle color-scheme presets"
        style={{
          position: "absolute", left: cx - hubR, top: cy - hubR, width: hubR * 2, height: hubR * 2, borderRadius: "50%",
          background: "var(--bg-floating)", border: "1px solid var(--border-control)",
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none",
        }}
      >
        <span style={{ fontSize: preset ? 7.5 : 8, letterSpacing: "0.04em", color: "var(--text-secondary)", textTransform: "uppercase", pointerEvents: "none", textAlign: "center", padding: "0 3px" }}>
          {preset ? preset.name : "Theme"}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close"
          style={{
            position: "absolute", top: -5, right: -5, width: 16, height: 16, borderRadius: "50%", zIndex: 2,
            border: "1px solid var(--border-control)", background: "var(--bg-panel)", color: "var(--text-primary)",
            cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export default function RoomBuilder() {
  const mountRef = useRef(null);
  const hudRef = useRef(null);
  const heightLabelRef = useRef(null);
  const dividerHandleRef = useRef(null);
  const dividerVLineRef = useRef(null);
  const dividerHLineRef = useRef(null);
  const measureLayerRef = useRef(null);
  const resetFnRef = useRef(null);
  const panelHeightApiRef = useRef({ setHeight: () => {}, getHeight: () => WALL_HEIGHT });
  const rebuildGridRef = useRef(() => {});
  const rebuildModelRef = useRef(() => {});
  const setViewModeApiRef = useRef(() => {});
  // UI chrome theme (ribbon, panels, buttons) -- mostly just the
  // surrounding app frame (CSS), but also drives the 3D viewport's empty-
  // space background/fog color via viewportThemeApiRef below, since a
  // near-black void reads as far too contrasty next to a light UI.
  // Defaults to dark to match how this always looked before.
  const [uiTheme, setUiTheme] = useState("dark");
  const viewportThemeApiRef = useRef(() => {});
  useEffect(() => { viewportThemeApiRef.current(uiTheme); }, [uiTheme]);
  const [tool, setTool] = useState("move");
  const toolRef = useRef(tool);
  useEffect(() => { toolRef.current = tool; rebuildModelRef.current(); }, [tool]);
  const [openingHeight, setOpeningHeight] = useState(DEFAULT_OPENING_HEIGHT);
  const openingHeightRef = useRef(openingHeight);
  useEffect(() => { openingHeightRef.current = openingHeight; }, [openingHeight]);
  const [openingDividers, setOpeningDividers] = useState(3);
  const openingDividersRef = useRef(openingDividers);
  useEffect(() => { openingDividersRef.current = openingDividers; }, [openingDividers]);
  const [openingAxisVertical, setOpeningAxisVertical] = useState(true);
  const openingAxisVerticalRef = useRef(openingAxisVertical);
  useEffect(() => { openingAxisVerticalRef.current = openingAxisVertical; }, [openingAxisVertical]);
  const [openingAxisHorizontal, setOpeningAxisHorizontal] = useState(false);
  const openingAxisHorizontalRef = useRef(openingAxisHorizontal);
  useEffect(() => { openingAxisHorizontalRef.current = openingAxisHorizontal; }, [openingAxisHorizontal]);
  const [doorHeight, setDoorHeight] = useState(7 * FT);
  const doorHeightRef = useRef(doorHeight);
  useEffect(() => { doorHeightRef.current = doorHeight; }, [doorHeight]);
  const [propsShape, setPropsShape] = useState("cube");
  const propsShapeRef = useRef(propsShape);
  useEffect(() => { propsShapeRef.current = propsShape; }, [propsShape]);
  const [wallThickness, setWallThickness] = useState(0.35);
  const [ceilingOn, setCeilingOn] = useState(false);
  const ceilingApiRef = useRef({ setEnabled: () => {} });
  const [groundOn, setGroundOn] = useState(false);
  const groundApiRef = useRef({ setEnabled: () => {} });
  const wallThicknessApiRef = useRef({ setThickness: () => {} });
  const [selectedPanel, setSelectedPanel] = useState(null);
  const selectedPanelRef = useRef(selectedPanel);
  useEffect(() => { selectedPanelRef.current = selectedPanel; rebuildModelRef.current(); }, [selectedPanel]);
  const [selectedHeight, setSelectedHeight] = useState(WALL_HEIGHT);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const selectedRoomIdRef = useRef(selectedRoomId);
  useEffect(() => { selectedRoomIdRef.current = selectedRoomId; rebuildModelRef.current(); }, [selectedRoomId]);
  const cutRoomRef = useRef(() => {});
  const copyRoomRef = useRef(() => {});
  const pasteRoomRef = useRef(() => {});
  const duplicateRoomRef = useRef(() => {});
  const deleteRoomRef = useRef(() => {});
  const [hasRoomClipboard, setHasRoomClipboard] = useState(false);
  const [selectedStairId, setSelectedStairId] = useState(null);
  const selectedStairIdRef = useRef(selectedStairId);
  useEffect(() => { selectedStairIdRef.current = selectedStairId; rebuildModelRef.current(); }, [selectedStairId]);
  const [selectedBalconyId, setSelectedBalconyId] = useState(null);
  const selectedBalconyIdRef = useRef(selectedBalconyId);
  useEffect(() => { selectedBalconyIdRef.current = selectedBalconyId; rebuildModelRef.current(); }, [selectedBalconyId]);
  const [selectedBalconyPart, setSelectedBalconyPart] = useState(null); // "pillars" | "ceiling" | null (whole assembly)
  const selectedBalconyPartRef = useRef(selectedBalconyPart);
  useEffect(() => { selectedBalconyPartRef.current = selectedBalconyPart; }, [selectedBalconyPart]);
  const [selectedOpeningId, setSelectedOpeningId] = useState(null); // a window or door cutout in a wall
  const selectedOpeningIdRef = useRef(selectedOpeningId);
  useEffect(() => { selectedOpeningIdRef.current = selectedOpeningId; rebuildModelRef.current(); }, [selectedOpeningId]);
  const [selectedPropId, setSelectedPropId] = useState(null); // a placed sphere/cube/cone/cylinder prop
  const selectedPropIdRef = useRef(selectedPropId);
  useEffect(() => { selectedPropIdRef.current = selectedPropId; rebuildModelRef.current(); }, [selectedPropId]);
  const [balconyStairHeight, setBalconyStairHeight] = useState(3 * FT);
  const balconyHeightApiRef = useRef({ setHeight: () => {} });
  const [balconyPlatformWidth, setBalconyPlatformWidth] = useState(10 * FT);
  const balconyWidthApiRef = useRef({ setWidth: () => {} });
  const [balconyPillarCount, setBalconyPillarCount] = useState(8);
  const balconyPillarCountApiRef = useRef({ setCount: () => {} });
  const [balconyPillarHeight, setBalconyPillarHeight] = useState(3 * FT);
  const balconyPillarHeightApiRef = useRef({ setHeight: () => {} });
  const [balconyGlassInfill, setBalconyGlassInfill] = useState(false);
  const balconyGlassApiRef = useRef({ setEnabled: () => {} });
  const deleteBalconyRef = useRef(() => {});
  const deleteOpeningRef = useRef(() => {});
  const deletePropRef = useRef(() => {});
  const openingEditApiRef = useRef({ setHeight: () => {}, setDividers: () => {}, setAxis: () => {} });
  const [selectedOpeningIsDoor, setSelectedOpeningIsDoor] = useState(false);
  const voiceActionsRef = useRef({});
  const voiceRoomContextRef = useRef(() => "");
  const [stairSteps, setStairSteps] = useState(20);
  const stairStepsApiRef = useRef({ setSteps: () => {} });
  const deleteStairRef = useRef(() => {});
  const switchActiveRoomRef = useRef(() => {});
  const [roomHeight, setRoomHeight] = useState(WALL_HEIGHT);
  const roomHeightApiRef = useRef({ setHeight: () => {} });
  const [curvedCornersOn, setCurvedCornersOn] = useState(false);
  const curvedCornersOnRef = useRef(curvedCornersOn);
  useEffect(() => { curvedCornersOnRef.current = curvedCornersOn; }, [curvedCornersOn]);
  const [curvedCornersRadius, setCurvedCornersRadius] = useState(0.6);
  const curvedCornersRadiusRef = useRef(curvedCornersRadius);
  useEffect(() => { curvedCornersRadiusRef.current = curvedCornersRadius; }, [curvedCornersRadius]);
  const curvedCornersApiRef = useRef({ setEnabled: () => {}, setRadius: () => {} });
  const resetEverythingRef = useRef(() => {});
  const [gridSizeFt, setGridSizeFt] = useState(10);
  const gridSizeRef = useRef(gridSizeFt * FT);
  useEffect(() => { gridSizeRef.current = gridSizeFt * FT; rebuildGridRef.current(); }, [gridSizeFt]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const snapEnabledRef = useRef(snapEnabled);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  const [showMeasurements, setShowMeasurements] = useState(false);
  const showMeasurementsRef = useRef(showMeasurements);
  useEffect(() => { showMeasurementsRef.current = showMeasurements; rebuildModelRef.current(); }, [showMeasurements]);
  const [viewMode, setViewMode] = useState("orbit");
  useEffect(() => { setViewModeApiRef.current(viewMode); }, [viewMode]);
  const [hiddenLineMode, setHiddenLineMode] = useState(false);
  const hiddenLineApiRef = useRef(() => {});
  useEffect(() => { hiddenLineApiRef.current(hiddenLineMode); }, [hiddenLineMode]);
  const [transparentInactive, setTransparentInactive] = useState(false);
  const transparentInactiveApiRef = useRef(() => {});
  useEffect(() => { transparentInactiveApiRef.current(transparentInactive); }, [transparentInactive]);
  const [wireframeMode, setWireframeMode] = useState(false);
  const wireframeApiRef = useRef(() => {});
  useEffect(() => { wireframeApiRef.current(wireframeMode); }, [wireframeMode]);
  // cycles the building's wall material: 0 = default (the textured look),
  // then grey concrete / black metal / white plastic / red, back to default.
  const [buildingMaterialIndex, setBuildingMaterialIndex] = useState(0);
  const buildingMaterialApiRef = useRef(() => {});
  useEffect(() => { buildingMaterialApiRef.current(buildingMaterialIndex); }, [buildingMaterialIndex]);
  const [ultraRealistic, setUltraRealistic] = useState(true);
  const ultraRealisticApiRef = useRef(() => {});
  useEffect(() => { ultraRealisticApiRef.current(ultraRealistic); }, [ultraRealistic]);
  const [tintInactiveOn, setTintInactiveOn] = useState(false);
  const [tintInactiveColor, setTintInactiveColor] = useState(0xff6b1a);
  const tintInactiveApiRef = useRef(() => {});
  useEffect(() => { tintInactiveApiRef.current(tintInactiveOn, tintInactiveColor); }, [tintInactiveOn, tintInactiveColor]);
  const [tintActiveOn, setTintActiveOn] = useState(false);
  const [tintActiveColor, setTintActiveColor] = useState(0xff6b1a);
  const tintActiveApiRef = useRef(() => {});
  useEffect(() => { tintActiveApiRef.current(tintActiveOn, tintActiveColor); }, [tintActiveOn, tintActiveColor]);
  const [themeWheelOpen, setThemeWheelOpen] = useState(false);
  const [themeWheelPos, setThemeWheelPos] = useState({ x: 640, y: 420 });
  // { type: "hue", hueDeg, ring } | { type: "grey", step, midLight } | { type: "preset", name } | null
  const [themeAnchor, setThemeAnchor] = useState(null);
  const themeApiRef = useRef(() => {});
  useEffect(() => { themeApiRef.current(themeAnchor); }, [themeAnchor]);
  // 0 = the generic hue/tint disc; 1..N indexes into CURATED_PALETTES
  const [themePresetIndex, setThemePresetIndex] = useState(0);
  const [viewLayout, setViewLayout] = useState("single");
  const viewLayoutRef = useRef(viewLayout);
  useEffect(() => { viewLayoutRef.current = viewLayout; }, [viewLayout]);
  const [walkMode, setWalkMode] = useState(false);
  const walkModeRef = useRef(walkMode);
  const walkModeApiRef = useRef(() => {});
  useEffect(() => { walkModeRef.current = walkMode; walkModeApiRef.current(walkMode); }, [walkMode]);
  const walkInputRef = useRef({ fwd: false, back: false, left: false, right: false });
  const [floorIds, setFloorIds] = useState([1]);
  const [activeFloorIdState, setActiveFloorIdState] = useState(1);
  const thumbCanvasMapRef = useRef(new Map());
  const refreshThumbnailApiRef = useRef(() => {});
  const duplicateFloorRef = useRef(() => {});
  const deleteFloorRef = useRef(() => {});
  const selectFloorRef = useRef(() => {});
  const reorderFloorsRef = useRef(() => {});
  const floorRowRefs = useRef(new Map());
  const floorDragRef = useRef(null);
  const [dragFloorId, setDragFloorId] = useState(null);
  const [dropInfo, setDropInfo] = useState(null);
  const addFloorRef = useRef(() => {});
  const toggleIsolateRef = useRef(() => {});
  const toggleHideRef = useRef(() => {});
  const [isolatedFloorIdsState, setIsolatedFloorIdsState] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);
  const pushUndoRef = useRef(() => {});
  const undoRef = useRef(() => {});
  const redoRef = useRef(() => {});
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(""); // "", "listening", "thinking", "done", "error"
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const voiceRecognitionRef = useRef(null);
  const [commandText, setCommandText] = useState(""); // typed alternative to the mic, for when speech input isn't available
  const copyFloorRef = useRef(() => {});
  const cutFloorRef = useRef(() => {});
  const pasteFloorRef = useRef(() => {});
  const [hasClipboard, setHasClipboard] = useState(false);
  const [floorHeight, setFloorHeight] = useState(WALL_HEIGHT);
  const floorHeightApiRef = useRef({ setHeight: () => {}, getHeight: () => WALL_HEIGHT });
  useEffect(() => {
    floorIds.forEach((id) => refreshThumbnailApiRef.current(id));
  }, [floorIds]);

  useEffect(() => {
    const mount = mountRef.current;
    let width = mount.clientWidth || 1;
    let height = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    scene.fog = new THREE.Fog(COLORS.bg, 60, 400);
    const sceneFog = scene.fog;
    // the empty-space backdrop and its matching fog color -- dark mode
    // keeps the original near-black void, but that same void read as far
    // too contrasty next to a light UI, so light mode gets a medium
    // grey-blue instead (closer to what Keynote uses behind its slide
    // canvas: a grey a shade darker than the surrounding chrome, not a
    // stark black-vs-white jump).
    const VIEWPORT_BG_LIGHT = 0xc7cad1;
    function applyViewportTheme(theme) {
      const c = theme === "light" ? VIEWPORT_BG_LIGHT : COLORS.bg;
      scene.background.set(c);
      sceneFog.color.set(c);
    }
    viewportThemeApiRef.current = applyViewportTheme;
    applyViewportTheme(uiTheme);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 500);
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    const orthoTopCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    const orthoFrontCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    const orthoLeftCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    let activeCamera = camera;
    // quad-view state: splitX/splitY are the divider's fractional position
    // (0-1) across the canvas; interactionCamera/interactionRect are locked
    // in at the start of each pointer gesture so a drag stays mapped to
    // whichever pane it began in even if the pointer wanders into another.
    let splitX = 0.5;
    let splitY = 0.5;
    let interactionCamera = camera;
    let interactionRect = null;
    let currentGestureIsOrtho = false;
    let dividerDragActive = false;
    // independent camera state per quad-view pane, so orbiting/zooming one
    // pane never moves the other three -- each fixed ortho pane gets its
    // own pan target + zoom radius, and the orbit pane gets its own full
    // target/theta/phi/radius, all separate from the single-view state.
    let currentGesturePaneDir = null; // "orbit" | "top" | "front" | "left" | null (single-view / no gesture)
    let quadPaneState = {
      orbit: { target: new THREE.Vector3(0, 0, 0), radius: 9.5, theta: 0.7, phi: 1.1 },
      top: { target: new THREE.Vector3(0, 0, 0), radius: 8 },
      front: { target: new THREE.Vector3(0, 0, 0), radius: 8 },
      left: { target: new THREE.Vector3(0, 0, 0), radius: 8 },
    };
    let quadPaneStateReady = false;
    function applyViewShift(cam, w, h) {
      cam.clearViewOffset();
      cam.setViewOffset(w * VIEW_SHIFT, h, 0, 0, w, h);
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.cursor = "grab";
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    // "magic hour" sun: 45 degrees above the horizon and 45 degrees off
    // both wall axes (equal x/z, y = horizontal-distance * sqrt(2)) so a
    // wall's shadow reads as a clean 45-degree diagonal across the floor,
    // exactly as long as the wall is tall, rather than the near-overhead
    // angle a small x/y/z position gives.
    // blended 30% toward white so lit walls read closer to their true
    // color instead of a strong orange cast -- still warm, just subtler.
    const keyLight = new THREE.DirectionalLight(new THREE.Color(0xffa457).lerp(new THREE.Color(0xffffff), 0.3), 1.2);
    keyLight.position.set(20, 28.3, 20);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    // wide enough to cover a large room plus the long, low-angle shadows a
    // tall building throws at a 45-degree sun -- bigger than the old +-10
    // (which was clipping shadows off well inside a 25m room).
    keyLight.shadow.camera.left = -40;
    keyLight.shadow.camera.right = 40;
    keyLight.shadow.camera.top = 40;
    keyLight.shadow.camera.bottom = -40;
    keyLight.shadow.radius = 1.5; // crisp edge -- a dramatic low sun reads as a sharp line, not a soft blur
    keyLight.shadow.bias = -0.0004; // reduces shadow acne without visible peter-panning
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);
    // cool blue skylight fill, complementing the warm sun (the classic
    // magic-hour palette: warm key, cool ambient/fill)
    // same 30%-toward-white blend as the key light, so shadow areas read
    // less strongly blue.
    const fillLight = new THREE.DirectionalLight(new THREE.Color(0x5f8fff).lerp(new THREE.Color(0xffffff), 0.3), 0.4);
    fillLight.position.set(-6, 4, -5);
    scene.add(fillLight);
    // fixed, non-shadow-casting fill lights aligned with each orthographic
    // viewing direction, so the top/front/left/right drafting views are
    // always evenly lit head-on regardless of the key light's fixed angle
    // (which otherwise leaves whichever face is turned away from it dark).
    const orthoFillTop = new THREE.DirectionalLight(0xffffff, 0.16);
    orthoFillTop.position.set(0, 30, 0.01);
    scene.add(orthoFillTop);
    const orthoFillFront = new THREE.DirectionalLight(0xffffff, 0.15);
    orthoFillFront.position.set(0, 2, 30);
    scene.add(orthoFillFront);
    const orthoFillLeft = new THREE.DirectionalLight(0xffffff, 0.15);
    orthoFillLeft.position.set(-30, 2, 0);
    scene.add(orthoFillLeft);
    const orthoFillRight = new THREE.DirectionalLight(0xffffff, 0.15);
    orthoFillRight.position.set(30, 2, 0);
    scene.add(orthoFillRight);

    // a 50x50m site ground plane under the room, so a building smaller than
    // that (like the 25x15 default) reads as sitting on a lawn rather than
    // floating in the void -- sits just below the room floor slab (which
    // spans y=-0.08 to y=0) so the two never z-fight. Off by default (a
    // toggle in the Layers panel); a radial alpha map fades it to fully
    // transparent over the outer ~30% of its radius instead of ending in a
    // hard square edge.
    function makeRadialFadeTexture(size) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const r = size / 2;
      const grad = ctx.createRadialGradient(r, r, r * 0.7, r, r, r);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(canvas);
    }
    const groundFadeTex = makeRadialFadeTexture(256);
    const groundMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x8fbf6a).multiplyScalar(0.6),
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.35,
      transparent: true,
      alphaMap: groundFadeTex,
    });
    const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), groundMat);
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = -0.1;
    groundPlane.receiveShadow = true;
    groundPlane.visible = false;
    scene.add(groundPlane);
    groundApiRef.current = { setEnabled: (on) => { groundPlane.visible = on; } };

    // ---------- "Realistic" mode: image-based lighting + postprocessing ----------
    let ultraRealisticOn = false;
    // A hand-built "magic hour" sky for image-based lighting: a warm
    // horizon-to-blue-zenith gradient plus a bright sun disc placed exactly
    // where keyLight points, so the environment's reflections/highlights
    // agree with the actual shadow-casting light. Intensities are kept
    // modest and deliberately tuned to sit alongside the scene's own key/
    // fill/ambient lights rather than fight them. (three.js's stock
    // RoomEnvironment was tried first and rejected: it's a product-photo
    // studio rig with a 900-intensity point light and light panels up to
    // 100x scalar, built for shiny jewelry close-ups -- wired into this
    // scene it blew every wall out to solid white.) Generated procedurally
    // via PMREMGenerator, so there's no external HDRI file to fetch.
    function paintVerticalGradient(geometry, radius, horizonColor, zenithColor) {
      const pos = geometry.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const t = Math.pow(THREE.MathUtils.clamp(y / radius, 0, 1), 0.6);
        c.copy(horizonColor).lerp(zenithColor, t);
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    function buildSoftEnvironmentScene() {
      const envScene = new THREE.Scene();
      const skyRadius = 40;
      const skyGeo = new THREE.SphereGeometry(skyRadius, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      // same 30%-toward-white blend as the key/fill lights, so the sky's
      // IBL contribution matches the subtler direct lighting instead of
      // reintroducing a strong orange/blue cast of its own.
      const horizonTone = new THREE.Color(0xff9d5c).lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(0.55);
      const zenithTone = new THREE.Color(0x4a7fdb).lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(0.5);
      paintVerticalGradient(skyGeo, skyRadius, horizonTone, zenithTone);
      const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
      envScene.add(sky);
      const ground = new THREE.Mesh(
        new THREE.SphereGeometry(skyRadius, 16, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2a271f).multiplyScalar(0.4), side: THREE.BackSide })
      );
      envScene.add(ground);
      // sun disc, placed on the sky sphere exactly along keyLight's
      // direction -- bright enough to read as a distinct hotspot and cast a
      // warm highlight on glossy surfaces, but nowhere near the intensity
      // of an actual light source, so it doesn't blow out diffuse walls.
      const sunDir = keyLight.position.clone().normalize();
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(2.6, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d5).multiplyScalar(9) })
      );
      sun.position.copy(sunDir.multiplyScalar(skyRadius * 0.96));
      envScene.add(sun);
      return envScene;
    }
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const realisticEnvMap = pmremGenerator.fromScene(buildSoftEnvironmentScene(), 0.04).texture;
    pmremGenerator.dispose();

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // default AO radius (0.25 world units) only catches tight crevices --
    // widened so the contact shadow actually spreads out across the floor
    // near a wall, the way a real soft ambient occlusion falloff looks.
    const gtaoPass = new GTAOPass(scene, camera, width, height, undefined, {
      radius: 1.1,
      distanceExponent: 1,
      thickness: 1,
      distanceFallOff: 0.5,
      scale: 1.8,
    });
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 1.6;
    gtaoPass.enabled = false;
    composer.addPass(gtaoPass);
    // High threshold + low strength: this should only catch genuinely bright
    // spots (a window with sky behind it, a light fixture), not glow every
    // wall -- bloom is a highlight accent, not a global brightener.
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.22, 0.4, 0.94);
    bloomPass.enabled = false;
    composer.addPass(bloomPass);
    const bokehPass = new BokehPass(scene, camera, { focus: 9, aperture: 0.00004, maxblur: 0.008 });
    bokehPass.enabled = false;
    composer.addPass(bokehPass);
    composer.addPass(new OutputPass());
    composer.setSize(width, height);

    // Renders through the postprocessing chain only in Realistic mode and
    // only for the free perspective camera (orbit/walk) -- the fixed
    // top/front/left/right drafting views and the quad-view panes stay on
    // the cheap direct-render path, same as shadows already do.
    function renderActive(cam) {
      if (ultraRealisticOn && cam === camera) {
        // keep whatever the camera is orbiting around (the character, in
        // walk mode) in focus rather than a fixed distance -- otherwise
        // zooming in to inspect a wall would just blur the wall you're
        // trying to look at.
        bokehPass.uniforms["focus"].value = radius;
        composer.render();
      } else {
        renderer.render(scene, cam);
      }
    }

    // ---------- procedural placeholder character (no external assets --
    // built from primitives, animated with simple sine-wave limb swings) ----------
    function buildCharacter() {
      const skin = new THREE.MeshStandardMaterial({ color: 0xd9a679, roughness: 0.85 });
      const shirt = new THREE.MeshStandardMaterial({ color: 0x3b6ea8, roughness: 0.8 });
      const pants = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.85 });

      const group = new THREE.Group();

      const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.23, 0.52, 12), shirt);
      torso.position.y = 1.06;
      torso.castShadow = true;
      group.add(torso);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), skin);
      head.position.y = 1.56;
      head.castShadow = true;
      group.add(head);

      function makeLimb(radiusTop, radiusBottom, length, mat, pivotPos) {
        const pivot = new THREE.Group();
        pivot.position.copy(pivotPos);
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 8), mat);
        mesh.position.y = -length / 2;
        mesh.castShadow = true;
        pivot.add(mesh);
        group.add(pivot);
        return pivot;
      }

      const leftArmPivot = makeLimb(0.055, 0.05, 0.44, skin, new THREE.Vector3(0.26, 1.34, 0));
      const rightArmPivot = makeLimb(0.055, 0.05, 0.44, skin, new THREE.Vector3(-0.26, 1.34, 0));
      const leftLegPivot = makeLimb(0.09, 0.07, 0.52, pants, new THREE.Vector3(0.1, 0.8, 0));
      const rightLegPivot = makeLimb(0.09, 0.07, 0.52, pants, new THREE.Vector3(-0.1, 0.8, 0));

      group.visible = false;
      scene.add(group);
      return { group, leftArmPivot, rightArmPivot, leftLegPivot, rightLegPivot };
    }
    const character = buildCharacter();
    let characterYaw = 0;
    let walkCyclePhase = 0;
    let walkCycleAmp = 0;

    // ---------- procedural grain textures (no external image assets) ----------
    // breaks up the flat single-color CG look on walls/floors with subtle
    // per-pixel noise, plus a matching roughness map so the specular
    // highlight isn't perfectly uniform either.
    function makeGrainTexture(size, [r, g, b], variation) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const n = (Math.random() - 0.5) * variation;
        img.data[i * 4 + 0] = Math.min(255, Math.max(0, r + n));
        img.data[i * 4 + 1] = Math.min(255, Math.max(0, g + n));
        img.data[i * 4 + 2] = Math.min(255, Math.max(0, b + n));
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(6, 6);
      return tex;
    }
    function makeRoughnessTexture(size, base, variation) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const v = Math.min(255, Math.max(0, base + (Math.random() - 0.5) * variation));
        img.data[i * 4 + 0] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(6, 6);
      return tex;
    }
    const wallGrainTex = makeGrainTexture(128, [242, 240, 234], 10);
    const wallRoughTex = makeRoughnessTexture(128, 210, 40);
    const floorGrainTex = makeGrainTexture(128, [230, 228, 220], 14);
    const floorRoughTex = makeRoughnessTexture(128, 195, 50);
    // brutalist concrete: a repeating precast-panel texture -- thin vertical
    // board-formed grooves, plus small tie-rod holes inset from each
    // panel's corners (which, once tiled, cluster into a group of four
    // right at each interior panel joint -- the classic look). Painted in
    // a near-white base so it reads as pure per-pixel shading once
    // multiplied by whatever grey the concrete preset's color is set to.
    function makeConcretePanelTexture(size) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const n = (Math.random() - 0.5) * 12;
        const v = Math.min(255, Math.max(0, 232 + n));
        img.data[i * 4 + 0] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = "rgba(70,68,64,0.4)";
      ctx.lineWidth = Math.max(1, size * 0.012);
      const grooveCount = 4;
      for (let i = 1; i < grooveCount; i++) {
        const x = (size / grooveCount) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size);
        ctx.stroke();
      }
      const holeR = size * 0.04;
      const inset = size * 0.08;
      [[inset, inset], [size - inset, inset], [inset, size - inset], [size - inset, size - inset]].forEach(([cx, cy]) => {
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, holeR);
        grad.addColorStop(0, "rgba(40,38,35,0.85)");
        grad.addColorStop(0.6, "rgba(90,88,84,0.45)");
        grad.addColorStop(1, "rgba(120,118,114,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
        ctx.fill();
      });
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(4, 4);
      return tex;
    }
    const concretePanelTex = makeConcretePanelTexture(256);
    // a plain ceramic/grid-tile look: a light, faintly-grained base cut into
    // an even grid by darker grout lines. Painted light and low-contrast
    // (like the concrete texture) so it reads as pure shading once
    // multiplied by whatever color the tile preset's material is tinted.
    function makeGridTileTexture(size) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const n = (Math.random() - 0.5) * 8;
        const v = Math.min(255, Math.max(0, 236 + n));
        img.data[i * 4 + 0] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = "rgba(60,58,55,0.35)";
      const tiles = 4;
      ctx.lineWidth = Math.max(1, size * 0.018);
      for (let i = 1; i < tiles; i++) {
        const p = (size / tiles) * i;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(4, 4);
      return tex;
    }
    const gridTileTex = makeGridTileTexture(256);

    let minorGrid = null;
    let majorGrid = null;
    // built from real thin quads (not GL_LINES via GridHelper) -- line-based
    // grids can't reliably control thickness across browsers and shimmer at
    // a distance; flat merged quads render like any other mesh and don't.
    // `plane` picks which two axes the grid spans: "xz" (horizontal, the
    // floor grid), "xy" (a vertical backdrop for the front view), or "zy"
    // (a vertical backdrop for the left/right views).
    function buildGridMesh(size, spacing, colorHex, opacity, thicknessWorld, plane = "xz") {
      const half = size / 2;
      const count = Math.max(1, Math.round(size / spacing));
      const positions = [];
      const indices = [];
      let vi = 0;
      const halfT = thicknessWorld / 2;
      function toXYZ(a, b) {
        if (plane === "xz") return [a, 0, b];
        if (plane === "xy") return [a, b, 0];
        return [0, b, a]; // "zy"
      }
      function addQuad(a0, b0, a1, b1) {
        const p0 = toXYZ(a0, b0), p1 = toXYZ(a1, b0), p2 = toXYZ(a1, b1), p3 = toXYZ(a0, b1);
        positions.push(...p0, ...p1, ...p2, ...p3);
        indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
      }
      for (let i = 0; i <= count; i++) {
        const p = -half + i * spacing;
        addQuad(-half, p - halfT, half, p + halfT);
        addQuad(p - halfT, -half, p + halfT, half);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
      return new THREE.Mesh(geo, mat);
    }
    function rebuildGrids() {
      if (minorGrid) { scene.remove(minorGrid); minorGrid.geometry.dispose(); minorGrid.material.dispose(); }
      if (majorGrid) { scene.remove(majorGrid); majorGrid.geometry.dispose(); majorGrid.material.dispose(); }
      const major = Math.max(0.02, gridSizeRef.current);
      const minor = major / 10;
      const majorDivisions = Math.min(300, Math.max(8, Math.round(220 / major)));
      const minorDivisions = Math.min(400, Math.max(8, Math.round(220 / minor)));
      const minorSize = minorDivisions * minor;
      const majorSize = majorDivisions * major;
      minorGrid = buildGridMesh(minorSize, minor, 0x33383f, 0.3, Math.max(0.008, minor * 0.03));
      minorGrid.position.y = -0.011;
      scene.add(minorGrid);
      majorGrid = buildGridMesh(majorSize, major, 0x565e68, 0.55, Math.max(0.018, major * 0.018));
      majorGrid.position.y = -0.0105;
      scene.add(majorGrid);
    }
    rebuildGridRef.current = rebuildGrids;
    rebuildGrids();

    // ---------- multi-floor management ----------
    // every cut feature stores a `panel` key: 'north'|'south'|'east'|'west' for
    // the four original walls, 'bf:<id>' for a pulled-out section's outer wall
    // (which can itself be cut/highlighted/pulled further), or 'pt:<id>' for a partition.
    // a "room" (an enclosed area detected within a floor) reuses this exact
    // same shape for its own walls/cuts/partitions -- it's a fully independent
    // mini floor, just parented under the floor it was pulled from.
    function makeFloorData() {
      return {
        footprint: { xMin: -DEFAULT_ROOM_HALF_X, xMax: DEFAULT_ROOM_HALF_X, zMin: -DEFAULT_ROOM_HALF_Z, zMax: DEFAULT_ROOM_HALF_Z },
        height: WALL_HEIGHT,
        thickness: 0.35,
        selections: [],   // {id, panel, u0, u1}
        bumpouts: [],     // {id, panel, u0, u1, depth}
        partitions: [],   // {id, panel, u, ext}  -- ext signed: negative=inward, positive=outward
        openings: [],     // {id, panel, u0, u1, height}
        panelHeights: {}, // panelKey -> height override (defaults to state.height)
        stairs: [],       // {id, axis, start, end, widthMin, widthMax, steps} -- a parametric staircase footprint
        floorHoles: [],   // {id, xMin, xMax, zMin, zMax} -- stairwell cutouts, usually auto-added above a stair on the floor below
        props: [],        // {id, kind, x, z} -- decorative sphere/cube/cone/cylinder placed on the floor
        curvedCorners: { enabled: false, radius: 0 }, // rounds the 4 corners of the base footprint's external walls
        balconies: [], // {id, panel, u0, u1, dividerAxis} -- a staircase+platform+pillars assembly with a window/door cutout in the wall behind it
        ceilingEnabled: false, // a purely decorative slab at wall-height -- never a raycast target
      };
    }
    let idSeq = 1;
    let nextFloorId = 2;
    let floors = [{ id: 1, data: makeFloorData(), rooms: [] }];
    let activeFloorId = 1;
    let activeRoomId = null; // id of the room (within the active floor) currently focused for editing, or null for the floor itself
    let buildingRoomId = null; // which room's data we're currently building geometry for (null = the floor's own content)
    let buildingFloorEntry = null; // the floor entry currently being built (so its .rooms list is reachable while rendering)
    const isolatedFloorIds = new Set();
    const hiddenFloorIds = new Set();
    const floorGroups = new Map();
    const roomGroups = new Map(); // roomId -> THREE.Group
    // rooms live in their own container per floor, added directly to the
    // scene (a sibling of the floor's own group, not a child of it) --
    // otherwise clearing the floor's own geometry on every rebuild would
    // also destroy every room nested inside it.
    const roomContainers = new Map(); // floorId -> THREE.Group
    const firstFloorGroup = new THREE.Group();
    scene.add(firstFloorGroup);
    floorGroups.set(1, firstFloorGroup);
    let sceneGroup = firstFloorGroup;
    let buildingActiveFloor = true; // true while building geometry that belongs to the active floor (its own content, or any of its rooms)
    // true for whatever wall edits (Wall/Window/Door/Stairs tools) can currently
    // land on: every floor's own content is pickable regardless of which one
    // is "active" (active only controls height/isolate/hide), but within the
    // active floor specifically, a room pulled out of it and the floor's own
    // walls are still mutually exclusive -- only one of them is picked at a
    // time, exactly as before. Rooms on OTHER floors stay out of scope here.
    let isPickableTarget = true;
    let state = floors[0].data;

    function restackFloors() {
      let y = 0;
      floors.forEach((f) => {
        const g = floorGroups.get(f.id);
        if (g) { g.position.y = y; g.position.x = f.offsetX || 0; g.position.z = f.offsetZ || 0; }
        const rc = roomContainers.get(f.id);
        if (rc) { rc.position.y = y; rc.position.x = f.offsetX || 0; rc.position.z = f.offsetZ || 0; }
        y += f.data.height;
      });
    }

    // ---------- undo / redo ----------
    // the whole `floors` array (each floor's room data plus its horizontal
    // offset) is plain JSON, so a full deep-clone snapshot before every
    // committed edit is cheap and simple -- no per-field diffing needed.
    const MAX_UNDO = 60;
    let undoStack = [];
    let redoStack = [];
    function snapshotFloors() {
      return { floors: JSON.parse(JSON.stringify(floors)), activeFloorId };
    }
    function syncUndoRedoAvailability() {
      setCanUndo(undoStack.length > 0);
      setCanRedo(redoStack.length > 0);
    }
    function pushUndo() {
      undoStack.push(snapshotFloors());
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
      syncUndoRedoAvailability();
    }
    function applySnapshot(snap) {
      pickList = [];
      const wantedIds = new Set(snap.floors.map((f) => f.id));
      Array.from(floorGroups.keys()).forEach((id) => {
        if (!wantedIds.has(id)) {
          const g = floorGroups.get(id);
          if (g) { clearGroup(g); scene.remove(g); }
          floorGroups.delete(id);
        }
      });
      const wantedRoomIds = new Set();
      snap.floors.forEach((f) => (f.rooms || []).forEach((r) => wantedRoomIds.add(r.id)));
      Array.from(roomGroups.keys()).forEach((id) => {
        if (!wantedRoomIds.has(id)) {
          const rg = roomGroups.get(id);
          if (rg) { clearGroup(rg); if (rg.parent) rg.parent.remove(rg); }
          roomGroups.delete(id);
        }
      });
      snap.floors.forEach((f) => {
        if (!floorGroups.has(f.id)) {
          const g = new THREE.Group();
          scene.add(g);
          floorGroups.set(f.id, g);
        }
      });
      floors = JSON.parse(JSON.stringify(snap.floors));
      activeFloorId = floors.find((f) => f.id === snap.activeFloorId) ? snap.activeFloorId : (floors[0] ? floors[0].id : 1);
      activeRoomId = null;
      restackFloors();
      dragState = null;
      dragCrossFloorRestore = null;
      orbiting = null;
      pinchState = null;
      previewSelection = null;
      previewOpening = null;
      setSelectedPanel(null);
      setSelectedRoomId(null);
      const activeEntry = floors.find((f) => f.id === activeFloorId);
      if (activeEntry) state = activeEntry.data;
      floors.forEach((f) => rebuildFloorEntry(f, f.id === activeFloorId));
      const g = floorGroups.get(activeFloorId);
      if (g && activeEntry) target.y = g.position.y + activeEntry.data.height * 0.32;
      updateCamera();
      applyVisibility();
      syncFloorsToReact();
    }
    function performUndo() {
      if (undoStack.length === 0) return;
      const current = snapshotFloors();
      const prev = undoStack.pop();
      redoStack.push(current);
      applySnapshot(prev);
      syncUndoRedoAvailability();
    }
    function performRedo() {
      if (redoStack.length === 0) return;
      const current = snapshotFloors();
      const next = redoStack.pop();
      undoStack.push(current);
      applySnapshot(next);
      syncUndoRedoAvailability();
    }
    pushUndoRef.current = pushUndo;
    undoRef.current = performUndo;
    redoRef.current = performRedo;

    const wallDefs = {
      north: { normal: new THREE.Vector3(0, 0, -1), thickAxis: "z", lengthAxis: "x", get coord() { return state.footprint.zMin; }, set coord(v) { state.footprint.zMin = v; } },
      south: { normal: new THREE.Vector3(0, 0, 1), thickAxis: "z", lengthAxis: "x", get coord() { return state.footprint.zMax; }, set coord(v) { state.footprint.zMax = v; } },
      west: { normal: new THREE.Vector3(-1, 0, 0), thickAxis: "x", lengthAxis: "z", get coord() { return state.footprint.xMin; }, set coord(v) { state.footprint.xMin = v; } },
      east: { normal: new THREE.Vector3(1, 0, 0), thickAxis: "x", lengthAxis: "z", get coord() { return state.footprint.xMax; }, set coord(v) { state.footprint.xMax = v; } },
    };

    function wallSpan(wallId) {
      const fp = state.footprint;
      return wallId === "north" || wallId === "south" ? [fp.xMin, fp.xMax] : [fp.zMin, fp.zMax];
    }
    function getPanelHeight(panelKey) {
      return state.panelHeights[panelKey] ?? state.height;
    }
    function setPanelHeightValue(panelKey, h) {
      state.panelHeights[panelKey] = Math.max(MIN_WALL_HEIGHT, Math.min(MAX_WALL_HEIGHT, h));
      rebuild();
    }
    panelHeightApiRef.current = { setHeight: setPanelHeightValue, getHeight: getPanelHeight };
    function selectPanelForHeight(panelKey) {
      setSelectedPanel(panelKey);
      setSelectedHeight(getPanelHeight(panelKey));
    }

    // When a pulled-in section on one base wall reaches all the way to a
    // corner, the perpendicular wall sharing that corner should stop short
    // too, instead of standing there unaffected -- this is what actually
    // forms an L-shaped room instead of a floating notch inside a still-
    // rectangular one. Each entry maps a wall's edge to the wall+edge that
    // shares that corner and can clip it.
    const CORNER_MAP = {
      "north:min": ["west", "min"], "north:max": ["east", "min"],
      "south:min": ["west", "max"], "south:max": ["east", "max"],
      "west:min": ["north", "min"], "west:max": ["south", "min"],
      "east:min": ["north", "max"], "east:max": ["south", "max"],
    };
    function findCornerClip(adjWallId, adjEdge) {
      const [aMin, aMax] = wallSpan(adjWallId);
      const notch = state.bumpouts.find((b) => b.panel === adjWallId && b.depth < -0.02 &&
        (adjEdge === "min" ? Math.abs(b.u0 - aMin) < 0.05 : Math.abs(b.u1 - aMax) < 0.05));
      if (!notch) return null;
      const adjDef = wallDefs[adjWallId];
      const axisSign = adjDef.thickAxis === "z" ? adjDef.normal.z : adjDef.normal.x;
      return adjDef.coord + axisSign * notch.depth;
    }
    // the span actually used for rendering/interaction, after any corner clips
    function effectiveWallSpan(wallId) {
      let [uMin, uMax] = wallSpan(wallId);
      ["min", "max"].forEach((edge) => {
        const mapping = CORNER_MAP[wallId + ":" + edge];
        if (!mapping) return;
        const clip = findCornerClip(mapping[0], mapping[1]);
        if (clip === null) return;
        if (edge === "min") uMin = Math.max(uMin, clip);
        else uMax = Math.min(uMax, clip);
      });
      return [uMin, uMax];
    }

    // resolves ANY panel key (base wall, pulled-out section, or partition) into
    // a uniform geometric description, recursively following parents.
    function getPanelInfo(panelKey) {
      if (wallDefs[panelKey]) {
        const def = wallDefs[panelKey];
        const [u0, u1] = effectiveWallSpan(panelKey);
        return { normal: def.normal, lengthAxis: def.lengthAxis, thickAxis: def.thickAxis, coord: def.coord, u0, u1 };
      }
      if (panelKey.startsWith("bf:")) {
        const bo = state.bumpouts.find((b) => "bf:" + b.id === panelKey);
        if (!bo) return null;
        const parent = getPanelInfo(bo.panel);
        if (!parent) return null;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const coord = parent.coord + axisSign * bo.depth;
        return { normal: parent.normal, lengthAxis: parent.lengthAxis, thickAxis: parent.thickAxis, coord, u0: bo.u0, u1: bo.u1 };
      }
      if (panelKey.startsWith("pt:")) {
        const p = state.partitions.find((x) => "pt:" + x.id === panelKey);
        if (!p) return null;
        const parent = getPanelInfo(p.panel);
        if (!parent) return null;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const far = parent.coord + axisSign * p.ext;
        const lo = Math.min(parent.coord, far);
        const hi = Math.max(parent.coord, far);
        const faceNormal = parent.lengthAxis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        return { normal: faceNormal, lengthAxis: parent.thickAxis, thickAxis: parent.lengthAxis, coord: p.u, u0: lo, u1: hi };
      }
      if (panelKey.startsWith("bs0:") || panelKey.startsWith("bs1:")) {
        // a bump-out's connector wall: geometrically the same shape as a
        // partition (perpendicular to the origin wall, spanning origin-to-far)
        const isMax = panelKey.startsWith("bs1:");
        const bo = state.bumpouts.find((b) => b.id === Number(panelKey.slice(4)));
        if (!bo) return null;
        const parent = getPanelInfo(bo.panel);
        if (!parent) return null;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const farCoord = parent.coord + axisSign * bo.depth;
        const lo = Math.min(parent.coord, farCoord);
        const hi = Math.max(parent.coord, farCoord);
        const faceNormal = parent.lengthAxis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        return { normal: faceNormal, lengthAxis: parent.thickAxis, thickAxis: parent.lengthAxis, coord: isMax ? bo.u1 : bo.u0, u0: lo, u1: hi };
      }
      return null;
    }

    function applyPanelExtrude(panelKey, newCoord) {
      newCoord = snapValue(newCoord);
      if (wallDefs[panelKey]) {
        wallDefs[panelKey].coord = clampWallCoord(panelKey, newCoord);
        return;
      }
      if (panelKey.startsWith("bf:")) {
        const id = Number(panelKey.slice(3));
        const bo = state.bumpouts.find((b) => b.id === id);
        if (!bo) return;
        const parent = getPanelInfo(bo.panel);
        if (!parent) return;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const newDepth = (newCoord - parent.coord) * axisSign;
        bo.depth = clampBumpDepth(bo.panel, newDepth);
        return;
      }
      if (panelKey.startsWith("bs0:") || panelKey.startsWith("bs1:")) {
        // dragging a connector wall sideways resizes the bump-out it belongs to
        const isMax = panelKey.startsWith("bs1:");
        const bo = state.bumpouts.find((b) => b.id === Number(panelKey.slice(4)));
        if (!bo) return;
        const parent = getPanelInfo(bo.panel);
        if (!parent) return;
        if (isMax) bo.u1 = Math.max(bo.u0 + 0.3, Math.min(parent.u1, newCoord));
        else bo.u0 = Math.min(bo.u1 - 0.3, Math.max(parent.u0, newCoord));
      }
    }
    // a pulled section can grow outward (positive depth, a new protrusion) or
    // inward (negative depth, a notch carved out of the room) -- outward is
    // capped at MAX_DEPTH, inward is capped so at least MIN_SIZE of room remains.
    function clampBumpDepth(parentPanelKey, depth) {
      if (depth >= 0) return Math.min(MAX_DEPTH, depth);
      if (wallDefs[parentPanelKey]) {
        const def = wallDefs[parentPanelKey];
        const fp = state.footprint;
        const span = def.thickAxis === "z" ? fp.zMax - fp.zMin : fp.xMax - fp.xMin;
        return Math.max(-(span - MIN_SIZE), depth);
      }
      return Math.max(-3, depth);
    }

    // soft snapping: pulls a coordinate onto the nearest grid or microgrid
    // line only while it's already close to one; drag further past it and it
    // releases, so it never fights a deliberate large move.
    function snapValue(v) {
      if (!snapEnabledRef.current) return v;
      const major = Math.max(0.02, gridSizeRef.current);
      const minor = major / 10;
      let best = v;
      let bestDist = Infinity;
      [major, minor].forEach((g) => {
        const nearest = Math.round(v / g) * g;
        const dist = Math.abs(v - nearest);
        if (dist < g * 0.286 && dist < bestDist) { best = nearest; bestDist = dist; }
      });
      return best;
    }

    // when dragging an extracted room, magnetically align its edges with
    // any other extracted room's edges, or the original floor's footprint,
    // once they're within CLOSE_SNAP_DIST -- makes it easy to butt rooms up
    // against each other into a new layout.
    function roomBounds(room, ox, oz) {
      const fp = room.data.footprint;
      return { x0: fp.xMin + ox, x1: fp.xMax + ox, z0: fp.zMin + oz, z1: fp.zMax + oz };
    }
    function snapRoomOffset(room, rawOx, rawOz) {
      const bounds = roomBounds(room, rawOx, rawOz);
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const targets = (floorEntry && floorEntry.rooms || [])
        .filter((r) => r.id !== room.id)
        .map((r) => roomBounds(r, r.offsetX || 0, r.offsetZ || 0));
      if (floorEntry) {
        const fp = floorEntry.data.footprint;
        targets.push({ x0: fp.xMin, x1: fp.xMax, z0: fp.zMin, z1: fp.zMax });
      }
      let bestDX = CLOSE_SNAP_DIST, bestDZ = CLOSE_SNAP_DIST;
      targets.forEach((t) => {
        if (bounds.z0 < t.z1 && t.z0 < bounds.z1) {
          [t.x0 - bounds.x1, t.x1 - bounds.x0, t.x0 - bounds.x0, t.x1 - bounds.x1].forEach((d) => {
            if (Math.abs(d) < Math.abs(bestDX)) bestDX = d;
          });
        }
        if (bounds.x0 < t.x1 && t.x0 < bounds.x1) {
          [t.z0 - bounds.z1, t.z1 - bounds.z0, t.z0 - bounds.z0, t.z1 - bounds.z1].forEach((d) => {
            if (Math.abs(d) < Math.abs(bestDZ)) bestDZ = d;
          });
        }
      });
      return {
        ox: Math.abs(bestDX) < CLOSE_SNAP_DIST ? rawOx + bestDX : rawOx,
        oz: Math.abs(bestDZ) < CLOSE_SNAP_DIST ? rawOz + bestDZ : rawOz,
      };
    }

    // ---------- materials & geometry helpers ----------
    // envMapIntensity is kept modest -- Realistic mode's environment map is
    // an *additional* light source on top of the existing lamps, so without
    // this every large flat surface (i.e. most of what's on screen) blows
    // out toward white instead of just picking up a subtle IBL tint.
    const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, map: wallGrainTex, roughnessMap: wallRoughTex, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.35 });
    const floorMat = new THREE.MeshStandardMaterial({ color: COLORS.floor, map: floorGrainTex, roughnessMap: floorRoughTex, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.35 });
    const wallMatDim = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.wall).multiplyScalar(0.5), map: wallGrainTex, roughnessMap: wallRoughTex, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.35 });
    const floorMatDim = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.floor).multiplyScalar(0.5), map: floorGrainTex, roughnessMap: floorRoughTex, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.35 });
    // tinted magenta -- used on the active floor while the Move Room tool is
    // selected, so it's obvious which whole room you're about to drag
    const wallMatSelected = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.wall).lerp(new THREE.Color(COLORS.highlight), 0.7), roughness: 0.92, metalness: 0.02, envMapIntensity: 0.35 });
    const floorMatSelected = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.floor).lerp(new THREE.Color(COLORS.highlight), 0.7), roughness: 0.95, metalness: 0.0, envMapIntensity: 0.35 });
    // balcony pillars/handrail get their own material (30% darker than the
    // wall color) rather than reusing wallMat directly, so darkening them
    // doesn't also darken every actual wall.
    const pillarMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.wall).multiplyScalar(0.7), roughness: 0.85, metalness: 0.02, envMapIntensity: 0.35 });
    const pillarMatSelected = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.wall).multiplyScalar(0.7).lerp(new THREE.Color(COLORS.highlight), 0.7), roughness: 0.92, metalness: 0.02, envMapIntensity: 0.35 });
    // the balcony platform gets its own material too -- a room theme colors
    // it independently from the room's own floor, rather than the platform
    // just always matching whatever the floor happens to be.
    const balconyPlatformMat = new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.35 });
    // decorative room ceiling -- 10% transparent (90% opaque) so it doesn't
    // block editing visibility from above; never added to pickList.
    const ceilingMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.9, envMapIntensity: 0.35 });
    // swapped to the dimmed pair whenever we're building a non-active floor,
    // so every other floor reads as 30% darker while it's not the one you're editing
    let currentWallMat = wallMat;
    let currentFloorMat = floorMat;
    const selMat = new THREE.MeshBasicMaterial({ color: COLORS.highlight, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const selMatPreview = new THREE.MeshBasicMaterial({ color: COLORS.highlight, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    // resize-handle bars drawn along the edges of a selected opening or
    // balcony platform -- a distinct orange (not the magenta selection fill
    // they sit on top of, which they'd otherwise blend into) and unlit /
    // depth-tested off so they always read clearly and stay easy to grab.
    const handleMat = new THREE.MeshBasicMaterial({ color: 0xff6b1a, transparent: true, opacity: 1, depthTest: false });
    // window glass: a thin, mostly-transparent, faintly blue-tinted pane
    // that's noticeably more specular (lower roughness) than the matte
    // wall surface it sits inside. Never added to pickList -- it's purely
    // visual and shouldn't intercept taps meant for the floor/room behind it.
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9ec8ee, transparent: true, opacity: 0.3, roughness: 0.12, metalness: 0.05, side: THREE.DoubleSide,
    });
    // an invisible volume used purely to make thin/hollow things (pillars,
    // window and door cutouts) much easier to tap -- raycasting still hits
    // it (unlike setting mesh.visible=false, which Three.js's Raycaster
    // skips entirely), but it renders as nothing.
    const hotspotMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    // staircases get their own light-pink color so they read distinctly
    // from the walls, rather than blending in as just another wall panel.
    const stairMat = new THREE.MeshStandardMaterial({ color: 0xf2c6d6, roughness: 0.82, metalness: 0.02 });
    // prop shapes, each with its own fixed color
    const propMats = {
      sphere: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.sphere, roughness: 0.55, metalness: 0.05 }),
      cone: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cone, roughness: 0.55, metalness: 0.05 }),
      cube: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cube, roughness: 0.55, metalness: 0.05 }),
      cylinder: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cylinder, roughness: 0.55, metalness: 0.05 }),
    };
    const PROP_HEIGHT = 8 * FT;

    let hiddenLineModeOn = false;
    function addEdges(mesh) {
      const eg = new THREE.EdgesGeometry(mesh.geometry, 20);
      const color = hiddenLineModeOn ? 0x000000 : COLORS.wallEdge;
      const opacity = hiddenLineModeOn ? 1.0 : 0.55;
      const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
      mesh.add(line);
    }

    // axis 'x' => panel runs along world X (thickness along Z); axis 'z' => runs along Z (thickness along X)
    function makePanel(axis, fixedCoord, a, b, thickness, yBase, yTop, material) {
      const len = Math.max(0.02, b - a);
      const h = Math.max(0.02, yTop - yBase);
      const geo = axis === "x" ? new THREE.BoxGeometry(len, h, thickness) : new THREE.BoxGeometry(thickness, h, len);
      const mesh = new THREE.Mesh(geo, material);
      const yMid = (yBase + yTop) / 2;
      if (axis === "x") mesh.position.set((a + b) / 2, yMid, fixedCoord);
      else mesh.position.set(fixedCoord, yMid, (a + b) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      addEdges(mesh);
      return mesh;
    }

    // a thin glass pane filling a window opening -- same positioning
    // convention as makePanel, just much thinner and never pickable.
    function makeGlassPane(axis, fixedCoord, a, b, yBase, yTop) {
      const len = Math.max(0.02, b - a);
      const h = Math.max(0.02, yTop - yBase);
      if (len < 0.05 || h < 0.05) return null;
      const glassThickness = 0.02;
      const geo = axis === "x" ? new THREE.BoxGeometry(len, h, glassThickness) : new THREE.BoxGeometry(glassThickness, h, len);
      const mesh = new THREE.Mesh(geo, glassMat);
      const yMid = (yBase + yTop) / 2;
      if (axis === "x") mesh.position.set((a + b) / 2, yMid, fixedCoord);
      else mesh.position.set(fixedCoord, yMid, (a + b) / 2);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      return mesh;
    }

    // shared by both wall-panel and partition rendering: cuts an opening
    // into the solid wall via addSeg (the caller's segment-filler), then
    // either leaves a plain floor-to-lintel doorway (no glass) or fills a
    // window with glass -- split into (dividers+1) panes with thin
    // wall-colored mullions between them when dividers > 0.
    // an invisible hit-volume spanning the whole opening (window or door),
    // so tapping anywhere in that column selects it -- there's no solid
    // geometry to raycast against otherwise, since an opening is a hole.
    // Also draws a visible magenta highlight overlay when it's the
    // currently selected opening.
    function addOpeningHotspotAndHighlight(c, lengthAxis, coord, y0, y1) {
      const len = Math.max(0.02, c.u1 - c.u0);
      const h = Math.max(0.02, y1 - y0);
      const T = state.thickness;
      const hgeo = lengthAxis === "x" ? new THREE.BoxGeometry(len, h, T) : new THREE.BoxGeometry(T, h, len);
      const hmesh = new THREE.Mesh(hgeo, hotspotMat);
      if (lengthAxis === "x") hmesh.position.set((c.u0 + c.u1) / 2, (y0 + y1) / 2, coord);
      else hmesh.position.set(coord, (y0 + y1) / 2, (c.u0 + c.u1) / 2);
      hmesh.userData = { kind: "opening", id: c.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
      sceneGroup.add(hmesh);
      if (isPickableTarget) pickList.push(hmesh);

      if (isPickableTarget && selectedOpeningIdRef.current === c.id) {
        const hlGeo = new THREE.PlaneGeometry(len, h);
        const hlMesh = new THREE.Mesh(hlGeo, selMat);
        if (lengthAxis === "x") {
          hlMesh.position.set((c.u0 + c.u1) / 2, (y0 + y1) / 2, coord);
        } else {
          hlMesh.rotation.y = Math.PI / 2;
          hlMesh.position.set(coord, (y0 + y1) / 2, (c.u0 + c.u1) / 2);
        }
        sceneGroup.add(hlMesh);
        addOpeningResizeHandles(c, lengthAxis, coord, y0, y1);
      }
    }

    // draggable edge bars around a selected opening -- left/right resize its
    // width (u0/u1), top resizes its height, and bottom (windows only --
    // doors are floor-anchored) resizes it from below. Poke slightly proud
    // of both wall faces and render on top (handleMat has depthTest off) so
    // they're always visible and easy to grab regardless of viewing angle.
    function addOpeningResizeHandles(c, lengthAxis, coord, y0, y1) {
      const T = state.thickness;
      const barU = Math.min(0.22, Math.max(0.1, (c.u1 - c.u0) * 0.35));
      const barY = Math.min(0.22, Math.max(0.1, (y1 - y0) * 0.35));
      function addHandle(edge, uCenter, yCenter, uLen, yLen) {
        const geo = lengthAxis === "x"
          ? new THREE.BoxGeometry(uLen, yLen, T + 0.05)
          : new THREE.BoxGeometry(T + 0.05, yLen, uLen);
        const mesh = new THREE.Mesh(geo, handleMat);
        mesh.renderOrder = 10;
        if (lengthAxis === "x") mesh.position.set(uCenter, yCenter, coord);
        else mesh.position.set(coord, yCenter, uCenter);
        mesh.userData = { kind: "resize-handle", target: "opening", id: c.id, edge, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(mesh);
        if (isPickableTarget) pickList.push(mesh);
      }
      addHandle("left", c.u0, (y0 + y1) / 2, barU, y1 - y0);
      addHandle("right", c.u1, (y0 + y1) / 2, barU, y1 - y0);
      addHandle("top", (c.u0 + c.u1) / 2, y1, c.u1 - c.u0, barY);
      if (!c.isDoor) addHandle("bottom", (c.u0 + c.u1) / 2, y0, c.u1 - c.u0, barY);
    }

    function renderOpeningCutout(c, lengthAxis, coord, H, addSeg, addMullion) {
      // bottomOverride lets an opening start above floor level (e.g. a
      // balcony door/window off a raised platform instead of the ground).
      // For a balcony opening, re-resolve it from the balcony's current
      // platformHeight every rebuild rather than trusting the value
      // snapshotted when the opening was first drawn -- otherwise raising
      // or lowering the platform height slider afterward leaves the door
      // floating at its original height instead of following the platform.
      if (c.fromBalcony != null) {
        const bal = (state.balconies || []).find((b) => b.id === c.fromBalcony);
        if (bal) c = { ...c, bottomOverride: bal.platformHeight || c.bottomOverride };
      }
      if (c.isDoor) {
        const doorBottom = Math.max(0, Math.min(H - 0.1, c.bottomOverride || 0));
        const h = Math.min(c.height ?? DEFAULT_OPENING_HEIGHT, H - doorBottom);
        const doorTop = doorBottom + h;
        if (doorBottom > 0.02) addSeg(c.u0, c.u1, 0, doorBottom);
        if (doorTop < H - 0.02) addSeg(c.u0, c.u1, doorTop, H);
        addOpeningHotspotAndHighlight(c, lengthAxis, coord, doorBottom, doorTop);
        return;
      }
      const bottomOverride = c.bottomOverride;
      const h = bottomOverride != null
        ? Math.min(c.height ?? DEFAULT_OPENING_HEIGHT, H - 0.05 - bottomOverride)
        : Math.min(c.height ?? DEFAULT_OPENING_HEIGHT, H - 0.1);
      const bottomY = bottomOverride != null ? Math.max(0, bottomOverride) : Math.max(0, (H - h) / 2);
      const topY = Math.min(H, bottomY + h);
      addSeg(c.u0, c.u1, 0, bottomY);
      addSeg(c.u0, c.u1, topY, H);
      addOpeningHotspotAndHighlight(c, lengthAxis, coord, bottomY, topY);

      const n = Math.max(0, Math.round(c.dividers || 0));
      const axis = c.dividerAxis || "vertical";
      const doVertical = axis === "vertical" || axis === "both";
      const doHorizontal = axis === "horizontal" || axis === "both";
      const mullionWidth = 0.05;

      // vertical dividers split the opening into columns (u-spans); if off,
      // there's just one column spanning the whole width.
      const uCols = doVertical ? n + 1 : 1;
      const uMullions = doVertical ? n : 0;
      const uAvail = Math.max(0.1, (c.u1 - c.u0) - uMullions * mullionWidth);
      const uColSpan = uAvail / uCols;
      let uCursor = c.u0;
      const uSpans = [];
      for (let i = 0; i < uCols; i++) {
        const hi = uCursor + uColSpan;
        uSpans.push({ lo: uCursor, hi });
        uCursor = hi;
        if (i < uCols - 1) {
          addMullion(uCursor, uCursor + mullionWidth, bottomY, topY);
          uCursor += mullionWidth;
        }
      }

      // horizontal dividers split the opening into rows (y-spans); if off,
      // there's just one row spanning the whole height.
      const yRows = doHorizontal ? n + 1 : 1;
      const yMullions = doHorizontal ? n : 0;
      const yAvail = Math.max(0.1, (topY - bottomY) - yMullions * mullionWidth);
      const yRowSpan = yAvail / yRows;
      let yCursor = bottomY;
      const ySpans = [];
      for (let j = 0; j < yRows; j++) {
        const hi = yCursor + yRowSpan;
        ySpans.push({ lo: yCursor, hi });
        yCursor = hi;
        if (j < yRows - 1) {
          addMullion(c.u0, c.u1, yCursor, yCursor + mullionWidth);
          yCursor += mullionWidth;
        }
      }

      uSpans.forEach((us) => {
        ySpans.forEach((ys) => {
          const glass = makeGlassPane(lengthAxis, coord, us.lo, us.hi, ys.lo, ys.hi);
          if (glass) { glass.userData = { kind: "glass" }; sceneGroup.add(glass); }
        });
      });
    }

    function disposeObject(obj) {
      obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material !== wallMat && o.material !== floorMat && o.material !== wallMatDim && o.material !== floorMatDim && o.material !== wallMatSelected && o.material !== floorMatSelected && o.material !== pillarMat && o.material !== pillarMatSelected && o.material !== ceilingMat && o.material !== selMat && o.material !== selMatPreview && o.material !== handleMat && o.material !== glassMat && o.material !== stairMat && o.material !== hotspotMat && !Object.values(propMats).includes(o.material)) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
    function clearGroup(group) {
      while (group.children.length) {
        const c = group.children[0];
        group.remove(c);
        disposeObject(c);
      }
    }

    function rangesOverlap(a0, a1, b0, b1) { return a0 < b1 && b0 < a1; }
    function wouldOverlapOpening(panelKey, u0, u1) {
      return state.openings.some((o) => o.panel === panelKey && rangesOverlap(u0, u1, o.u0, o.u1));
    }
    // resizing an opening/balcony by its own edge handle must not count its
    // own (or, for a balcony, its own door+windows') existing span as an
    // overlap with itself.
    function wouldOverlapOpeningExcluding(panelKey, u0, u1, excludeId) {
      return state.openings.some((o) => o.id !== excludeId && o.panel === panelKey && rangesOverlap(u0, u1, o.u0, o.u1));
    }
    function wouldOverlapOpeningExcludingBalcony(panelKey, u0, u1, balconyId) {
      return state.openings.some((o) => o.fromBalcony !== balconyId && o.panel === panelKey && rangesOverlap(u0, u1, o.u0, o.u1));
    }
    function wouldOverlapSelection(panelKey, u0, u1) {
      return state.selections.some((s) => s.panel === panelKey && rangesOverlap(u0, u1, s.u0, s.u1));
    }
    function wouldOverlapBumpout(panelKey, u0, u1) {
      return state.bumpouts.some((b) => b.panel === panelKey && rangesOverlap(u0, u1, b.u0, b.u1));
    }
    function panelU(info, p) { return info.lengthAxis === "x" ? p.x : p.z; }
    function clampWallCoord(wallId, v) {
      const fp = state.footprint;
      if (wallId === "north") return Math.max(-MAX_COORD, Math.min(v, fp.zMax - MIN_SIZE));
      if (wallId === "south") return Math.min(MAX_COORD, Math.max(v, fp.zMin + MIN_SIZE));
      if (wallId === "west") return Math.max(-MAX_COORD, Math.min(v, fp.xMax - MIN_SIZE));
      if (wallId === "east") return Math.min(MAX_COORD, Math.max(v, fp.xMin + MIN_SIZE));
      return v;
    }
    // partitions carry a signed extension: negative = grows toward the opposite
    // wall (and snaps flush once it reaches it), positive = grows outward, away
    // from the room, capped at a fixed reach since there's nothing to connect to.
    // a partition (or a wall pulled inward) that comes within CLOSE_SNAP_DIST
    // of the opposite wall is treated as having reached it -- snapping flush
    // so the two are considered connected, closing off an enclosed space,
    // without requiring pixel-perfect dragging.
    const CLOSE_SNAP_DIST = 2.6 * FT;
    function clampPartitionExt(parentPanelKey, ext) {
      if (wallDefs[parentPanelKey]) {
        const def = wallDefs[parentPanelKey];
        const fp = state.footprint;
        const span = def.thickAxis === "z" ? fp.zMax - fp.zMin : fp.xMax - fp.xMin;
        if (ext < 0) {
          let v = Math.max(-span, ext);
          if (v < -(span - CLOSE_SNAP_DIST)) v = -span;
          return v;
        }
        return Math.min(OUTWARD_PARTITION_MAX, ext);
      }
      return Math.max(-OUTWARD_PARTITION_MAX, Math.min(OUTWARD_PARTITION_MAX, ext));
    }
    function snapToPanelPlane(info, pt) {
      const p = pt.clone();
      if (info.thickAxis === "z") p.z = info.coord; else p.x = info.coord;
      return p;
    }

    // ---------- rebuild the visible + pickable geometry from state ----------
    let pickList = [];
    let previewSelection = null;
    let previewOpening = null;
    let previewStair = null; // {x0,x1,z0,z1} while dragging out a new staircase footprint
    let measureAnchors = []; // {point: Vector3, text} for the length overlay

    function defaultStairSteps(height) {
      return Math.max(2, Math.round((height / FT) * 2));
    }

    function openingsFor(panelKey) {
      const list = state.openings.filter((o) => o.panel === panelKey).map((o) => ({ ...o }));
      if (previewOpening && previewOpening.panel === panelKey) list.push({ ...previewOpening, id: "__preview__" });
      return list;
    }
    function bumpoutsFor(panelKey) { return state.bumpouts.filter((b) => b.panel === panelKey); }
    function selectionsFor(panelKey) {
      const list = state.selections.filter((s) => s.panel === panelKey);
      if (previewSelection && previewSelection.panel === panelKey) list.push(previewSelection);
      return list;
    }

    // determines which of the room's 4 base corners are safe to round -- a
    // corner next to any bump-out (pushed out OR pulled in) is left sharp,
    // since the simple 4-corner fillet math assumes a plain rectangle there;
    // trying to round it too would create the wall "break" that shows up
    // when a bump-out sits right at a corner.
    function computeCurvableCorners(cornerR) {
      const margin = cornerR + 0.4;
      function bumpNearMinEnd(panelKey) {
        const info = getPanelInfo(panelKey);
        if (!info) return false;
        return state.bumpouts.some((b) => b.panel === panelKey && Math.abs(b.depth) > 0.02 && b.u0 < info.u0 + margin);
      }
      function bumpNearMaxEnd(panelKey) {
        const info = getPanelInfo(panelKey);
        if (!info) return false;
        return state.bumpouts.some((b) => b.panel === panelKey && Math.abs(b.depth) > 0.02 && b.u1 > info.u1 - margin);
      }
      return {
        nw: !bumpNearMinEnd("north") && !bumpNearMinEnd("west"),
        ne: !bumpNearMaxEnd("north") && !bumpNearMinEnd("east"),
        se: !bumpNearMaxEnd("south") && !bumpNearMaxEnd("east"),
        sw: !bumpNearMinEnd("south") && !bumpNearMaxEnd("west"),
      };
    }

    // traces the room's floor boundary as a THREE.Shape, using a straight
    // line at any corner that isn't curvable and an arc (matching the wall
    // fillets exactly) at any corner that is -- so the floor always lines
    // up with whatever the walls are actually doing.
    function buildCurvedFloorShape(fp, curvable, R) {
      const shape = new THREE.Shape();
      shape.moveTo(curvable.nw ? fp.xMin + R : fp.xMin, fp.zMin);
      shape.lineTo(curvable.ne ? fp.xMax - R : fp.xMax, fp.zMin);
      if (curvable.ne) shape.absarc(fp.xMax - R, fp.zMin + R, R, -Math.PI / 2, 0, false);
      shape.lineTo(fp.xMax, curvable.se ? fp.zMax - R : fp.zMax);
      if (curvable.se) shape.absarc(fp.xMax - R, fp.zMax - R, R, 0, Math.PI / 2, false);
      shape.lineTo(curvable.sw ? fp.xMin + R : fp.xMin, fp.zMax);
      if (curvable.sw) shape.absarc(fp.xMin + R, fp.zMax - R, R, Math.PI / 2, Math.PI, false);
      shape.lineTo(fp.xMin, curvable.nw ? fp.zMin + R : fp.zMin);
      if (curvable.nw) shape.absarc(fp.xMin + R, fp.zMin + R, R, Math.PI, Math.PI * 1.5, false);
      shape.closePath();
      return shape;
    }

    function renderPanel(panelKey, bumpoutFloorPieces) {
      const info = getPanelInfo(panelKey);
      if (!info) return;
      const { normal, lengthAxis, thickAxis, coord, u0: uMin, u1: uMax } = info;
      const H = getPanelHeight(panelKey);
      const T = state.thickness;

      // curved corners only ever trim the 4 base walls of the room's own
      // rectangular footprint -- bump-out walls and partitions are left
      // alone, and this is a purely visual trim (the interactive u0/u1 used
      // for dragging elsewhere is untouched). Each end is only inset when
      // that particular corner is curvable (see computeCurvableCorners).
      const isBaseWall = panelKey === "north" || panelKey === "south" || panelKey === "east" || panelKey === "west";
      let wallU0 = uMin, wallU1 = uMax;
      const cc = state.curvedCorners;
      if (isBaseWall && cc && cc.enabled && cc.radius > 0.05) {
        const fp = state.footprint;
        const cornerR = Math.min(cc.radius, (fp.xMax - fp.xMin) / 2 - 0.15, (fp.zMax - fp.zMin) / 2 - 0.15);
        if (cornerR > 0.05) {
          const curvable = computeCurvableCorners(cornerR);
          let minOk, maxOk;
          if (panelKey === "north") { minOk = curvable.nw; maxOk = curvable.ne; }
          else if (panelKey === "south") { minOk = curvable.sw; maxOk = curvable.se; }
          else if (panelKey === "west") { minOk = curvable.nw; maxOk = curvable.sw; }
          else { minOk = curvable.ne; maxOk = curvable.se; } // east
          if (minOk) wallU0 = uMin + cornerR;
          if (maxOk) wallU1 = uMax - cornerR;
        }
      }

      function addSeg(a, b, yb, yt) {
        if (b - a < 0.02 || yt - yb < 0.02) return;
        const isSelectedWall = isPickableTarget && selectedPanelRef.current === panelKey;
        const seg = makePanel(lengthAxis, coord, a, b, T, yb, yt, isSelectedWall ? wallMatSelected : currentWallMat);
        seg.userData = { kind: "wall", panel: panelKey, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(seg);
        if (isPickableTarget) pickList.push(seg);
      }
      // window mullions read as slender frame bars, not a second wall --
      // kept thinner than the wall itself rather than matching it.
      function addMullion(a, b, yb, yt) {
        if (b - a < 0.02 || yt - yb < 0.02) return;
        const seg = makePanel(lengthAxis, coord, a, b, T * 0.7, yb, yt, currentWallMat);
        seg.userData = { kind: "wall", panel: panelKey, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(seg);
      }

      const cuts = [
        ...openingsFor(panelKey).map((o) => ({ ...o, _t: "open" })),
        ...bumpoutsFor(panelKey).map((b) => ({ ...b, _t: "bump" })),
      ]
        .map((c) => ({ ...c, u0: Math.max(wallU0, Math.min(c.u0, wallU1)), u1: Math.max(wallU0, Math.min(c.u1, wallU1)) }))
        .filter((c) => c.u1 - c.u0 > 0.05)
        .sort((a, b) => a.u0 - b.u0);

      let cursor = wallU0;
      cuts.forEach((c) => {
        if (c.u0 > cursor + 0.001) addSeg(cursor, c.u0, 0, H);
        if (c._t === "open") {
          renderOpeningCutout(c, lengthAxis, coord, H, addSeg, addMullion);
        } else if (Math.abs(c.depth) > 0.02) {
          // the far wall AND the two connector (side) walls are each rendered
          // by their own panel pass below ("bf:"/"bs0:"/"bs1:"+c.id) so every
          // one of them can carry its own cuts, highlights, and further pulls
          // -- building any of them again here would duplicate/mask them.
          if (c.depth > 0.02) {
            // only an outward pull adds new floor area; an inward pull carves
            // a notch that gets subtracted from the floor separately below
            const axisSign = thickAxis === "z" ? normal.z : normal.x;
            const farCoord = coord + axisSign * c.depth;
            const lo = Math.min(coord, farCoord);
            const hi = Math.max(coord, farCoord);
            bumpoutFloorPieces.push({ axis: lengthAxis, u0: c.u0, u1: c.u1, lo, hi });
          }
        }
        cursor = c.u1;
      });
      if (cursor < wallU1 - 0.001) addSeg(cursor, wallU1, 0, H);

      selectionsFor(panelKey).forEach((sel) => {
        const u0 = Math.max(wallU0, Math.min(sel.u0, wallU1));
        const u1 = Math.max(wallU0, Math.min(sel.u1, wallU1));
        if (u1 - u0 < 0.05) return;
        const geo = new THREE.PlaneGeometry(u1 - u0, H);
        const mat = sel.id === "__preview__" ? selMatPreview : selMat;
        const mesh = new THREE.Mesh(geo, mat);
        const offset = T / 2 + 0.015;
        let posX, posZ;
        if (lengthAxis === "x") { posX = (u0 + u1) / 2; posZ = coord + normal.z * offset; }
        else { posZ = (u0 + u1) / 2; posX = coord + normal.x * offset; }
        mesh.position.set(posX, H / 2, posZ);
        mesh.lookAt(mesh.position.clone().add(normal));
        mesh.userData = { kind: "selection", id: sel.id, panel: panelKey, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(mesh);
        if (sel.id !== "__preview__" && isPickableTarget) pickList.push(mesh);
      });
    }

    function renderPartition(p) {
      const parent = getPanelInfo(p.panel);
      if (!parent) return;
      p.u = Math.max(parent.u0, Math.min(parent.u1, p.u));
      p.ext = clampPartitionExt(p.panel, p.ext);
      if (Math.abs(p.ext) < 0.03) return;
      const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
      const far = parent.coord + axisSign * p.ext;
      const lo = Math.min(parent.coord, far);
      const hi = Math.max(parent.coord, far);
      const lengthAxis = parent.thickAxis;
      const panelKey = "pt:" + p.id;
      const H = getPanelHeight(panelKey);
      const T = state.thickness;

      function addSeg(a, b, yb, yt) {
        if (b - a < 0.02 || yt - yb < 0.02) return;
        const isSelectedWall = isPickableTarget && selectedPanelRef.current === "pt:" + p.id;
        const seg = makePanel(lengthAxis, p.u, a, b, T, yb, yt, isSelectedWall ? wallMatSelected : currentWallMat);
        seg.userData = { kind: "partition", id: p.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(seg);
        if (isPickableTarget) pickList.push(seg);
      }
      function addMullion(a, b, yb, yt) {
        if (b - a < 0.02 || yt - yb < 0.02) return;
        const seg = makePanel(lengthAxis, p.u, a, b, T * 0.7, yb, yt, currentWallMat);
        seg.userData = { kind: "partition", id: p.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(seg);
      }

      const opens = openingsFor(panelKey)
        .map((o) => ({ ...o, u0: Math.max(lo, Math.min(o.u0, hi)), u1: Math.max(lo, Math.min(o.u1, hi)) }))
        .filter((o) => o.u1 - o.u0 > 0.05)
        .sort((a, b) => a.u0 - b.u0);

      let cursor = lo;
      opens.forEach((op) => {
        if (op.u0 > cursor + 0.001) addSeg(cursor, op.u0, 0, H);
        renderOpeningCutout(op, lengthAxis, p.u, H, addSeg, addMullion);
        cursor = op.u1;
      });
      if (cursor < hi - 0.001) addSeg(cursor, hi, 0, H);
    }

    // standard rectangle-minus-rectangle: splits `rect` around `cut`, returning
    // up to 4 non-overlapping remainder pieces (or [rect] unchanged if no overlap)
    function subtractRect(rect, cut) {
      const ix0 = Math.max(rect.x0, cut.x0), ix1 = Math.min(rect.x1, cut.x1);
      const iz0 = Math.max(rect.z0, cut.z0), iz1 = Math.min(rect.z1, cut.z1);
      if (ix0 >= ix1 || iz0 >= iz1) return [rect];
      const pieces = [];
      if (rect.z0 < iz0) pieces.push({ x0: rect.x0, x1: rect.x1, z0: rect.z0, z1: iz0 });
      if (rect.z1 > iz1) pieces.push({ x0: rect.x0, x1: rect.x1, z0: iz1, z1: rect.z1 });
      if (rect.x0 < ix0) pieces.push({ x0: rect.x0, x1: ix0, z0: iz0, z1: iz1 });
      if (rect.x1 > ix1) pieces.push({ x0: ix1, x1: rect.x1, z0: iz0, z1: iz1 });
      return pieces;
    }
    function subtractAll(rects, cut) {
      let out = [];
      rects.forEach((r) => { out = out.concat(subtractRect(r, cut)); });
      return out;
    }
    // stairwell headroom cutout: a rectangle the width of the stair, running
    // 6ft back from the point where the stair reaches full height (its
    // "end") toward where it starts climbing -- a simplified stand-in for
    // a real headroom calculation, sized for one average person's clearance.
    const STAIR_HEADROOM = 12 * FT;
    function computeStairHoleCut(stair) {
      const dir = Math.sign(stair.end - stair.start) || 1;
      const a = stair.end, b = stair.end - dir * STAIR_HEADROOM;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (stair.axis === "x") return { x0: lo, x1: hi, z0: stair.widthMin, z1: stair.widthMax };
      return { x0: stair.widthMin, x1: stair.widthMax, z0: lo, z1: hi };
    }
    function notchFloorCut(bump) {
      const def = wallDefs[bump.panel];
      if (!def) return null; // only notches on the 4 base walls affect the floor
      const axisSign = def.thickAxis === "z" ? def.normal.z : def.normal.x;
      const farCoord = def.coord + axisSign * bump.depth;
      const lo = Math.min(def.coord, farCoord), hi = Math.max(def.coord, farCoord);
      return def.lengthAxis === "x"
        ? { x0: bump.u0, x1: bump.u1, z0: lo, z1: hi }
        : { x0: lo, x1: hi, z0: bump.u0, z1: bump.u1 };
    }

    // an inward pull that reaches all the way to a base wall's actual corner
    // hands that corner off to the perpendicular wall (which effectiveWallSpan
    // shortens to meet it) instead of also building a connector wall there.
    function bumpoutCornerTouch(bo) {
      if (bo.depth >= -0.02 || !wallDefs[bo.panel]) return { min: false, max: false };
      const raw = wallSpan(bo.panel);
      return { min: Math.abs(bo.u0 - raw[0]) < 0.05, max: Math.abs(bo.u1 - raw[1]) < 0.05 };
    }

    // ---------- room detection (flood fill over a fine grid) ----------
    // Everything in this app is axis-aligned, so a rasterized flood fill is a
    // simple, robust way to find enclosed sub-areas: mark which grid cells
    // fall inside the floor's footprint (base rectangle plus any outward
    // pull, minus any inward notch), treat partitions as walls that block
    // movement between cells, then flood-fill connected components. Each
    // component is one enclosed room. This only "sees" straight, axis-aligned
    // partitions -- it won't detect rooms shaped by anything else.
    function outwardBumpRect(b) {
      const parent = getPanelInfo(b.panel);
      if (!parent || b.depth <= 0.02) return null;
      const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
      const farCoord = parent.coord + axisSign * b.depth;
      const lo = Math.min(parent.coord, farCoord), hi = Math.max(parent.coord, farCoord);
      return parent.lengthAxis === "x" ? { x0: b.u0, x1: b.u1, z0: lo, z1: hi } : { x0: lo, x1: hi, z0: b.u0, z1: b.u1 };
    }
    function detectRooms() {
      const fp = state.footprint;
      let floorRects = [{ x0: fp.xMin, x1: fp.xMax, z0: fp.zMin, z1: fp.zMax }];
      state.bumpouts.forEach((b) => {
        if (b.depth < -0.02) {
          const cut = notchFloorCut(b);
          if (cut) floorRects = subtractAll(floorRects, cut);
        }
      });
      const outwardRects = state.bumpouts.map(outwardBumpRect).filter(Boolean);
      const allRects = floorRects.concat(outwardRects);
      if (allRects.length === 0) return [];

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      allRects.forEach((r) => { minX = Math.min(minX, r.x0); maxX = Math.max(maxX, r.x1); minZ = Math.min(minZ, r.z0); maxZ = Math.max(maxZ, r.z1); });
      if (!isFinite(minX) || maxX - minX < 0.1 || maxZ - minZ < 0.1) return [];

      let CELL = 0.15;
      let cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
      let rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
      while (cols * rows > 40000) {
        CELL *= 1.3;
        cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
        rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
      }

      const inside = new Uint8Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const cx = minX + (i + 0.5) * CELL, cz = minZ + (j + 0.5) * CELL;
          inside[j * cols + i] = allRects.some((r) => cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1) ? 1 : 0;
        }
      }

      const partitionSegs = [];
      state.partitions.forEach((p) => {
        const parent = getPanelInfo(p.panel);
        if (!parent || Math.abs(p.ext) < 0.03) return;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const far = parent.coord + axisSign * p.ext;
        const lo = Math.min(parent.coord, far), hi = Math.max(parent.coord, far);
        if (parent.thickAxis === "z") partitionSegs.push({ vertical: true, at: p.u, a: lo, b: hi });
        else partitionSegs.push({ vertical: false, at: p.u, a: lo, b: hi });
      });
      function blockedV(edgeX, z0, z1) {
        return partitionSegs.some((s) => s.vertical && Math.abs(s.at - edgeX) < CELL * 0.5 && s.a <= z1 - 1e-6 && s.b >= z0 + 1e-6);
      }
      function blockedH(edgeZ, x0, x1) {
        return partitionSegs.some((s) => !s.vertical && Math.abs(s.at - edgeZ) < CELL * 0.5 && s.a <= x1 - 1e-6 && s.b >= x0 + 1e-6);
      }

      const roomOf = new Int32Array(cols * rows).fill(-1);
      const rooms = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          if (!inside[idx] || roomOf[idx] !== -1) continue;
          const id = rooms.length;
          const cellList = [];
          const stack = [[i, j]];
          roomOf[idx] = id;
          while (stack.length) {
            const [ci, cj] = stack.pop();
            cellList.push([ci, cj]);
            const cx0 = minX + ci * CELL, cx1 = cx0 + CELL, cz0 = minZ + cj * CELL, cz1 = cz0 + CELL;
            const tryNeighbor = (ni, nj, blocked) => {
              if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) return;
              const nIdx = nj * cols + ni;
              if (inside[nIdx] && roomOf[nIdx] === -1 && !blocked) { roomOf[nIdx] = id; stack.push([ni, nj]); }
            };
            tryNeighbor(ci + 1, cj, blockedV(cx1, cz0, cz1));
            tryNeighbor(ci - 1, cj, blockedV(cx0, cz0, cz1));
            tryNeighbor(ci, cj + 1, blockedH(cz1, cx0, cx1));
            tryNeighbor(ci, cj - 1, blockedH(cz0, cx0, cx1));
          }
          rooms.push({ cellList });
        }
      }

      return rooms.map((room) => {
        const cellSet = new Set(room.cellList.map(([i, j]) => i + "," + j));
        // merge cells into floor rectangles: horizontal runs per row, then
        // stack rows with an identical run into a single taller rectangle
        const byRow = new Map();
        room.cellList.forEach(([i, j]) => { if (!byRow.has(j)) byRow.set(j, []); byRow.get(j).push(i); });
        const rowRuns = [];
        byRow.forEach((is, j) => {
          is.sort((a, b) => a - b);
          let start = is[0], prev = is[0];
          for (let k = 1; k < is.length; k++) {
            if (is[k] === prev + 1) { prev = is[k]; continue; }
            rowRuns.push({ j, i0: start, i1: prev }); start = is[k]; prev = is[k];
          }
          rowRuns.push({ j, i0: start, i1: prev });
        });
        rowRuns.sort((a, b) => a.j - b.j || a.i0 - b.i0);
        const used = new Array(rowRuns.length).fill(false);
        const floorRectsOut = [];
        for (let a = 0; a < rowRuns.length; a++) {
          if (used[a]) continue;
          let j0 = rowRuns[a].j, j1 = rowRuns[a].j;
          const i0 = rowRuns[a].i0, i1 = rowRuns[a].i1;
          used[a] = true;
          let extended = true;
          while (extended) {
            extended = false;
            for (let b = 0; b < rowRuns.length; b++) {
              if (used[b]) continue;
              if (rowRuns[b].i0 === i0 && rowRuns[b].i1 === i1 && rowRuns[b].j === j1 + 1) { j1 = rowRuns[b].j; used[b] = true; extended = true; }
            }
          }
          floorRectsOut.push({ x0: minX + i0 * CELL, x1: minX + (i1 + 1) * CELL, z0: minZ + j0 * CELL, z1: minZ + (j1 + 1) * CELL });
        }

        // perimeter: any cell edge whose neighbor isn't in this room becomes
        // a wall edge; merge collinear runs along each grid line
        const vEdges = [], hEdges = [];
        room.cellList.forEach(([i, j]) => {
          const cx0 = minX + i * CELL, cx1 = cx0 + CELL, cz0 = minZ + j * CELL, cz1 = cz0 + CELL;
          if (!cellSet.has((i - 1) + "," + j)) vEdges.push({ x: cx0, z0: cz0, z1: cz1 });
          if (!cellSet.has((i + 1) + "," + j)) vEdges.push({ x: cx1, z0: cz0, z1: cz1 });
          if (!cellSet.has(i + "," + (j - 1))) hEdges.push({ z: cz0, x0: cx0, x1: cx1 });
          if (!cellSet.has(i + "," + (j + 1))) hEdges.push({ z: cz1, x0: cx0, x1: cx1 });
        });
        const wallSegs = [];
        const byX = new Map();
        vEdges.forEach((e) => { const k = e.x.toFixed(4); if (!byX.has(k)) byX.set(k, []); byX.get(k).push(e); });
        byX.forEach((edges, k) => {
          edges.sort((a, b) => a.z0 - b.z0);
          let s = edges[0].z0, en = edges[0].z1;
          for (let idx = 1; idx < edges.length; idx++) {
            if (edges[idx].z0 <= en + 1e-6) en = Math.max(en, edges[idx].z1);
            else { wallSegs.push({ axis: "z", coord: parseFloat(k), a: s, b: en }); s = edges[idx].z0; en = edges[idx].z1; }
          }
          wallSegs.push({ axis: "z", coord: parseFloat(k), a: s, b: en });
        });
        const byZ = new Map();
        hEdges.forEach((e) => { const k = e.z.toFixed(4); if (!byZ.has(k)) byZ.set(k, []); byZ.get(k).push(e); });
        byZ.forEach((edges, k) => {
          edges.sort((a, b) => a.x0 - b.x0);
          let s = edges[0].x0, en = edges[0].x1;
          for (let idx = 1; idx < edges.length; idx++) {
            if (edges[idx].x0 <= en + 1e-6) en = Math.max(en, edges[idx].x1);
            else { wallSegs.push({ axis: "x", coord: parseFloat(k), a: s, b: en }); s = edges[idx].x0; en = edges[idx].x1; }
          }
          wallSegs.push({ axis: "x", coord: parseFloat(k), a: s, b: en });
        });

        const cx = floorRectsOut.reduce((sum, r) => sum + (r.x0 + r.x1) / 2, 0) / floorRectsOut.length;
        const cz = floorRectsOut.reduce((sum, r) => sum + (r.z0 + r.z1) / 2, 0) / floorRectsOut.length;
        let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
        floorRectsOut.forEach((r) => { bx0 = Math.min(bx0, r.x0); bx1 = Math.max(bx1, r.x1); bz0 = Math.min(bz0, r.z0); bz1 = Math.max(bz1, r.z1); });
        return { floorRects: floorRectsOut, wallSegs, centroid: { x: cx, z: cz }, bbox: { xMin: bx0, xMax: bx1, zMin: bz0, zMax: bz1 } };
      });
    }

    // A notch (negative-depth bumpout) cuts a chunk out of the room's floor
    // on the assumption that the cut area stays open to the exterior. But a
    // partition can wall off part of that cut -- e.g. a partition drawn
    // across a notch's mouth turns it into a fully enclosed room -- and once
    // that happens the area is topologically interior even though it's still
    // outside `floorRects`. This finds any such sealed pocket so the floor
    // can be healed there. Modeled on detectRooms()'s grid flood-fill: void
    // cells (inside the footprint but cut away by a notch) are flooded
    // starting from the footprint's outer edge, blocked by partition
    // segments; whatever void never gets reached from the edge is sealed off
    // and needs its floor restored.
    function computeSealedNotchFloorRects(floorRectsPostNotch) {
      const fp = state.footprint;
      const minX = fp.xMin, maxX = fp.xMax, minZ = fp.zMin, maxZ = fp.zMax;
      if (maxX - minX < 0.1 || maxZ - minZ < 0.1) return [];

      let CELL = 0.15;
      let cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
      let rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
      while (cols * rows > 40000) {
        CELL *= 1.3;
        cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
        rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
      }

      const isVoid = new Uint8Array(cols * rows); // inside the footprint but cut away by a notch
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const cx = minX + (i + 0.5) * CELL, cz = minZ + (j + 0.5) * CELL;
          const inFloor = floorRectsPostNotch.some((r) => cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1);
          isVoid[j * cols + i] = inFloor ? 0 : 1;
        }
      }
      if (!isVoid.some((v) => v)) return [];

      const partitionSegs = [];
      state.partitions.forEach((p) => {
        const parent = getPanelInfo(p.panel);
        if (!parent || Math.abs(p.ext) < 0.03) return;
        const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
        const far = parent.coord + axisSign * p.ext;
        const lo = Math.min(parent.coord, far), hi = Math.max(parent.coord, far);
        if (parent.thickAxis === "z") partitionSegs.push({ vertical: true, at: p.u, a: lo, b: hi });
        else partitionSegs.push({ vertical: false, at: p.u, a: lo, b: hi });
      });
      function blockedV(edgeX, z0, z1) {
        return partitionSegs.some((s) => s.vertical && Math.abs(s.at - edgeX) < CELL * 0.5 && s.a <= z1 - 1e-6 && s.b >= z0 + 1e-6);
      }
      function blockedH(edgeZ, x0, x1) {
        return partitionSegs.some((s) => !s.vertical && Math.abs(s.at - edgeZ) < CELL * 0.5 && s.a <= x1 - 1e-6 && s.b >= x0 + 1e-6);
      }

      const reached = new Uint8Array(cols * rows);
      const stack = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          if (!isVoid[idx]) continue;
          // a void cell touching the footprint's outer edge always connects
          // to true exterior, whatever partitions surround it elsewhere
          if (i === 0 || i === cols - 1 || j === 0 || j === rows - 1) { reached[idx] = 1; stack.push([i, j]); }
        }
      }
      while (stack.length) {
        const [ci, cj] = stack.pop();
        const cx0 = minX + ci * CELL, cx1 = cx0 + CELL, cz0 = minZ + cj * CELL, cz1 = cz0 + CELL;
        const tryNeighbor = (ni, nj, blocked) => {
          if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) return;
          const nIdx = nj * cols + ni;
          if (isVoid[nIdx] && !reached[nIdx] && !blocked) { reached[nIdx] = 1; stack.push([ni, nj]); }
        };
        tryNeighbor(ci + 1, cj, blockedV(cx1, cz0, cz1));
        tryNeighbor(ci - 1, cj, blockedV(cx0, cz0, cz1));
        tryNeighbor(ci, cj + 1, blockedH(cz1, cx0, cx1));
        tryNeighbor(ci, cj - 1, blockedH(cz0, cx0, cx1));
      }

      const sealedCells = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        if (isVoid[idx] && !reached[idx]) sealedCells.push([i, j]);
      }
      if (sealedCells.length === 0) return [];

      // merge sealed cells into rectangles: row runs, then stack matching
      // runs across rows -- same pattern as detectRooms()
      const byRow = new Map();
      sealedCells.forEach(([i, j]) => { if (!byRow.has(j)) byRow.set(j, []); byRow.get(j).push(i); });
      const rowRuns = [];
      byRow.forEach((is, j) => {
        is.sort((a, b) => a - b);
        let start = is[0], prev = is[0];
        for (let k = 1; k < is.length; k++) {
          if (is[k] === prev + 1) { prev = is[k]; continue; }
          rowRuns.push({ j, i0: start, i1: prev }); start = is[k]; prev = is[k];
        }
        rowRuns.push({ j, i0: start, i1: prev });
      });
      rowRuns.sort((a, b) => a.j - b.j || a.i0 - b.i0);
      const used = new Array(rowRuns.length).fill(false);
      const healed = [];
      for (let a = 0; a < rowRuns.length; a++) {
        if (used[a]) continue;
        let j1 = rowRuns[a].j;
        const j0 = rowRuns[a].j, i0 = rowRuns[a].i0, i1 = rowRuns[a].i1;
        used[a] = true;
        let extended = true;
        while (extended) {
          extended = false;
          for (let b = 0; b < rowRuns.length; b++) {
            if (used[b]) continue;
            if (rowRuns[b].i0 === i0 && rowRuns[b].i1 === i1 && rowRuns[b].j === j1 + 1) { j1 = rowRuns[b].j; used[b] = true; extended = true; }
          }
        }
        healed.push({ x0: minX + i0 * CELL, x1: minX + (i1 + 1) * CELL, z0: minZ + j0 * CELL, z1: minZ + (j1 + 1) * CELL });
      }
      return healed;
    }

    function rebuildCurrentFloorGeometry() {
      clearGroup(sceneGroup);
      const fp = state.footprint;
      const bumpoutFloorPieces = [];
      // every floor piece mesh created below gets pushed here so the
      // ceiling (if enabled) can be built from exact copies of them,
      // shifted up to wall height -- so it always matches the room's real
      // footprint (bumpouts, notches, curved corners and all) instead of a
      // plain rectangle, and updates automatically on every rebuild.
      const floorMeshesForCeiling = [];

      const panelKeys = ["north", "south", "east", "west"];
      state.bumpouts.forEach((b) => {
        if (Math.abs(b.depth) <= 0.02) return;
        panelKeys.push("bf:" + b.id);
        const touch = bumpoutCornerTouch(b);
        if (!touch.min) panelKeys.push("bs0:" + b.id);
        if (!touch.max) panelKeys.push("bs1:" + b.id);
      });
      panelKeys.forEach((pk) => renderPanel(pk, bumpoutFloorPieces));
      state.partitions.forEach((p) => renderPartition(p));
      renderCurvedCorners();

      let floorRects = [{ x0: fp.xMin, x1: fp.xMax, z0: fp.zMin, z1: fp.zMax }];
      const ccFloor = state.curvedCorners;
      let builtCurvedFloor = false;
      if (ccFloor && ccFloor.enabled && ccFloor.radius > 0.05) {
        const R = Math.min(ccFloor.radius, (fp.xMax - fp.xMin) / 2 - 0.15, (fp.zMax - fp.zMin) / 2 - 0.15);
        if (R > 0.05) {
          const curvable = computeCurvableCorners(R);
          const shape = buildCurvedFloorShape(fp, curvable, R);
          state.bumpouts.forEach((b) => {
            if (b.depth < -0.02) {
              const cut = notchFloorCut(b);
              if (cut) {
                const hole = new THREE.Path();
                hole.moveTo(cut.x0, cut.z0);
                hole.lineTo(cut.x1, cut.z0);
                hole.lineTo(cut.x1, cut.z1);
                hole.lineTo(cut.x0, cut.z1);
                hole.closePath();
                shape.holes.push(hole);
              }
            }
          });
          (state.floorHoles || []).forEach((h) => {
            const hole = new THREE.Path();
            hole.moveTo(h.xMin, h.zMin);
            hole.lineTo(h.xMax, h.zMin);
            hole.lineTo(h.xMax, h.zMax);
            hole.lineTo(h.xMin, h.zMax);
            hole.closePath();
            shape.holes.push(hole);
          });
          const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false, curveSegments: 8 });
          const floor = new THREE.Mesh(geo, currentFloorMat);
          floor.rotation.x = Math.PI / 2;
          floor.position.y = 0;
          floor.receiveShadow = true;
          floor.userData = { kind: "floor", ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(floor);
          floorMeshesForCeiling.push(floor);
          if (buildingActiveFloor && (toolRef.current === "move" || toolRef.current === "stairs" || toolRef.current === "props")) pickList.push(floor);
          builtCurvedFloor = true;
        }
      }
      if (!builtCurvedFloor) state.bumpouts.forEach((b) => {
        if (b.depth < -0.02) {
          const cut = notchFloorCut(b);
          if (cut) floorRects = subtractAll(floorRects, cut);
        }
      });
      // a partition can wall off part of a notch, turning that cut-away area
      // into a fully enclosed room -- restore its floor before floorHoles
      // (genuine stairwell cutouts, unrelated to notches) get subtracted.
      if (!builtCurvedFloor && state.partitions.length > 0 && state.bumpouts.some((b) => b.depth < -0.02)) {
        const healed = computeSealedNotchFloorRects(floorRects);
        if (healed.length) floorRects = floorRects.concat(healed);
      }
      if (!builtCurvedFloor) (state.floorHoles || []).forEach((h) => {
        floorRects = subtractAll(floorRects, { x0: h.xMin, x1: h.xMax, z0: h.zMin, z1: h.zMax });
      });
      if (!builtCurvedFloor) floorRects.forEach((r) => {
        const fw = r.x1 - r.x0, fd = r.z1 - r.z0;
        if (fw < 0.02 || fd < 0.02) return;
        const floor = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.08, fd), currentFloorMat);
        floor.position.set((r.x0 + r.x1) / 2, -0.04, (r.z0 + r.z1) / 2);
        floor.receiveShadow = true;
        floor.userData = { kind: "floor", ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(floor);
        floorMeshesForCeiling.push(floor);
        const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
        const coveredByRoom = buildingRoomId == null && buildingFloorEntry && (buildingFloorEntry.rooms || []).some((rm) => {
          const rf = rm.data.footprint, ox = rm.offsetX || 0, oz = rm.offsetZ || 0;
          return cx >= rf.xMin + ox && cx <= rf.xMax + ox && cz >= rf.zMin + oz && cz <= rf.zMax + oz;
        });
        if (buildingActiveFloor && (toolRef.current === "move" || toolRef.current === "stairs" || toolRef.current === "props") && !coveredByRoom) pickList.push(floor);
      });

      const w = fp.xMax - fp.xMin;
      const d = fp.zMax - fp.zMin;
      bumpoutFloorPieces.forEach((bp) => {
        let fw, fd, px, pz;
        if (bp.axis === "x") { fw = bp.u1 - bp.u0; fd = bp.hi - bp.lo; px = (bp.u0 + bp.u1) / 2; pz = (bp.lo + bp.hi) / 2; }
        else { fw = bp.hi - bp.lo; fd = bp.u1 - bp.u0; px = (bp.lo + bp.hi) / 2; pz = (bp.u0 + bp.u1) / 2; }
        const fmesh = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.08, fd), currentFloorMat);
        fmesh.position.set(px, -0.04, pz);
        fmesh.receiveShadow = true;
        fmesh.userData = { kind: "floor", ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(fmesh);
        floorMeshesForCeiling.push(fmesh);
        if (buildingActiveFloor && (toolRef.current === "move" || toolRef.current === "stairs" || toolRef.current === "props")) pickList.push(fmesh);
      });

      if (buildingActiveFloor && hudRef.current) {
        hudRef.current.textContent = `${w.toFixed(1)} m \u00d7 ${d.toFixed(1)} m  \u00b7  ${state.height.toFixed(1)} m high`;
      }

      if (buildingActiveFloor) {
        measureAnchors = [];
        if (showMeasurementsRef.current) {
          const addAnchor = (pk) => {
            const info = getPanelInfo(pk);
            if (!info) return;
            const len = info.u1 - info.u0;
            if (len < 0.05) return;
            const mid = (info.u0 + info.u1) / 2;
            const H = getPanelHeight(pk);
            const pt = new THREE.Vector3();
            if (info.lengthAxis === "x") pt.set(mid, H * 0.55, info.coord);
            else pt.set(info.coord, H * 0.55, mid);
            pt.addScaledVector(info.normal, state.thickness / 2 + 0.06);
            pt.y += sceneGroup.position.y;
            measureAnchors.push({ point: pt, text: (len / FT).toFixed(2) + " ft" });
          };
          panelKeys.forEach(addAnchor);
          state.partitions.forEach((p) => addAnchor("pt:" + p.id));
        }
      }

      renderStairs();
      renderProps();
      renderBalconies();
      renderCeiling(floorMeshesForCeiling);
    }

    // a purely decorative slab at wall height -- intentionally never added
    // to pickList and never edge-outlined, so it can't become a raycast
    // target for any tool (picking, dragging, selection). Built from exact
    // copies of the actual floor pieces (shifted up to wall height) rather
    // than a plain rectangle, so a U-shaped room, one with bumpouts, or one
    // with curved corners gets a ceiling that matches its real footprint --
    // and since it's rebuilt from those same pieces every time, editing the
    // walls updates it automatically.
    function renderCeiling(floorMeshes) {
      if (!state.ceilingEnabled) return;
      const ceilingY = state.height - 0.05;
      floorMeshes.forEach((floorMesh) => {
        const mesh = new THREE.Mesh(floorMesh.geometry, ceilingMat);
        mesh.position.copy(floorMesh.position);
        mesh.position.y = ceilingY;
        mesh.rotation.copy(floorMesh.rotation);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        sceneGroup.add(mesh);
      });
    }

    // a staircase is a stack of solid steps, each a flat-bottomed box sitting
    // on the floor: step i spans y=[0,(i+1)*stepHeight] and one depth slice
    // of the footprint, so the whole run climbs from the floor to the room's
    // current height -- recomputed live, so raising/lowering the room re-scales it.
    function renderStairs() {
      const H = state.height;
      (state.stairs || []).forEach((st) => {
        const span = st.end - st.start;
        const widthSpan = st.widthMax - st.widthMin;
        if (Math.abs(span) < 0.05 || widthSpan < 0.05) return;
        const n = Math.max(1, Math.round(st.steps) || 1);
        const stepH = H / n;
        const stepSpan = span / n;
        const isSelected = isPickableTarget && selectedStairIdRef.current === st.id;
        const mat = isSelected ? wallMatSelected : stairMat;
        for (let i = 0; i < n; i++) {
          const a = st.start + i * stepSpan;
          const b = st.start + (i + 1) * stepSpan;
          const lo = Math.min(a, b), hi = Math.max(a, b);
          const topY = (i + 1) * stepH;
          let geo, px, pz;
          if (st.axis === "x") {
            geo = new THREE.BoxGeometry(Math.max(0.02, hi - lo), Math.max(0.02, topY), Math.max(0.02, widthSpan));
            px = (lo + hi) / 2; pz = (st.widthMin + st.widthMax) / 2;
          } else {
            geo = new THREE.BoxGeometry(Math.max(0.02, widthSpan), Math.max(0.02, topY), Math.max(0.02, hi - lo));
            px = (st.widthMin + st.widthMax) / 2; pz = (lo + hi) / 2;
          }
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(px, topY / 2, pz);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          addEdges(mesh);
          mesh.userData = { kind: "stair", id: st.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (isPickableTarget) pickList.push(mesh);
        }
      });
      if (previewStair && isPickableTarget) {
        const w = previewStair.x1 - previewStair.x0;
        const d = previewStair.z1 - previewStair.z0;
        if (w > 0.02 && d > 0.02 && previewStair.axis) {
          // real stepped preview (not just a flat rectangle) so the axis
          // and climb direction the drag is about to commit to is visible
          // live, before you let go -- a fixed small step count just for
          // the preview, independent of whatever step count gets used once
          // it's actually committed.
          const H = state.height;
          const n = 6;
          const span = previewStair.end - previewStair.start;
          const stepSpan = span / n;
          for (let i = 0; i < n; i++) {
            const a = previewStair.start + i * stepSpan;
            const b = previewStair.start + (i + 1) * stepSpan;
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const topY = ((i + 1) / n) * H;
            let geo, px, pz;
            if (previewStair.axis === "x") {
              geo = new THREE.BoxGeometry(Math.max(0.02, hi - lo), Math.max(0.02, topY), Math.max(0.02, previewStair.widthMax - previewStair.widthMin));
              px = (lo + hi) / 2; pz = (previewStair.widthMin + previewStair.widthMax) / 2;
            } else {
              geo = new THREE.BoxGeometry(Math.max(0.02, previewStair.widthMax - previewStair.widthMin), Math.max(0.02, topY), Math.max(0.02, hi - lo));
              px = (previewStair.widthMin + previewStair.widthMax) / 2; pz = (lo + hi) / 2;
            }
            const mesh = new THREE.Mesh(geo, selMatPreview);
            mesh.position.set(px, topY / 2, pz);
            sceneGroup.add(mesh);
          }
        }
      }
    }

    // sphere/cube/cone/cylinder props, placed by tapping the floor with the
    // Props tool. Each stores its own w (x-size)/d (z-size)/h (y-size),
    // falling back to the original fixed sizes for props placed before
    // resizing existed. Cube resizes w/d independently (a true rectangle);
    // sphere/cylinder/cone keep w===d (a uniform radius) and only h varies
    // independently, so a corner drag can never make them elliptical.
    function propDefaultDiameter(kind) { return kind === "cone" || kind === "cylinder" ? 6 * FT : PROP_HEIGHT; }
    function propWidthOf(p) { return p.w != null ? p.w : propDefaultDiameter(p.kind); }
    function propDepthOf(p) { return p.d != null ? p.d : propDefaultDiameter(p.kind); }
    function propHeightOf(p) { return p.h != null ? p.h : PROP_HEIGHT; }
    const PROP_MIN_SIZE = 0.2; // smallest edge/diameter/height a prop can be resized to
    const PROP_MAX_SIZE = 30;
    const PROP_HANDLE = 0.16; // small cube handles -- visually unobtrusive, still easy to grab on touch

    function renderProps() {
      (state.props || []).forEach((p) => {
        const w = propWidthOf(p), d = propDepthOf(p), h = propHeightOf(p);
        let geo;
        switch (p.kind) {
          case "sphere":
            geo = new THREE.SphereGeometry(w / 2, 20, 16);
            break;
          case "cube":
            geo = new THREE.BoxGeometry(w, h, d);
            break;
          case "cone":
            geo = new THREE.ConeGeometry(w / 2, h, 24);
            break;
          case "cylinder":
          default:
            geo = new THREE.CylinderGeometry(w / 2, w / 2, h, 24);
            break;
        }
        const mesh = new THREE.Mesh(geo, propMats[p.kind] || propMats.cube);
        mesh.position.set(p.x, h / 2, p.z);
        // a sphere's geometry radius already sets its X/Z extent (kept
        // equal to w=d above) -- height comes from a Y-only scale instead,
        // since SphereGeometry has no independent height parameter.
        if (p.kind === "sphere" && w > 0.001) mesh.scale.y = h / w;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        addEdges(mesh);
        mesh.userData = { kind: "prop", id: p.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(mesh);
        if (isPickableTarget) pickList.push(mesh);

        if (isPickableTarget && selectedPropIdRef.current === p.id) {
          const boxGeo = new THREE.BoxGeometry(w, h, d);
          const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(boxGeo),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false })
          );
          wire.position.set(p.x, h / 2, p.z);
          wire.renderOrder = 9;
          sceneGroup.add(wire);

          function addHandle(edge, hx, hy, hz) {
            const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(PROP_HANDLE, PROP_HANDLE, PROP_HANDLE), handleMat);
            mesh2.position.set(hx, hy, hz);
            mesh2.renderOrder = 10;
            mesh2.userData = { kind: "resize-handle", target: "prop", id: p.id, edge, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(mesh2);
            pickList.push(mesh2);
          }
          [["nw", -1, -1], ["ne", 1, -1], ["sw", -1, 1], ["se", 1, 1]].forEach(([edge, sx, sz]) => {
            addHandle(edge, p.x + sx * (w / 2), h, p.z + sz * (d / 2));
          });
          addHandle("top", p.x, h + PROP_HANDLE * 0.9, p.z);
        }
      });
    }

    // rebuilds a balcony's door+flanking-windows openings from scratch off
    // its current u0/u1/platformHeight -- the exact same subdivision the
    // initial balcony-draw commit uses (fixed-width centered door, a solid
    // mullion gap on each side, dividers scaled to whatever's left).
    // Called both there and whenever a platform edge handle is dragged, so
    // resizing a balcony keeps the door centered and the windows correctly
    // re-spanned instead of just stretching the original three openings.
    function regenerateBalconyOpenings(bal) {
      state.openings = state.openings.filter((o) => o.fromBalcony !== bal.id);
      const doorW = 3 * FT;
      const mid = (bal.u0 + bal.u1) / 2;
      const doorU0 = mid - doorW / 2, doorU1 = mid + doorW / 2;
      const winHeight = 7 * FT;
      const doorMullion = 0.2;
      const leftWinU1 = doorU0 - doorMullion;
      const rightWinU0 = doorU1 + doorMullion;
      function dividersForSpan(span) {
        const segs = Math.max(1, Math.round(span / (3 * FT)));
        return Math.max(0, segs - 1);
      }
      const leftSpan = leftWinU1 - bal.u0;
      if (leftSpan > 0.3) {
        state.openings.push({ id: idSeq++, panel: bal.panel, u0: bal.u0, u1: leftWinU1, height: winHeight, dividers: dividersForSpan(leftSpan), dividerAxis: bal.dividerAxis, bottomOverride: bal.platformHeight, fromBalcony: bal.id });
      }
      const rightSpan = bal.u1 - rightWinU0;
      if (rightSpan > 0.3) {
        state.openings.push({ id: idSeq++, panel: bal.panel, u0: rightWinU0, u1: bal.u1, height: winHeight, dividers: dividersForSpan(rightSpan), dividerAxis: bal.dividerAxis, bottomOverride: bal.platformHeight, fromBalcony: bal.id });
      }
      state.openings.push({ id: idSeq++, panel: bal.panel, u0: doorU0, u1: doorU1, height: doorHeightRef.current, isDoor: true, bottomOverride: bal.platformHeight, fromBalcony: bal.id });
    }

    // the staircase-balcony assembly: a low 3-step stair leading up to a
    // wide platform (4x a normal tread's depth) against the wall, with
    // corner pillars enclosing the platform. The window/door cutout in the
    // wall itself is handled entirely by the ordinary opening system (see
    // the balcony-draw commit logic) -- this only builds the exterior
    // structure standing in front of it.
    function renderBalconies() {
      const STEP_D = 3 * FT;
      const DEFAULT_PLATFORM_D = 10 * FT;
      const PILLAR_SIZE = 0.09;
      const DEFAULT_PILLAR_SPACING = 3 * FT;
      const CEILING_THICKNESS = BALCONY_CEILING_THICKNESS;
      const CEILING_DROP = BALCONY_CEILING_DROP;
      const RAIL_H = 0.08; // top handrail bar thickness
      // evenly spaced points (by arc length) walking an open, 3-sided fence
      // path: up the near side, across the outer edge, back down the far
      // side. The wall-side edge is skipped -- a fence doesn't need a rail
      // against the house wall that's already there. Returned in walking
      // order so consecutive pairs are the fence bays for the handrail and
      // glass infill.
      function fencePath(pu0, pu1, pd0, pd1, count) {
        const sideLen = pd1 - pd0;
        const outerLen = pu1 - pu0;
        const totalLen = Math.max(0.01, sideLen * 2 + outerLen);
        const n = Math.max(2, Math.round(count));
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * totalLen;
          let u, d;
          if (t <= sideLen) { u = pu0; d = pd0 + t; }
          else if (t <= sideLen + outerLen) { u = pu0 + (t - sideLen); d = pd1; }
          else { u = pu1; d = pd1 - (t - sideLen - outerLen); }
          pts.push([u, d]);
        }
        return pts;
      }
      (state.balconies || []).forEach((bal) => {
        const info = getPanelInfo(bal.panel);
        if (!info) return;
        const side = bal.side || 1;
        const nx = info.normal.x * side, nz = info.normal.z * side;
        const axis = info.lengthAxis;
        const isSelected = isPickableTarget && selectedBalconyIdRef.current === bal.id;
        const part = selectedBalconyPartRef.current;
        const wholeSelected = isSelected && part == null;
        const pillarsSelected = isSelected && part === "pillars";
        const ceilingSelected = isSelected && part === "ceiling";
        const floorLikeMat = wholeSelected ? floorMatSelected : balconyPlatformMat;
        const stepMat = wholeSelected ? wallMatSelected : currentWallMat;
        const pillarMatActive = (wholeSelected || pillarsSelected) ? pillarMatSelected : pillarMat;
        const ceilingMat = (wholeSelected || ceilingSelected) ? wallMatSelected : currentWallMat;
        function toWorld(u, d) {
          if (axis === "x") return { x: u, z: info.coord + nz * d };
          return { x: info.coord + nx * d, z: u };
        }
        function addBox(u0, u1, d0, d1, y0, y1, mat, kindOverride) {
          const uLen = Math.max(0.02, u1 - u0);
          const dLen = Math.max(0.02, d1 - d0);
          const h = Math.max(0.02, y1 - y0);
          const geo = axis === "x" ? new THREE.BoxGeometry(uLen, h, dLen) : new THREE.BoxGeometry(dLen, h, uLen);
          const mesh = new THREE.Mesh(geo, mat);
          const cU = (u0 + u1) / 2, cD = (d0 + d1) / 2;
          const w = toWorld(cU, cD);
          mesh.position.set(w.x, (y0 + y1) / 2, w.z);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          addEdges(mesh);
          mesh.userData = { kind: kindOverride || "balcony", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (isPickableTarget) pickList.push(mesh);
        }
        // connects two fence-path points with a box running between them --
        // shared by the handrail (thin, at pillarTop) and the glass infill
        // (a shorter pane filling the bay below it).
        function addRailSeg(pa, pb, y0, y1, thickness, mat, castsShadow) {
          const wa = toWorld(pa[0], pa[1]), wb = toWorld(pb[0], pb[1]);
          const dx = wb.x - wa.x, dz = wb.z - wa.z;
          const len = Math.hypot(dx, dz);
          if (len < 0.02 || y1 - y0 < 0.02) return null;
          const geo = new THREE.BoxGeometry(len, y1 - y0, thickness);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set((wa.x + wb.x) / 2, (y0 + y1) / 2, (wa.z + wb.z) / 2);
          mesh.rotation.y = Math.atan2(-dz, dx);
          mesh.castShadow = castsShadow;
          mesh.receiveShadow = true;
          return mesh;
        }
        const u0 = bal.u0, u1 = bal.u1;
        const platformHeight = bal.platformHeight || 3 * FT;
        const PLATFORM_D = bal.platformWidth || DEFAULT_PLATFORM_D;
        // platform, right against the wall
        addBox(u0, u1, 0, PLATFORM_D, 0, platformHeight, floorLikeMat);
        // steps descending away from the platform to the ground -- however
        // many risers it takes to cover the current platform height at
        // roughly a 1ft rise each (recomputed so they land exactly on the
        // platform's actual height, whatever the slider is set to).
        const numLevels = Math.max(1, Math.round(platformHeight / (1 * FT)));
        const stepH = platformHeight / numLevels;
        for (let i = 0; i < numLevels - 1; i++) {
          const topH = (numLevels - 1 - i) * stepH;
          addBox(u0, u1, PLATFORM_D + i * STEP_D, PLATFORM_D + (i + 1) * STEP_D, 0, topH, stepMat);
        }
        // pillar height is user-controlled (bal.pillarHeight, "height above
        // the platform"), defaulting to a 3ft fence rail the first time a
        // balcony is drawn -- raising the slider all the way reconnects
        // them to the ceiling slab; rendering clamps the *top* end only, so
        // they can never poke through it.
        const ceilingAttachY = state.height - CEILING_DROP - CEILING_THICKNESS;
        const defaultPillarHeight = 3 * FT;
        const pillarHeight = bal.pillarHeight != null ? bal.pillarHeight : defaultPillarHeight;
        const pillarTop = Math.max(platformHeight + 0.3, Math.min(platformHeight + pillarHeight, ceilingAttachY));
        if (!bal.pillarsRemoved) {
          const half = PILLAR_SIZE / 2;
          const perimeterLen = PLATFORM_D * 2 + (u1 - u0);
          const count = bal.pillarCount || Math.max(2, Math.round(perimeterLen / DEFAULT_PILLAR_SPACING));
          const points = fencePath(u0 + half, u1 - half, half, PLATFORM_D - half, count);
          points.forEach(([cu, cd]) => {
            const w = toWorld(cu, cd);
            const geo = new THREE.BoxGeometry(PILLAR_SIZE, pillarTop - platformHeight, PILLAR_SIZE);
            const mesh = new THREE.Mesh(geo, pillarMatActive);
            mesh.position.set(w.x, (platformHeight + pillarTop) / 2, w.z);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            addEdges(mesh);
            mesh.userData = { kind: "balcony-pillar", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(mesh);
            if (isPickableTarget) pickList.push(mesh);
          });
          // top handrail, capping every pillar like a fence rail
          for (let i = 0; i < points.length - 1; i++) {
            const mesh = addRailSeg(points[i], points[i + 1], pillarTop, pillarTop + RAIL_H, PILLAR_SIZE, pillarMatActive, true);
            if (!mesh) continue;
            addEdges(mesh);
            mesh.userData = { kind: "balcony-pillar", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(mesh);
            if (isPickableTarget) pickList.push(mesh);
          }
          // optional glass infill, filling each fence bay below the rail
          if (bal.glassInfill) {
            for (let i = 0; i < points.length - 1; i++) {
              const mesh = addRailSeg(points[i], points[i + 1], platformHeight + 0.03, pillarTop - 0.03, 0.02, glassMat, false);
              if (!mesh) continue;
              mesh.userData = { kind: "glass" };
              sceneGroup.add(mesh);
            }
          }
          // the pillars themselves are thin and easy to miss with a tap --
          // an invisible box spanning the whole pillar zone makes tapping
          // anywhere in that space (not just exactly on a pillar) select
          // the whole group. Built by hand rather than through addBox,
          // since addBox always adds visible edge outlines, which would
          // defeat the point of an invisible hotspot.
          {
            const hw = Math.max(0.02, u1 - u0), hd = Math.max(0.02, PLATFORM_D);
            const hh = Math.max(0.02, pillarTop - platformHeight);
            const hgeo = axis === "x" ? new THREE.BoxGeometry(hw, hh, hd) : new THREE.BoxGeometry(hd, hh, hw);
            const hmesh = new THREE.Mesh(hgeo, hotspotMat);
            const hw2 = toWorld((u0 + u1) / 2, PLATFORM_D / 2);
            hmesh.position.set(hw2.x, (platformHeight + pillarTop) / 2, hw2.z);
            hmesh.userData = { kind: "balcony-pillar", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(hmesh);
            if (isPickableTarget) pickList.push(hmesh);
          }
        }
        // covered ceiling, a fixed drop below the room's own default height
        if (!bal.ceilingRemoved) {
          addBox(u0, u1, 0, PLATFORM_D, ceilingAttachY, state.height - CEILING_DROP, ceilingMat, "balcony-ceiling");
        }
        // draggable edge bars at the platform's two side edges (u0/u1) --
        // only while the whole assembly (not just a pillar or the ceiling)
        // is selected, spanning corner-post-style from the ground to the
        // rail top so they're easy to spot and grab from any angle.
        if (isPickableTarget && wholeSelected) {
          const barU = Math.max(0.08, Math.min(0.16, (u1 - u0) * 0.15));
          const barD = 0.16;
          function addHandle(edge, uCenter) {
            const geo = axis === "x" ? new THREE.BoxGeometry(barU, pillarTop, barD) : new THREE.BoxGeometry(barD, pillarTop, barU);
            const mesh = new THREE.Mesh(geo, handleMat);
            mesh.renderOrder = 10;
            const w = toWorld(uCenter, PLATFORM_D / 2);
            mesh.position.set(w.x, pillarTop / 2, w.z);
            mesh.userData = { kind: "resize-handle", target: "balcony", id: bal.id, edge, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(mesh);
            pickList.push(mesh);
          }
          addHandle("left", u0);
          addHandle("right", u1);
        }
      });
    }

    // fills the 4 corners of the room's own rectangular footprint with a
    // rounded fillet (up to 5 straight segments approximating an arc), to
    // match the inset the base walls already got in renderPanel. First-pass
    // scope: only the plain 4-corner rectangle -- bump-outs/partitions
    // aren't accounted for, so combining curved corners with those may
    // look imperfect at the junction, though it won't break anything.
    function renderCurvedCorners() {
      const cc = state.curvedCorners;
      if (!cc || !cc.enabled || cc.radius <= 0.05) return;
      const fp = state.footprint;
      const R = Math.min(cc.radius, (fp.xMax - fp.xMin) / 2 - 0.15, (fp.zMax - fp.zMin) / 2 - 0.15);
      if (R <= 0.05) return;
      const H = getPanelHeight("north");
      const T = state.thickness;
      const segs = 5;
      const curvable = computeCurvableCorners(R);
      const corners = [
        { key: "nw", cx: fp.xMin + R, cz: fp.zMin + R, a0: 180, a1: 270 },
        { key: "ne", cx: fp.xMax - R, cz: fp.zMin + R, a0: 270, a1: 360 },
        { key: "se", cx: fp.xMax - R, cz: fp.zMax - R, a0: 0, a1: 90 },
        { key: "sw", cx: fp.xMin + R, cz: fp.zMax - R, a0: 90, a1: 180 },
      ];
      corners.forEach((c) => {
        // a corner next to a bump-out is left as its original sharp corner
        // (renderPanel didn't inset the adjoining walls for it either), so
        // no arc is built there and the walls simply meet as they always did.
        if (!curvable[c.key]) return;
        for (let i = 0; i < segs; i++) {
          const ang0 = (c.a0 + (c.a1 - c.a0) * (i / segs)) * Math.PI / 180;
          const ang1 = (c.a0 + (c.a1 - c.a0) * ((i + 1) / segs)) * Math.PI / 180;
          const x0 = c.cx + R * Math.cos(ang0), z0 = c.cz + R * Math.sin(ang0);
          const x1 = c.cx + R * Math.cos(ang1), z1 = c.cz + R * Math.sin(ang1);
          const len = Math.hypot(x1 - x0, z1 - z0);
          if (len < 0.02) continue;
          const angle = Math.atan2(z1 - z0, x1 - x0);
          const geo = new THREE.BoxGeometry(len, Math.max(0.02, H), T);
          const mesh = new THREE.Mesh(geo, currentWallMat);
          mesh.position.set((x0 + x1) / 2, H / 2, (z0 + z1) / 2);
          mesh.rotation.y = -angle;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          addEdges(mesh);
          mesh.userData = { kind: "wall", panel: "cc:" + c.key, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (isPickableTarget) pickList.push(mesh);
        }
      });
    }

    // renders one floor's data into its own group. Every floor's own top-
    // level content (walls/openings/stairs -- not any room pulled out of
    // it) is added to pickList and stays editable with Wall/Window/Door/
    // Stairs regardless of which floor is "active" -- active only decides
    // height/isolate/hide, plus which floor a click on the bare floor
    // itself (to extract or move a room) affects. Hidden or non-isolated
    // floors are still excluded automatically, since Three.js's raycaster
    // skips invisible objects on its own.
    function rebuildFloorEntry(entry, isActive) {
      // clearGroup() below disposes this floor's (and its rooms') old
      // meshes but never touches pickList -- drop their stale entries here,
      // once, so every caller (rebuild(), rebuildAllFloors(), or a direct
      // call like the active-floor handoff in selectFloorById) gets a
      // pickList that never accumulates disposed/orphaned mesh references.
      pickList = pickList.filter((o) => o.userData.ownerFloorId !== entry.id);
      const savedState = state;
      const savedGroup = sceneGroup;
      const savedActive = buildingActiveFloor;
      const savedTarget = isPickableTarget;
      const savedWallMat = currentWallMat;
      const savedFloorMat = currentFloorMat;
      const savedRoomId = buildingRoomId;
      const savedFloorEntry = buildingFloorEntry;
      state = entry.data;
      sceneGroup = floorGroups.get(entry.id);
      buildingActiveFloor = isActive;
      // the active floor's own top-level walls are only pickable while no
      // room within it is focused (a pulled-out room and the floor's own
      // walls are mutually exclusive); every other floor's top-level
      // content is always pickable, since rooms-within-other-floors aren't
      // part of this yet.
      isPickableTarget = isActive ? activeRoomId == null : true;
      buildingRoomId = null;
      buildingFloorEntry = entry;
      currentWallMat = isActive ? wallMat : wallMatDim;
      currentFloorMat = isActive ? floorMat : floorMatDim;
      // if a room's footprint exactly matches this floor's own, that room has
      // fully replaced the floor's own walls -- skip rendering the floor's
      // own content there so the two don't visually compete (and to leave
      // the room as the only clickable thing in that space).
      const wholeFloorClaimed = (entry.rooms || []).some((rm) => {
        const rf = rm.data.footprint, fp2 = entry.data.footprint;
        return Math.abs(rf.xMin - fp2.xMin) < 0.05 && Math.abs(rf.xMax - fp2.xMax) < 0.05 &&
               Math.abs(rf.zMin - fp2.zMin) < 0.05 && Math.abs(rf.zMax - fp2.zMax) < 0.05;
      });
      if (sceneGroup) {
        if (wholeFloorClaimed) clearGroup(sceneGroup);
        else rebuildCurrentFloorGeometry();
      }
      refreshThumbnail(entry.id);
      state = savedState;
      sceneGroup = savedGroup;
      buildingActiveFloor = savedActive;
      isPickableTarget = savedTarget;
      currentWallMat = savedWallMat;
      currentFloorMat = savedFloorMat;
      buildingRoomId = savedRoomId;
      buildingFloorEntry = savedFloorEntry;
      (entry.rooms || []).forEach((room) => rebuildRoomEntry(entry, room, isActive));
    }

    // a room reuses the exact same rendering path as a floor (rebuildCurrentFloorGeometry)
    // -- it's just parented in its own group, offset horizontally within its floor.
    function rebuildRoomEntry(floorEntry, room, floorIsActive) {
      const savedState = state;
      const savedGroup = sceneGroup;
      const savedActive = buildingActiveFloor;
      const savedTarget = isPickableTarget;
      const savedWallMat = currentWallMat;
      const savedFloorMat = currentFloorMat;
      const savedRoomId = buildingRoomId;
      const savedFloorEntry = buildingFloorEntry;
      state = room.data;
      let container = roomContainers.get(floorEntry.id);
      if (!container) {
        container = new THREE.Group();
        scene.add(container);
        roomContainers.set(floorEntry.id, container);
        const g = floorGroups.get(floorEntry.id);
        if (g) container.position.copy(g.position);
      }
      let rg = roomGroups.get(room.id);
      if (!rg) {
        rg = new THREE.Group();
        container.add(rg);
        roomGroups.set(room.id, rg);
      }
      rg.position.set(room.offsetX || 0, 0, room.offsetZ || 0);
      sceneGroup = rg;
      buildingActiveFloor = floorIsActive;
      const isSelectedRoom = floorIsActive && activeRoomId === room.id;
      isPickableTarget = isSelectedRoom;
      buildingRoomId = room.id;
      buildingFloorEntry = floorEntry;
      currentWallMat = !floorIsActive ? wallMatDim : wallMat;
      currentFloorMat = !floorIsActive ? floorMatDim : (isSelectedRoom ? floorMatSelected : floorMat);
      clearGroup(sceneGroup);
      rebuildCurrentFloorGeometry();
      state = savedState;
      sceneGroup = savedGroup;
      buildingActiveFloor = savedActive;
      isPickableTarget = savedTarget;
      currentWallMat = savedWallMat;
      currentFloorMat = savedFloorMat;
      buildingRoomId = savedRoomId;
      buildingFloorEntry = savedFloorEntry;
    }

    // called constantly -- every drag frame, every mutation, every tool or
    // selection change -- so it must only refresh the ONE floor actually
    // being worked on right now (the cross-floor retarget target while a
    // gesture has landed on another layer's wall, via buildingFloorEntry;
    // otherwise the active floor) rather than wiping pickList outright.
    // Blowing away the whole list here was the reason cross-floor editing
    // broke the instant any tool was (re)selected: every OTHER visible
    // layer's walls would silently drop out of pickList and become
    // unclickable, even though they were still fully editable in principle.
    function rebuild() {
      const targetId = buildingFloorEntry ? buildingFloorEntry.id : activeFloorId;
      const entry = floors.find((f) => f.id === targetId);
      if (entry) rebuildFloorEntry(entry, entry.id === activeFloorId);
    }

    function rebuildAllFloors() {
      pickList = [];
      floors.forEach((f) => rebuildFloorEntry(f, f.id === activeFloorId));
    }

    // ---------- view-mode toggles ----------
    function applyHiddenLineMode(on) {
      hiddenLineModeOn = on;
      rebuildAllFloors();
    }
    hiddenLineApiRef.current = applyHiddenLineMode;

    function applyTransparentInactive(on) {
      wallMatDim.transparent = true;
      wallMatDim.opacity = on ? 0.5 : 1;
      floorMatDim.transparent = true;
      floorMatDim.opacity = on ? 0.5 : 1;
    }
    transparentInactiveApiRef.current = applyTransparentInactive;

    function applyWireframe(on) {
      [wallMat, floorMat, wallMatDim, floorMatDim, wallMatSelected, floorMatSelected].forEach((m) => { m.wireframe = on; });
    }
    wireframeApiRef.current = applyWireframe;

    // Matte vinyl / concrete / shiny metal / grid tile -- a *finish*,
    // layered on top of whatever color is currently active (the theme
    // wheel's pick, the older tint swatches, or the plain default) rather
    // than each one owning a fixed color of its own. Concrete is the one
    // exception (forceColor): real precast concrete doesn't take a paint
    // tint, so it keeps its own grey regardless of the room's theme, same
    // as before. floorLighten (concrete only) blends that fixed color
    // toward white for a lighter poured-slab floor shade; every other
    // finish just gives the floor its own theme/tint color like the wall,
    // at the same roughness/metalness/map.
    const BUILDING_MATERIAL_PRESETS = [
      null, // default finish -- the room's own grain map, whatever color is active
      { key: "vinyl", roughness: 0.94, metalness: 0.0 },
      { key: "concrete", forceColor: true, color: 0x93999c, roughness: 0.88, metalness: 0.08, concrete: true, floorLighten: 0.2 },
      { key: "metal", roughness: 0.12, metalness: 0.92 },
      { key: "tile", roughness: 0.32, metalness: 0.04, tile: true },
    ];
    // the building-material preset, the theme wheel, and the tint-active/
    // tint-inactive swatches (an older, separate feature) all ultimately
    // want to set wallMat/floorMat's .color -- keeping them as independent
    // "just overwrite .color" functions meant whichever ran last silently
    // erased the others' result. All of them now just record their own bit
    // of state and recompute the materials from scratch together, so
    // there's no order-dependent clobbering.
    let currentBuildingMaterialIndex = 0;
    let currentTintActiveOn = false, currentTintActiveColor = 0xff6b1a;
    let currentTintInactiveOn = false, currentTintInactiveColor = 0xff6b1a;
    let currentThemeWallColor = null, currentThemeFloorColor = null;
    function recomputeWallFloorMaterials() {
      const preset = BUILDING_MATERIAL_PRESETS[currentBuildingMaterialIndex];
      const forceColor = !!(preset && preset.forceColor);
      const mainColor = forceColor ? preset.color : (currentThemeWallColor != null ? currentThemeWallColor : COLORS.wall);
      const roughness = preset ? preset.roughness : 0.85;
      const metalness = preset ? preset.metalness : 0.02;
      const useConcreteTex = !!(preset && preset.concrete);
      const useTileTex = !!(preset && preset.tile);
      const map = preset ? (useConcreteTex ? concretePanelTex : useTileTex ? gridTileTex : null) : wallGrainTex;
      const roughnessMap = preset ? null : wallRoughTex;

      const wallColor = new THREE.Color(mainColor);
      if (currentTintActiveOn) wallColor.lerp(new THREE.Color(currentTintActiveColor), 0.92);
      wallMat.map = map;
      wallMat.roughnessMap = roughnessMap;
      wallMat.color.copy(wallColor);
      wallMat.roughness = roughness;
      wallMat.metalness = metalness;
      wallMat.needsUpdate = true;

      const wallDimColor = new THREE.Color(mainColor).multiplyScalar(0.5);
      if (currentTintInactiveOn) wallDimColor.lerp(new THREE.Color(currentTintInactiveColor), 0.8);
      wallMatDim.map = map;
      wallMatDim.roughnessMap = roughnessMap;
      wallMatDim.color.copy(wallDimColor);
      wallMatDim.roughness = roughness;
      wallMatDim.metalness = metalness;
      wallMatDim.needsUpdate = true;

      // the room ceiling ("roof") always matches the walls -- a balcony's
      // own covered ceiling already tracks currentWallMat directly, so it
      // follows for free without any change here.
      ceilingMat.map = map;
      ceilingMat.color.copy(wallColor);
      ceilingMat.roughness = roughness;
      ceilingMat.metalness = metalness;
      ceilingMat.needsUpdate = true;

      let floorBase, floorRough, floorMetal, floorMap, floorRoughnessMap;
      if (forceColor && preset.floorLighten != null) {
        floorBase = new THREE.Color(mainColor).lerp(new THREE.Color(0xffffff), preset.floorLighten);
        floorRough = roughness; floorMetal = metalness;
        floorMap = useConcreteTex ? concretePanelTex : null;
        floorRoughnessMap = null;
      } else {
        floorBase = currentThemeFloorColor != null ? currentThemeFloorColor : COLORS.floor;
        floorRough = preset ? roughness : 0.88;
        floorMetal = preset ? metalness : 0.0;
        floorMap = preset ? (useTileTex ? gridTileTex : null) : floorGrainTex;
        floorRoughnessMap = preset ? null : floorRoughTex;
      }
      const floorColor = new THREE.Color(floorBase);
      if (currentTintActiveOn) floorColor.lerp(new THREE.Color(currentTintActiveColor), 0.92).multiplyScalar(0.94);
      floorMat.map = floorMap;
      floorMat.roughnessMap = floorRoughnessMap;
      floorMat.color.copy(floorColor);
      floorMat.roughness = floorRough;
      floorMat.metalness = floorMetal;
      floorMat.needsUpdate = true;

      const floorDimColor = new THREE.Color(floorBase).multiplyScalar(0.5);
      if (currentTintInactiveOn) floorDimColor.lerp(new THREE.Color(currentTintInactiveColor), 0.8).multiplyScalar(0.92);
      floorMatDim.map = floorMap;
      floorMatDim.roughnessMap = floorRoughnessMap;
      floorMatDim.color.copy(floorDimColor);
      floorMatDim.roughness = floorRough;
      floorMatDim.metalness = floorMetal;
      floorMatDim.needsUpdate = true;
    }
    function applyBuildingMaterial(index) {
      currentBuildingMaterialIndex = index;
      recomputeWallFloorMaterials();
    }
    buildingMaterialApiRef.current = applyBuildingMaterial;

    function applyUltraRealistic(on) {
      ultraRealisticOn = on;
      // "maximized for lighting" -- Realistic mode is the deliberately
      // expensive option, so it gets the biggest shadow map the frustum
      // above can reasonably fill, not a token bump.
      const size = on ? 4096 : 1024;
      keyLight.shadow.mapSize.set(size, size);
      if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
      keyLight.intensity = on ? 1.3 : 1.2;
      // the environment map below adds its own ambient fill once IBL is on,
      // so the flat AmbientLight comes down a bit to leave room for it
      // rather than the two stacking on top of each other.
      ambient.intensity = on ? 0.28 : 0.55;
      // Postprocessing (AO/bloom/DOF) already costs several extra
      // full-screen passes, so realistic mode keeps the same pixel ratio
      // cap as normal rather than also pushing supersampling higher --
      // stacking both would be the difference between "smooth" and
      // "unusable" on a mobile GPU.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
      scene.environment = on ? realisticEnvMap : null;
      gtaoPass.enabled = on;
      bloomPass.enabled = on;
      bokehPass.enabled = on;
    }
    ultraRealisticApiRef.current = applyUltraRealistic;
    // Realistic mode defaults on -- applied explicitly here (matching the
    // ultraRealistic useState default below) rather than relying solely on
    // the [ultraRealistic] effect, since that effect is declared (and so
    // runs, on mount) before this one populates ultraRealisticApiRef.current
    // -- calling it there on the very first mount would just hit the ref's
    // no-op placeholder and silently do nothing.
    applyUltraRealistic(true);

    function applyTintInactive(on, colorHex) {
      currentTintInactiveOn = on;
      currentTintInactiveColor = colorHex;
      recomputeWallFloorMaterials();
    }
    tintInactiveApiRef.current = applyTintInactive;

    function applyTintActive(on, colorHex) {
      currentTintActiveOn = on;
      currentTintActiveColor = colorHex;
      recomputeWallFloorMaterials();
    }
    tintActiveApiRef.current = applyTintActive;

    // colors every prop kind to its own tone from a chosen theme (or, when
    // cleared, reverts each one to its own default color) -- mutating the
    // shared materials directly, so already-placed props update
    // immediately without needing a rebuild.
    const STAIR_DEFAULT_COLOR = 0xf2c6d6;
    function applyPropColors(colors) {
      Object.keys(propMats).forEach((kind) => {
        propMats[kind].color.set(colors ? colors[kind] : PROP_DEFAULT_COLORS[kind]);
      });
    }
    const PILLAR_DEFAULT_COLOR = new THREE.Color(COLORS.wall).multiplyScalar(0.7).getHex();
    // the room color theme: either one anchor point (a hue-wheel cell, or a
    // step on the grey ring) expanding into a related palette via
    // themeColorsFor, or a curated named preset supplying every color
    // outright -- either way, one distinct tone reaches each of the wall,
    // floor, stairs, balcony platform, balcony railings, and every prop kind.
    function applyRoomTheme(anchor) {
      if (!anchor) {
        currentThemeWallColor = null;
        currentThemeFloorColor = null;
        recomputeWallFloorMaterials();
        stairMat.color.set(STAIR_DEFAULT_COLOR);
        balconyPlatformMat.color.set(COLORS.floor);
        pillarMat.color.set(PILLAR_DEFAULT_COLOR);
        applyPropColors(null);
        return;
      }
      let palette;
      if (anchor.type === "preset") {
        palette = CURATED_PALETTES.find((p) => p.name === anchor.name) || CURATED_PALETTES[0];
      } else if (anchor.type === "grey") {
        palette = themeColorsFor(0, 0, anchor.midLight);
      } else {
        palette = themeColorsFor(anchor.hueDeg, THEME_SAT, THEME_WALL_MIDLIGHT);
      }
      currentThemeWallColor = palette.wall;
      currentThemeFloorColor = palette.floor;
      recomputeWallFloorMaterials();
      stairMat.color.set(palette.stairs);
      balconyPlatformMat.color.set(palette.platform);
      pillarMat.color.set(palette.railing);
      applyPropColors(palette);
    }
    themeApiRef.current = applyRoomTheme;

    // ---------- camera orbit / fixed orthographic views ----------
    let radius = Math.max(DEFAULT_ROOM_HALF_X, DEFAULT_ROOM_HALF_Z) * 2.2;
    let theta = 0.65;
    let phi = 1.05;
    let viewMode = "orbit";
    const target = new THREE.Vector3(0, state.height * 0.32, 0);
    const ORTHO_DIRS = {
      top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
      front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
      left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
      right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    };
    function computeOrthoFit(dirKey) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      floors.forEach((f) => {
        const g = floorGroups.get(f.id);
        if (!g) return;
        const fp = f.data.footprint;
        minX = Math.min(minX, fp.xMin); maxX = Math.max(maxX, fp.xMax);
        minZ = Math.min(minZ, fp.zMin); maxZ = Math.max(maxZ, fp.zMax);
        minY = Math.min(minY, g.position.y); maxY = Math.max(maxY, g.position.y + f.data.height);
        (f.rooms || []).forEach((r) => {
          const ox = r.offsetX || 0, oz = r.offsetZ || 0;
          const rfp = r.data.footprint;
          minX = Math.min(minX, rfp.xMin + ox); maxX = Math.max(maxX, rfp.xMax + ox);
          minZ = Math.min(minZ, rfp.zMin + oz); maxZ = Math.max(maxZ, rfp.zMax + oz);
        });
      });
      if (minX === Infinity) { minX = -3; maxX = 3; minZ = -3; maxZ = 3; minY = 0; maxY = 3; }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      let halfW, halfH;
      if (dirKey === "top") { halfW = (maxX - minX) / 2; halfH = (maxZ - minZ) / 2; }
      else if (dirKey === "front") { halfW = (maxX - minX) / 2; halfH = (maxY - minY) / 2; }
      else { halfW = (maxZ - minZ) / 2; halfH = (maxY - minY) / 2; } // left / right
      const margin = 3.3; // room occupies roughly 30% of the frame, not a snug fit
      halfW = Math.max(0.4, halfW * margin);
      halfH = Math.max(0.4, halfH * margin);
      const aspect = width / height;
      // fit both dimensions within the viewport's aspect ratio (contain-fit):
      // whichever dimension needs more room to stay uncropped wins.
      const fitH = Math.max(halfH, halfW / aspect);
      return { cx, cy, cz, fitH };
    }

    function updateCamera() {
      if (viewMode === "orbit") {
        const s = Math.sin(phi);
        camera.position.set(
          target.x + radius * s * Math.sin(theta),
          target.y + radius * Math.cos(phi),
          target.z + radius * s * Math.cos(theta)
        );
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
        activeCamera = camera;
      } else {
        const cfg = ORTHO_DIRS[viewMode];
        orthoCamera.position.copy(target).addScaledVector(cfg.dir, 200);
        orthoCamera.up.copy(cfg.up);
        orthoCamera.lookAt(target);
        const aspect = width / height;
        orthoCamera.left = -radius * aspect;
        orthoCamera.right = radius * aspect;
        orthoCamera.top = radius;
        orthoCamera.bottom = -radius;
        orthoCamera.near = 0.1;
        orthoCamera.far = 500;
        orthoCamera.updateProjectionMatrix();
        orthoCamera.clearViewOffset();
        orthoCamera.updateMatrixWorld(true);
        activeCamera = orthoCamera;
      }
    }
    applyViewShift(camera, width, height);
    updateCamera();
    function setViewMode(mode) {
      viewMode = mode;
      dragState = null;
      dragCrossFloorRestore = null;
      orbiting = null;
      pinchState = null;
      if (mode !== "orbit") {
        // re-center and re-fit to the current content (with a ~10% border)
        // every time an orthographic view is entered, rather than reusing
        // whatever target/radius the orbit camera happened to be at.
        const fit = computeOrthoFit(mode);
        target.set(fit.cx, fit.cy, fit.cz);
        radius = fit.fitH;
      }
      updateCamera();
    }
    setViewModeApiRef.current = setViewMode;

    // ---------- quad-view layout (top-left: top, top-right: orbit, bottom-left: front, bottom-right: left) ----------
    function ensureQuadPaneState() {
      if (quadPaneStateReady) return;
      quadPaneStateReady = true;
      ["top", "front", "left"].forEach((k) => {
        const fit = computeOrthoFit(k);
        quadPaneState[k].target.set(fit.cx, fit.cy, fit.cz);
        quadPaneState[k].radius = fit.fitH;
      });
      const fit = computeOrthoFit("top");
      quadPaneState.orbit.target.set(fit.cx, fit.cy, fit.cz);
      quadPaneState.orbit.radius = Math.max(6, fit.fitH * 1.3);
    }

    function updateQuadOrthoCam(cam, dirKey, aspect) {
      const cfg = ORTHO_DIRS[dirKey];
      const st = quadPaneState[dirKey];
      cam.position.copy(st.target).addScaledVector(cfg.dir, 200);
      cam.up.copy(cfg.up);
      cam.lookAt(st.target);
      cam.left = -st.radius * aspect;
      cam.right = st.radius * aspect;
      cam.top = st.radius;
      cam.bottom = -st.radius;
      cam.near = 0.1;
      cam.far = 500;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }

    function updateQuadOrbitCam(aspect) {
      const st = quadPaneState.orbit;
      const s = Math.sin(st.phi);
      camera.position.set(
        st.target.x + st.radius * s * Math.sin(st.theta),
        st.target.y + st.radius * Math.cos(st.phi),
        st.target.z + st.radius * s * Math.cos(st.theta)
      );
      camera.lookAt(st.target);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    // returns the 4 pane rects in DOM pixel space (y measured from the top),
    // each tagged with its camera, direction key (for the ortho panes) and
    // paneKey (for looking up its independent camera state).
    function computeQuadPanes(w, h) {
      const sx = w * splitX, sy = h * splitY;
      return [
        { x: 0, y: 0, w: sx, h: sy, cam: orthoTopCam, dir: "top", paneKey: "top" },
        { x: sx, y: 0, w: w - sx, h: sy, cam: camera, dir: null, paneKey: "orbit" },
        { x: 0, y: sy, w: sx, h: h - sy, cam: orthoFrontCam, dir: "front", paneKey: "front" },
        { x: sx, y: sy, w: w - sx, h: h - sy, cam: orthoLeftCam, dir: "left", paneKey: "left" },
      ];
    }

    function renderQuadLayout(w, h) {
      ensureQuadPaneState();
      const panes = computeQuadPanes(w, h);
      renderer.setScissorTest(true);
      panes.forEach((p) => {
        if (p.w <= 1 || p.h <= 1) return;
        const aspect = p.w / p.h;
        if (p.dir) {
          updateQuadOrthoCam(p.cam, p.dir, aspect);
        } else {
          p.cam.clearViewOffset();
          updateQuadOrbitCam(aspect);
        }
        // the fixed ortho panes look straight along one axis, so the key
        // light's hard directional shadow often falls across most of what's
        // visible and reads as "the whole view is dark" -- shadows are only
        // meaningful for the free-look pane, so switch them off for the rest.
        renderer.shadowMap.enabled = !p.dir;
        // these cameras also sit 200 units from the target (needed so their
        // frustum math is well-conditioned), which puts the model deep
        // inside the scene fog's falloff and washes it toward the dark
        // background regardless of lighting -- fog only makes sense for the
        // up-close orbit view anyway, so drop it for the fixed panes.
        scene.fog = p.dir ? null : sceneFog;
        const glY = h - p.y - p.h;
        renderer.setViewport(p.x, glY, p.w, p.h);
        renderer.setScissor(p.x, glY, p.w, p.h);
        renderer.render(scene, p.cam);
      });
      renderer.shadowMap.enabled = true;
      scene.fog = sceneFog;
      renderer.setScissorTest(false);
    }

    // called at the start of every pointer gesture (and, while nothing is
    // being dragged, on every hover-move) so picking/orbiting/panning use
    // whichever pane's camera the pointer is currently over. Returns
    // "divider" if the point is over the draggable split-handle instead.
    function updateInteractionContext(clientX, clientY) {
      if (viewLayoutRef.current !== "quad") {
        interactionCamera = activeCamera;
        interactionRect = null;
        currentGestureIsOrtho = viewMode !== "orbit";
        currentGesturePaneDir = null;
        return "ok";
      }
      const rect = renderer.domElement.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      const w = rect.width, h = rect.height;
      const sx = w * splitX, sy = h * splitY;
      if (Math.abs(x - sx) < 14 && Math.abs(y - sy) < 14) return "divider";
      if (x < sx && y < sy) { interactionCamera = orthoTopCam; interactionRect = { x: 0, y: 0, w: sx, h: sy }; currentGestureIsOrtho = true; currentGesturePaneDir = "top"; return "ok"; }
      if (x >= sx && y < sy) { interactionCamera = camera; interactionRect = { x: sx, y: 0, w: w - sx, h: sy }; currentGestureIsOrtho = false; currentGesturePaneDir = "orbit"; return "ok"; }
      if (x < sx && y >= sy) { interactionCamera = orthoFrontCam; interactionRect = { x: 0, y: sy, w: sx, h: h - sy }; currentGestureIsOrtho = true; currentGesturePaneDir = "front"; return "ok"; }
      interactionCamera = orthoLeftCam; interactionRect = { x: sx, y: sy, w: w - sx, h: h - sy }; currentGestureIsOrtho = true; currentGesturePaneDir = "left"; return "ok";
    }

    // ---------- third-person walk mode (character + orbiting follow camera) ----------
    const CHAR_EYE_HEIGHT = 1.55; // where the camera's orbit target sits relative to the character's feet
    const WALK_SPEED = 2.4; // meters/second
    const WALK_RADIUS = 0.3; // rough "shoulder width" kept clear of walls
    let walkPos = new THREE.Vector3(0, 0, 0);
    let walkFloorId = null;
    let walkHeightOffset = 0; // meters above the current walking floor's own base, from climbing a stair
    let walkTransition = null; // {fromPos, fromQuat, elapsed, duration} -- eases the camera in on entry
    let savedView = null; // camera state to restore when leaving walk mode

    function enterWalkMode() {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      dragState = null;
      dragCrossFloorRestore = null;
      orbiting = null;
      pinchState = null;
      previewSelection = null;
      previewOpening = null;
      previewStair = null;
      savedView = { viewMode, target: target.clone(), radius, theta, phi, fov: camera.fov };
      walkFloorId = entry.id;
      walkHeightOffset = 0;
      const fp = entry.data.footprint;
      walkPos.set((fp.xMin + fp.xMax) / 2, 0, (fp.zMin + fp.zMax) / 2);
      characterYaw = 0;
      walkCyclePhase = 0;
      walkCycleAmp = 0;
      character.group.position.set(walkPos.x, 0, walkPos.z);
      character.group.rotation.y = characterYaw;
      character.group.visible = true;
      viewMode = "orbit"; // third-person always orbits around the character, regardless of the prior view
      radius = 5.5;
      theta = 0;
      phi = 1.15;
      camera.fov = 55;
      camera.updateProjectionMatrix();
      const fromPos = activeCamera.position.clone();
      const fromQuat = camera.quaternion.clone();
      activeCamera = camera; // picking/editing during walk mode always raycasts through this camera
      target.set(walkPos.x, CHAR_EYE_HEIGHT, walkPos.z);
      updateCamera();
      const toPos = camera.position.clone();
      const toQuat = camera.quaternion.clone();
      walkTransition = { fromPos, fromQuat, toPos, toQuat, elapsed: 0, duration: 0.45 };
      camera.clearViewOffset();
      renderer.domElement.style.cursor = "default";
    }

    function exitWalkMode() {
      character.group.visible = false;
      if (savedView) {
        viewMode = savedView.viewMode;
        target.copy(savedView.target);
        radius = savedView.radius;
        theta = savedView.theta;
        phi = savedView.phi;
        camera.fov = savedView.fov;
        camera.updateProjectionMatrix();
      }
      walkTransition = null;
      updateCamera();
      renderer.domElement.style.cursor = "grab";
    }

    walkModeApiRef.current = (on) => { if (on) enterWalkMode(); else exitWalkMode(); };

    // finds a stair on the given floor whose footprint contains (x,z), and
    // how far along its climb that point is (0 at the bottom, 1 at the top).
    function stairClimbAt(floorEntry, x, z) {
      if (!floorEntry) return null;
      const stairs = floorEntry.data.stairs || [];
      for (const st of stairs) {
        const along = st.axis === "x" ? x : z;
        const across = st.axis === "x" ? z : x;
        if (across < st.widthMin - 0.05 || across > st.widthMax + 0.05) continue;
        const lo = Math.min(st.start, st.end), hi = Math.max(st.start, st.end);
        if (along < lo - 0.05 || along > hi + 0.05) continue;
        const t = st.end === st.start ? 0 : (along - st.start) / (st.end - st.start);
        return { frac: Math.min(1, Math.max(0, t)), stair: st };
      }
      return null;
    }

    function updateWalkMovement(dt) {
      const input = walkInputRef.current;
      // movement is relative to the camera's current orbit angle (theta),
      // like a normal third-person game: forward always means "away from
      // the camera, into the scene" no matter which way you've orbited.
      const forwardX = -Math.sin(theta), forwardZ = -Math.cos(theta);
      const rightX = Math.cos(theta), rightZ = -Math.sin(theta);
      let dx = 0, dz = 0;
      if (input.fwd) { dx += forwardX; dz += forwardZ; }
      if (input.back) { dx -= forwardX; dz -= forwardZ; }
      if (input.right) { dx += rightX; dz += rightZ; }
      if (input.left) { dx -= rightX; dz -= rightZ; }
      const len = Math.hypot(dx, dz);
      const moving = len > 0.0001;
      let floorEntry = floors.find((f) => f.id === walkFloorId);
      if (moving && floorEntry) {
        const step = WALK_SPEED * dt;
        let nx = walkPos.x + (dx / len) * step;
        let nz = walkPos.z + (dz / len) * step;
        const fp = floorEntry.data.footprint;
        nx = Math.min(fp.xMax - WALK_RADIUS, Math.max(fp.xMin + WALK_RADIUS, nx));
        nz = Math.min(fp.zMax - WALK_RADIUS, Math.max(fp.zMin + WALK_RADIUS, nz));
        walkPos.x = nx;
        walkPos.z = nz;
        // turn the character to face the direction it's actually moving
        const targetYaw = Math.atan2(dx, dz);
        let diff = targetYaw - characterYaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        characterYaw += diff * Math.min(1, dt * 10);
      }
      // stair climbing: smoothly ramp height while inside a stair's footprint
      const climb = floorEntry ? stairClimbAt(floorEntry, walkPos.x, walkPos.z) : null;
      if (climb) {
        walkHeightOffset = climb.frac * (floorEntry.data.height || WALL_HEIGHT);
      } else {
        walkHeightOffset = 0;
      }
      // reaching the top of a stair, with a floor above whose footprint
      // covers this point (i.e. we've walked into its stairwell opening),
      // hands walking off to that floor at its own base level.
      if (climb && climb.frac >= 0.98 && floorEntry) {
        const idx = floors.findIndex((f) => f.id === floorEntry.id);
        const above = idx !== -1 ? floors[idx + 1] : null;
        if (above) {
          const afp = above.data.footprint;
          if (walkPos.x >= afp.xMin && walkPos.x <= afp.xMax && walkPos.z >= afp.zMin && walkPos.z <= afp.zMax) {
            walkFloorId = above.id;
            walkHeightOffset = 0;
          }
        }
      }
      // procedural walk-cycle: legs/arms swing on a sine wave whose
      // amplitude eases toward 0 (idle) or 1 (walking), and whose phase
      // only advances while actually moving, so the character doesn't
      // "walk in place" when stationary.
      const targetAmp = moving ? 1 : 0;
      walkCycleAmp += (targetAmp - walkCycleAmp) * Math.min(1, dt * 6);
      if (moving) walkCyclePhase += dt * 7.5;
      const legSwing = Math.sin(walkCyclePhase) * 0.55 * walkCycleAmp;
      const armSwing = Math.sin(walkCyclePhase) * 0.45 * walkCycleAmp;
      character.leftLegPivot.rotation.x = legSwing;
      character.rightLegPivot.rotation.x = -legSwing;
      character.leftArmPivot.rotation.x = -armSwing;
      character.rightArmPivot.rotation.x = armSwing;

      updateWalkCamera();
    }

    function updateWalkCamera() {
      const floorEntry = floors.find((f) => f.id === walkFloorId);
      const g = floorEntry ? floorGroups.get(floorEntry.id) : null;
      const baseY = g ? g.position.y : 0;
      character.group.position.set(walkPos.x, baseY + walkHeightOffset, walkPos.z);
      character.group.rotation.y = characterYaw;
      // the camera orbits this point (drag to rotate, wheel/pinch to zoom,
      // exactly like the normal orbit camera) -- it just tracks the
      // character instead of a fixed target.
      target.set(walkPos.x, baseY + walkHeightOffset + CHAR_EYE_HEIGHT, walkPos.z);
      updateCamera();
    }

    // widens the view (never narrows it) so the active floor's footprint and
    // all of its rooms -- wherever they've been dragged or pasted to --
    // stay in frame. Called whenever a room is created/pasted, since those
    // can land well outside whatever the camera currently happens to show.
    function ensureActiveContentInFrame() {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      const fp = entry.data.footprint;
      let minX = fp.xMin, maxX = fp.xMax, minZ = fp.zMin, maxZ = fp.zMax;
      (entry.rooms || []).forEach((rm) => {
        const rf = rm.data.footprint, ox = rm.offsetX || 0, oz = rm.offsetZ || 0;
        minX = Math.min(minX, rf.xMin + ox); maxX = Math.max(maxX, rf.xMax + ox);
        minZ = Math.min(minZ, rf.zMin + oz); maxZ = Math.max(maxZ, rf.zMax + oz);
      });
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const neededRadius = Math.max(maxX - minX, maxZ - minZ) * 0.85 + 2;
      target.x = cx;
      target.z = cz;
      // since any visible layer's walls stay editable regardless of which one
      // is "active" (see rebuildFloorEntry), the camera must keep every
      // visible layer in frame when switching/duplicating the active one --
      // otherwise a layer can get scrolled out of view and its walls become
      // unreachable to click, even though they're still fully editable.
      let minY = Infinity, maxY = -Infinity;
      floors.forEach((f) => {
        const visible = isolatedFloorIds.size > 0 ? isolatedFloorIds.has(f.id) : !hiddenFloorIds.has(f.id);
        if (!visible) return;
        const g = floorGroups.get(f.id);
        if (!g) return;
        minY = Math.min(minY, g.position.y);
        maxY = Math.max(maxY, g.position.y + f.data.height);
      });
      const g = floorGroups.get(entry.id);
      if (minY === Infinity) { minY = g ? g.position.y : 0; maxY = minY + entry.data.height; }
      const activeCenterY = g ? g.position.y + entry.data.height * 0.32 : (minY + maxY) / 2;
      target.y = Math.max(minY, Math.min(maxY, activeCenterY));
      const verticalRadius = (maxY - minY) * 0.6 + 2;
      const combinedRadius = Math.max(neededRadius, verticalRadius);
      if (combinedRadius > radius) radius = Math.min(MAX_RADIUS, combinedRadius);
      updateCamera();
    }

    // ---------- pointer / drag machinery ----------
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function getNDC(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      const rx = interactionRect ? interactionRect.x : 0;
      const ry = interactionRect ? interactionRect.y : 0;
      const rw = interactionRect ? interactionRect.w : rect.width;
      const rh = interactionRect ? interactionRect.h : rect.height;
      ndc.x = ((e.clientX - rect.left - rx) / rw) * 2 - 1;
      ndc.y = -((e.clientY - rect.top - ry) / rh) * 2 + 1;
      return ndc;
    }
    // Resize handles (window/door/balcony/prop) render as small bars or
    // cubes -- fine visually, but as literal 3D geometry they shrink to a
    // near-unhittable speck once zoomed out, or on a touchscreen finger.
    // Rather than growing the geometry itself (which would either look
    // chunky up close or still be tiny far away), handles get a hit-test
    // radius that's constant in SCREEN pixels: project each one to screen
    // space and grab whichever is closest to the pointer, as long as it's
    // within a generous "fingertip" radius -- independent of zoom level.
    const HANDLE_HIT_PX = 26;
    const handleWorldPos = new THREE.Vector3();
    function pointerPixel(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      const rx = interactionRect ? interactionRect.x : 0;
      const ry = interactionRect ? interactionRect.y : 0;
      return { x: e.clientX - rect.left - rx, y: e.clientY - rect.top - ry };
    }
    function pickHandle(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      const rw = interactionRect ? interactionRect.w : rect.width;
      const rh = interactionRect ? interactionRect.h : rect.height;
      const p = pointerPixel(e);
      let best = null, bestDist = HANDLE_HIT_PX;
      for (const obj of pickList) {
        if (obj.userData.kind !== "resize-handle") continue;
        obj.getWorldPosition(handleWorldPos);
        const proj = handleWorldPos.clone().project(interactionCamera);
        if (proj.z < -1 || proj.z > 1) continue; // behind the camera or outside its clip range
        const sx = (proj.x * 0.5 + 0.5) * rw;
        const sy = (-proj.y * 0.5 + 0.5) * rh;
        const d = Math.hypot(sx - p.x, sy - p.y);
        if (d < bestDist) { bestDist = d; best = obj; }
      }
      return best;
    }
    function pick(e) {
      const handle = pickHandle(e);
      if (handle) return { object: handle, point: handle.getWorldPosition(new THREE.Vector3()) };
      raycaster.setFromCamera(getNDC(e), interactionCamera);
      const hits = raycaster.intersectObjects(pickList, false);
      return hits.length ? hits[0] : null;
    }
    function rayFromEvent(e) {
      raycaster.setFromCamera(getNDC(e), interactionCamera);
      return raycaster.ray;
    }
    function makeVerticalPlane(normal, point) {
      const planeNormal = new THREE.Vector3(Math.abs(normal.z), 0, Math.abs(normal.x));
      const plane = new THREE.Plane();
      plane.setFromNormalAndCoplanarPoint(planeNormal, point);
      return plane;
    }
    function panelFacePlane(info, point) {
      const plane = new THREE.Plane();
      plane.setFromNormalAndCoplanarPoint(info.normal, point);
      return plane;
    }
    function worldDirScreen(point, dir) {
      const p0 = point.clone().project(activeCamera);
      const p1 = point.clone().addScaledVector(dir, 0.4).project(activeCamera);
      return { x: p1.x - p0.x, y: -(p1.y - p0.y) };
    }
    function classifyDrag(info, hitPoint, dx, dy) {
      const runDir = info.lengthAxis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const rs = worldDirScreen(hitPoint, runDir);
      const ns = worldDirScreen(hitPoint, info.normal);
      const rl = Math.hypot(rs.x, rs.y) || 1;
      const nl = Math.hypot(ns.x, ns.y) || 1;
      const rScore = Math.abs((dx * rs.x + dy * rs.y) / rl);
      const nScore = Math.abs((dx * ns.x + dy * ns.y) / nl);
      return rScore >= nScore ? "select" : "extrude";
    }

    let dragState = null;
    // when a gesture starts on a non-active floor, this holds what to put
    // the shared editing context (state/sceneGroup/etc.) back to once the
    // gesture ends -- see the cross-floor retargeting in onPointerDown.
    let dragCrossFloorRestore = null;
    function restoreCrossFloorContext() {
      if (!dragCrossFloorRestore) return;
      ({ state, sceneGroup, buildingFloorEntry, buildingRoomId, currentWallMat, currentFloorMat } = dragCrossFloorRestore);
      dragCrossFloorRestore = null;
    }
    let orbiting = null;
    const activePointers = new Map();
    let pinchState = null;
    function pointerDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function pointerMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    function capture(e) { try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    function armTimer() {
      const token = {};
      return {
        token,
        id: setTimeout(() => { if (dragState && dragState.token === token) dragState.armed = true; }, HOLD_MS),
      };
    }

    // extracts the detected region into its own draggable room. If the floor
    // has no partitions, the detected region IS the floor's whole current
    // shape, so we deep-clone the entire floor data (bumpouts, selections,
    // openings, panel heights and all) rather than starting from a blank
    // rectangle -- otherwise any pushed/pulled walls would be silently lost.
    // With partitions splitting the floor into sub-rooms, a full-fidelity
    // extraction of just one sub-room's shape isn't implemented yet, so
    // that case still falls back to a plain rectangle matching its bounds.
    function commitRoomFromFound(found, hitPoint) {
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      if (!floorEntry) return null;
      pushUndo();
      const id = idSeq++;
      let roomData;
      if (!state.partitions || state.partitions.length === 0) {
        roomData = JSON.parse(JSON.stringify(state));
      } else {
        roomData = makeFloorData();
        roomData.footprint = { ...found.bbox };
      }
      const room = { id, data: roomData, offsetX: 0, offsetZ: 0 };
      if (!floorEntry.rooms) floorEntry.rooms = [];
      floorEntry.rooms.push(room);
      switchActiveRoom(id);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hitPoint.y);
      dragState = { type: "room-drag", roomId: id, plane, start: hitPoint.clone(), startOffsetX: 0, startOffsetZ: 0 };
      rebuild();
      return id;
    }

    function onPointerDown(e) {
      if (e.pointerType === "touch") e.preventDefault();
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2) {
        if (activePointers.size === 2) {
          // a second finger just landed -- hand off to two-finger pan/zoom and
          // drop whatever single-finger gesture was in progress
          if (dragState && dragState.holdTimer) clearTimeout(dragState.holdTimer);
          dragState = null;
          restoreCrossFloorContext();
          orbiting = null;
          previewSelection = null;
          previewOpening = null;
          pinchState = { lastDist: null, lastMid: null, pane: null };
          {
            const pts0 = Array.from(activePointers.values()).slice(0, 2);
            if (pts0.length === 2) {
              const mid0 = pointerMid(pts0[0], pts0[1]);
              updateInteractionContext(mid0.x, mid0.y);
              pinchState.pane = viewLayoutRef.current === "quad" ? currentGesturePaneDir : null;
            }
          }
          rebuild();
        }
        capture(e);
        return;
      }

      const ctx = updateInteractionContext(e.clientX, e.clientY);
      if (ctx === "divider") {
        dividerDragActive = true;
        capture(e);
        return;
      }

      const hit = pick(e);
      if (!hit) {
        orbiting = { x: e.clientX, y: e.clientY, moved: 0 };
        renderer.domElement.style.cursor = "grabbing";
        capture(e);
        return;
      }
      const obj = hit.object;
      const kind = obj.userData.kind;

      // A tap can now land on any visible floor, not just the active one --
      // retarget the shared editing context (state/sceneGroup/etc.) to
      // whichever floor actually owns the thing that was hit, before any
      // tool-specific logic below runs. Every handler just reads/writes
      // these ambient variables, so this one retarget is all it takes for
      // them to transparently edit the right floor's data. Restored back
      // to the active floor once the gesture ends (onPointerUp), so active
      // stays reserved for height/isolate/hide as intended -- and rooms
      // stay out of this (ownerRoomId != null never reaches here for a
      // non-active floor to begin with, since rooms are only ever pickable
      // on the active floor's currently-focused one).
      // Applied as a function (not inlined once) because switchActiveRoom
      // -- called a few lines below for wall/partition hits -- resets
      // `state` back to the active floor whenever a room was previously
      // focused there, which would silently undo this; re-applying right
      // after that call makes this retarget the actual last word.
      function applyCrossFloorRetarget(hitFloorId) {
        if (hitFloorId == null || hitFloorId === activeFloorId) return;
        const targetEntry = floors.find((f) => f.id === hitFloorId);
        if (!targetEntry) return;
        if (!dragCrossFloorRestore) {
          dragCrossFloorRestore = { state, sceneGroup, buildingFloorEntry, buildingRoomId, currentWallMat, currentFloorMat };
        }
        state = targetEntry.data;
        sceneGroup = floorGroups.get(hitFloorId);
        buildingFloorEntry = targetEntry;
        buildingRoomId = null;
        currentWallMat = wallMat;
        currentFloorMat = floorMat;
      }
      const hitFloorId = obj.userData.ownerFloorId ?? null;
      if (obj.userData.ownerRoomId == null) applyCrossFloorRetarget(hitFloorId);

      // Grabbing an edge handle on a selected window, door, or balcony
      // platform starts an interactive resize -- available regardless of
      // which tool is active, same as selecting the opening/balcony itself.
      if (kind === "resize-handle") {
        const rh = obj.userData;
        const ownerRoomId = rh.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        if (ownerRoomId == null) applyCrossFloorRetarget(hitFloorId);
        if (rh.target === "opening") {
          const o = state.openings.find((oo) => oo.id === rh.id);
          if (!o) return;
          const info = getPanelInfo(o.panel);
          if (!info) return;
          pushUndo();
          dragState = { type: "resize-opening", id: rh.id, edge: rh.edge, panelKey: o.panel, plane: panelFacePlane(info, hit.point) };
        } else if (rh.target === "balcony") {
          const bal = (state.balconies || []).find((b) => b.id === rh.id);
          if (!bal) return;
          const info = getPanelInfo(bal.panel);
          if (!info) return;
          pushUndo();
          dragState = { type: "resize-balcony", id: rh.id, edge: rh.edge, panelKey: bal.panel, plane: panelFacePlane(info, hit.point) };
        } else if (rh.target === "prop") {
          const p = (state.props || []).find((pp) => pp.id === rh.id);
          if (!p) return;
          pushUndo();
          if (rh.edge === "top") {
            // vertical drag: a plane through the prop's center, facing the
            // camera, so the pointer ray's intersection tracks how far up
            // or down the drag moved regardless of viewing angle.
            const center = new THREE.Vector3(p.x, propHeightOf(p) / 2, p.z);
            const camXZ = new THREE.Vector3(interactionCamera.position.x - center.x, 0, interactionCamera.position.z - center.z);
            if (camXZ.lengthSq() < 1e-6) camXZ.set(0, 0, 1); else camXZ.normalize();
            const plane = new THREE.Plane();
            plane.setFromNormalAndCoplanarPoint(camXZ, center);
            dragState = { type: "resize-prop-height", id: rh.id, plane, startH: propHeightOf(p), startY: hit.point.y };
          } else {
            // corner drag: a horizontal plane at the prop's current top,
            // so the pointer's XZ position under the cursor maps directly
            // to how far the dragged corner has moved from center.
            const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
            dragState = { type: "resize-prop-corner", id: rh.id, corner: rh.edge, plane, cx: p.x, cz: p.z };
          }
        }
        capture(e);
        return;
      }

      // Tapping a staircase selects it and exposes its step-count/delete
      // controls, regardless of which tool is currently active.
      if (kind === "stair") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        const st = (state.stairs || []).find((s) => s.id === obj.userData.id);
        setSelectedPanel(null);
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
        setSelectedOpeningId(null);
        setSelectedStairId(obj.userData.id);
        if (st) setStairSteps(st.steps);
        return;
      }

      // Same idea for a balcony assembly -- tapping the steps or platform
      // selects the whole thing (deleting it removes everything, per the
      // staircase-height slider's Delete button); tapping a pillar or the
      // ceiling specifically selects just that part, so the global Delete
      // button (up top) can remove only that piece and leave the rest.
      if (kind === "balcony" || kind === "balcony-pillar" || kind === "balcony-ceiling") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        const bal = (state.balconies || []).find((b) => b.id === obj.userData.id);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedOpeningId(null);
        setSelectedBalconyId(obj.userData.id);
        setSelectedBalconyPart(kind === "balcony-pillar" ? "pillars" : kind === "balcony-ceiling" ? "ceiling" : null);
        if (bal) {
          const ph = bal.platformHeight || 3 * FT;
          setBalconyStairHeight(ph);
          setBalconyPlatformWidth(bal.platformWidth || 10 * FT);
          setBalconyPillarHeight(bal.pillarHeight != null ? bal.pillarHeight : 3 * FT);
          const perimeterLen = (bal.platformWidth || 10 * FT) * 2 + (bal.u1 - bal.u0);
          setBalconyPillarCount(bal.pillarCount || Math.max(2, Math.round(perimeterLen / (3 * FT))));
          setBalconyGlassInfill(!!bal.glassInfill);
        }
        return;
      }

      // A window or door cutout in a wall -- selectable from any tool (not
      // just Window/Door), same as stairs and balconies. There's more
      // parametric control planned for doors specifically down the line;
      // this selection is the foundation that'll hang off of.
      if (kind === "opening") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
        setSelectedOpeningId(obj.userData.id);
        // sync the height/dividers/direction controls to whichever opening
        // was just tapped, so they read (and edit) its actual values
        // instead of whatever was left over from drawing the last one.
        const o = state.openings.find((oo) => oo.id === obj.userData.id);
        setSelectedOpeningIsDoor(!!(o && o.isDoor));
        if (o && !o.isDoor) {
          setOpeningHeight(o.height ?? DEFAULT_OPENING_HEIGHT);
          setOpeningDividers(o.dividers || 0);
          setOpeningAxisVertical(o.dividerAxis === "vertical" || o.dividerAxis === "both");
          setOpeningAxisHorizontal(o.dividerAxis === "horizontal" || o.dividerAxis === "both");
        } else if (o && o.isDoor) {
          setDoorHeight(o.height ?? DEFAULT_OPENING_HEIGHT);
        }
        return;
      }

      // A placed prop (sphere/cube/cone/cylinder) -- selectable from any
      // tool, same as stairs/balconies/openings. Selecting it shows the
      // corner + top-center resize handles (see renderProps).
      if (kind === "prop") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
        setSelectedOpeningId(null);
        setSelectedPropId(obj.userData.id);
        return;
      }

      // Move Walls: tapping the floor selects (or detects) the enclosed room
      // under that point and lets you drag it away; tapping a wall/partition
      // switches editing focus onto whatever it belongs to (the floor itself,
      // or one specific room) before continuing as normal.
      if (toolRef.current === "move" && kind === "floor") {
        setSelectedPropId(null);
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        if (!floorEntry) return;
        if (ownerRoomId != null) {
          const room = (floorEntry.rooms || []).find((r) => r.id === ownerRoomId);
          if (!room) return;
          pushUndo();
          switchActiveRoom(ownerRoomId);
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
          dragState = {
            type: "room-drag", roomId: ownerRoomId, plane, start: hit.point.clone(),
            startOffsetX: room.offsetX || 0, startOffsetZ: room.offsetZ || 0,
          };
          capture(e);
          return;
        }
        // with no partitions yet, the whole floor already IS the "room" --
        // there's nothing distinct to extract. commitRoomFromFound would
        // still clone the floor's entire data into a brand-new room object
        // and switch editing focus onto that clone; from that point on the
        // clone and the floor silently diverge, so a Layer height change
        // afterward stops visibly affecting anything (the floor's own data
        // changed, but what's on screen is now the clone) until you
        // deselect and the two disagree. So a tap-drag here just moves the
        // floor itself instead.
        if (!state.partitions || state.partitions.length === 0) {
          pushUndo();
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
          dragState = {
            type: "room-move", plane, start: hit.point.clone(),
            startOffsetX: floorEntry.offsetX || 0, startOffsetZ: floorEntry.offsetZ || 0,
          };
          capture(e);
          return;
        }
        const rooms = detectRooms();
        const hx = hit.point.x, hz = hit.point.z;
        const found = rooms.find((r) => r.floorRects.some((fr) => hx >= fr.x0 - 0.02 && hx <= fr.x1 + 0.02 && hz >= fr.z0 - 0.02 && hz <= fr.z1 + 0.02));
        if (!found) return;
        // extracts the region into its own selected, draggable room right
        // away -- release without moving and it just stays selected in
        // place (showing the room menu); keep dragging and it moves.
        commitRoomFromFound(found, hit.point.clone());
        capture(e);
        return;
      }

      // Stairs tool: tapping the plain floor and dragging draws the
      // footprint rectangle for a new staircase (tapping an existing one is
      // now handled tool-agnostically above).
      if (toolRef.current === "stairs") {
        if (kind === "floor") {
          const ownerRoomId = obj.userData.ownerRoomId ?? null;
          if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
          pushUndo();
          setSelectedStairId(null);
        setSelectedPropId(null);
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
          dragState = { type: "stair-draw", plane, x0: hit.point.x, z0: hit.point.z, x1: hit.point.x, z1: hit.point.z };
          capture(e);
        }
        return;
      }
      // Props tool: tapping the floor drops the currently-selected shape
      // right there. Not a drag gesture -- one tap, one prop placed. The
      // balcony "shape" is the exception -- it's drawn along a wall (see
      // the pending-balcony branch below), so a floor tap does nothing.
      if (toolRef.current === "props" && propsShapeRef.current !== "balcony") {
        if (kind === "floor") {
          const ownerRoomId = obj.userData.ownerRoomId ?? null;
          if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
          pushUndo();
          if (!state.props) state.props = [];
          state.props.push({ id: idSeq++, kind: propsShapeRef.current, x: hit.point.x, z: hit.point.z });
          rebuild();
        }
        return;
      }
      if (kind === "wall" || kind === "partition" || kind === "selection") {
        // reaching here means the tap landed on a wall/partition itself,
        // not an existing opening/stair/balcony (those are handled -- and
        // return early -- above), so any previously selected one of those
        // is stale now: clear it rather than leaving its resize handles
        // and ribbon controls stuck showing while a new thing gets drawn.
        setSelectedOpeningId(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        // switchActiveRoom resets `state` to the active floor when it
        // clears room focus -- reassert the cross-floor retarget so the
        // drag that's about to start still lands on the right floor.
        if (ownerRoomId == null) applyCrossFloorRetarget(hitFloorId);
      }

      // grabbing an existing partition directly (outside the cut tool) always
      // adjusts its length/direction -- a dedicated, always-available gesture.
      if (kind === "partition" && toolRef.current !== "cut") {
        const p = state.partitions.find((x) => x.id === obj.userData.id);
        if (!p) return;
        const parent = getPanelInfo(p.panel);
        if (!parent) return;
        pushUndo();
        dragState = {
          type: "partition-redrag", id: p.id,
          normal: parent.normal, plane: makeVerticalPlane(parent.normal, hit.point),
          start: hit.point.clone(), baseExt: p.ext,
        };
        capture(e);
        return;
      }

      let panelKey = null;
      if (kind === "wall" || kind === "selection") panelKey = obj.userData.panel;
      else if (kind === "partition") panelKey = "pt:" + obj.userData.id; // only reached in the cut tool
      if (!panelKey) return;
      const info = getPanelInfo(panelKey);
      if (!info) return;
      const hp = snapToPanelPlane(info, hit.point);

      if (toolRef.current === "cut") {
        // the cut tool has one job -- no need to arm with a hold first, tap
        // and drag immediately starts marking the opening's width
        dragState = { type: "pending-cut", panelKey, info, hitPoint: hp, startScreen: { x: e.clientX, y: e.clientY } };
      } else if (toolRef.current === "door") {
        // doors are a fixed width (3ft), floor to lintel at the current
        // door-height setting -- a single tap places one centered on the
        // tap point, no drag needed.
        pushUndo();
        const doorWidth = 3 * FT;
        const u = panelU(info, hp);
        let u0 = u - doorWidth / 2, u1 = u + doorWidth / 2;
        if (u0 < info.u0) { u0 = info.u0; u1 = u0 + doorWidth; }
        if (u1 > info.u1) { u1 = info.u1; u0 = u1 - doorWidth; }
        if (u1 - u0 >= MIN_OPENING && !wouldOverlapBumpout(panelKey, u0, u1)) {
          state.openings = state.openings.filter((o) => !(o.panel === panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          state.openings.push({ id: idSeq++, panel: panelKey, u0, u1, height: doorHeightRef.current, isDoor: true });
          rebuild();
        }
      } else if (toolRef.current === "props" && propsShapeRef.current === "balcony") {
        // the staircase-balcony assembly is drawn along a wall exactly like
        // a window (tap and drag to mark its span), not placed on the
        // floor like the other props -- so it gets its own wall-drag entry
        // point here rather than going through the floor-tap prop handler.
        // which side of the wall this was drawn on decides which side the
        // whole structure gets built on -- compare the RAW hit point
        // (before it gets snapped onto the wall's centerline plane) against
        // the wall's centerline, since the snapped point would always read
        // as exactly on the line and give the same answer every time.
        const thickCoord = info.thickAxis === "x" ? hit.point.x : hit.point.z;
        const normalComponent = info.thickAxis === "x" ? info.normal.x : info.normal.z;
        const side = Math.sign((thickCoord - info.coord) * normalComponent) || 1;
        dragState = { type: "pending-balcony", panelKey, info, hitPoint: hp, side, startScreen: { x: e.clientX, y: e.clientY } };
      } else {
        const t = armTimer();
        dragState = {
          type: "pending", panelKey, info, hitPoint: hp,
          selIdAtPoint: kind === "selection" ? obj.userData.id : null,
          startScreen: { x: e.clientX, y: e.clientY }, token: t.token, holdTimer: t.id,
        };
      }
      capture(e);
    }

    function onPointerMove(e) {
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (dividerDragActive) {
        const rect = renderer.domElement.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        splitX = Math.min(0.82, Math.max(0.18, nx));
        splitY = Math.min(0.82, Math.max(0.18, ny));
        return;
      }

      if (!dragState && !orbiting && !pinchState) {
        const ctx = updateInteractionContext(e.clientX, e.clientY);
        if (ctx === "divider") {
          renderer.domElement.style.cursor = "move";
          return;
        }
      }

      if (pinchState) {
        if (e.pointerType === "touch") e.preventDefault();
        const pts = Array.from(activePointers.values()).slice(0, 2);
        if (pts.length < 2) return;
        const dist = pointerDist(pts[0], pts[1]);
        const mid = pointerMid(pts[0], pts[1]);
        if (pinchState.lastDist != null) {
          const scale = dist / (pinchState.lastDist || 1);
          const dx = mid.x - pinchState.lastMid.x;
          const dy = mid.y - pinchState.lastMid.y;
          const quadPane = pinchState.pane;
          if (quadPane) {
            // pinching inside a quad-view pane only zooms/pans that pane,
            // same principle as single-finger drag/wheel on it.
            const st = quadPaneState[quadPane];
            st.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, st.radius / scale));
            const panScale = st.radius * 0.0022;
            const paneCam = quadPane === "orbit" ? camera : quadPane === "top" ? orthoTopCam : quadPane === "front" ? orthoFrontCam : orthoLeftCam;
            const e_ = paneCam.matrixWorld.elements;
            const camRight = new THREE.Vector3(e_[0], e_[1], e_[2]);
            const camUp = new THREE.Vector3(e_[4], e_[5], e_[6]);
            st.target.addScaledVector(camRight, -dx * panScale);
            st.target.addScaledVector(camUp, dy * panScale);
          } else {
            radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius / scale));
            const panScale = radius * 0.0022;
            const e_ = activeCamera.matrixWorld.elements;
            const camRight = new THREE.Vector3(e_[0], e_[1], e_[2]);
            const camUp = new THREE.Vector3(e_[4], e_[5], e_[6]);
            target.addScaledVector(camRight, -dx * panScale);
            target.addScaledVector(camUp, dy * panScale);
            updateCamera();
          }
        }
        pinchState.lastDist = dist;
        pinchState.lastMid = mid;
        return;
      }

      if (orbiting) {
        const dx = e.clientX - orbiting.x;
        const dy = e.clientY - orbiting.y;
        const movedSoFar = orbiting.moved + Math.hypot(dx, dy);
        const quadPane = viewLayoutRef.current === "quad" ? currentGesturePaneDir : null;
        if (quadPane === "orbit") {
          // quad view's own orbit pane -- has its own theta/phi, separate
          // from single-view orbit and from the other 3 panes.
          const st = quadPaneState.orbit;
          st.theta -= dx * 0.006;
          st.phi = Math.min(1.45, Math.max(0.25, st.phi - dy * 0.006));
        } else if (quadPane) {
          // one of quad view's fixed ortho panes -- pans only that pane's
          // own target, leaving the other 3 panes untouched.
          const st = quadPaneState[quadPane];
          const panScale = st.radius * 0.0022;
          const e_ = interactionCamera.matrixWorld.elements;
          const camRight = new THREE.Vector3(e_[0], e_[1], e_[2]);
          const camUp = new THREE.Vector3(e_[4], e_[5], e_[6]);
          st.target.addScaledVector(camRight, -dx * panScale);
          st.target.addScaledVector(camUp, dy * panScale);
        } else if (!currentGestureIsOrtho) {
          // this also covers walk mode, which forces viewMode to "orbit" --
          // dragging empty space orbits the follow camera around the
          // character exactly like it orbits a fixed target otherwise.
          theta -= dx * 0.006;
          phi = Math.min(1.45, Math.max(0.25, phi - dy * 0.006));
        } else {
          // fixed orthographic views (single-view mode):
          // dragging empty space pans instead of orbiting
          const panScale = radius * 0.0022;
          const e_ = interactionCamera.matrixWorld.elements;
          const camRight = new THREE.Vector3(e_[0], e_[1], e_[2]);
          const camUp = new THREE.Vector3(e_[4], e_[5], e_[6]);
          target.addScaledVector(camRight, -dx * panScale);
          target.addScaledVector(camUp, dy * panScale);
        }
        orbiting = { x: e.clientX, y: e.clientY, moved: movedSoFar };
        if (viewLayoutRef.current !== "quad") updateCamera();
        return;
      }
      if (!dragState) {
        const hit = pick(e);
        renderer.domElement.style.cursor = hit ? "pointer" : "grab";
        return;
      }

      if (dragState.type === "pending") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (!dragState.armed && dist > MOVE_PX) {
          clearTimeout(dragState.holdTimer);
          pushUndo();
          const info = dragState.info;
          const cls = classifyDrag(info, dragState.hitPoint, dx, dy);
          if (cls === "select") {
            const u = panelU(info, dragState.hitPoint);
            dragState = { type: "select-drag", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u };
            previewSelection = { id: "__preview__", panel: dragState.panelKey, u0: u, u1: u };
          } else if (dragState.selIdAtPoint) {
            const sel = state.selections.find((s) => s.id === dragState.selIdAtPoint);
            if (sel) {
              state.selections = state.selections.filter((s) => s.id !== sel.id);
              const id = idSeq++;
              state.bumpouts.push({ id, panel: dragState.panelKey, u0: sel.u0, u1: sel.u1, depth: 0 });
              dragState = { type: "panel-extrude", panelKey: "bf:" + id, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
            } else {
              dragState = { type: "panel-extrude", panelKey: dragState.panelKey, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
            }
          } else {
            dragState = { type: "panel-extrude", panelKey: dragState.panelKey, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
          }
          if (dragState.type === "panel-extrude") setSelectedPanel(dragState.panelKey);
          rebuild();
          return;
        }
        if (dragState.armed && dist > 2) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          const id = idSeq++;
          state.partitions.push({ id, panel: dragState.panelKey, u, ext: 0 });
          dragState = { type: "partition-draw", id, normal: info.normal, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), baseExt: 0 };
          rebuild();
          return;
        }
        return;
      }

      if (dragState.type === "pending-cut") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          clearTimeout(dragState.holdTimer);
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "opening-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u };
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: openingHeightRef.current };
          rebuild();
        }
        return;
      }

      if (dragState.type === "pending-balcony") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "balcony-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u, side: dragState.side };
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: 7 * FT };
          rebuild();
        }
        return;
      }

      const ray = rayFromEvent(e);

      if (dragState.type === "panel-extrude") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const delta = dragState.thickAxis === "z" ? pt.z - dragState.start.z : pt.x - dragState.start.x;
        applyPanelExtrude(dragState.panelKey, dragState.startCoord + delta);
        rebuild();
      } else if (dragState.type === "select-drag") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewSelection = { id: "__preview__", panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u) };
        rebuild();
      } else if (dragState.type === "partition-draw" || dragState.type === "partition-redrag") {
        const now = performance.now();
        if (dragState.snapHoldUntil && now < dragState.snapHoldUntil) {
          // holding at the hard-snapped connection -- ignore pointer
          // movement for a moment so touching the opposite wall reads as a
          // definite "click stop" rather than a value that keeps sliding.
          rebuild();
        } else {
          const pt = new THREE.Vector3();
          if (!ray.intersectPlane(dragState.plane, pt)) return;
          const t = pt.clone().sub(dragState.start).dot(dragState.normal);
          const p = state.partitions.find((pp) => pp.id === dragState.id);
          const parent = p ? getPanelInfo(p.panel) : null;
          if (p && parent) {
            const axisSign = parent.thickAxis === "z" ? parent.normal.z : parent.normal.x;
            const rawExt = (dragState.baseExt || 0) + t;
            const farSnapped = snapValue(parent.coord + axisSign * rawExt);
            const newExt = clampPartitionExt(p.panel, (farSnapped - parent.coord) * axisSign);
            const wallSpan = wallDefs[p.panel]
              ? (parent.thickAxis === "z" ? state.footprint.zMax - state.footprint.zMin : state.footprint.xMax - state.footprint.xMin)
              : null;
            const isFullSpan = (ext) => wallSpan != null && ext <= -wallSpan + 0.001;
            if (isFullSpan(newExt) && !isFullSpan(p.ext)) {
              playClickSound();
              dragState.snapHoldUntil = now + 500;
            }
            p.ext = newExt;
          }
          rebuild();
        }
      } else if (dragState.type === "opening-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: openingHeightRef.current };
        rebuild();
      } else if (dragState.type === "balcony-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: 7 * FT };
        rebuild();
      } else if (dragState.type === "resize-opening") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const o = state.openings.find((oo) => oo.id === dragState.id);
        const info = getPanelInfo(dragState.panelKey);
        if (!o || !info) { dragState = null; return; }
        const MIN_OPENING_H = 0.3; // smallest opening you can resize to vertically
        if (dragState.edge === "left" || dragState.edge === "right") {
          const u = snapValue(panelU(info, pt));
          if (dragState.edge === "left") {
            const newU0 = Math.max(info.u0, Math.min(u, o.u1 - MIN_OPENING));
            if (!wouldOverlapOpeningExcluding(o.panel, newU0, o.u1, o.id) && !wouldOverlapBumpout(o.panel, newU0, o.u1)) o.u0 = newU0;
          } else {
            const newU1 = Math.min(info.u1, Math.max(u, o.u0 + MIN_OPENING));
            if (!wouldOverlapOpeningExcluding(o.panel, o.u0, newU1, o.id) && !wouldOverlapBumpout(o.panel, o.u0, newU1)) o.u1 = newU1;
          }
        } else {
          const H = state.height;
          const y = snapValue(pt.y);
          if (o.isDoor) {
            // doors are floor-anchored (or platform-anchored, off a
            // balcony) -- only the top edge moves, changing height alone.
            const bottom = o.bottomOverride || 0;
            o.height = Math.max(MIN_OPENING_H, Math.min(H - 0.05 - bottom, y - bottom));
            if (selectedOpeningIdRef.current === o.id) setDoorHeight(o.height);
          } else {
            // a plain window starts centered (bottomOverride null, height
            // split evenly around the middle) -- the first drag of either
            // edge pins the OTHER edge in place by recording bottomOverride,
            // so top and bottom move independently from then on, like a
            // real window frame rather than always staying centered.
            const curBottom = o.bottomOverride != null ? o.bottomOverride : Math.max(0, (H - (o.height ?? DEFAULT_OPENING_HEIGHT)) / 2);
            const curTop = curBottom + (o.height ?? DEFAULT_OPENING_HEIGHT);
            if (dragState.edge === "top") {
              const newTop = Math.max(curBottom + MIN_OPENING_H, Math.min(H - 0.05, y));
              o.bottomOverride = curBottom;
              o.height = newTop - curBottom;
            } else {
              const newBottom = Math.max(0, Math.min(curTop - MIN_OPENING_H, y));
              o.bottomOverride = newBottom;
              o.height = curTop - newBottom;
            }
            if (selectedOpeningIdRef.current === o.id) setOpeningHeight(o.height);
          }
        }
        rebuild();
      } else if (dragState.type === "resize-balcony") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const bal = (state.balconies || []).find((b) => b.id === dragState.id);
        const info = getPanelInfo(dragState.panelKey);
        if (!bal || !info) { dragState = null; return; }
        const MIN_BALCONY = 6 * FT;
        const u = snapValue(panelU(info, pt));
        if (dragState.edge === "left") {
          const newU0 = Math.max(info.u0, Math.min(u, bal.u1 - MIN_BALCONY));
          if (!wouldOverlapOpeningExcludingBalcony(bal.panel, newU0, bal.u1, bal.id) && !wouldOverlapBumpout(bal.panel, newU0, bal.u1)) {
            bal.u0 = newU0;
            regenerateBalconyOpenings(bal);
          }
        } else {
          const newU1 = Math.min(info.u1, Math.max(u, bal.u0 + MIN_BALCONY));
          if (!wouldOverlapOpeningExcludingBalcony(bal.panel, bal.u0, newU1, bal.id) && !wouldOverlapBumpout(bal.panel, bal.u0, newU1)) {
            bal.u1 = newU1;
            regenerateBalconyOpenings(bal);
          }
        }
        rebuild();
      } else if (dragState.type === "resize-prop-corner") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const p = (state.props || []).find((pp) => pp.id === dragState.id);
        if (!p) { dragState = null; return; }
        const signX = dragState.corner === "ne" || dragState.corner === "se" ? 1 : -1;
        const signZ = dragState.corner === "sw" || dragState.corner === "se" ? 1 : -1;
        const dx = pt.x - dragState.cx, dz = pt.z - dragState.cz;
        if (p.kind === "cube") {
          const newW = Math.max(PROP_MIN_SIZE, Math.min(PROP_MAX_SIZE, signX * dx * 2));
          const newD = Math.max(PROP_MIN_SIZE, Math.min(PROP_MAX_SIZE, signZ * dz * 2));
          p.w = newW;
          p.d = newD;
        } else {
          // round shapes stay a uniform radius -- the diagonal distance
          // from center to the pointer, regardless of which corner it is.
          const newDiam = Math.max(PROP_MIN_SIZE, Math.min(PROP_MAX_SIZE, Math.hypot(dx, dz) * 2));
          p.w = newDiam;
          p.d = newDiam;
        }
        rebuild();
      } else if (dragState.type === "resize-prop-height") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const p = (state.props || []).find((pp) => pp.id === dragState.id);
        if (!p) { dragState = null; return; }
        const deltaY = pt.y - dragState.startY;
        p.h = Math.max(PROP_MIN_SIZE, Math.min(PROP_MAX_SIZE, dragState.startH + deltaY));
        rebuild();
      } else if (dragState.type === "room-move") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const dx = pt.x - dragState.start.x;
        const dz = pt.z - dragState.start.z;
        const entry = floors.find((f) => f.id === activeFloorId);
        if (entry) {
          entry.offsetX = snapValue(dragState.startOffsetX + dx);
          entry.offsetZ = snapValue(dragState.startOffsetZ + dz);
          restackFloors();
        }
      } else if (dragState.type === "room-drag") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const dx = pt.x - dragState.start.x;
        const dz = pt.z - dragState.start.z;
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === dragState.roomId);
        if (room) {
          let ox = dragState.startOffsetX + dx;
          let oz = dragState.startOffsetZ + dz;
          if (snapEnabledRef.current) {
            const snapped = snapRoomOffset(room, ox, oz);
            const justTouched = (snapped.ox !== ox || snapped.oz !== oz) && !dragState.wasSnapped;
            dragState.wasSnapped = snapped.ox !== ox || snapped.oz !== oz;
            if (justTouched) playClickSound();
            ox = snapped.ox; oz = snapped.oz;
          }
          room.offsetX = ox;
          room.offsetZ = oz;
          rebuild();
        }
      } else if (dragState.type === "stair-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        // clamp to the room's actual interior so a drag toward a wall can
        // never record an endpoint beyond it -- previously the plane the
        // drag raycasts against is infinite, so the value kept extending
        // past the wall even though the wall visually hid the preview,
        // and the built staircase would poke out through it.
        const fp = state.footprint;
        const margin = (state.thickness || 0.35) / 2 + 0.02;
        const clampedX = Math.min(fp.xMax - margin, Math.max(fp.xMin + margin, pt.x));
        const clampedZ = Math.min(fp.zMax - margin, Math.max(fp.zMin + margin, pt.z));
        dragState.x1 = snapValue(clampedX);
        dragState.z1 = snapValue(clampedZ);
        // compute the same dominant-axis choice the final commit uses, live,
        // so the preview actually shows stepped, oriented geometry while
        // dragging instead of a flat rectangle -- you can see which axis
        // it's about to commit to before you let go, and adjust if it's
        // not the one you meant.
        const pdx = dragState.x1 - dragState.x0;
        const pdz = dragState.z1 - dragState.z0;
        const pAxis = Math.abs(pdx) >= Math.abs(pdz) ? "x" : "z";
        previewStair = {
          x0: Math.min(dragState.x0, dragState.x1), x1: Math.max(dragState.x0, dragState.x1),
          z0: Math.min(dragState.z0, dragState.z1), z1: Math.max(dragState.z0, dragState.z1),
          axis: pAxis,
          start: pAxis === "x" ? dragState.x0 : dragState.z0,
          end: pAxis === "x" ? dragState.x1 : dragState.z1,
          widthMin: pAxis === "x" ? Math.min(dragState.z0, dragState.z1) : Math.min(dragState.x0, dragState.x1),
          widthMax: pAxis === "x" ? Math.max(dragState.z0, dragState.z1) : Math.max(dragState.x0, dragState.x1),
        };
        rebuild();
      }
    }

    function onPointerUp(e) {
      const wasMulti = activePointers.size >= 2;
      if (e && activePointers.has(e.pointerId)) activePointers.delete(e.pointerId);
      if (wasMulti) {
        if (activePointers.size < 2) pinchState = null;
        return;
      }
      if (dividerDragActive) {
        dividerDragActive = false;
        return;
      }
      if (orbiting) {
        const wasTap = orbiting.moved < 4;
        orbiting = null;
        renderer.domElement.style.cursor = "grab";
        if (wasTap) {
          setSelectedPanel(null);
          setSelectedStairId(null);
        setSelectedPropId(null);
          setSelectedBalconyId(null);
          setSelectedBalconyPart(null);
          setSelectedOpeningId(null);
          switchActiveRoom(null);
        }
        return;
      }
      if (!dragState) return;
      if (dragState.holdTimer) clearTimeout(dragState.holdTimer);

      if (dragState.type === "pending") {
        if (dragState.selIdAtPoint) {
          pushUndo();
          state.selections = state.selections.filter((s) => s.id !== dragState.selIdAtPoint);
        }
        selectPanelForHeight(dragState.panelKey);
      } else if (dragState.type === "pending-cut") {
        selectPanelForHeight(dragState.panelKey);
      } else if (dragState.type === "select-drag") {
        const u0 = Math.min(dragState.u0, dragState.u1);
        const u1 = Math.max(dragState.u0, dragState.u1);
        if (u1 - u0 >= MIN_HIGHLIGHT && !wouldOverlapSelection(dragState.panelKey, u0, u1) && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          state.selections.push({ id: idSeq++, panel: dragState.panelKey, u0, u1 });
        }
        previewSelection = null;
      } else if (dragState.type === "panel-extrude") {
        if (dragState.panelKey.startsWith("bf:")) {
          const id = Number(dragState.panelKey.slice(3));
          const bo = state.bumpouts.find((b) => b.id === id);
          if (bo && Math.abs(bo.depth) < 0.04) state.bumpouts = state.bumpouts.filter((b) => b.id !== id);
        }
      } else if (dragState.type === "partition-draw" || dragState.type === "partition-redrag") {
        const p = state.partitions.find((pp) => pp.id === dragState.id);
        if (p && Math.abs(p.ext) < 0.04) state.partitions = state.partitions.filter((pp) => pp.id !== p.id);
      } else if (dragState.type === "opening-draw") {
        const u0 = Math.min(dragState.u0, dragState.u1);
        const u1 = Math.max(dragState.u0, dragState.u1);
        if (u1 - u0 >= MIN_OPENING && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          // a new opening that overlaps existing ones on the same panel
          // replaces them, rather than being blocked -- drawing a wider
          // window over a narrower one simply supersedes it.
          state.openings = state.openings.filter((o) => !(o.panel === dragState.panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          state.openings.push({
            id: idSeq++, panel: dragState.panelKey, u0, u1, height: openingHeightRef.current, dividers: openingDividersRef.current,
            dividerAxis: openingAxisVerticalRef.current && openingAxisHorizontalRef.current ? "both" : openingAxisHorizontalRef.current ? "horizontal" : "vertical",
          });
        }
        previewOpening = null;
      } else if (dragState.type === "balcony-draw") {
        const u0 = Math.min(dragState.u0, dragState.u1);
        const u1 = Math.max(dragState.u0, dragState.u1);
        const MIN_BALCONY = 6 * FT; // needs room for the center door plus a sliver of window on each side
        if (u1 - u0 >= MIN_BALCONY && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          state.openings = state.openings.filter((o) => !(o.panel === dragState.panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          const bid = idSeq++;
          const dividerAxis = openingAxisVerticalRef.current && openingAxisHorizontalRef.current ? "both" : openingAxisHorizontalRef.current ? "horizontal" : "vertical";
          const platformHeight = 3 * FT;
          const bal = { id: bid, panel: dragState.panelKey, u0, u1, dividerAxis, side: dragState.side || 1, platformHeight };
          if (!state.balconies) state.balconies = [];
          state.balconies.push(bal);
          regenerateBalconyOpenings(bal);
          // deliberately not auto-selected -- the magenta selection
          // highlight right after drawing one is more distracting than
          // useful; tap it afterward if you want to edit it.
          setBalconyStairHeight(platformHeight);
        }
        previewOpening = null;
      } else if (dragState.type === "stair-draw") {
        const dx = dragState.x1 - dragState.x0;
        const dz = dragState.z1 - dragState.z0;
        if (Math.abs(dx) >= MIN_STAIR_SIZE && Math.abs(dz) >= MIN_STAIR_SIZE) {
          const id = idSeq++;
          if (!state.stairs) state.stairs = [];
          // the ascending axis follows whichever direction was dragged
          // farther (so stairs drawn along the room's length climb along
          // its length, drawn across the width climb across it); the click
          // point is zero height, the release point is full room height.
          const stair = Math.abs(dx) >= Math.abs(dz)
            ? { id, axis: "x", start: dragState.x0, end: dragState.x1, widthMin: Math.min(dragState.z0, dragState.z1), widthMax: Math.max(dragState.z0, dragState.z1), steps: defaultStairSteps(state.height) }
            : { id, axis: "z", start: dragState.z0, end: dragState.z1, widthMin: Math.min(dragState.x0, dragState.x1), widthMax: Math.max(dragState.x0, dragState.x1), steps: defaultStairSteps(state.height) };
          state.stairs.push(stair);
          setSelectedStairId(id);
          setStairSteps(stair.steps);
          // if a layer already sits above this one, retroactively cut its
          // headroom opening now too -- not just when a new layer is
          // created after the fact. Only handled for stairs on the floor
          // itself (not inside an extracted room), since a room's offset
          // would need to be folded into the hole's world position. Uses
          // buildingFloorEntry rather than activeFloorId, since the stair
          // may have just been drawn on a different (non-active) floor.
          if (buildingRoomId == null && buildingFloorEntry) {
            const idx = floors.findIndex((f) => f.id === buildingFloorEntry.id);
            const aboveEntry = idx !== -1 ? floors[idx + 1] : null;
            if (aboveEntry) {
              if (!aboveEntry.data.floorHoles) aboveEntry.data.floorHoles = [];
              const cut = computeStairHoleCut(stair);
              aboveEntry.data.floorHoles.push({ id: idSeq++, xMin: cut.x0, xMax: cut.x1, zMin: cut.z0, zMax: cut.z1, sourceStairId: id });
              rebuildFloorEntry(aboveEntry, false);
            }
          }
        }
        previewStair = null;
      }

      dragState = null;
      renderer.domElement.style.cursor = "grab";
      rebuild();
      restoreCrossFloorContext();
    }

    function onWheel(e) {
      e.preventDefault();
      if (viewLayoutRef.current === "quad") {
        const ctx = updateInteractionContext(e.clientX, e.clientY);
        if (ctx === "divider") return;
        const st = quadPaneState[currentGesturePaneDir];
        if (st) st.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, st.radius + e.deltaY * 0.01));
        return;
      }
      radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius + e.deltaY * 0.01));
      updateCamera();
    }

    const el = renderer.domElement;
    el.addEventListener("pointerdown", onPointerDown, { passive: false });
    el.addEventListener("pointermove", onPointerMove, { passive: false });
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    // belt-and-suspenders: some mobile browsers still try to interpret a
    // second touch as a native gesture (page pinch-zoom, swipe-back) even
    // with touch-action: none on the canvas: block it explicitly too.
    el.addEventListener("touchstart", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    el.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    el.addEventListener("gesturestart", (e) => e.preventDefault());
    el.addEventListener("gesturechange", (e) => e.preventDefault());

    function onKeyDown(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        if (e.shiftKey) performRedo(); else performUndo();
      } else if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        performRedo();
      }
    }
    window.addEventListener("keydown", onKeyDown);

    function onResize() {
      width = mount.clientWidth || 1;
      height = mount.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      applyViewShift(camera, width, height);
      renderer.setSize(width, height);
      composer.setSize(width, height);
      updateCamera();
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    function resetAll() {
      pushUndo();
      state.footprint = { xMin: -DEFAULT_ROOM_HALF_X, xMax: DEFAULT_ROOM_HALF_X, zMin: -DEFAULT_ROOM_HALF_Z, zMax: DEFAULT_ROOM_HALF_Z };
      state.selections = [];
      state.bumpouts = [];
      state.partitions = [];
      state.openings = [];
      state.panelHeights = {};
      state.height = WALL_HEIGHT;
      restackFloors();
      previewSelection = null;
      previewOpening = null;
      dragState = null;
      dragCrossFloorRestore = null;
      rebuild();
      syncFloorsToReact();
    }
    resetFnRef.current = resetAll;
    rebuildModelRef.current = rebuild;

    function resetEverything() {
      pushUndo();
      Array.from(roomGroups.values()).forEach((rg) => { clearGroup(rg); if (rg.parent) rg.parent.remove(rg); });
      roomGroups.clear();
      Array.from(roomContainers.values()).forEach((rc) => { clearGroup(rc); scene.remove(rc); });
      roomContainers.clear();
      Array.from(floorGroups.keys()).forEach((id) => {
        const g = floorGroups.get(id);
        if (g) { clearGroup(g); scene.remove(g); }
      });
      floorGroups.clear();
      const newFloorId = nextFloorId++;
      floors = [{ id: newFloorId, data: makeFloorData(), rooms: [] }];
      activeFloorId = newFloorId;
      activeRoomId = null;
      isolatedFloorIds.clear();
      setIsolatedFloorIdsState([]);
      hiddenFloorIds.clear();
      roomClipboard = null;
      roomPasteCount = 0;
      setHasRoomClipboard(false);
      const g = new THREE.Group();
      scene.add(g);
      floorGroups.set(newFloorId, g);
      restackFloors();
      state = floors[0].data;
      dragState = null;
      dragCrossFloorRestore = null;
      orbiting = null;
      pinchState = null;
      setSelectedPanel(null);
      setSelectedRoomId(null);
      setHiddenIds([]);
      target.set(0, state.height * 0.32, 0);
      updateCamera();
      // every old floor's meshes were just torn down above (clearGroup()
      // doesn't touch pickList) and rebuild() only refreshes the one new
      // floor -- so this is the one place a full wipe is actually correct,
      // rather than the surgical per-floor filtering rebuild() now does.
      pickList = [];
      rebuild();
      syncFloorsToReact();
    }
    resetEverythingRef.current = resetEverything;

    rebuild();

    function syncFloorsToReact() {
      setFloorIds(floors.map((f) => f.id));
      setActiveFloorIdState(activeFloorId);
      const entry = floors.find((f) => f.id === activeFloorId);
      if (entry) {
        setFloorHeight(entry.data.height);
        setWallThickness(entry.data.thickness);
        setCeilingOn(!!entry.data.ceilingEnabled);
      }
    }

    function refreshThumbnail(floorId) {
      const canvas = thumbCanvasMapRef.current.get(floorId);
      if (!canvas) return;
      const entry = floors.find((f) => f.id === floorId);
      if (!entry) return;
      const savedState = state;
      state = entry.data;
      const lines = [];
      const addLines = (pk) => {
        const info = getPanelInfo(pk);
        if (!info) return;
        // draw the wall as solid line(s), but leave a gap wherever a
        // bump-out opens through it into another connected space --
        // otherwise the plan shows a wall where there is really an L-shaped
        // opening. Window/door openings don't affect the plan silhouette,
        // so those still draw as a continuous wall.
        const cuts = bumpoutsFor(pk)
          .map((b) => ({
            u0: Math.max(info.u0, Math.min(b.u0, info.u1)),
            u1: Math.max(info.u0, Math.min(b.u1, info.u1)),
            depth: b.depth,
          }))
          .filter((c) => Math.abs(c.depth) > 0.02 && c.u1 - c.u0 > 0.05)
          .sort((a, b) => a.u0 - b.u0);
        let cursor = info.u0;
        const segs = [];
        cuts.forEach((c) => {
          if (c.u0 > cursor + 0.001) segs.push([cursor, c.u0]);
          cursor = c.u1;
        });
        if (cursor < info.u1 - 0.001) segs.push([cursor, info.u1]);
        segs.forEach(([a, b]) => {
          if (info.lengthAxis === "x") lines.push([a, info.coord, b, info.coord]);
          else lines.push([info.coord, a, info.coord, b]);
        });
      };
      const keys = ["north", "south", "east", "west"];
      state.bumpouts.forEach((b) => {
        if (Math.abs(b.depth) <= 0.02) return;
        keys.push("bf:" + b.id);
        const touch = bumpoutCornerTouch(b);
        if (!touch.min) keys.push("bs0:" + b.id);
        if (!touch.max) keys.push("bs1:" + b.id);
      });
      keys.forEach(addLines);
      state.partitions.forEach((p) => addLines("pt:" + p.id));
      const fp = state.footprint;
      state = savedState;

      // rooms pulled out of this floor draw as their own little box, offset
      // to wherever they've been dragged, so the thumbnail actually reflects
      // a detached room instead of looking like nothing changed. If the room
      // has curved corners on, approximate the same rounded corners here too
      // (matching renderCurvedCorners' 5-segment arc) so the plan view isn't
      // misleadingly square. This doesn't account for bump-out-adjacent
      // corners being left sharp the way the real 3D geometry does -- a
      // minor mismatch, acceptable for a low-detail preview.
      (entry.rooms || []).forEach((room) => {
        const rf = room.data.footprint;
        const ox = room.offsetX || 0, oz = room.offsetZ || 0;
        const cc = room.data.curvedCorners;
        const R = cc && cc.enabled ? Math.min(cc.radius, (rf.xMax - rf.xMin) / 2 - 0.15, (rf.zMax - rf.zMin) / 2 - 0.15) : 0;
        if (R > 0.05) {
          const segs = 5;
          lines.push([rf.xMin + R + ox, rf.zMin + oz, rf.xMax - R + ox, rf.zMin + oz]);
          lines.push([rf.xMax + ox, rf.zMin + R + oz, rf.xMax + ox, rf.zMax - R + oz]);
          lines.push([rf.xMax - R + ox, rf.zMax + oz, rf.xMin + R + ox, rf.zMax + oz]);
          lines.push([rf.xMin + ox, rf.zMax - R + oz, rf.xMin + ox, rf.zMin + R + oz]);
          const corners = [
            { cx: rf.xMin + R, cz: rf.zMin + R, a0: 180, a1: 270 },
            { cx: rf.xMax - R, cz: rf.zMin + R, a0: 270, a1: 360 },
            { cx: rf.xMax - R, cz: rf.zMax - R, a0: 0, a1: 90 },
            { cx: rf.xMin + R, cz: rf.zMax - R, a0: 90, a1: 180 },
          ];
          corners.forEach((c) => {
            for (let i = 0; i < segs; i++) {
              const ang0 = (c.a0 + (c.a1 - c.a0) * (i / segs)) * Math.PI / 180;
              const ang1 = (c.a0 + (c.a1 - c.a0) * ((i + 1) / segs)) * Math.PI / 180;
              const x0 = c.cx + R * Math.cos(ang0), z0 = c.cz + R * Math.sin(ang0);
              const x1 = c.cx + R * Math.cos(ang1), z1 = c.cz + R * Math.sin(ang1);
              lines.push([x0 + ox, z0 + oz, x1 + ox, z1 + oz]);
            }
          });
          return;
        }
        lines.push([rf.xMin + ox, rf.zMin + oz, rf.xMax + ox, rf.zMin + oz]);
        lines.push([rf.xMax + ox, rf.zMin + oz, rf.xMax + ox, rf.zMax + oz]);
        lines.push([rf.xMax + ox, rf.zMax + oz, rf.xMin + ox, rf.zMax + oz]);
        lines.push([rf.xMin + ox, rf.zMax + oz, rf.xMin + ox, rf.zMin + oz]);
      });

      const ctx = canvas.getContext("2d");
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#B9B7B0";
      ctx.fillRect(0, 0, W, H);
      let minX = fp.xMin, maxX = fp.xMax, minZ = fp.zMin, maxZ = fp.zMax;
      lines.forEach(([x0, z0, x1, z1]) => {
        minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
        minZ = Math.min(minZ, z0, z1); maxZ = Math.max(maxZ, z0, z1);
      });
      const pad = W * 0.09;
      const spanX = Math.max(0.5, maxX - minX), spanZ = Math.max(0.5, maxZ - minZ);
      const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanZ);
      const ox = W / 2 - ((minX + maxX) / 2) * scale;
      const oz = H / 2 - ((minZ + maxZ) / 2) * scale;
      ctx.strokeStyle = "#2E2D28";
      ctx.lineWidth = Math.max(1.5, W * 0.014);
      lines.forEach(([x0, z0, x1, z1]) => {
        ctx.beginPath();
        ctx.moveTo(ox + x0 * scale, oz + z0 * scale);
        ctx.lineTo(ox + x1 * scale, oz + z1 * scale);
        ctx.stroke();
      });
    }
    refreshThumbnailApiRef.current = refreshThumbnail;

    // moves wall-editing focus onto a room (or back to the floor itself when
    // id is null) -- everything else (tap a wall, cut an opening, add a
    // partition) already works once `state` points at the right data object.
    function switchActiveRoom(id) {
      if (activeRoomId === id) return;
      activeRoomId = id;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      if (id == null) {
        state = floorEntry ? floorEntry.data : makeFloorData();
      } else {
        const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
        state = room ? room.data : makeFloorData();
        if (room) {
          setRoomHeight(room.data.height);
          const cc = room.data.curvedCorners || { enabled: false, radius: 0 };
          setCurvedCornersOn(cc.enabled);
          setCurvedCornersRadius(cc.radius || 0.6);
        }
      }
      setSelectedPanel(null);
      setSelectedRoomId(id);
      setSelectedStairId(null);
        setSelectedPropId(null);
      setSelectedBalconyId(null);
      setSelectedBalconyPart(null);
      setSelectedOpeningId(null);
      rebuild();
    }
    switchActiveRoomRef.current = switchActiveRoom;

    function setActiveRoomHeight(h) {
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === activeRoomId);
      if (!room) return;
      room.data.height = Math.max(MIN_WALL_HEIGHT, Math.min(MAX_WALL_HEIGHT, h));
      rebuild();
    }
    roomHeightApiRef.current = { setHeight: setActiveRoomHeight };

    function setActiveRoomCurvedCorners(enabled, radius) {
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === activeRoomId);
      if (!room) return;
      if (!room.data.curvedCorners) room.data.curvedCorners = { enabled: false, radius: 0 };
      room.data.curvedCorners.enabled = enabled;
      room.data.curvedCorners.radius = radius;
      rebuild();
    }
    curvedCornersApiRef.current = {
      setEnabled: (v) => setActiveRoomCurvedCorners(v, curvedCornersRadiusRef.current),
      setRadius: (v) => setActiveRoomCurvedCorners(curvedCornersOnRef.current, v),
    };

    function setActiveBalconyHeight(h) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.platformHeight = Math.max(1 * FT, Math.min(state.height - 1.5 * FT, h));
      rebuild();
    }
    balconyHeightApiRef.current = { setHeight: setActiveBalconyHeight };

    function setActiveBalconyPlatformWidth(w) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.platformWidth = Math.max(3 * FT, Math.min(60 * FT, w));
      rebuild();
    }
    balconyWidthApiRef.current = { setWidth: setActiveBalconyPlatformWidth };

    function setActiveBalconyPillarCount(n) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.pillarCount = Math.max(2, Math.min(60, Math.round(n)));
      rebuild();
    }
    balconyPillarCountApiRef.current = { setCount: setActiveBalconyPillarCount };

    // the slider's max is generous on purpose -- rendering clamps the
    // *actual* pillar top to never exceed the ceiling, so sliding past
    // "fully connected" just has no further visible effect, while sliding
    // below it opens the gap that disconnects the pillars from the roof.
    function setActiveBalconyPillarHeight(h) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.pillarHeight = Math.max(0.3, h);
      rebuild();
    }
    balconyPillarHeightApiRef.current = { setHeight: setActiveBalconyPillarHeight };

    function setActiveBalconyGlassInfill(on) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.glassInfill = on;
      rebuild();
    }
    balconyGlassApiRef.current = { setEnabled: setActiveBalconyGlassInfill };

    function deleteActiveBalcony() {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const part = selectedBalconyPartRef.current;
      const bal = (state.balconies || []).find((b) => b.id === id);
      pushUndo();
      if (part === "pillars" && bal) {
        bal.pillarsRemoved = true;
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
      } else if (part === "ceiling" && bal) {
        bal.ceilingRemoved = true;
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
      } else {
        // steps or platform selected (or no specific part) -- removes the
        // whole assembly, including its window/door cutout in the wall.
        state.balconies = (state.balconies || []).filter((b) => b.id !== id);
        state.openings = (state.openings || []).filter((o) => o.fromBalcony !== id);
        setSelectedBalconyId(null);
        setSelectedBalconyPart(null);
      }
      rebuild();
    }
    deleteBalconyRef.current = deleteActiveBalcony;

    function deleteActiveOpening() {
      const id = selectedOpeningIdRef.current;
      if (id == null) return;
      pushUndo();
      state.openings = (state.openings || []).filter((o) => o.id !== id);
      setSelectedOpeningId(null);
      rebuild();
    }
    deleteOpeningRef.current = deleteActiveOpening;

    function deleteActiveProp() {
      const id = selectedPropIdRef.current;
      if (id == null) return;
      pushUndo();
      state.props = (state.props || []).filter((p) => p.id !== id);
      setSelectedPropId(null);
      rebuild();
    }
    deletePropRef.current = deleteActiveProp;

    // live-edits whichever opening is currently selected, so the height/
    // dividers/direction controls act on that specific window (or door)
    // instead of only ever setting the default for the next one drawn.
    function setActiveOpeningHeight(h) {
      const id = selectedOpeningIdRef.current;
      if (id == null) return;
      const o = (state.openings || []).find((oo) => oo.id === id);
      if (!o) return;
      o.height = Math.max(0, h);
      rebuild();
    }
    function setActiveOpeningDividers(n) {
      const id = selectedOpeningIdRef.current;
      if (id == null) return;
      const o = (state.openings || []).find((oo) => oo.id === id);
      if (!o || o.isDoor) return;
      o.dividers = Math.max(0, n);
      rebuild();
    }
    function setActiveOpeningAxis(vertical, horizontal) {
      const id = selectedOpeningIdRef.current;
      if (id == null) return;
      const o = (state.openings || []).find((oo) => oo.id === id);
      if (!o || o.isDoor) return;
      o.dividerAxis = vertical && horizontal ? "both" : horizontal ? "horizontal" : "vertical";
      rebuild();
    }
    openingEditApiRef.current = { setHeight: setActiveOpeningHeight, setDividers: setActiveOpeningDividers, setAxis: setActiveOpeningAxis };

    // ---------- voice command actions ----------
    // A small, deliberately isolated set of actions a voice command can
    // drive, each just calling straight into the same state + rebuild()
    // convention every other tool in the app already uses -- nothing
    // separate or parallel. This is a starting slice (room size, a
    // straight partition, windows on a wall), not full tool coverage;
    // more actions can be added here the same way as the voice feature grows.
    function voiceSetRoomSize(widthFt, depthFt) {
      pushUndo();
      const hw = Math.max(3, widthFt) * FT / 2;
      const hd = Math.max(3, depthFt) * FT / 2;
      state.footprint = { xMin: -hw, xMax: hw, zMin: -hd, zMax: hd };
      rebuild();
    }
    function voiceAddPartition(wall, positionFraction) {
      const info = getPanelInfo(wall);
      if (!info) return;
      pushUndo();
      const frac = Math.max(0.05, Math.min(0.95, positionFraction));
      const u = info.u0 + (info.u1 - info.u0) * frac;
      const id = idSeq++;
      state.partitions.push({ id, panel: wall, u, ext: 0 });
      rebuild();
    }
    function voiceAddWindowsToWall(wall, count) {
      const info = getPanelInfo(wall);
      if (!info) return;
      pushUndo();
      const n = Math.max(1, Math.min(8, Math.round(count)));
      const span = info.u1 - info.u0;
      const segW = span / n;
      const winW = Math.min(segW * 0.6, 1.5);
      for (let i = 0; i < n; i++) {
        const center = info.u0 + segW * (i + 0.5);
        const u0 = center - winW / 2, u1 = center + winW / 2;
        if (wouldOverlapBumpout(wall, u0, u1)) continue;
        state.openings = state.openings.filter((o) => !(o.panel === wall && rangesOverlap(u0, u1, o.u0, o.u1)));
        state.openings.push({ id: idSeq++, panel: wall, u0, u1, height: DEFAULT_OPENING_HEIGHT, dividers: 1, dividerAxis: "vertical" });
      }
      rebuild();
    }
    function voiceAddWindowsAllWalls(countPerWall) {
      pushUndo();
      ["north", "south", "east", "west"].forEach((w) => voiceAddWindowsToWall(w, countPerWall));
    }
    voiceActionsRef.current = {
      set_room_size: (a) => voiceSetRoomSize(a.width_ft, a.depth_ft),
      add_partition: (a) => voiceAddPartition(a.wall, a.position_fraction ?? 0.5),
      add_windows_to_wall: (a) => voiceAddWindowsToWall(a.wall, a.count ?? 2),
      add_windows_all_walls: (a) => voiceAddWindowsAllWalls(a.count_per_wall ?? 2),
    };
    voiceRoomContextRef.current = () => {
      const fp = state.footprint;
      const wFt = ((fp.xMax - fp.xMin) / FT).toFixed(1);
      const dFt = ((fp.zMax - fp.zMin) / FT).toFixed(1);
      return `Current room footprint: ${wFt} ft (east-west, walls "east"/"west" run along this) by ${dFt} ft (north-south, walls "north"/"south" run along this). Existing partitions: ${state.partitions.length}. Existing openings: ${state.openings.length}.`;
    };

    function selectFloorById(id) {
      const entry = floors.find((f) => f.id === id);
      if (!entry) return;
      const prevActiveId = activeFloorId;
      activeFloorId = id;
      activeRoomId = null;
      state = entry.data;
      dragState = null;
      dragCrossFloorRestore = null;
      orbiting = null;
      pinchState = null;
      setSelectedPanel(null);
      setSelectedRoomId(null);
      setSelectedStairId(null);
        setSelectedPropId(null);
      rebuild();
      if (prevActiveId !== id) {
        const prevEntry = floors.find((f) => f.id === prevActiveId);
        if (prevEntry) rebuildFloorEntry(prevEntry, false);
      }
      ensureActiveContentInFrame();
      syncFloorsToReact();
    }
    selectFloorRef.current = selectFloorById;

    function duplicateActiveFloor() {
      pushUndo();
      const idx = floors.findIndex((f) => f.id === activeFloorId);
      if (idx === -1) return;
      const src = floors[idx];
      const clone = JSON.parse(JSON.stringify(src.data));
      // each extracted room needs its own new id (ids must stay unique for
      // picking/selection to work) -- this was previously omitted entirely,
      // so a duplicated layer silently lost all of its rooms.
      const clonedRooms = (src.rooms || []).map((r) => ({
        id: idSeq++,
        data: JSON.parse(JSON.stringify(r.data)),
        offsetX: r.offsetX || 0,
        offsetZ: r.offsetZ || 0,
      }));
      const newId = nextFloorId++;
      const entry = { id: newId, data: clone, rooms: clonedRooms, offsetX: src.offsetX || 0, offsetZ: src.offsetZ || 0 };
      floors.splice(idx + 1, 0, entry);
      const g = new THREE.Group();
      scene.add(g);
      floorGroups.set(newId, g);
      restackFloors();
      if (isolatedFloorIds.size) { isolatedFloorIds.clear(); setIsolatedFloorIdsState([]); }
      selectFloorById(newId);
      applyVisibility();
    }
    duplicateFloorRef.current = duplicateActiveFloor;

    function deleteActiveFloor() {
      if (floors.length <= 1) return;
      pushUndo();
      const idx = floors.findIndex((f) => f.id === activeFloorId);
      if (idx === -1) return;
      const [removed] = floors.splice(idx, 1);
      const g = floorGroups.get(removed.id);
      if (g) { clearGroup(g); scene.remove(g); }
      floorGroups.delete(removed.id);
      // clearGroup() disposes the removed floor's meshes but doesn't touch
      // pickList -- drop its (and its rooms') entries so raycasting never
      // hits an orphaned, disposed mesh.
      pickList = pickList.filter((o) => o.userData.ownerFloorId !== removed.id);
      (removed.rooms || []).forEach((room) => {
        const rg = roomGroups.get(room.id);
        if (rg) { clearGroup(rg); if (rg.parent) rg.parent.remove(rg); }
        roomGroups.delete(room.id);
      });
      const rc = roomContainers.get(removed.id);
      if (rc) { clearGroup(rc); scene.remove(rc); }
      roomContainers.delete(removed.id);
      hiddenFloorIds.delete(removed.id);
      if (isolatedFloorIds.delete(removed.id)) setIsolatedFloorIdsState(Array.from(isolatedFloorIds));
      restackFloors();
      const newIdx = Math.min(idx, floors.length - 1);
      selectFloorById(floors[newIdx].id);
      applyVisibility();
      setHiddenIds(Array.from(hiddenFloorIds));
    }
    deleteFloorRef.current = deleteActiveFloor;

    function applyVisibility() {
      floorGroups.forEach((g, fid) => {
        g.visible = isolatedFloorIds.size > 0 ? isolatedFloorIds.has(fid) : !hiddenFloorIds.has(fid);
      });
    }

    function addNewFloor() {
      pushUndo();
      const idx = floors.findIndex((f) => f.id === activeFloorId);
      const newId = nextFloorId++;
      const newData = makeFloorData();
      // if the floor directly below has any staircases, automatically cut a
      // matching headroom opening in this new floor above them
      const belowEntry = idx !== -1 ? floors[idx] : null;
      if (belowEntry && belowEntry.data.stairs && belowEntry.data.stairs.length) {
        newData.floorHoles = belowEntry.data.stairs.map((st) => {
          const cut = computeStairHoleCut(st);
          return { id: idSeq++, xMin: cut.x0, xMax: cut.x1, zMin: cut.z0, zMax: cut.z1, sourceStairId: st.id };
        });
      }
      const entry = { id: newId, data: newData };
      if (idx === -1) floors.push(entry); else floors.splice(idx + 1, 0, entry);
      const g = new THREE.Group();
      scene.add(g);
      floorGroups.set(newId, g);
      restackFloors();
      if (isolatedFloorIds.size) { isolatedFloorIds.clear(); setIsolatedFloorIdsState([]); }
      selectFloorById(newId);
      applyVisibility();
    }
    addFloorRef.current = addNewFloor;

    function toggleHideFloor(id) {
      if (hiddenFloorIds.has(id)) hiddenFloorIds.delete(id); else hiddenFloorIds.add(id);
      applyVisibility();
      setHiddenIds(Array.from(hiddenFloorIds));
    }
    toggleHideRef.current = toggleHideFloor;

    function frameFloorEntry(entry) {
      const g = floorGroups.get(entry.id);
      if (!entry || !g) return;
      const fp = entry.data.footprint;
      let minX = fp.xMin, maxX = fp.xMax, minZ = fp.zMin, maxZ = fp.zMax;
      (entry.rooms || []).forEach((r) => {
        const ox = r.offsetX || 0, oz = r.offsetZ || 0;
        const rfp = r.data.footprint;
        minX = Math.min(minX, rfp.xMin + ox); maxX = Math.max(maxX, rfp.xMax + ox);
        minZ = Math.min(minZ, rfp.zMin + oz); maxZ = Math.max(maxZ, rfp.zMax + oz);
      });
      target.x = (minX + maxX) / 2;
      target.z = (minZ + maxZ) / 2;
      target.y = g.position.y + entry.data.height * 0.32;
      radius = Math.max(4, Math.max(maxX - minX, maxZ - minZ) * 1.3);
    }

    function frameAllContent() {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
      floors.forEach((f) => {
        const g = floorGroups.get(f.id);
        if (!g) return;
        const fp = f.data.footprint;
        minX = Math.min(minX, fp.xMin); maxX = Math.max(maxX, fp.xMax);
        minZ = Math.min(minZ, fp.zMin); maxZ = Math.max(maxZ, fp.zMax);
        minY = Math.min(minY, g.position.y); maxY = Math.max(maxY, g.position.y + f.data.height);
        (f.rooms || []).forEach((r) => {
          const ox = r.offsetX || 0, oz = r.offsetZ || 0;
          const rfp = r.data.footprint;
          minX = Math.min(minX, rfp.xMin + ox); maxX = Math.max(maxX, rfp.xMax + ox);
          minZ = Math.min(minZ, rfp.zMin + oz); maxZ = Math.max(maxZ, rfp.zMax + oz);
        });
      });
      if (minX === Infinity) { minX = -3; maxX = 3; minZ = -3; maxZ = 3; minY = 0; maxY = state.height; }
      target.x = (minX + maxX) / 2;
      target.z = (minZ + maxZ) / 2;
      target.y = (minY + maxY) / 2;
      radius = Math.max(9.5, Math.max(maxX - minX, maxZ - minZ, maxY - minY) * 1.4);
    }

    // frames the union of several floors at once (same bounds logic as
    // frameAllContent, just restricted to a subset) -- used when more than
    // one layer is isolated together.
    function frameFloorEntries(entries) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
      entries.forEach((f) => {
        const g = floorGroups.get(f.id);
        if (!g) return;
        const fp = f.data.footprint;
        minX = Math.min(minX, fp.xMin); maxX = Math.max(maxX, fp.xMax);
        minZ = Math.min(minZ, fp.zMin); maxZ = Math.max(maxZ, fp.zMax);
        minY = Math.min(minY, g.position.y); maxY = Math.max(maxY, g.position.y + f.data.height);
        (f.rooms || []).forEach((r) => {
          const ox = r.offsetX || 0, oz = r.offsetZ || 0;
          const rfp = r.data.footprint;
          minX = Math.min(minX, rfp.xMin + ox); maxX = Math.max(maxX, rfp.xMax + ox);
          minZ = Math.min(minZ, rfp.zMin + oz); maxZ = Math.max(maxZ, rfp.zMax + oz);
        });
      });
      if (minX === Infinity) return;
      target.x = (minX + maxX) / 2;
      target.z = (minZ + maxZ) / 2;
      target.y = (minY + maxY) / 2;
      radius = Math.max(4, Math.max(maxX - minX, maxZ - minZ, maxY - minY) * 1.3);
    }

    // multiple layers can be isolated together -- toggling one adds/removes
    // it from the set rather than replacing whatever was isolated before.
    function toggleIsolateFloor(id) {
      if (isolatedFloorIds.has(id)) isolatedFloorIds.delete(id);
      else isolatedFloorIds.add(id);
      applyVisibility();
      if (isolatedFloorIds.size > 0) {
        const entries = floors.filter((f) => isolatedFloorIds.has(f.id));
        frameFloorEntries(entries);
      } else {
        frameAllContent();
      }
      updateCamera();
      setIsolatedFloorIdsState(Array.from(isolatedFloorIds));
    }
    toggleIsolateRef.current = toggleIsolateFloor;

    let clipboard = null;
    function copyActiveFloor() {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      clipboard = JSON.parse(JSON.stringify({
        data: entry.data,
        rooms: entry.rooms || [],
        offsetX: entry.offsetX || 0,
        offsetZ: entry.offsetZ || 0,
      }));
      setHasClipboard(true);
    }
    copyFloorRef.current = copyActiveFloor;

    function cutActiveFloor() {
      copyActiveFloor();
      deleteActiveFloor();
    }
    cutFloorRef.current = cutActiveFloor;

    function pasteFloor() {
      if (!clipboard) return;
      pushUndo();
      const idx = floors.findIndex((f) => f.id === activeFloorId);
      const newId = nextFloorId++;
      const clonedRooms = (clipboard.rooms || []).map((r) => ({
        id: idSeq++,
        data: JSON.parse(JSON.stringify(r.data)),
        offsetX: r.offsetX || 0,
        offsetZ: r.offsetZ || 0,
      }));
      const entry = {
        id: newId,
        data: JSON.parse(JSON.stringify(clipboard.data)),
        rooms: clonedRooms,
        offsetX: clipboard.offsetX,
        offsetZ: clipboard.offsetZ,
      };
      if (idx === -1) floors.push(entry); else floors.splice(idx + 1, 0, entry);
      const g = new THREE.Group();
      scene.add(g);
      floorGroups.set(newId, g);
      restackFloors();
      if (isolatedFloorIds.size) { isolatedFloorIds.clear(); setIsolatedFloorIdsState([]); }
      selectFloorById(newId);
      applyVisibility();
    }
    pasteFloorRef.current = pasteFloor;

    // Cut removes the room from this floor and stashes it in the clipboard --
    // useful for moving a room to a different floor/layer entirely (dragging
    // only repositions within the same floor). Copy stashes a copy but
    // leaves the original in place. Paste adds the clipboard room to the
    // active floor; pasting repeatedly places copies side by side.
    let roomClipboard = null;
    let roomPasteCount = 0;

    function cutSelectedRoom() {
      const id = selectedRoomIdRef.current;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
      if (!floorEntry || !room) return;
      pushUndo();
      roomClipboard = JSON.parse(JSON.stringify({ data: room.data, offsetX: room.offsetX || 0, offsetZ: room.offsetZ || 0 }));
      roomPasteCount = 0;
      setHasRoomClipboard(true);
      const idx = floorEntry.rooms.findIndex((r) => r.id === id);
      floorEntry.rooms.splice(idx, 1);
      const rg = roomGroups.get(id);
      if (rg) { clearGroup(rg); rg.parent && rg.parent.remove(rg); roomGroups.delete(id); }
      switchActiveRoom(null);
    }
    cutRoomRef.current = cutSelectedRoom;

    function copySelectedRoom() {
      const id = selectedRoomIdRef.current;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
      if (!room) return;
      roomClipboard = JSON.parse(JSON.stringify({ data: room.data, offsetX: room.offsetX || 0, offsetZ: room.offsetZ || 0 }));
      roomPasteCount = 0;
      setHasRoomClipboard(true);
    }
    copyRoomRef.current = copySelectedRoom;

    function pasteRoom() {
      if (!roomClipboard) return;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      if (!floorEntry) return;
      pushUndo();
      const id = idSeq++;
      roomPasteCount++;
      const width = roomClipboard.data.footprint.xMax - roomClipboard.data.footprint.xMin;
      const room = {
        id,
        data: JSON.parse(JSON.stringify(roomClipboard.data)),
        offsetX: (roomClipboard.offsetX || 0) + (width + 0.5) * roomPasteCount,
        offsetZ: roomClipboard.offsetZ || 0,
      };
      if (!floorEntry.rooms) floorEntry.rooms = [];
      floorEntry.rooms.push(room);
      switchActiveRoom(id);
      ensureActiveContentInFrame();
    }
    pasteRoomRef.current = pasteRoom;

    function duplicateSelectedRoom() {
      const id = selectedRoomIdRef.current;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
      if (!floorEntry || !room) return;
      pushUndo();
      const newId = idSeq++;
      const width = room.data.footprint.xMax - room.data.footprint.xMin;
      const newRoom = {
        id: newId,
        data: JSON.parse(JSON.stringify(room.data)),
        offsetX: (room.offsetX || 0) + width + 0.5,
        offsetZ: room.offsetZ || 0,
      };
      floorEntry.rooms.push(newRoom);
      switchActiveRoom(newId);
      ensureActiveContentInFrame();
    }
    duplicateRoomRef.current = duplicateSelectedRoom;

    function deleteSelectedRoom() {
      const id = selectedRoomIdRef.current;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
      if (!floorEntry || !room) return;
      pushUndo();
      const idx = floorEntry.rooms.findIndex((r) => r.id === id);
      floorEntry.rooms.splice(idx, 1);
      const rg = roomGroups.get(id);
      if (rg) { clearGroup(rg); rg.parent && rg.parent.remove(rg); roomGroups.delete(id); }
      switchActiveRoom(null);
      rebuild();
    }
    deleteRoomRef.current = deleteSelectedRoom;

    function setActiveStairSteps(n) {
      const st = (state.stairs || []).find((s) => s.id === selectedStairIdRef.current);
      if (!st) return;
      st.steps = Math.max(2, Math.round(n));
      rebuild();
    }
    stairStepsApiRef.current = { setSteps: setActiveStairSteps };

    function deleteActiveStair() {
      const id = selectedStairIdRef.current;
      if (id == null) return;
      pushUndo();
      state.stairs = (state.stairs || []).filter((s) => s.id !== id);
      // clean up any headroom opening this stair auto-cut in the floor above
      if (activeRoomId == null) {
        const idx = floors.findIndex((f) => f.id === activeFloorId);
        const aboveEntry = idx !== -1 ? floors[idx + 1] : null;
        if (aboveEntry && aboveEntry.data.floorHoles) {
          const before = aboveEntry.data.floorHoles.length;
          aboveEntry.data.floorHoles = aboveEntry.data.floorHoles.filter((h) => h.sourceStairId !== id);
          if (aboveEntry.data.floorHoles.length !== before) rebuildFloorEntry(aboveEntry, false);
        }
      }
      setSelectedStairId(null);
        setSelectedPropId(null);
      rebuild();
    }
    deleteStairRef.current = deleteActiveStair;

    function reorderFloors(draggedId, targetId, position) {
      if (draggedId == null || targetId == null || draggedId === targetId) return;
      const fromIdx = floors.findIndex((f) => f.id === draggedId);
      if (fromIdx === -1) return;
      pushUndo();
      const [moved] = floors.splice(fromIdx, 1);
      const toIdx = floors.findIndex((f) => f.id === targetId);
      if (toIdx === -1) { floors.splice(fromIdx, 0, moved); return; }
      const insertAt = position === "before" ? toIdx : toIdx + 1;
      floors.splice(insertAt, 0, moved);
      restackFloors();
      const g = floorGroups.get(activeFloorId);
      const activeEntry = floors.find((f) => f.id === activeFloorId);
      if (g && activeEntry) target.y = g.position.y + activeEntry.data.height * 0.32;
      updateCamera();
      syncFloorsToReact();
    }
    reorderFloorsRef.current = reorderFloors;

    function setActiveFloorHeight(h) {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      entry.data.height = Math.max(MIN_WALL_HEIGHT, Math.min(MAX_WALL_HEIGHT, h));
      // any wall previously given its own individual height override would
      // otherwise stay stuck at that old value forever, since getPanelHeight()
      // prefers a per-panel override over the room's overall height -- when
      // the user is adjusting the room's overall height, the clear intent is
      // for every wall to track it, so per-wall overrides reset here.
      entry.data.panelHeights = {};
      restackFloors();
      const g = floorGroups.get(activeFloorId);
      if (g) target.y = g.position.y + entry.data.height * 0.32;
      updateCamera();
      rebuild();
    }
    floorHeightApiRef.current = {
      setHeight: setActiveFloorHeight,
      getHeight: () => (floors.find((f) => f.id === activeFloorId) || {}).data?.height ?? WALL_HEIGHT,
    };

    function setActiveFloorThickness(t) {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      entry.data.thickness = Math.max(0.03, Math.min(0.6, t));
      rebuild();
    }
    wallThicknessApiRef.current = { setThickness: setActiveFloorThickness };

    function setActiveFloorCeiling(enabled) {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      entry.data.ceilingEnabled = enabled;
      rebuild();
    }
    ceilingApiRef.current = { setEnabled: setActiveFloorCeiling };

    function updateHeightLabel() {
      const el = heightLabelRef.current;
      if (!el) return;
      const pk = selectedPanelRef.current;
      if (!pk) { el.style.display = "none"; return; }
      const info = getPanelInfo(pk);
      if (!info) { el.style.display = "none"; return; }
      const H = getPanelHeight(pk);
      const mid = (info.u0 + info.u1) / 2;
      const pt = new THREE.Vector3();
      if (info.lengthAxis === "x") pt.set(mid, H + 0.2, info.coord);
      else pt.set(info.coord, H + 0.2, mid);
      pt.addScaledVector(info.normal, 0.05);
      const activeGroup = floorGroups.get(activeFloorId);
      if (activeGroup) pt.y += activeGroup.position.y;
      const camForward = new THREE.Vector3();
      activeCamera.getWorldDirection(camForward);
      if (pt.clone().sub(activeCamera.position).dot(camForward) <= 0) { el.style.display = "none"; return; }
      const ndc = pt.clone().project(activeCamera);
      const rect = renderer.domElement.getBoundingClientRect();
      const sx = (ndc.x * 0.5 + 0.5) * rect.width;
      const sy = (-ndc.y * 0.5 + 0.5) * rect.height;
      el.style.display = "block";
      el.style.left = sx + "px";
      el.style.top = sy + "px";
      el.textContent = H.toFixed(2) + " m";
    }

    const measureLabelPool = [];
    function updateMeasureLabels() {
      const layer = measureLayerRef.current;
      if (!layer) return;
      if (!showMeasurementsRef.current || measureAnchors.length === 0) {
        measureLabelPool.forEach((el) => { el.style.display = "none"; });
        return;
      }
      const camForward = new THREE.Vector3();
      activeCamera.getWorldDirection(camForward);
      const rect = renderer.domElement.getBoundingClientRect();
      measureAnchors.forEach((a, i) => {
        let el = measureLabelPool[i];
        if (!el) {
          el = document.createElement("div");
          el.style.position = "absolute";
          el.style.transform = "translate(-50%, -50%)";
          el.style.color = "#FF6B1A";
          el.style.fontSize = "10.5px";
          el.style.fontWeight = "700";
          el.style.fontFamily = "'Roboto', system-ui, sans-serif";
          el.style.fontVariantNumeric = "tabular-nums";
          el.style.pointerEvents = "none";
          el.style.textShadow = "0 1px 3px rgba(0,0,0,0.75)";
          el.style.whiteSpace = "nowrap";
          layer.appendChild(el);
          measureLabelPool[i] = el;
        }
        const inFront = a.point.clone().sub(activeCamera.position).dot(camForward) > 0;
        if (!inFront) { el.style.display = "none"; return; }
        const ndc = a.point.clone().project(activeCamera);
        el.style.display = "block";
        el.style.left = ((ndc.x * 0.5 + 0.5) * rect.width) + "px";
        el.style.top = ((-ndc.y * 0.5 + 0.5) * rect.height) + "px";
        el.textContent = a.text;
      });
      for (let i = measureAnchors.length; i < measureLabelPool.length; i++) {
        measureLabelPool[i].style.display = "none";
      }
    }

    function hideOverlayLabels() {
      if (heightLabelRef.current) heightLabelRef.current.style.display = "none";
      measureLabelPool.forEach((elx) => { elx.style.display = "none"; });
    }

    let raf;
    let lastTickTime = performance.now();
    function tick() {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTickTime) / 1000);
      lastTickTime = now;

      if (walkModeRef.current) {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        camera.aspect = width / height;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        renderer.shadowMap.enabled = true;
        scene.fog = sceneFog;
        if (dividerHandleRef.current) dividerHandleRef.current.style.display = "none";
        if (dividerVLineRef.current) dividerVLineRef.current.style.display = "none";
        if (dividerHLineRef.current) dividerHLineRef.current.style.display = "none";

        if (walkTransition) {
          walkTransition.elapsed += dt;
          const t = Math.min(1, walkTransition.elapsed / walkTransition.duration);
          const eased = 1 - Math.pow(1 - t, 3);
          camera.position.lerpVectors(walkTransition.fromPos, walkTransition.toPos, eased);
          camera.quaternion.slerpQuaternions(walkTransition.fromQuat, walkTransition.toQuat, eased);
          camera.updateMatrixWorld(true);
          if (t >= 1) walkTransition = null;
        } else {
          updateWalkMovement(dt);
        }
        renderActive(camera);
        // editing (wall drags, height changes, measurements) works the same
        // while walking, so keep their live overlays working too.
        updateHeightLabel();
        updateMeasureLabels();
        raf = requestAnimationFrame(tick);
        return;
      }

      if (viewLayoutRef.current === "quad") {
        renderQuadLayout(width, height);
        hideOverlayLabels();
        if (dividerHandleRef.current) {
          dividerHandleRef.current.style.display = "block";
          dividerHandleRef.current.style.left = (width * splitX) + "px";
          dividerHandleRef.current.style.top = (height * splitY) + "px";
        }
        if (dividerVLineRef.current) {
          dividerVLineRef.current.style.display = "block";
          dividerVLineRef.current.style.left = (width * splitX) + "px";
          dividerVLineRef.current.style.top = "0px";
          dividerVLineRef.current.style.height = height + "px";
        }
        if (dividerHLineRef.current) {
          dividerHLineRef.current.style.display = "block";
          dividerHLineRef.current.style.top = (height * splitY) + "px";
          dividerHLineRef.current.style.left = "0px";
          dividerHLineRef.current.style.width = width + "px";
        }
      } else {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        applyViewShift(camera, width, height);
        // same reasoning as the quad panes: a fixed top/front/left/right
        // view looks straight along one axis, so the key light's hard
        // shadow tends to cover most of what's visible -- only the free
        // orbit view benefits from shadows, so switch them off otherwise.
        renderer.shadowMap.enabled = viewMode === "orbit";
        scene.fog = viewMode === "orbit" ? sceneFog : null;
        renderActive(activeCamera);
        updateHeightLabel();
        updateMeasureLabels();
        if (dividerHandleRef.current) dividerHandleRef.current.style.display = "none";
        if (dividerVLineRef.current) dividerVLineRef.current.style.display = "none";
        if (dividerHLineRef.current) dividerHLineRef.current.style.display = "none";
      }
      raf = requestAnimationFrame(tick);
    }
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      clearGroup(sceneGroup);
      clearGroup(character.group);
      scene.remove(character.group);
      if (minorGrid) { minorGrid.geometry.dispose(); minorGrid.material.dispose(); }
      if (majorGrid) { majorGrid.geometry.dispose(); majorGrid.material.dispose(); }
      measureLabelPool.forEach((elx) => elx.remove());
      wallMat.dispose();
      floorMat.dispose();
      wallMatDim.dispose();
      floorMatDim.dispose();
      wallMatSelected.dispose();
      floorMatSelected.dispose();
      pillarMat.dispose();
      pillarMatSelected.dispose();
      ceilingMat.dispose();
      selMat.dispose();
      selMatPreview.dispose();
      glassMat.dispose();
      stairMat.dispose();
      hotspotMat.dispose();
      Object.values(propMats).forEach((m) => m.dispose());
      wallGrainTex.dispose();
      wallRoughTex.dispose();
      floorGrainTex.dispose();
      floorRoughTex.dispose();
      concretePanelTex.dispose();
      groundPlane.geometry.dispose();
      groundMat.dispose();
      groundFadeTex.dispose();
      realisticEnvMap.dispose();
      composer.dispose();
      gtaoPass.dispose();
      bloomPass.dispose();
      bokehPass.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  const RIBBON_HEIGHT = 48;
  const TOPBAR_HEIGHT = 44;
  const [layersPanelWidth, setLayersPanelWidth] = useState(148);
  const panelResizeRef = useRef(null);
  const layersScrollRef = useRef(null);
  const scrollStripDragRef = useRef(null);
  const newSceneBtnRef = useRef(null);
  const defaultLayersWidth = () => 210;
  useEffect(() => { setLayersPanelWidth(defaultLayersWidth()); }, []);
  const [floorNames, setFloorNames] = useState({});
  const [renamingFloorId, setRenamingFloorId] = useState(null);
  const [renameInputValue, setRenameInputValue] = useState("");

  // ---------- voice command: speech -> Claude -> actions ----------
  // Interpretation runs through a local backend (server/voice-server.js)
  // that shells out to the `claude` CLI on this machine, so it rides
  // whatever the CLI is already logged into (a subscription or an API key)
  // instead of the browser needing its own Anthropic API key.
  const VOICE_SERVER_URL = "http://localhost:8787/api/voice-command";
  async function askClaude(transcript) {
    const systemPrompt =
      "You control a 3D room-builder app by translating one spoken instruction into a list of actions. " +
      voiceRoomContextRef.current() +
      " Available actions -- respond with ONLY a JSON array, no prose, no markdown fences, each item shaped as " +
      '{"action": "<name>", ...params}. Actions: ' +
      'set_room_size {width_ft, depth_ft} -- sets the overall room footprint. ' +
      'add_partition {wall: "north"|"south"|"east"|"west", position_fraction: 0-1} -- adds a single straight dividing wall running perpendicular to the named wall, at that fraction along its length (0.5 = middle). To divide a room into four with two crossing walls, emit one add_partition on "north" and one on "west", both at 0.5. ' +
      'add_windows_to_wall {wall, count} -- evenly spaces that many windows along the named wall. ' +
      'add_windows_all_walls {count_per_wall} -- windows on all four walls at once. ' +
      "If the instruction is unclear or asks for something with no matching action, respond with an empty array [].";
    const resp = await fetch(VOICE_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, systemPrompt }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Voice server error (${resp.status}). Is \`npm run voice-server\` running?`);
    }
    const data = await resp.json();
    const clean = (data.text || "").replace(/```json|```/g, "").trim();
    try {
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function executeVoiceActions(actions) {
    actions.forEach((a) => {
      const fn = voiceActionsRef.current[a.action];
      if (fn) {
        try { fn(a); } catch { /* one bad action shouldn't block the rest */ }
      }
    });
  }

  // shared by both the spoken and typed command paths: sends the
  // instruction text to Claude, runs whatever actions come back, and
  // reports the outcome in the same status/transcript window either way.
  async function submitToClaude(said) {
    setVoiceStatus("thinking");
    try {
      const actions = await askClaude(said);
      executeVoiceActions(actions);
      setVoiceStatus(actions.length ? "done" : "error");
      setVoiceTranscript(actions.length ? "" : said + "\n(No matching action understood.)");
    } catch (err) {
      setVoiceStatus("error");
      setVoiceTranscript("Couldn't reach Claude: " + (err && err.message ? err.message : String(err)));
    }
  }

  function submitTypedCommand() {
    const said = commandText.trim();
    if (!said) return;
    setCommandText("");
    submitToClaude(said);
  }

  function startVoiceListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setVoiceStatus("error");
      setVoiceTranscript("Speech recognition isn't supported in this browser -- try Chrome.");
      return;
    }
    let finalText = "";
    let hadError = false;
    const rec = new SR();
    rec.lang = "en-US";
    // continuous + manual stop, per spec: tap to start, talk (no auto
    // cutoff on a pause), tap again to stop and submit whatever was said.
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    voiceRecognitionRef.current = rec;
    setVoiceListening(true);
    setVoiceStatus("listening");
    setVoiceTranscript("");
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + " ";
        else interim += t;
      }
      setVoiceTranscript((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      hadError = true;
      setVoiceListening(false);
      setVoiceStatus("error");
      const reason = e && e.error;
      const hint = reason === "not-allowed" || reason === "service-not-allowed"
        ? "Microphone access was blocked -- check the browser's site permissions and allow the mic for this page."
        : reason === "no-speech" ? "No speech detected."
        : reason === "network" ? "Speech service network error."
        : `Speech recognition error: ${reason || "unknown"}.`;
      setVoiceTranscript(hint);
    };
    rec.onend = async () => {
      setVoiceListening(false);
      if (hadError) return;
      const said = finalText.trim();
      if (!said) {
        setVoiceStatus("error");
        setVoiceTranscript("No speech was captured -- try again and speak right after tapping.");
        return;
      }
      await submitToClaude(said);
    };
    try {
      rec.start();
    } catch (err) {
      setVoiceListening(false);
      setVoiceStatus("error");
      setVoiceTranscript("Couldn't start the microphone: " + (err && err.message ? err.message : String(err)));
    }
  }
  function stopVoiceListening() {
    if (voiceRecognitionRef.current) voiceRecognitionRef.current.stop();
  }

  return (
    <div data-theme={uiTheme} style={{ position: "relative", width: "100%", height: "100%", background: "var(--bg-window)", overflow: "hidden", fontFamily: "var(--font-system)", overscrollBehavior: "none" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing: border-box; }
        [data-theme="dark"] {
          --bg-window: #1e1e1e;
          --bg-panel: #2c2c2e;
          --bg-panel-translucent: rgba(44, 44, 46, 0.82);
          --bg-control: #3a3a3c;
          --bg-control-hover: #48484a;
          --bg-control-pressed: #58585a;
          --bg-floating: rgba(30, 30, 30, 0.78);
          --border-separator: rgba(84, 84, 88, 0.65);
          --border-control: rgba(255, 255, 255, 0.12);
          --text-primary: rgba(255, 255, 255, 0.92);
          --text-secondary: rgba(235, 235, 245, 0.6);
          --text-tertiary: rgba(235, 235, 245, 0.3);
          --scrollbar-track: rgba(255, 255, 255, 0.05);
        }
        [data-theme="light"] {
          /* a warm, slightly desaturated off-white -- the Teenage
             Engineering color-wheel tool's own background tone -- rather
             than a cooler, more neutral system grey. */
          --bg-window: #eae9e4;
          --bg-panel: #f4f3ee;
          --bg-panel-translucent: rgba(244, 243, 238, 0.85);
          --bg-control: #ffffff;
          --bg-control-hover: #e7e5de;
          --bg-control-pressed: #d6d3ca;
          --bg-floating: rgba(255, 255, 255, 0.85);
          --border-separator: rgba(40, 38, 30, 0.16);
          --border-control: rgba(20, 18, 12, 0.14);
          --text-primary: rgba(20, 18, 12, 0.92);
          --text-secondary: rgba(50, 46, 38, 0.6);
          --text-tertiary: rgba(50, 46, 38, 0.32);
          --scrollbar-track: rgba(0, 0, 0, 0.04);
        }
        [data-theme] {
          /* the app's own brand accent -- kept constant across both themes
             rather than swapped for Apple's system blue, since it's used
             throughout as the "this is selected/active" signal (layers,
             resize handles, active-tool state) and switching it would
             fight the rest of the app's visual language. */
          --accent: #FF6B1A;
          --accent-contrast: #141414;
          /* a technical monospace, matching the Teenage Engineering
             color-wheel reference's look -- applied to the whole interface
             in both themes (the dark theme keeps its own dark colors,
             just set in this same typeface). */
          --font-system: "Space Mono", ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
        }
        .rb-btn {
          font-family: var(--font-system);
          /* a touch smaller/tighter than before -- the monospace typeface
             runs wider per character than the old system sans-serif, so
             this claws back some of the ribbon's horizontal density. */
          font-size: 11px;
          font-weight: 700;
          letter-spacing: -0.02em;
          padding: 6px 9px;
          border-radius: 6px;
          border: 0.5px solid var(--border-control);
          background: var(--bg-control);
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
          white-space: nowrap;
        }
        .rb-btn:hover { background: var(--bg-control-hover); }
        .rb-btn.active { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
        .rb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .rb-btn:disabled { opacity: 0.35; cursor: default; }
        .rb-input {
          width: 54px; font-family: var(--font-system); font-size: 12.5px; padding: 5px 7px;
          border-radius: 6px; border: 0.5px solid var(--border-control); background: var(--bg-control); color: var(--text-primary);
        }
        .rb-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .rb-range { width: 100%; accent-color: var(--accent); height: 3px; }
        .rb-hue-slider {
          width: 100%; height: 10px; border-radius: 5px; cursor: pointer;
          -webkit-appearance: none; appearance: none;
          background: linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000);
        }
        .rb-hue-slider::-webkit-slider-thumb {
          -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
          background: #fff; border: 2px solid var(--bg-window); cursor: pointer; box-shadow: 0 0 0 1px rgba(255,255,255,0.4);
        }
        .rb-hue-slider::-moz-range-thumb {
          width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 2px solid var(--bg-window); cursor: pointer;
        }
        .rb-hue-slider::-moz-range-track { height: 10px; border-radius: 5px; }
        .ribbon {
          position: absolute; left: 0; right: 0; bottom: 0; height: ${RIBBON_HEIGHT}px;
          display: flex; align-items: stretch; overflow-x: auto; overflow-y: hidden;
          background: var(--bg-panel-translucent); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border-top: 0.5px solid var(--border-separator);
        }
        .ribbon-section { display: flex; align-items: center; gap: 12px; padding: 0 12px; flex-shrink: 0; }
        .ribbon-divider { width: 0.5px; align-self: stretch; margin: 8px 0; background: var(--border-separator); flex-shrink: 0; }
        .ribbon-group { display: flex; flex-direction: column; gap: 3px; min-width: 108px; flex-shrink: 0; justify-content: center; }
        .ribbon-label {
          font-size: 11px; text-transform: none; letter-spacing: 0; color: var(--text-secondary); font-weight: 500; white-space: nowrap;
        }
        .panel-title {
          font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--text-primary); font-weight: 600;
        }
        .layers-scroll { position: absolute; inset: 0; overflow-y: auto; padding: 8px 34px 8px 8px; -webkit-overflow-scrolling: touch; touch-action: pan-y; overscroll-behavior: contain; }
        .layers-scroll::-webkit-scrollbar { width: 20px; }
        .layers-scroll::-webkit-scrollbar-thumb { background: rgba(255, 107, 26, 0.55); border-radius: 4px; border: 6px solid transparent; background-clip: padding-box; }
        .layers-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255, 107, 26, 0.8); background-clip: padding-box; }
        .layers-scroll::-webkit-scrollbar-track { background: var(--scrollbar-track); }
        .rb-walk-btn {
          width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
          background: var(--bg-floating); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border: 0.5px solid var(--border-control); color: var(--text-primary);
          touch-action: none; cursor: pointer; user-select: none;
        }
        .rb-walk-btn:active { background: rgba(255,107,26,0.55); border-color: var(--accent); }
      `}</style>

      <div ref={mountRef} style={{ position: "absolute", inset: 0, touchAction: "none" }} />

      {/* Command UI -- a typed command box plus the mic button, below the
          top bar and inset from the right edge. Mic: tap to start (ring
          turns orange while active), speak, tap again to stop and submit.
          Text box: type an instruction and hit Enter or the send button --
          same Claude pipeline either way, useful wherever speech input
          isn't available (e.g. this sandbox). */}
      <div style={{ position: "absolute", top: TOPBAR_HEIGHT + 14, right: 24, zIndex: 50, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="text"
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitTypedCommand(); }}
            placeholder="Type a command…"
            style={{
              width: 200, height: 34, padding: "0 10px", borderRadius: 9,
              border: "0.5px solid var(--border-control)", background: "var(--bg-floating)",
              backdropFilter: "blur(12px)", color: "var(--text-primary)", fontSize: 12, outline: "none",
            }}
          />
          <button
            className="rb-btn"
            onClick={submitTypedCommand}
            disabled={!commandText.trim()}
            style={{ width: 34, height: 34, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", opacity: commandText.trim() ? 1 : 0.5 }}
            title="Send command"
          >
            <Send size={14} strokeWidth={2} />
          </button>
          <button
            className="rb-btn"
            onClick={() => (voiceListening ? stopVoiceListening() : startVoiceListening())}
            style={{
              width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: voiceListening ? "0 0 0 3px #FF9500" : "none",
              transition: "box-shadow 0.15s ease",
              flexShrink: 0,
            }}
            title={voiceListening ? "Tap to stop and submit" : "Tap to start voice command"}
          >
            <Mic size={16} strokeWidth={2} color={voiceListening ? "#FF9500" : undefined} />
          </button>
        </div>
        {(voiceStatus || voiceTranscript) && (
          <div
            style={{
              maxWidth: 240, padding: "8px 10px", borderRadius: 10, background: "var(--bg-floating)", backdropFilter: "blur(12px)",
              border: "0.5px solid var(--border-control)", color: "var(--text-primary)", fontSize: 11, lineHeight: 1.4,
            }}
          >
            <div style={{ opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 9, marginBottom: 2 }}>
              {voiceStatus === "listening" && "Listening… tap to submit"}
              {voiceStatus === "thinking" && "Thinking…"}
              {voiceStatus === "done" && "Done"}
              {voiceStatus === "error" && "Couldn't complete that"}
            </div>
            {voiceTranscript && <div>{voiceTranscript}</div>}
          </div>
        )}
      </div>

      <div
        ref={dividerVLineRef}
        style={{ position: "absolute", display: "none", width: 1.5, background: "rgba(180,180,180,0.5)", pointerEvents: "none" }}
      />
      <div
        ref={dividerHLineRef}
        style={{ position: "absolute", display: "none", height: 1.5, background: "rgba(180,180,180,0.5)", pointerEvents: "none" }}
      />
      <div
        ref={dividerHandleRef}
        style={{
          position: "absolute", display: "none", width: 22, height: 22,
          transform: "translate(-50%, -50%)", pointerEvents: "none",
          borderRadius: "50%", background: "rgba(255,107,26,0.18)",
          border: "1.5px solid #FF6B1A",
        }}
      />
      <div ref={measureLayerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }} />

      {walkMode && (
        <div style={{ position: "absolute", top: TOPBAR_HEIGHT + 10, left: "50%", transform: "translateX(-50%)", color: "var(--text-primary)", fontSize: 9.5, background: "var(--bg-floating)", backdropFilter: "blur(12px)", padding: "5px 10px", borderRadius: 8, pointerEvents: "none" }}>
          Drag empty space to orbit the camera &middot; drag a wall or floor to edit it &middot; camera icon to exit
        </div>
      )}

      {walkMode && (
        <div style={{ position: "absolute", right: 24, bottom: RIBBON_HEIGHT + 20, width: 168, height: 168 }}>
          {[
            { dir: "fwd", Icon: ArrowUp, style: { left: 56, top: 0 } },
            { dir: "left", Icon: ArrowLeft, style: { left: 0, top: 56 } },
            { dir: "right", Icon: ArrowRight, style: { left: 112, top: 56 } },
            { dir: "back", Icon: ArrowDown, style: { left: 56, top: 112 } },
          ].map(({ dir, Icon, style }) => (
            <button
              key={dir}
              className="rb-walk-btn"
              style={{ position: "absolute", ...style }}
              onPointerDown={(e) => { e.preventDefault(); walkInputRef.current[dir] = true; }}
              onPointerUp={() => { walkInputRef.current[dir] = false; }}
              onPointerLeave={() => { walkInputRef.current[dir] = false; }}
              onPointerCancel={() => { walkInputRef.current[dir] = false; }}
            >
              <Icon size={22} strokeWidth={2} />
            </button>
          ))}
        </div>
      )}

      <div
        ref={heightLabelRef}
        style={{
          position: "absolute", display: "none", transform: "translate(-50%, -100%)",
          background: "rgba(232, 24, 156, 0.28)", border: "1px solid #E8189C", borderRadius: 2,
          padding: "3px 7px", color: "#FFFFFF", fontSize: 10, fontWeight: 700,
          fontVariantNumeric: "tabular-nums", pointerEvents: "none", whiteSpace: "nowrap",
        }}
      />

      {/* LEFT: Layers panel, floating -- PowerPoint-style slide list, resizable via the handle on its right edge */}
      <div
        style={{
          position: "absolute", top: TOPBAR_HEIGHT + 8, left: 16, bottom: RIBBON_HEIGHT + 16, width: layersPanelWidth,
          background: "var(--bg-panel-translucent)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "0.5px solid var(--border-separator)", borderRadius: 10,
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        <div
          title="Drag to resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            panelResizeRef.current = { startX: e.clientX, startWidth: layersPanelWidth };
          }}
          onPointerMove={(e) => {
            const rs = panelResizeRef.current;
            if (!rs) return;
            const w = Math.min(520, Math.max(150, rs.startWidth + (e.clientX - rs.startX)));
            setLayersPanelWidth(w);
          }}
          onPointerUp={() => { panelResizeRef.current = null; }}
          style={{
            position: "absolute", top: 0, right: -12, width: 24, height: "100%",
            cursor: "ew-resize", touchAction: "none", zIndex: 1,
          }}
        />
        <div style={{ padding: "9px 9px 7px", borderBottom: "0.5px solid var(--border-separator)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="panel-title">Layers</span>
            <div style={{ display: "flex", gap: 3 }}>
              <button className="rb-btn" style={{ padding: "3px 6px", fontSize: 9 }} onClick={() => addFloorRef.current()} title="Add a new layer with a default room">+</button>
              <button className="rb-btn" style={{ padding: "3px 6px", fontSize: 9 }} onClick={() => duplicateFloorRef.current()} title="Duplicate the selected layer">Dup</button>
              <button className="rb-btn" style={{ padding: "3px 6px", fontSize: 9 }} onClick={() => deleteFloorRef.current()} title="Delete the selected layer">Del</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            <button className="rb-btn" style={{ padding: "3px 5px", fontSize: 8.5, flex: 1 }} onClick={() => cutFloorRef.current()} title="Cut the selected layer to the clipboard">Cut</button>
            <button className="rb-btn" style={{ padding: "3px 5px", fontSize: 8.5, flex: 1 }} onClick={() => copyFloorRef.current()} title="Copy the selected layer to the clipboard">Copy</button>
            <button
              className="rb-btn"
              disabled={!hasClipboard}
              style={{ padding: "3px 5px", fontSize: 8.5, flex: 1 }}
              onClick={() => pasteFloorRef.current()}
              title="Paste the clipboard as a new layer"
            >
              Paste
            </button>
          </div>
        </div>

        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div className="layers-scroll" ref={layersScrollRef}>
            {[...floorIds].reverse().map((id, i) => (
              <div key={id} style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                  height: 3, margin: "1px 4px", borderRadius: 1,
                  background: dropInfo && dropInfo.targetId === id && dropInfo.edge === "above" ? "#FF6B1A" : "transparent",
                }}
              />
              <div
                ref={(el) => { if (el) floorRowRefs.current.set(id, el); }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  floorDragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
                }}
                onPointerMove={(e) => {
                  const ds = floorDragRef.current;
                  if (!ds || ds.id !== id) return;
                  const dx = e.clientX - ds.startX, dy = e.clientY - ds.startY;
                  if (!ds.moved && Math.hypot(dx, dy) > 6) {
                    ds.moved = true;
                    setDragFloorId(id);
                  }
                  if (ds.moved) {
                    let found = null;
                    floorRowRefs.current.forEach((el, rid) => {
                      if (rid === id) return;
                      const rect = el.getBoundingClientRect();
                      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
                        found = { targetId: rid, edge: e.clientY < rect.top + rect.height / 2 ? "above" : "below" };
                      }
                    });
                    setDropInfo(found);
                  }
                }}
                onPointerUp={(e) => {
                  const ds = floorDragRef.current;
                  if (ds && ds.id === id) {
                    if (ds.moved && dropInfo) {
                      reorderFloorsRef.current(id, dropInfo.targetId, dropInfo.edge === "above" ? "after" : "before");
                    } else if (!ds.moved) {
                      selectFloorRef.current(id);
                    }
                  }
                  floorDragRef.current = null;
                  setDragFloorId(null);
                  setDropInfo(null);
                }}
                style={{
                  display: "flex", flexDirection: "row", alignItems: "center", gap: 7, cursor: "grab",
                  padding: 5, borderRadius: 2, touchAction: "none",
                  opacity: dragFloorId === id ? 0.4 : 1,
                  border: id === activeFloorIdState ? "1px solid #FF6B1A" : "1px solid transparent",
                  background: id === activeFloorIdState ? "rgba(255,107,26,0.14)" : "transparent",
                }}
              >
                <canvas
                  ref={(el) => { if (el) thumbCanvasMapRef.current.set(id, el); }}
                  width={480}
                  height={480}
                  style={{ borderRadius: 1, display: "block", width: 56, height: 56, flexShrink: 0 }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
                  {renamingFloorId === id ? (
                    <input
                      autoFocus
                      value={renameInputValue}
                      onChange={(e) => setRenameInputValue(e.target.value)}
                      onBlur={() => {
                        setFloorNames((prev) => ({ ...prev, [id]: renameInputValue.trim() }));
                        setRenamingFloorId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenamingFloorId(null);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: 9.5, background: "var(--bg-control)", color: "var(--text-primary)",
                        border: "1px solid var(--accent)", borderRadius: 4, width: "100%", padding: "1px 3px",
                      }}
                    />
                  ) : (
                    <span
                      style={{ color: "var(--text-primary)", fontSize: 9.5, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameInputValue(floorNames[id] || `Layer ${floorIds.length - i}`);
                        setRenamingFloorId(id);
                      }}
                      title="Click to rename"
                    >
                      {floorNames[id] || `Layer ${floorIds.length - i}`}
                    </span>
                  )}
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-secondary)", fontSize: 8.5, cursor: "pointer" }}>
                      Iso
                      <input
                        type="checkbox"
                        checked={isolatedFloorIdsState.includes(id)}
                        onChange={() => toggleIsolateRef.current(id)}
                        title="Isolate this layer (multiple can be isolated together)"
                        style={{ width: 11, height: 11, cursor: "pointer", accentColor: "var(--accent)" }}
                      />
                    </label>
                    <button
                      className="rb-btn"
                      style={{
                        padding: "1px 5px", fontSize: 8.5,
                        background: hiddenIds.includes(id) ? "var(--accent)" : "var(--bg-control)",
                        color: hiddenIds.includes(id) ? "var(--accent-contrast)" : "var(--text-secondary)",
                      }}
                      onClick={() => toggleHideRef.current(id)}
                      title="Hide this layer"
                    >
                      {hiddenIds.includes(id) ? "Hidden" : "Hide"}
                    </button>
                  </div>
                </div>
              </div>
              <div
                style={{
                  height: 3, margin: "1px 4px", borderRadius: 1,
                  background: dropInfo && dropInfo.targetId === id && dropInfo.edge === "below" ? "#FF6B1A" : "transparent",
                }}
              />
            </div>
              ))}
          </div>
          <div
            title="Drag to scroll"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrollStripDragRef.current = { startY: e.clientY, startScrollTop: layersScrollRef.current ? layersScrollRef.current.scrollTop : 0 };
            }}
            onPointerMove={(e) => {
              const ds = scrollStripDragRef.current;
              if (!ds || !layersScrollRef.current) return;
              layersScrollRef.current.scrollTop = ds.startScrollTop + (e.clientY - ds.startY);
            }}
            onPointerUp={() => { scrollStripDragRef.current = null; }}
            style={{
              position: "absolute", top: 0, right: 0, width: 30, height: "100%",
              touchAction: "none", cursor: "ns-resize", zIndex: 2,
            }}
          />
        </div>

        <div style={{ padding: "9px 11px", borderTop: "0.5px solid var(--border-separator)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-secondary)", fontSize: 9 }}>
            <span>Layer height</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{floorHeight.toFixed(2)} m</span>
          </div>
          <input
            className="rb-range"
            type="range"
            min={MIN_WALL_HEIGHT}
            max={MAX_WALL_HEIGHT}
            step={0.05}
            value={floorHeight}
            onPointerDown={() => pushUndoRef.current()}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setFloorHeight(v);
              floorHeightApiRef.current.setHeight(v);
            }}
          />
          <div style={{ display: "flex", gap: 12, marginTop: 7 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={ceilingOn}
                onChange={(e) => {
                  pushUndoRef.current();
                  setCeilingOn(e.target.checked);
                  ceilingApiRef.current.setEnabled(e.target.checked);
                }}
              />
              Ceiling
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={groundOn}
                onChange={(e) => {
                  setGroundOn(e.target.checked);
                  groundApiRef.current.setEnabled(e.target.checked);
                }}
              />
              Ground
            </label>
          </div>
        </div>
      </div>

      {/* TOP: full-width row so the resizable layers panel below can never
          overlap these controls, no matter how wide it's dragged -- no
          background here, the buttons float directly over the 3D view */}
      <div
        style={{
          position: "absolute", top: 0, left: 0, right: 0, height: TOPBAR_HEIGHT,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 12px", gap: 12, pointerEvents: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto" }}>
          <button
            ref={newSceneBtnRef}
            className="rb-btn"
            onClick={() => {
              resetEverythingRef.current();
              setTool("move");
              setSelectedStairId(null);
        setSelectedPropId(null);
              setStairSteps(12);
              setSelectedBalconyId(null);
              setSelectedBalconyPart(null);
              setSelectedOpeningId(null);
              setBalconyStairHeight(3 * FT);
              setBalconyPlatformWidth(10 * FT);
              setBalconyPillarCount(8);
              setBalconyPillarHeight(3 * FT);
              setBalconyGlassInfill(false);
              setViewMode("orbit");
              setViewLayout("single");
              if (walkMode) setWalkMode(false);
              setHiddenLineMode(false);
              setWireframeMode(false);
              setBuildingMaterialIndex(0);
              setTransparentInactive(false);
              setUltraRealistic(true);
              setTintActiveOn(false);
              setTintInactiveOn(false);
              setThemeAnchor(null);
              setThemePresetIndex(0);
              setThemeWheelOpen(false);
              setSnapEnabled(true);
              setShowMeasurements(false);
              setFloorNames({});
              setOpeningHeight(DEFAULT_OPENING_HEIGHT);
              setOpeningDividers(3);
              setOpeningAxisVertical(true);
              setOpeningAxisHorizontal(false);
              setDoorHeight(7 * FT);
              setPropsShape("cube");
              setCurvedCornersOn(false);
              setCurvedCornersRadius(0.6);
              setGridSizeFt(10);
              setLayersPanelWidth(defaultLayersWidth());
            }}
          >
            New scene
          </button>
          <button
            className="rb-btn"
            onClick={() => {
              resetFnRef.current && resetFnRef.current();
              setSelectedPanel(null);
            }}
          >
            Reset
          </button>
          <button
            className="rb-btn"
            title="Delete whatever is currently selected"
            onClick={() => {
              if (selectedBalconyId != null) deleteBalconyRef.current();
              else if (selectedStairId != null) deleteStairRef.current();
              else if (selectedOpeningId != null) deleteOpeningRef.current();
              else if (selectedPropId != null) deletePropRef.current();
              else if (selectedRoomId != null) deleteRoomRef.current();
            }}
          >
            Delete
          </button>
          <div style={{ width: 14 }} />
          <button className="rb-btn" disabled={!canUndo} title="Undo" style={{ display: "flex", alignItems: "center" }} onClick={() => undoRef.current()}>
            <Undo2 size={16} strokeWidth={2} />
          </button>
          <button className="rb-btn" disabled={!canRedo} title="Redo" style={{ display: "flex", alignItems: "center" }} onClick={() => redoRef.current()}>
            <Redo2 size={16} strokeWidth={2} />
          </button>
          <div style={{ width: 14 }} />
          <button
            className={`rb-btn ${walkMode ? "active" : ""}`}
            title={walkMode ? "Exit walk mode" : "Walk mode"}
            style={{ display: "flex", alignItems: "center" }}
            onClick={() => setWalkMode((v) => !v)}
          >
            <CameraIcon size={16} strokeWidth={2} />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, pointerEvents: "auto" }}>
          <div style={{ display: "flex", gap: 5 }}>
            <button className={`rb-btn ${viewLayout === "single" ? "active" : ""}`} title="Single view" style={{ display: "flex", alignItems: "center", padding: "6px 9px" }} onClick={() => setViewLayout("single")}>
              <SingleViewIcon />
            </button>
            <button className={`rb-btn ${viewLayout === "quad" ? "active" : ""}`} title="Four views" style={{ display: "flex", alignItems: "center", padding: "6px 9px" }} onClick={() => setViewLayout("quad")}>
              <QuadViewIcon />
            </button>
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            {["orbit", "top", "front", "left", "right"].map((v) => (
              <button
                key={v}
                className={`rb-btn ${viewMode === v ? "active" : ""}`}
                style={{ padding: "6px 8px", fontSize: 9 }}
                onClick={() => setViewMode(v)}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="rb-btn"
            title={uiTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            style={{ display: "flex", alignItems: "center" }}
            onClick={() => setUiTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {uiTheme === "dark" ? <Moon size={16} strokeWidth={2} /> : <Sun size={16} strokeWidth={2} />}
          </button>
        </div>
      </div>

      {/* these two float directly over the always-dark 3D canvas, not over
          any themed chrome panel, so they stay a fixed light color in both
          themes rather than following --text-secondary/tertiary (which
          would go dark-on-dark and vanish in light mode). */}
      <div ref={hudRef} style={{ position: "absolute", bottom: RIBBON_HEIGHT + 12, left: 16, color: uiTheme === "light" ? "rgba(20,20,20,0.7)" : "rgba(255,255,255,0.75)", textShadow: uiTheme === "light" ? "0 1px 2px rgba(255,255,255,0.6)" : "0 1px 2px rgba(0,0,0,0.5)", fontSize: 9.5, fontVariantNumeric: "tabular-nums" }} />
      <div style={{ position: "absolute", bottom: RIBBON_HEIGHT + 12, right: 16, color: uiTheme === "light" ? "rgba(20,20,20,0.5)" : "rgba(255,255,255,0.45)", textShadow: uiTheme === "light" ? "0 1px 2px rgba(255,255,255,0.6)" : "0 1px 2px rgba(0,0,0,0.5)", fontSize: 8.5, textAlign: "right" }}>
        Drag empty space to orbit (or pan, in a fixed view) &middot; scroll or pinch to zoom &middot; two-finger drag to pan
      </div>

      {/* BOTTOM: ribbon -- tools, then context settings, then view options, then everything else */}
      <div className="ribbon">
        <div className="ribbon-section">
          <span className="panel-title" style={{ marginRight: 4 }}>Exodex</span>
          <button
            className="rb-btn"
            onClick={() => setThemeWheelOpen((v) => !v)}
            title="Room color theme -- pick a hue or grey to tint the walls, floor, stairs, and props as one cohesive palette"
            style={{
              padding: 0, width: 22, height: 22, minWidth: 22, borderRadius: "50%", overflow: "hidden",
              background: "conic-gradient(from 0deg, #e5484d, #f2c230, #4caf6d, #4a90d9, #9b5de5, #e5484d)",
              boxShadow: themeWheelOpen ? "0 0 0 2px var(--accent)" : "none",
            }}
          />
          <button
            className="rb-btn"
            onClick={() => setBuildingMaterialIndex((i) => (i + 1) % 5)}
            title="Cycle material finish (default, matte vinyl, concrete, shiny metal, grid tile) -- an overlay on the current theme color, except concrete which keeps its own grey"
            style={{
              padding: 2, width: 22, height: 22, minWidth: 22, display: "grid",
              gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 1, overflow: "hidden",
            }}
          >
            <span style={{ background: "#d8d5cf", borderRadius: 1 }} />
            <span style={{ background: "#93999c", borderRadius: 1 }} />
            <span style={{ background: "linear-gradient(135deg, #eef0f2, #8a8d92)", borderRadius: 1 }} />
            <span style={{ background: "#e9e9e4", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 1 }} />
          </button>
          <button className={`rb-btn ${tool === "move" ? "active" : ""}`} onClick={() => setTool("move")}>Wall</button>
          <button className={`rb-btn ${tool === "cut" ? "active" : ""}`} onClick={() => setTool("cut")}>Window</button>
          <button className={`rb-btn ${tool === "door" ? "active" : ""}`} onClick={() => setTool("door")}>Door</button>
          <button className={`rb-btn ${tool === "stairs" ? "active" : ""}`} onClick={() => setTool("stairs")}>Stairs</button>
          <button className={`rb-btn ${tool === "props" ? "active" : ""}`} onClick={() => setTool("props")}>Props</button>
        </div>

        <div className="ribbon-divider" />

        <div className="ribbon-section">
          {tool === "move" && selectedRoomId != null && selectedPanel == null && (
            <>
              <div className="ribbon-group" style={{ minWidth: 340 }}>
                <span className="ribbon-label">Room</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="rb-btn" onClick={() => cutRoomRef.current()}>Cut</button>
                  <button className="rb-btn" onClick={() => copyRoomRef.current()}>Copy</button>
                  <button className="rb-btn" disabled={!hasRoomClipboard} onClick={() => pasteRoomRef.current()}>Paste</button>
                  <button className="rb-btn" onClick={() => duplicateRoomRef.current()}>Duplicate</button>
                  <button className="rb-btn" onClick={() => deleteRoomRef.current()}>Delete</button>
                  <button className="rb-btn" onClick={() => switchActiveRoomRef.current(null)}>Done</button>
                </div>
              </div>
              <div className="ribbon-group">
                <span className="ribbon-label">Room height &middot; {roomHeight.toFixed(2)} m</span>
                <input
                  className="rb-range"
                  type="range"
                  min={MIN_WALL_HEIGHT}
                  max={MAX_WALL_HEIGHT}
                  step={0.05}
                  value={roomHeight}
                  onPointerDown={() => pushUndoRef.current()}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setRoomHeight(v);
                    roomHeightApiRef.current.setHeight(v);
                  }}
                />
              </div>
              <div className="ribbon-group" style={{ minWidth: 190 }}>
                <span className="ribbon-label">
                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={curvedCornersOn}
                      onChange={(e) => {
                        pushUndoRef.current();
                        setCurvedCornersOn(e.target.checked);
                        curvedCornersApiRef.current.setEnabled(e.target.checked);
                      }}
                    />
                    Curved corners &middot; {curvedCornersRadius.toFixed(2)} m
                  </label>
                </span>
                <input
                  className="rb-range"
                  type="range"
                  min={0.1}
                  max={2.5}
                  step={0.05}
                  value={curvedCornersRadius}
                  onPointerDown={() => pushUndoRef.current()}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setCurvedCornersRadius(v);
                    curvedCornersApiRef.current.setRadius(v);
                  }}
                />
              </div>
            </>
          )}
          {tool === "move" && selectedPanel != null && (
            <div className="ribbon-group" style={{ minWidth: 200 }}>
              <span className="ribbon-label">Wall height &middot; {selectedHeight.toFixed(2)} m</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="rb-range"
                  type="range"
                  min={MIN_WALL_HEIGHT}
                  max={MAX_WALL_HEIGHT}
                  step={0.05}
                  value={selectedHeight}
                  onPointerDown={() => pushUndoRef.current()}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSelectedHeight(v);
                    panelHeightApiRef.current.setHeight(selectedPanel, v);
                  }}
                />
                <button className="rb-btn" onClick={() => setSelectedPanel(null)}>Done</button>
              </div>
            </div>
          )}
          {tool === "move" && selectedRoomId == null && selectedPanel == null && (
            <div className="ribbon-group">
              <span className="ribbon-label">Thickness &middot; {wallThickness.toFixed(2)} m</span>
              <input
                className="rb-range"
                type="range"
                min={0.03}
                max={0.6}
                step={0.01}
                value={wallThickness}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setWallThickness(v);
                  wallThicknessApiRef.current.setThickness(v);
                }}
              />
            </div>
          )}
          {((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) && (
            <div className="ribbon-group">
              <span className="ribbon-label">
                {selectedOpeningId != null ? "Selected window height" : "Opening height"} &middot; {(openingHeight / FT).toFixed(2)} ft
              </span>
              <input
                className="rb-range"
                type="range"
                min={0}
                max={Math.max(0.2, (floorHeight - 0.1) / FT)}
                step={0.05}
                value={openingHeight / FT}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const ft = parseFloat(e.target.value);
                  const h = Math.max(0, ft * FT);
                  setOpeningHeight(h);
                  if (selectedOpeningId != null) openingEditApiRef.current.setHeight(h);
                }}
              />
            </div>
          )}
          {((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) && (
            <div className="ribbon-group">
              <span className="ribbon-label">Dividers &middot; {openingDividers}</span>
              <input
                className="rb-range"
                type="range"
                min={0}
                max={6}
                step={1}
                value={openingDividers}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setOpeningDividers(n);
                  if (selectedOpeningId != null) openingEditApiRef.current.setDividers(n);
                }}
              />
            </div>
          )}
          {((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) && (
            <div className="ribbon-group">
              <span className="ribbon-label">Divider direction</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className={`rb-btn ${openingAxisVertical ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    const v = !openingAxisVertical;
                    setOpeningAxisVertical(v);
                    if (selectedOpeningId != null) openingEditApiRef.current.setAxis(v, openingAxisHorizontal);
                  }}
                >
                  Vertical
                </button>
                <button
                  className={`rb-btn ${openingAxisHorizontal ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    const h = !openingAxisHorizontal;
                    setOpeningAxisHorizontal(h);
                    if (selectedOpeningId != null) openingEditApiRef.current.setAxis(openingAxisVertical, h);
                  }}
                >
                  Horizontal
                </button>
              </div>
            </div>
          )}
          {((tool === "door" && selectedOpeningId == null) || (selectedOpeningId != null && selectedOpeningIsDoor)) && (
            <div className="ribbon-group">
              <span className="ribbon-label">
                {selectedOpeningId != null ? "Selected door height" : "Door height"} &middot; {(doorHeight / FT).toFixed(2)} ft
              </span>
              <input
                className="rb-range"
                type="range"
                min={3}
                max={Math.max(3.2, (floorHeight - 0.05) / FT)}
                step={0.05}
                value={doorHeight / FT}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const h = Math.max(0, parseFloat(e.target.value) * FT);
                  setDoorHeight(h);
                  if (selectedOpeningId != null) openingEditApiRef.current.setHeight(h);
                }}
              />
            </div>
          )}
          {tool === "props" && (
            <div className="ribbon-group" style={{ minWidth: 220 }}>
              <span className="ribbon-label">Prop shape</span>
              <div style={{ display: "flex", gap: 6 }}>
                {["sphere", "cube", "cone", "cylinder", "balcony"].map((s) => (
                  <button
                    key={s}
                    className={`rb-btn ${propsShape === s ? "active" : ""}`}
                    onClick={() => setPropsShape(s)}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {selectedStairId != null && (
            <div className="ribbon-group" style={{ minWidth: 220 }}>
              <span className="ribbon-label">Steps &middot; {stairSteps}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="rb-range"
                  type="range"
                  min={2}
                  max={60}
                  step={1}
                  value={stairSteps}
                  onPointerDown={() => pushUndoRef.current()}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setStairSteps(n);
                    stairStepsApiRef.current.setSteps(n);
                  }}
                />
                <button className="rb-btn" onClick={() => deleteStairRef.current()}>Delete</button>
                <button className="rb-btn" onClick={() => setSelectedStairId(null)}>Done</button>
              </div>
            </div>
          )}
          {selectedBalconyId != null && (
            <div className="ribbon-group" style={{ minWidth: 260 }}>
              <span className="ribbon-label">Staircase height &middot; {(balconyStairHeight / FT).toFixed(2)} ft</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="rb-range"
                  type="range"
                  min={1}
                  max={Math.max(1.5, (floorHeight - 1.5 * FT) / FT)}
                  step={0.1}
                  value={balconyStairHeight / FT}
                  onPointerDown={() => pushUndoRef.current()}
                  onChange={(e) => {
                    const ft = parseFloat(e.target.value);
                    setBalconyStairHeight(ft * FT);
                    balconyHeightApiRef.current.setHeight(ft * FT);
                  }}
                />
                <button className="rb-btn" onClick={() => deleteBalconyRef.current()}>Delete</button>
                <button className="rb-btn" onClick={() => setSelectedBalconyId(null)}>Done</button>
              </div>
            </div>
          )}
          {selectedBalconyId != null && (
            <div className="ribbon-group" style={{ minWidth: 220 }}>
              <span className="ribbon-label">Platform width &middot; {(balconyPlatformWidth / FT).toFixed(2)} ft</span>
              <input
                className="rb-range"
                type="range"
                min={3}
                max={60}
                step={0.5}
                value={balconyPlatformWidth / FT}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const ft = parseFloat(e.target.value);
                  setBalconyPlatformWidth(ft * FT);
                  balconyWidthApiRef.current.setWidth(ft * FT);
                }}
              />
            </div>
          )}
          {selectedBalconyId != null && (
            <div className="ribbon-group" style={{ minWidth: 200 }}>
              <span className="ribbon-label">Pillars &middot; {balconyPillarCount}</span>
              <input
                className="rb-range"
                type="range"
                min={2}
                max={60}
                step={1}
                value={balconyPillarCount}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setBalconyPillarCount(n);
                  balconyPillarCountApiRef.current.setCount(n);
                }}
              />
            </div>
          )}
          {selectedBalconyId != null && (
            <div className="ribbon-group" style={{ minWidth: 200 }}>
              <span className="ribbon-label">Pillar height &middot; {(balconyPillarHeight / FT).toFixed(2)} ft</span>
              <input
                className="rb-range"
                type="range"
                min={1}
                max={50}
                step={0.1}
                value={balconyPillarHeight / FT}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const ft = parseFloat(e.target.value);
                  setBalconyPillarHeight(ft * FT);
                  balconyPillarHeightApiRef.current.setHeight(ft * FT);
                }}
              />
            </div>
          )}
          {selectedBalconyId != null && (
            <div className="ribbon-group" style={{ minWidth: 80 }}>
              <button
                className={`rb-btn ${balconyGlassInfill ? "active" : ""}`}
                onClick={() => {
                  pushUndoRef.current();
                  const on = !balconyGlassInfill;
                  setBalconyGlassInfill(on);
                  balconyGlassApiRef.current.setEnabled(on);
                }}
              >
                Glass
              </button>
            </div>
          )}
          {selectedOpeningId != null && (
            <div className="ribbon-group" style={{ minWidth: 160 }}>
              <span className="ribbon-label">Opening selected</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="rb-btn" onClick={() => deleteOpeningRef.current()}>Delete</button>
                <button className="rb-btn" onClick={() => setSelectedOpeningId(null)}>Done</button>
              </div>
            </div>
          )}
        </div>

        <div className="ribbon-divider" />

        <div className="ribbon-section">
          <div className="ribbon-group">
            <span className="ribbon-label">Grid &middot; {gridSizeFt.toFixed(2)} ft</span>
            <input
              className="rb-range"
              type="range"
              min={0.1}
              max={10}
              step={0.05}
              value={gridSizeFt}
              onChange={(e) => setGridSizeFt(parseFloat(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button className={`rb-btn ${snapEnabled ? "active" : ""}`} onClick={() => setSnapEnabled((v) => !v)}>Snap</button>
            <button className={`rb-btn ${showMeasurements ? "active" : ""}`} onClick={() => setShowMeasurements((v) => !v)}>Measure</button>
            <button className={`rb-btn ${hiddenLineMode ? "active" : ""}`} onClick={() => setHiddenLineMode((v) => !v)}>Hidden line</button>
            <button className={`rb-btn ${wireframeMode ? "active" : ""}`} onClick={() => setWireframeMode((v) => !v)}>Wireframe</button>
            <button className={`rb-btn ${transparentInactive ? "active" : ""}`} onClick={() => setTransparentInactive((v) => !v)}>Fade inactive</button>
            <button className={`rb-btn ${ultraRealistic ? "active" : ""}`} onClick={() => setUltraRealistic((v) => !v)}>Realistic</button>
          </div>
          <div className="ribbon-group" style={{ minWidth: 150, gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={tintActiveOn} onChange={(e) => setTintActiveOn(e.target.checked)} style={{ cursor: "pointer" }} />
              <span className="ribbon-label" style={{ margin: 0, width: 40, flexShrink: 0 }}>Active</span>
              <div style={{ display: "flex", gap: 3 }}>
                {TE_SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => { setTintActiveColor(c); setTintActiveOn(true); }}
                    title={`#${c.toString(16).padStart(6, "0")}`}
                    style={{
                      width: 14, height: 14, borderRadius: "50%", padding: 0, cursor: "pointer",
                      background: `#${c.toString(16).padStart(6, "0")}`,
                      border: tintActiveOn && tintActiveColor === c ? "2px solid var(--accent)" : "1px solid var(--border-control)",
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={tintInactiveOn} onChange={(e) => setTintInactiveOn(e.target.checked)} style={{ cursor: "pointer" }} />
              <span className="ribbon-label" style={{ margin: 0, width: 40, flexShrink: 0 }}>Inactive</span>
              <div style={{ display: "flex", gap: 3 }}>
                {TE_SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => { setTintInactiveColor(c); setTintInactiveOn(true); }}
                    title={`#${c.toString(16).padStart(6, "0")}`}
                    style={{
                      width: 14, height: 14, borderRadius: "50%", padding: 0, cursor: "pointer",
                      background: `#${c.toString(16).padStart(6, "0")}`,
                      border: tintInactiveOn && tintInactiveColor === c ? "2px solid var(--accent)" : "1px solid var(--border-control)",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {themeWheelOpen && (
        <ThemeWheelOverlay
          pos={themeWheelPos}
          onPosChange={setThemeWheelPos}
          activeTheme={themeAnchor}
          presetIndex={themePresetIndex}
          onCyclePreset={() => setThemePresetIndex((i) => (i + 1) % (CURATED_PALETTES.length + 1))}
          onPick={(anchor) => setThemeAnchor(anchor)}
          onClose={() => setThemeWheelOpen(false)}
        />
      )}
    </div>
  );
}
