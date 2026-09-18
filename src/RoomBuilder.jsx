import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Undo2, Redo2, Camera as CameraIcon, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Mic, Sun, Moon, Send, Globe, Box, Cone, Cylinder, Trash2, Copy } from "lucide-react";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import DEFAULT_PRESET_SCENES from "./defaultPresets.json";

const WALL_HEIGHT = 4.8768; // 16 ft
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
const MOVE_PX = 6;                // pixels of movement that resolves a quick drag
const DEFAULT_OPENING_HEIGHT = +(WALL_HEIGHT * 0.8).toFixed(2);
const FT = 0.3048;                // grid/measurement units are shown in feet
const DEFAULT_ROOM_HALF_X = 12.5; // default room is 25m x 15m
const DEFAULT_ROOM_HALF_Z = 7.5;
const MIN_STAIR_SIZE = FT;         // smallest footprint that commits as a staircase
const MIN_ROOM_DRAW_SIZE = 3 * FT; // smallest footprint that commits as a new drawn room
const ROOM_SNAP_DIST = 3;          // meters -- generous snap radius for the Room tool's corner/edge snapping
const WALL_CYCLE_HOLD_MS = 2000;   // once a dragged partition snaps flush to an opposing wall, this long a hold advances solid -> door -> fully-open
const WALL_DELETE_HOLD_MS = 1000;  // once a pushed selection's bump-out snaps flush to an opposing wall, this long a hold arms deleting it
const WALL_CYCLE_DOOR_WIDTH = 6 * FT; // matches the automatic room-to-room connecting door width
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
const PROP_DEFAULT_COLORS = {
  sphere: 0xd6453c, cone: 0x3f9d5c, cube: 0x3a6bc9, cylinder: 0xd6453c,
  colSquare: 0xf2f0ea, colRound: 0xf2f0ea, jailWall: 0x2a2a2e,
};

// display names for the six building-material finishes -- kept in this
// same order as the Three.js closure's own BUILDING_MATERIAL_PRESETS array
// so the ribbon button (rendered outside that closure) can label/cycle them.
const BUILDING_MATERIAL_NAMES = ["Plastic", "Concrete", "Metal", "Gloss", "Vinyl", "Wood"];

// Theme color wheel: a full filled disc -- a small greyscale ring at the
// hub (15 greys plus pure white and pure black) surrounded by a hue wheel
// (angle = one of twelve hues, radius = four tones running from a vivid,
// near-fully-saturated color at the rim to a pale near-white tint close to
// the hub), modeled directly on Teenage Engineering's color-wheel tool.
// Tapping any cell selects that hue (or, on the grey ring, that lightness)
// as the room's theme; themeColorsFor then derives a small palette of
// related tones from that one anchor -- lightest to the floor, a midtone
// to the walls, a complementary hue for the balcony roof, and the rest
// (with a little randomness for variety) spread across the remaining
// props and elements.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(x * 255);
  // R=f(0), G=f(8), B=f(4) -- per the standard CSS HSL->RGB formula; the
  // green/blue channels were swapped here before (f(4) as G, f(8) as B),
  // which silently mirrored every hue with G != B (e.g. picking "green"
  // actually produced blue) despite the wheel still looking rainbow-ish
  // at a glance.
  return (toHex(f(0)) << 16) | (toHex(f(8)) << 8) | toHex(f(4));
}
function hexToCss(hex) { return `#${hex.toString(16).padStart(6, "0")}`; }
function hexToHsl(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 0.0001) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}
// shifts a hex color's hue/saturation/lightness by the wheel's global
// adjustment sliders -- used both for the generic disc's colors and for a
// named theme's, so the sliders affect whatever is currently shown.
function adjustHex(hex, hueShift, satMul, lightMul) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex((h + hueShift + 360) % 360, Math.max(0, Math.min(100, s * satMul)), Math.max(2, Math.min(98, l * lightMul)));
}
const THEME_SAT = 62; // the fixed saturation every hue theme derives its palette at
const THEME_WALL_MIDLIGHT = 56; // the wall's lightness anchor for a hue theme
function clampL(l) { return Math.max(4, Math.min(96, l)); }
function clampS(s) { return Math.max(0, Math.min(100, s)); }
// derives the room's whole palette from one anchor point -- hueDeg/sat pick
// the family, midLight pivots the whole palette lighter or darker (used by
// the grey ring to get a distinct light-to-dark monochrome theme from
// every step). Each category gets a small random jitter on top of its
// base offset -- so re-picking the same spot still gives a slightly
// different, still-cohesive palette -- and the balcony roof is anchored to
// the complementary hue (opposite the rest of the room) rather than a
// tint of the same one.
function themeColorsFor(hueDeg, sat, midLight = THEME_WALL_MIDLIGHT) {
  const jitter = (range) => (Math.random() - 0.5) * range;
  const tone = (dl, dh = 0, ds = 0) => hslToHex((hueDeg + dh + 360) % 360, clampS(sat + ds), clampL(midLight + dl));
  return {
    // the wall always gets the most vivid tone of the bunch -- pinned near
    // the anchor lightness (where a fixed HSL saturation reads most
    // saturated, rather than washed out pale or crushed dark) and boosted
    // a little further in saturation on top of that.
    floor: tone(32 + jitter(6), jitter(6), jitter(8)),
    wall: tone(0 + jitter(4), 0, 12 + jitter(6)),
    stairs: tone(16 + jitter(6), jitter(8), jitter(8)),
    platform: tone(22 + jitter(6), jitter(10), jitter(8)),
    sphere: tone(-12 + jitter(8), 14 + jitter(10), jitter(10)),
    cylinder: tone(-6 + jitter(8), 24 + jitter(12), jitter(10)),
    railing: tone(-20 + jitter(6), -16 + jitter(10), jitter(8)),
    cone: tone(-30 + jitter(8), -24 + jitter(12), jitter(10)),
    cube: tone(-38 + jitter(6), jitter(10), jitter(8)),
    // the complementary hue -- opposite side of the wheel -- so the roof
    // reads as a deliberate accent rather than another shade of the room.
    roof: hslToHex((hueDeg + 180 + jitter(20) + 360) % 360, clampS(sat + jitter(15)), clampL(midLight + 4 + jitter(20))),
  };
}
const WHEEL_HUE_COUNT = 12;
const WHEEL_TINT_RINGS = 6; // six tones per hue -- a near-white tint at the hub, ramping up to the most intense, fully-saturated version of the hue at the rim
const WHEEL_GREY_STEPS = 17; // 15 greys + pure white + pure black
// the hue/tint disc -- twelve 30-degree hue sectors, each with six tone
// cells running from a near-white tint close to the hub out to a vivid,
// fully-saturated color at the rim.
const WHEEL_DISC_CELLS = (() => {
  const cells = [];
  for (let h = 0; h < WHEEL_HUE_COUNT; h++) {
    const hueDeg = (h / WHEEL_HUE_COUNT) * 360;
    for (let r = 0; r < WHEEL_TINT_RINGS; r++) {
      const t = r / (WHEEL_TINT_RINGS - 1);
      const lightness = 95 - t * 47; // near-white near the hub (r=0) -> vivid at the rim (r=max)
      const saturation = 18 + t * 82; // barely tinted near the hub -> fully saturated at the rim
      cells.push({ hue: h, ring: r, hueDeg, hex: hslToHex(hueDeg, saturation, lightness) });
    }
  }
  return cells;
})();
// the small hub-side greyscale ring, black at one end, white at the other.
const WHEEL_GREY_CELLS = Array.from({ length: WHEEL_GREY_STEPS }, (_, i) => {
  const midLight = clampL((i / (WHEEL_GREY_STEPS - 1)) * 100);
  return { step: i, midLight, hex: hslToHex(0, 0, midLight) };
});

// nudges a hex color's lightness toward white (amt > 0) or black (amt < 0),
// amt in [-1, 1] -- used to derive the rest of a curated palette's tones
// (stairs, platform, and the individual prop shapes) from just its four
// named roles, so every preset only needs to name a wall/floor/railing/
// prop color and the rest stays visually cohesive with it automatically.
function liteHex(hex, amt) {
  const { h, s, l } = hexToHsl(hex);
  const newL = amt >= 0 ? l + (100 - l) * amt : l + l * amt;
  return hslToHex(h, s, clampL(newL));
}
// builds a full 10-category palette from just the four roles a curated
// preset actually cares about naming: the wall, the floor, the railing/
// balcony-hardware accent, and the props' base hue. Stairs reads as a
// lighter break from the wall; the balcony platform a darker break from
// the floor; the balcony roof matches the railing (both read as one piece
// of "hardware" against the room); each prop shape gets a small lightness
// step off the shared prop hue so a room full of them doesn't look like
// four copies of the same object.
function buildPalette(name, wall, floor, railing, prop) {
  return {
    name, wall, floor, railing,
    stairs: liteHex(wall, 0.35),
    platform: liteHex(floor, -0.28),
    roof: railing,
    sphere: prop,
    cube: liteHex(prop, -0.14),
    cone: liteHex(prop, 0.18),
    cylinder: liteHex(prop, -0.26),
    wheel: [wall, floor, railing, prop],
  };
}
// Twelve named color themes, lifted straight off two reference mood-board
// sheets ("10 Creative Colour Themes" and the first two entries of "10
// Visionary Colour Themes") -- each one's six swatches are its actual
// six-color strip from the sheet, read left to right, with no computed
// gradient involved. In theme-wheel mode each theme fills one of the
// wheel's twelve wedges with its own six swatches (hub-side ring first,
// rim ring last), so tapping a theme's wedge shows exactly that theme's
// real palette rather than a generic tint ramp. Tapping one of the six
// rings promotes that swatch to the wall; see applyRoomTheme for how the
// other five resolve into floor/prop/railing.
const THEME_PALETTES = [
  { name: "Neon Dream", swatches: [0xe91e8c, 0x8b1fc9, 0x5b3ce0, 0x2255e6, 0x00c2e0, 0x0d1128] },
  { name: "Pastel Serenity", swatches: [0xf0c3a8, 0xeec6c6, 0xf4ddd2, 0xc6dbcd, 0xb7cee0, 0xc5c6d6] },
  { name: "Korean Minimal", swatches: [0xc8b090, 0x8a5a3d, 0x9b9184, 0x89877e, 0x7b8470, 0x2a2620] },
  { name: "Cyberpunk", swatches: [0x4a1050, 0xe6198f, 0x9a80d6, 0x1f70c6, 0x16305a, 0x0c1220] },
  { name: "Modernism", swatches: [0x161616, 0x4a4a4a, 0x8e8e8e, 0xd7d3c7, 0xb7a787, 0xa8481f] },
  { name: "Earth & Nature", swatches: [0x3c4a2d, 0x6a7949, 0xa8815b, 0xb0673f, 0x89492f, 0xddcfb7] },
  { name: "Japandi", swatches: [0x2b2b2b, 0x575757, 0x837d73, 0xe7e1d3, 0x899080, 0x393b2f] },
  { name: "Artistic Bold", swatches: [0xa3222c, 0xe2662c, 0xe2b02c, 0x1f4f8f, 0x2879a0, 0xe0a8ba] },
  { name: "Monochrome+", swatches: [0x0a0a0a, 0x4a4a4a, 0x8a8a8a, 0xc8c8c8, 0x5c1c28, 0xc8949c] },
  { name: "Ethereal Future", swatches: [0xd7c7e7, 0xe7c7db, 0xefd7df, 0xbfd7cf, 0xb7c7cf, 0xcfcfd3] },
  { name: "Miyazaki", swatches: [0x3c5140, 0x899a6b, 0xb7cfd7, 0xc7dbdf, 0xebdbc7, 0xbf6f4f] },
  { name: "Ghost in the Shell", swatches: [0x1b2740, 0x394960, 0x5b6f87, 0xa7bbc7, 0xdbe1e3, 0xdfd3d1] },
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
// greyscale ring at the hub, surrounded by a full disc (angle = one of
// twelve slots, radius = six tone rings). Three distinct gestures: drag
// the hub to reposition the whole widget; tap the hub (no real movement)
// to toggle which grid the disc shows -- the generic 12-hue x 6-ring tonal
// wheel, or the 12 named image-derived themes, each filling its wedge with
// its own six real swatch colors -- without applying anything itself; drag
// anywhere on the colorful disc itself to spin it, with a bit of momentum
// once released, like a real dial.
function ThemeWheelOverlay({ pos, onPosChange, onPick, onClose, activeTheme, mode, onToggleMode, hueShift, satMul, lightMul, onSlider }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // --- hub: drag to move, tap (little/no movement) to toggle hue/theme mode ---
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
      if (moved < 6) onToggleMode();
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

  const size = 272; // 20% smaller than the original 340
  const cx = size / 2, cy = size / 2;
  const hubR = 19;
  const greyR0 = 19, greyR1 = 34;
  const discR0 = 34, discR1 = 132;
  const hueSpan = 360 / WHEEL_HUE_COUNT;
  const greySpan = 360 / WHEEL_GREY_STEPS;
  const ringDepth = (discR1 - discR0) / WHEEL_TINT_RINGS;
  // seams between wedges are drawn as a constant-width stroke on each cell
  // (see WHEEL_SEAM below), not a geometric angle/radius gap -- an angular
  // gap widens with radius (arc length scales with r), which is what was
  // reading as "triangular wedges" between cells instead of a uniform
  // single-pixel line.

  const isActiveCell = (hueDeg, ring) => activeTheme && activeTheme.type === "hue" && activeTheme.hueDeg === hueDeg && activeTheme.ring === ring;
  const isActiveGrey = (step) => activeTheme && activeTheme.type === "grey" && activeTheme.step === step;
  const isActiveTheme = (name, ring) => activeTheme && activeTheme.type === "theme" && activeTheme.name === name && activeTheme.ring === ring;
  const adj = (hex) => adjustHex(hex, hueShift, satMul, lightMul);
  const activeThemeName = mode === "theme" && activeTheme && activeTheme.type === "theme" ? activeTheme.name : "";

  return (
    <div
      style={{
        position: "absolute", left: pos.x, top: pos.y, zIndex: 200, width: size,
        transform: "translate(-50%, -50%)",
        userSelect: "none", WebkitUserSelect: "none",
      }}
    >
      {/* the active theme's name, in the same font/size as the ribbon's own
          floating labels (.ribbon-label, replicated inline since this sits
          outside the ribbon) -- only shown once a theme wedge is actually
          picked, not merely while browsing the theme grid. */}
      <div
        style={{
          height: 12, marginBottom: 4, textAlign: "center", fontFamily: "var(--font-mono)",
          fontSize: 9.5, fontWeight: 500, color: "var(--text-secondary)", whiteSpace: "nowrap",
          opacity: entered ? 1 : 0, transition: "opacity 0.25s ease",
        }}
      >
        {activeThemeName}
      </div>
      <div
        style={{
          width: size, height: size, position: "relative",
          transform: `scale(${entered ? 1 : 0.35})`,
          opacity: entered ? 1 : 0,
          transition: "transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.25s ease",
          filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.35))",
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
            {mode === "theme"
              ? THEME_PALETTES.flatMap((theme, ti) => {
                  const angleDeg = (ti / WHEEL_HUE_COUNT) * 360;
                  return theme.swatches.map((hex, ring) => (
                    <path
                      key={`t${ti}-r${ring}`}
                      d={ringWedgePath(cx, cy, discR0 + ring * ringDepth, discR0 + (ring + 1) * ringDepth, angleDeg - 90, hueSpan, 0)}
                      fill={hexToCss(adj(hex))}
                      stroke={isActiveTheme(theme.name, ring) ? "var(--accent)" : "var(--wheel-seam)"}
                      strokeWidth={isActiveTheme(theme.name, ring) ? 1.75 : 1}
                      style={{ cursor: "pointer" }}
                      onClick={() => pick({ type: "theme", name: theme.name, ring })}
                    >
                      <title>{`${theme.name} · ${hexToCss(adj(hex))}`}</title>
                    </path>
                  ));
                })
              : WHEEL_DISC_CELLS.map((cell) => (
                  <path
                    key={`h${cell.hue}-r${cell.ring}`}
                    d={ringWedgePath(cx, cy, discR0 + cell.ring * ringDepth, discR0 + (cell.ring + 1) * ringDepth, cell.hueDeg - 90, hueSpan, 0)}
                    fill={hexToCss(adj(cell.hex))}
                    stroke={isActiveCell(cell.hueDeg, cell.ring) ? "var(--accent)" : "var(--wheel-seam)"}
                    strokeWidth={isActiveCell(cell.hueDeg, cell.ring) ? 1.75 : 1}
                    style={{ cursor: "pointer" }}
                    onClick={() => pick({ type: "hue", hueDeg: cell.hueDeg, ring: cell.ring })}
                  >
                    <title>{hexToCss(adj(cell.hex))}</title>
                  </path>
                ))}
            {WHEEL_GREY_CELLS.map((g) => (
              <path
                key={`grey${g.step}`}
                d={ringWedgePath(cx, cy, greyR0, greyR1, g.step * greySpan - 90, greySpan, 0)}
                fill={hexToCss(adjustHex(g.hex, 0, 1, lightMul))}
                stroke={isActiveGrey(g.step) ? "var(--accent)" : "var(--wheel-seam)"}
                strokeWidth={isActiveGrey(g.step) ? 1.5 : 1}
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
          title={`Drag to move, tap to switch between the hue wheel and the theme wheel -- currently: ${mode === "theme" ? "Themes" : "Hue"}`}
          style={{
            position: "absolute", left: cx - hubR, top: cy - hubR, width: hubR * 2, height: hubR * 2, borderRadius: "50%",
            background: "#1a1a1a", border: "1px solid var(--border-control)",
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none",
          }}
        >
          {/* a plain plus mark, like the reference's own hub -- which mode
              is active is still there on hover (see the title above)
              rather than cluttering the hub visually. */}
          <span style={{ fontSize: 15, lineHeight: 1, color: "#ffffff", pointerEvents: "none", fontWeight: 300 }}>+</span>
        </div>
        {/* close button lives outside the disc, upper-right, rather than
            crowding the hub -- the hub is just drag/cycle now. */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close"
          style={{
            position: "absolute", top: -10, right: -10, width: 24, height: 24, borderRadius: "50%", zIndex: 2,
            border: "1px solid var(--border-control)", background: "var(--bg-panel)", color: "var(--text-primary)",
            cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          }}
        >
          &times;
        </button>
      </div>
      {/* global adjustment sliders -- shift/scale every color the wheel is
          currently showing (and so the next pick applies), without
          touching whatever theme is already applied to the room. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          marginTop: 16, display: "flex", gap: 20,
          fontFamily: "var(--font-mono)", opacity: entered ? 1 : 0, transition: "opacity 0.25s ease 0.1s",
        }}
      >
        {[
          { key: "hue", label: "hue", value: hueShift, min: -180, max: 180, fmt: (v) => `${Math.round(v)}°` },
          { key: "sat", label: "saturation", value: satMul, min: 0, max: 2, fmt: (v) => `${Math.round(v * 100)}%` },
          { key: "light", label: "lightness", value: lightMul, min: 0, max: 2, fmt: (v) => `${Math.round(v * 100)}%` },
        ].map((s) => (
          <div key={s.key} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 8.5, color: "var(--text-secondary)" }}>{s.label}</span>
            <span style={{ fontSize: 11, color: "var(--text-primary)" }}>{s.fmt(s.value)}</span>
            <input
              type="range" min={s.min} max={s.max} step={(s.max - s.min) / 200} value={s.value}
              onChange={(e) => onSlider(s.key, parseFloat(e.target.value))}
              className="rb-bare-range" style={{ marginTop: 6 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Ground environment (grass/street/city/island) ----------
// the outdoor site slab: 3x its original footprint, with trees, streets, a
// toy skyline, or an island-in-the-ocean scattered around the building
// depending on which of the four world types is currently picked.
const GROUND_SIZE = 150; // 3x the original 50x50 slab
const GROUND_RADIUS = GROUND_SIZE / 2;
const GROUND_EDGE_FADE_FRAC = 0.2; // outer 20% of the radius is the transparent fade band
const GROUND_CORE_RADIUS = GROUND_RADIUS * (1 - GROUND_EDGE_FADE_FRAC);
const GROUND_THEMES = ["grass", "street", "city", "island"];
const GROUND_THEME_LABELS = ["Grass & trees", "Sidewalk & road", "City skyline", "Island & ocean"];
const GROUND_TILE_SIZE = 3; // world meters per texture tile, for every ground-plane pattern below

// a tiny ramp sampled by hardware bilinear filtering rather than
// hand-rasterized -- smooth at any zoom no matter how few texels it holds.
// Mapped along a ring's *radial* UV fraction (see setRadialUV below), so
// only the thin outer band of the site pays any alpha-blending cost at
// all; the big inner disc renders fully opaque.
function makeFadeRamp() {
  const N = 32;
  const data = new Uint8Array(N * 4);
  const EASE_POWER = 1.6; // >1 => slow right off the inner edge, faster toward the outer edge
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1); // 0 at the inner edge, 1 at the outer edge
    const a = Math.round(255 * Math.pow(1 - t, EASE_POWER));
    data[i * 4 + 0] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = a;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
// re-maps a ring/annulus geometry's UV so u runs 0 (inner edge) -> 1 (outer
// edge) uniformly at every angle -- three.js's own ring UVs are a flat
// disc projection, not a radial fraction, so they can't drive a radial
// fade texture directly.
function setRadialUV(geometry, innerRadius, outerRadius) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const r = Math.sqrt(x * x + y * y);
    uv.setXY(i, (r - innerRadius) / (outerRadius - innerRadius), 0.5);
  }
  uv.needsUpdate = true;
}
// re-maps a flat disc/ring's UV to plain world-space meters instead of
// three.js's disc projection, so a repeating tile texture (grass flecks,
// sidewalk pavers, ocean ripple) reads as a consistent grid at every
// radius instead of stretching toward the center.
function setPlanarUV(geometry, tileSize) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / tileSize, pos.getY(i) / tileSize);
  uv.needsUpdate = true;
}
// a small deterministic PRNG (mulberry32) -- the scattered trees/buildings
// stay put across re-renders and toggles instead of reshuffling every
// time, which would look distracting rather than "aesthetically pleasing".
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// scatters `count` points inside a disc of `radius` using `rng`, skipping a
// padded exclusion rectangle (the building's own footprint) and keeping a
// minimum spacing between points -- shared by every theme's trees/
// buildings/palms so they read as deliberately placed, not overlapping.
function scatterPoints(rng, count, radius, exclude, minSpacing) {
  const pts = [];
  let attempts = 0;
  while (pts.length < count && attempts < count * 40) {
    attempts++;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * radius;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (x > exclude.xMin && x < exclude.xMax && z > exclude.zMin && z < exclude.zMax) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.z - z) < minSpacing)) continue;
    pts.push({ x, z, angle: rng() * Math.PI * 2, scale: 0.75 + rng() * 0.6 });
  }
  return pts;
}
// a soft, hand-painted-looking mottled tile (two close tones of one base
// color, in a loose scatter of blotches, wrapped across the tile edges so
// the seam disappears under RepeatWrapping) -- a flat storybook-
// illustration texture instead of one flat, characterless color.
function makeMottledTile(rng, size, baseColor, spotColor, spotCount) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = spotColor;
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < spotCount; i++) {
    const x = rng() * size, y = rng() * size;
    const rx = size * (0.05 + rng() * 0.09), ry = rx * (0.6 + rng() * 0.5);
    const rot = rng() * Math.PI;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, rx, ry, rot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
// a light grid of paver lines over a flat concrete tone -- the "sidewalk"
// pattern, tiled at GROUND_TILE_SIZE via RepeatWrapping.
function makeSidewalkTile(size, cellsPerTile) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#cbc7bc";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#a9a498";
  ctx.lineWidth = Math.max(1, size * 0.012);
  const step = size / cellsPerTile;
  for (let i = 1; i < cellsPerTile; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
// a dark asphalt strip with a dashed centre line and pale curb edges,
// tiled lengthwise (V) via RepeatWrapping so the dashes repeat evenly
// along however long the road plane ends up being.
function makeRoadTexture(size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3d3f42";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#e8d94a";
  ctx.lineWidth = size * 0.035;
  ctx.setLineDash([size * 0.18, size * 0.14]);
  ctx.beginPath(); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#d8d4c8";
  ctx.lineWidth = size * 0.025;
  ctx.beginPath(); ctx.moveTo(0, size * 0.06); ctx.lineTo(size, size * 0.06); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, size * 0.94); ctx.lineTo(size, size * 0.94); ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping; // the road's length axis (U) -- dashes repeat along it
  tex.wrapT = THREE.ClampToEdgeWrapping; // the road's width axis (V) -- one curb-to-curb span, no repeat
  tex.needsUpdate = true;
  return tex;
}

export default function RoomBuilder() {
  const mountRef = useRef(null);
  const hudRef = useRef(null);
  const heightLabelRef = useRef(null);
  const dividerHandleRef = useRef(null);
  const dividerVLineRef = useRef(null);
  const dividerHLineRef = useRef(null);
  const measureLayerRef = useRef(null);
  const floorLabelLayerRef = useRef(null);
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
  const uiThemeRef = useRef(uiTheme);
  useEffect(() => { uiThemeRef.current = uiTheme; }, [uiTheme]);
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
  // "grid" (the default mullioned pane), "round", or "louver" -- see
  // renderOpeningCutout for how each renders.
  const [openingStyle, setOpeningStyle] = useState("grid");
  const openingStyleRef = useRef(openingStyle);
  useEffect(() => { openingStyleRef.current = openingStyle; }, [openingStyle]);
  const [doorHeight, setDoorHeight] = useState(10 * FT);
  const doorHeightRef = useRef(doorHeight);
  useEffect(() => { doorHeightRef.current = doorHeight; }, [doorHeight]);
  const [doorSplit, setDoorSplit] = useState(false);
  const doorSplitRef = useRef(doorSplit);
  useEffect(() => { doorSplitRef.current = doorSplit; }, [doorSplit]);
  // "standard" (plain rectangular head), "arched", "revolving", or
  // "turnstile" -- the latter two replace the door leaf entirely with a
  // freestanding assembly, see renderOpeningCutout/renderDoorAssembly.
  const [doorStyle, setDoorStyle] = useState("standard");
  const doorStyleRef = useRef(doorStyle);
  useEffect(() => { doorStyleRef.current = doorStyle; }, [doorStyle]);
  const [propsShape, setPropsShape] = useState("cube");
  const propsShapeRef = useRef(propsShape);
  useEffect(() => { propsShapeRef.current = propsShape; }, [propsShape]);
  const [columnShape, setColumnShape] = useState("none");
  const columnShapeRef = useRef(columnShape);
  useEffect(() => { columnShapeRef.current = columnShape; }, [columnShape]);
  const [pillarShape, setPillarShape] = useState("none");
  const pillarShapeRef = useRef(pillarShape);
  useEffect(() => { pillarShapeRef.current = pillarShape; }, [pillarShape]);
  const [selectedFloorPillarsId, setSelectedFloorPillarsId] = useState(null);
  const selectedFloorPillarsIdRef = useRef(selectedFloorPillarsId);
  useEffect(() => { selectedFloorPillarsIdRef.current = selectedFloorPillarsId; rebuildModelRef.current(); }, [selectedFloorPillarsId]);
  const deleteFloorPillarsRef = useRef(() => {});
  const [wallThickness, setWallThickness] = useState(0.35);
  const [ceilingOn, setCeilingOn] = useState(false);
  // mirrors ceilingEnabled across every floor (not just the active one) so
  // each layer row's own ceiling toggle can render checked/unchecked
  // correctly without switching floors first.
  const [ceilingFloorIds, setCeilingFloorIds] = useState([]);
  const toggleFloorCeilingRef = useRef(() => {});
  const ceilingApiRef = useRef({ setEnabled: () => {} });
  const [groundOn, setGroundOn] = useState(false);
  const groundApiRef = useRef({ setEnabled: () => {} });
  // which outdoor world the ground shows -- 0 grass/trees, 1 sidewalk+road,
  // 2 city skyline, 3 island+ocean. The quadrant button in the Layers
  // panel (shown only once Ground is on) cycles through these on tap.
  const [groundTheme, setGroundTheme] = useState(0);
  const groundThemeApiRef = useRef(() => {});
  useEffect(() => { groundThemeApiRef.current(groundTheme); }, [groundTheme]);
  const wallThicknessApiRef = useRef({ setThickness: () => {} });
  const sceneIoApiRef = useRef({ save: () => null, load: () => {} });
  // "Recent" scenes -- a browser-local (localStorage) autosave history,
  // since there's no server to persist to. Every 15s the whole scene
  // (every floor, same shape undo/redo already snapshots) plus a thumbnail
  // gets saved under the current session's scene id; "New scene" starts a
  // fresh id so it becomes its own new history entry instead of overwriting
  // the one just left.
  const RECENT_SCENES_KEY = "roombuilder.recentScenes.v1";
  const MAX_RECENT_SCENES = 14;
  const [recentScenes, setRecentScenes] = useState([]);
  const currentSceneIdRef = useRef(`scene_${Date.now()}`);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_SCENES_KEY);
      if (raw) setRecentScenes(JSON.parse(raw));
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) -- the
      // Recent panel just stays empty for this session rather than erroring.
    }
  }, []);
  function autosaveScene() {
    const snap = sceneIoApiRef.current.save();
    if (!snap) return;
    let thumb = null;
    try {
      const canvas = thumbCanvasMapRef.current.get(activeFloorIdRef.current);
      if (canvas) thumb = canvas.toDataURL("image/png");
    } catch {
      // canvas may be tainted or momentarily unavailable -- keep whatever
      // thumbnail this entry already had rather than failing the save.
    }
    setRecentScenes((prev) => {
      const id = currentSceneIdRef.current;
      const idx = prev.findIndex((s) => s.id === id);
      const entry = {
        id,
        name: idx >= 0 ? prev[idx].name : `Scene ${prev.length + 1}`,
        savedAt: Date.now(),
        snapshot: snap,
        thumb: thumb || (idx >= 0 ? prev[idx].thumb : null),
      };
      const next = idx >= 0 ? [...prev.slice(0, idx), entry, ...prev.slice(idx + 1)] : [entry, ...prev].slice(0, MAX_RECENT_SCENES);
      try { localStorage.setItem(RECENT_SCENES_KEY, JSON.stringify(next)); } catch {
        // over quota or unavailable -- the in-memory list (this render)
        // still works for the rest of the session, it just won't survive
        // a reload.
      }
      return next;
    });
  }
  useEffect(() => {
    const interval = setInterval(autosaveScene, 15000);
    return () => clearInterval(interval);
  }, []);
  function loadRecentScene(entry) {
    currentSceneIdRef.current = entry.id;
    sceneIoApiRef.current.load(entry.snapshot);
  }
  // the 5 built-in starting-point presets are read-only, so loading one
  // starts a fresh scene id (like "New scene" does) rather than reusing the
  // preset's own id -- edits autosave as their own new Recent entry instead
  // of ever overwriting the preset.
  function loadPresetScene(preset) {
    currentSceneIdRef.current = `scene_${Date.now()}`;
    sceneIoApiRef.current.load(preset.snapshot);
  }
  const [lightAzimuth, setLightAzimuth] = useState(45);
  const lightAzimuthApiRef = useRef(() => {});
  useEffect(() => { lightAzimuthApiRef.current(lightAzimuth); }, [lightAzimuth]);
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
  const [selectedTerraceId, setSelectedTerraceId] = useState(null);
  const selectedTerraceIdRef = useRef(selectedTerraceId);
  useEffect(() => { selectedTerraceIdRef.current = selectedTerraceId; rebuildModelRef.current(); }, [selectedTerraceId]);
  const deleteTerraceRef = useRef(() => {});
  const [selectedSuppBalconyId, setSelectedSuppBalconyId] = useState(null);
  const selectedSuppBalconyIdRef = useRef(selectedSuppBalconyId);
  useEffect(() => { selectedSuppBalconyIdRef.current = selectedSuppBalconyId; rebuildModelRef.current(); }, [selectedSuppBalconyId]);
  const deleteSuppBalconyRef = useRef(() => {});
  const [suppBalconyHeight, setSuppBalconyHeight] = useState(6 * FT);
  const suppBalconyHeightApiRef = useRef({ setHeight: () => {} });
  const [suppBalconyRailingCount, setSuppBalconyRailingCount] = useState(6);
  const suppBalconyRailingCountApiRef = useRef({ setCount: () => {} });
  const [selectedOpeningId, setSelectedOpeningId] = useState(null); // a window or door cutout in a wall
  const selectedOpeningIdRef = useRef(selectedOpeningId);
  useEffect(() => { selectedOpeningIdRef.current = selectedOpeningId; rebuildModelRef.current(); }, [selectedOpeningId]);
  const [selectedPropId, setSelectedPropId] = useState(null); // a placed sphere/cube/cone/cylinder prop
  const selectedPropIdRef = useRef(selectedPropId);
  useEffect(() => { selectedPropIdRef.current = selectedPropId; rebuildModelRef.current(); }, [selectedPropId]);
  const [balconyStairHeight, setBalconyStairHeight] = useState(5 * FT);
  const balconyHeightApiRef = useRef({ setHeight: () => {} });
  const [balconyPlatformWidth, setBalconyPlatformWidth] = useState(10 * FT);
  const balconyWidthApiRef = useRef({ setWidth: () => {} });
  const [balconyPillarCount, setBalconyPillarCount] = useState(8);
  const balconyPillarCountApiRef = useRef({ setCount: () => {} });
  const [balconyPillarHeight, setBalconyPillarHeight] = useState(3 * FT);
  const balconyPillarHeightApiRef = useRef({ setHeight: () => {} });
  const [balconyGlassInfill, setBalconyGlassInfill] = useState(false);
  const balconyGlassApiRef = useRef({ setEnabled: () => {} });
  // "supported" (posts, no ceiling -- the classic look), "recessed" (a
  // ceiling slab overhead, no posts -- reads as tucked under the building),
  // or "cantilevered" (neither -- a bare floating slab). Maps onto the
  // existing pillarsRemoved/ceilingRemoved flags rather than new geometry.
  const [balconyStyle, setBalconyStyle] = useState("supported");
  const balconyStyleRef = useRef(balconyStyle);
  useEffect(() => { balconyStyleRef.current = balconyStyle; }, [balconyStyle]);
  const balconyStyleApiRef = useRef({ setStyle: () => {} });
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
  // how far the slider can go for the currently selected room -- half its
  // shorter footprint dimension, so dragging all the way to the end always
  // reaches a true full circle/cylinder rather than stopping at a fixed cap.
  const curvedCornersMaxRadiusRef = useRef(2.5);
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
  const [tintInactiveOn, setTintInactiveOn] = useState(true);
  const [tintInactiveColor, setTintInactiveColor] = useState(0xff6b1a);
  const tintInactiveApiRef = useRef(() => {});
  useEffect(() => { tintInactiveApiRef.current(tintInactiveOn, tintInactiveColor); }, [tintInactiveOn, tintInactiveColor]);
  const [tintActiveOn, setTintActiveOn] = useState(true);
  const [tintActiveColor, setTintActiveColor] = useState(0xffffff);
  const tintActiveApiRef = useRef(() => {});
  useEffect(() => { tintActiveApiRef.current(tintActiveOn, tintActiveColor); }, [tintActiveOn, tintActiveColor]);
  const [themeWheelOpen, setThemeWheelOpen] = useState(false);
  // defaults beside the Layers panel, in the lower-left corner of the 3D
  // viewport, with a real buffer from the panel edge and the ribbon below
  // it -- not sitting on top of the panel, and not dead center over the
  // user's work area the moment it's opened.
  const [themeWheelPos, setThemeWheelPos] = useState(() => {
    const wheelHalf = 136; // half of the wheel overlay's own 272px size
    const edgeBuffer = 36;
    const defaultPanelWidth = 148;
    const ribbonHeight = 48;
    return {
      x: defaultPanelWidth + edgeBuffer + wheelHalf,
      y: typeof window !== "undefined" ? Math.max(320, window.innerHeight - ribbonHeight - edgeBuffer - wheelHalf) : 420,
    };
  });
  // { type: "hue", hueDeg, ring } | { type: "grey", step, midLight } | { type: "theme", name, ring } | null
  const [themeAnchor, setThemeAnchor] = useState(null);
  const themeApiRef = useRef(() => {});
  // global wheel sliders -- re-tint whatever's currently picked (anchor or
  // theme) without changing what's picked itself.
  const [themeHueShift, setThemeHueShift] = useState(0);
  const [themeSatMul, setThemeSatMul] = useState(1);
  const [themeLightMul, setThemeLightMul] = useState(1);
  useEffect(() => {
    themeApiRef.current(themeAnchor, { hueShift: themeHueShift, satMul: themeSatMul, lightMul: themeLightMul });
  }, [themeAnchor, themeHueShift, themeSatMul, themeLightMul]);
  // which grid the wheel currently shows -- "hue" (the generic 12-hue x
  // 6-ring tonal disc) or "theme" (the 12 named image-derived themes).
  // Tapping the hub only flips this; it never applies a color by itself.
  const [themeWheelMode, setThemeWheelMode] = useState("hue");
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
  const activeFloorIdRef = useRef(activeFloorIdState);
  useEffect(() => { activeFloorIdRef.current = activeFloorIdState; }, [activeFloorIdState]);
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
  // drag-a-layer-onto-the-Duplicate/Delete-button targets, tracked
  // separately from the row-reorder dropInfo above since they're a
  // different kind of drop target (a button, not another row).
  const dupBtnRef = useRef(null);
  const delBtnRef = useRef(null);
  const [dragOverAction, setDragOverAction] = useState(null);
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
    // the empty-space backdrop and its matching fog color -- pixel-identical
    // to the Layers/Recent panels' own --bg-panel in each theme (#e8e8e8
    // light, #2c2c2e dark), so spinning the 3D view right up against the
    // sidebar shows no seam at all, rather than a distinct tone of its own.
    const VIEWPORT_BG_LIGHT = 0xe5e5e5;
    const VIEWPORT_BG_DARK = 0x2c2c2e;
    function applyViewportTheme(theme) {
      const c = theme === "light" ? VIEWPORT_BG_LIGHT : VIEWPORT_BG_DARK;
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
    // a low sun (30 degrees above the horizon, was 45) for longer, more
    // dramatic shadows -- azimuth (compass direction around the room) is
    // adjustable at runtime via the light-direction slider, defaulting to
    // the same 45-degrees-off-both-wall-axes direction as before.
    // Kept ~98% neutral (just a whisper of warmth) rather than a strong
    // orange cast, so every surface's own color reads true instead of
    // being tinted by the light.
    const KEY_LIGHT_HORIZ_DIST = 28.284;
    const KEY_LIGHT_ELEVATION_DEG = 30;
    const KEY_LIGHT_DEFAULT_AZIMUTH_DEG = 45;
    const keyLight = new THREE.DirectionalLight(0xfff6ee, 1.2);
    function setKeyLightAzimuth(azimuthDeg) {
      const az = (azimuthDeg * Math.PI) / 180;
      const y = KEY_LIGHT_HORIZ_DIST * Math.tan((KEY_LIGHT_ELEVATION_DEG * Math.PI) / 180);
      keyLight.position.set(KEY_LIGHT_HORIZ_DIST * Math.cos(az), y, KEY_LIGHT_HORIZ_DIST * Math.sin(az));
    }
    setKeyLightAzimuth(KEY_LIGHT_DEFAULT_AZIMUTH_DEG);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    // wide enough to cover a large room plus the long, low-angle shadows a
    // tall building throws at a low sun -- bigger than the old +-10 (which
    // was clipping shadows off well inside a 25m room).
    keyLight.shadow.camera.left = -40;
    keyLight.shadow.camera.right = 40;
    keyLight.shadow.camera.top = 40;
    keyLight.shadow.camera.bottom = -40;
    keyLight.shadow.radius = 1.5; // crisp edge -- a dramatic low sun reads as a sharp line, not a soft blur
    keyLight.shadow.bias = -0.0004; // reduces shadow acne without visible peter-panning
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);
    // a near-neutral skylight fill (barely cool) -- just enough to keep
    // shadowed faces from going pure black, without tinting them.
    const fillLight = new THREE.DirectionalLight(0xf3f6ff, 0.4);
    fillLight.position.set(-6, 4, -5);
    scene.add(fillLight);
    lightAzimuthApiRef.current = setKeyLightAzimuth;
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

    // a big outdoor site slab under the room (3x the original 50x50m, so a
    // building smaller than that still reads as sitting on real ground
    // rather than a postage stamp), sitting just below the room floor slab
    // (which spans y=-0.08 to y=0) so the two never z-fight. Off by default
    // (a toggle in the Layers panel). Split into two pieces rather than one
    // big alpha-blended quad: a fully opaque inner disc (cheap to draw --
    // early-z, no blending) plus a thin transparent ring right at the edge
    // that fades to the scene background. Only that thin ring pays any
    // blending cost at all, and its fade ramp is a tiny texture read via
    // hardware bilinear filtering rather than a hand-rasterized gradient,
    // so it stays perfectly smooth at any zoom instead of banding.
    const groundGroup = new THREE.Group();
    groundGroup.position.y = -0.1;
    groundGroup.visible = false;
    scene.add(groundGroup);

    const groundFadeTex = makeFadeRamp();
    const groundFadeGeo = new THREE.RingGeometry(GROUND_CORE_RADIUS, GROUND_RADIUS, 128, 1);
    setRadialUV(groundFadeGeo, GROUND_CORE_RADIUS, GROUND_RADIUS);
    const groundFadeMat = new THREE.MeshStandardMaterial({
      color: 0x9a9a9a, roughness: 0.95, metalness: 0, transparent: true, alphaMap: groundFadeTex,
    });
    const groundFadeMesh = new THREE.Mesh(groundFadeGeo, groundFadeMat);
    groundFadeMesh.rotation.x = -Math.PI / 2;
    groundFadeMesh.receiveShadow = true;
    groundGroup.add(groundFadeMesh);

    // the theme-specific content (the opaque core plane plus whatever
    // decorations that world adds) lives in its own group so switching
    // worlds can cleanly clear+rebuild just this part without touching the
    // always-present fade ring above.
    const envContentGroup = new THREE.Group();
    groundGroup.add(envContentGroup);

    // the building's own world-space footprint (its own base plus every
    // room pulled out of it, on every floor) -- decorations are scattered
    // around this rectangle (padded out a bit) rather than through it.
    function computeBuildingBoundsXZ() {
      let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
      floors.forEach((f) => {
        const fp = f.data.footprint, ox = f.offsetX || 0, oz = f.offsetZ || 0;
        xMin = Math.min(xMin, fp.xMin + ox); xMax = Math.max(xMax, fp.xMax + ox);
        zMin = Math.min(zMin, fp.zMin + oz); zMax = Math.max(zMax, fp.zMax + oz);
        (f.rooms || []).forEach((r) => {
          const rfp = r.data.footprint, rox = r.offsetX || 0, roz = r.offsetZ || 0;
          xMin = Math.min(xMin, rfp.xMin + rox); xMax = Math.max(xMax, rfp.xMax + rox);
          zMin = Math.min(zMin, rfp.zMin + roz); zMax = Math.max(zMax, rfp.zMax + roz);
        });
      });
      if (!isFinite(xMin)) return { xMin: -DEFAULT_ROOM_HALF_X, xMax: DEFAULT_ROOM_HALF_X, zMin: -DEFAULT_ROOM_HALF_Z, zMax: DEFAULT_ROOM_HALF_Z };
      return { xMin, xMax, zMin, zMax };
    }

    // a matched pair of InstancedMesh (trunk + canopy) -- one draw call per
    // part no matter how many trees, so a whole forest costs about as much
    // as a single tree would.
    function addTrees(rng, points, group, opts) {
      if (!points.length) return;
      const { trunkColor, canopyColors, trunkH = [1.1, 1.9], canopyR = [0.9, 1.6] } = opts;
      const trunkMesh = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.11, 0.16, 1, 6),
        new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.9 }),
        points.length
      );
      trunkMesh.castShadow = true; trunkMesh.receiveShadow = true;
      const canopyMesh = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1, 1, 7),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
        points.length
      );
      canopyMesh.castShadow = true; canopyMesh.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
      points.forEach((p, i) => {
        const th = (trunkH[0] + rng() * (trunkH[1] - trunkH[0])) * p.scale;
        const cr = (canopyR[0] + rng() * (canopyR[1] - canopyR[0])) * p.scale;
        const ch = cr * 1.8;
        m.compose(new THREE.Vector3(p.x, th / 2, p.z), q, new THREE.Vector3(1, th, 1));
        trunkMesh.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(p.x, th + ch * 0.42, p.z), q, new THREE.Vector3(cr, ch, cr));
        canopyMesh.setMatrixAt(i, m);
        canopyMesh.setColorAt(i, col.set(canopyColors[i % canopyColors.length]));
      });
      trunkMesh.instanceMatrix.needsUpdate = true;
      canopyMesh.instanceMatrix.needsUpdate = true;
      canopyMesh.instanceColor.needsUpdate = true;
      group.add(trunkMesh, canopyMesh);
    }
    // one InstancedMesh of unit cubes, each independently scaled/rotated/
    // tinted -- reads as "a city full of different little towers" for the
    // cost of a single draw call.
    function addBuildings(rng, points, group) {
      if (!points.length) return;
      const palette = [0xdff0f7, 0xffe3c2, 0xffd0da, 0xd7ead2, 0xe4d7f5, 0xfff3b0];
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }),
        points.length
      );
      mesh.castShadow = true; mesh.receiveShadow = true;
      const m = new THREE.Matrix4(), col = new THREE.Color();
      points.forEach((p, i) => {
        const w = (2.2 + rng() * 2.4) * p.scale, d = (2.2 + rng() * 2.4) * p.scale, h = (3 + rng() * 9) * p.scale;
        m.compose(
          new THREE.Vector3(p.x, h / 2, p.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.angle),
          new THREE.Vector3(w, h, d)
        );
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.set(palette[Math.floor(rng() * palette.length)]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
    }
    function tiledCoreMesh(radius, texture) {
      const geo = new THREE.CircleGeometry(radius, 96);
      setPlanarUV(geo, GROUND_TILE_SIZE);
      texture.repeat.set((radius * 2) / GROUND_TILE_SIZE, (radius * 2) / GROUND_TILE_SIZE);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.95 }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.receiveShadow = true;
      return mesh;
    }
    function buildGrassGround(bounds) {
      const rngTex = makeRng(77);
      envContentGroup.add(tiledCoreMesh(GROUND_CORE_RADIUS, makeMottledTile(rngTex, 256, "#8bc76a", "#6fae55", 26)));
      const padded = { xMin: bounds.xMin - 2.5, xMax: bounds.xMax + 2.5, zMin: bounds.zMin - 2.5, zMax: bounds.zMax + 2.5 };
      const rng = makeRng(99);
      const pts = scatterPoints(rng, 30, GROUND_CORE_RADIUS - 6, padded, 3.2);
      addTrees(rng, pts, envContentGroup, { trunkColor: 0x8a5a3d, canopyColors: [0x6fae55, 0x8bc76a, 0x579a48] });
    }
    function buildStreetGround(bounds) {
      envContentGroup.add(tiledCoreMesh(GROUND_CORE_RADIUS, makeSidewalkTile(256, 3)));
      const roadWidth = 9, roadLength = GROUND_SIZE * 0.92;
      const roadTex = makeRoadTexture(256);
      roadTex.repeat.set(roadLength / 8, 1);
      // PlaneGeometry's local X becomes world X after the flat rotation below
      // (local Y becomes world Z) -- length first, width second, so the road
      // actually runs along the building's front instead of through its depth.
      const road = new THREE.Mesh(new THREE.PlaneGeometry(roadLength, roadWidth), new THREE.MeshStandardMaterial({ color: 0xffffff, map: roadTex, roughness: 0.85 }));
      road.rotation.x = -Math.PI / 2;
      road.position.set(0, 0.015, bounds.zMax + 6 + roadWidth / 2);
      road.receiveShadow = true;
      envContentGroup.add(road);
      // a short row of lamp posts along the sidewalk side of the road
      const rng = makeRng(4242);
      const postPts = [];
      const postX0 = -roadLength * 0.42, postSpacing = roadLength * 0.14;
      for (let i = 0; i < 7; i++) postPts.push({ x: postX0 + i * postSpacing, z: road.position.z - roadWidth / 2 - 0.6, angle: 0, scale: 1 });
      const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 6), new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6 }), postPts.length);
      const lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0x6b5620, roughness: 0.4 }), postPts.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion();
      postPts.forEach((p, i) => {
        m.compose(new THREE.Vector3(p.x, 1.5, p.z), q, new THREE.Vector3(1, 1, 1));
        postMesh.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(p.x, 3.05, p.z), q, new THREE.Vector3(1, 1, 1));
        lampMesh.setMatrixAt(i, m);
      });
      postMesh.instanceMatrix.needsUpdate = true; lampMesh.instanceMatrix.needsUpdate = true;
      postMesh.castShadow = true; postMesh.receiveShadow = true;
      envContentGroup.add(postMesh, lampMesh);
      void rng; // reserved for future street-side variety
    }
    function buildCityGround(bounds) {
      envContentGroup.add(tiledCoreMesh(GROUND_CORE_RADIUS, makeSidewalkTile(256, 2)));
      const padded = { xMin: bounds.xMin - 4, xMax: bounds.xMax + 4, zMin: bounds.zMin - 4, zMax: bounds.zMax + 4 };
      const rng = makeRng(555);
      const pts = scatterPoints(rng, 26, GROUND_CORE_RADIUS - 8, padded, 5.5);
      addBuildings(rng, pts, envContentGroup);
    }
    function buildIslandGround(bounds) {
      const sandRadius = Math.max(bounds.xMax - bounds.xMin, bounds.zMax - bounds.zMin) * 0.9 + 8;
      const sandRng = makeRng(3);
      const sand = tiledCoreMesh(sandRadius, makeMottledTile(sandRng, 256, "#eddca2", "#e0c986", 18));
      sand.position.y = 0.02; // the island sits a hair above the ocean ring, without poking above the room's own floor
      envContentGroup.add(sand);

      const oceanGeo = new THREE.RingGeometry(sandRadius, GROUND_CORE_RADIUS, 96, 1);
      setPlanarUV(oceanGeo, GROUND_TILE_SIZE * 1.5);
      const oceanRng = makeRng(9);
      const oceanTex = makeMottledTile(oceanRng, 256, "#6ec6e0", "#8ad7ea", 22);
      oceanTex.repeat.set((GROUND_CORE_RADIUS * 2) / (GROUND_TILE_SIZE * 1.5), (GROUND_CORE_RADIUS * 2) / (GROUND_TILE_SIZE * 1.5));
      const oceanMesh = new THREE.Mesh(oceanGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, map: oceanTex, roughness: 0.4, metalness: 0.05 }));
      oceanMesh.rotation.x = -Math.PI / 2;
      oceanMesh.receiveShadow = true;
      envContentGroup.add(oceanMesh);

      const padded = { xMin: bounds.xMin - 2, xMax: bounds.xMax + 2, zMin: bounds.zMin - 2, zMax: bounds.zMax + 2 };
      const rng = makeRng(21);
      const pts = scatterPoints(rng, 10, sandRadius - 2, padded, 3.5);
      addTrees(rng, pts, envContentGroup, { trunkColor: 0xb08a5a, canopyColors: [0x6fae55, 0x8bc76a], trunkH: [1.6, 2.4], canopyR: [0.6, 0.95] });
    }
    const GROUND_FADE_TINTS = { grass: 0x8fae7c, street: 0x9a9a9a, city: 0x9a9a9a, island: 0x4a8fae };
    let currentGroundTheme = 0;
    function applyGroundTheme(themeIndex) {
      currentGroundTheme = themeIndex;
      clearGroup(envContentGroup);
      const key = GROUND_THEMES[themeIndex] || "grass";
      groundFadeMat.color.set(GROUND_FADE_TINTS[key]);
      const bounds = computeBuildingBoundsXZ();
      if (key === "grass") buildGrassGround(bounds);
      else if (key === "street") buildStreetGround(bounds);
      else if (key === "city") buildCityGround(bounds);
      else buildIslandGround(bounds);
    }
    groundThemeApiRef.current = applyGroundTheme;
    groundApiRef.current = {
      setEnabled: (on) => {
        groundGroup.visible = on;
        // refreshed against whatever the building looks like right now,
        // each time the ground is actually switched on to look at.
        if (on) applyGroundTheme(currentGroundTheme);
      },
    };

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
    // A second, much more detailed environment used only for reflections on
    // glass and "shiny" finishes (metal/gloss/railings) -- a high-contrast
    // cityscape silhouette (dark buildings), a bright sky, and a very hot
    // sun hotspot, so a reflective surface actually reads as reflecting a
    // real place instead of a flat gradient. Generated procedurally (same
    // PMREMGenerator approach as the soft ambient one above) rather than
    // fetched from an external HDRI file -- no network dependency, and it
    // works the same whether this ships on GitHub Pages or inlined into an
    // Artifact page with a strict CDN allowlist that wouldn't permit
    // fetching a real .hdr file anyway.
    function buildReflectionEnvironmentScene() {
      const envScene = new THREE.Scene();
      const skyRadius = 45;
      const skyGeo = new THREE.SphereGeometry(skyRadius, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2);
      // a bright, punchy sky -- near-white at the horizon, a saturated blue
      // overhead, noticeably brighter than the soft ambient sky so it reads
      // as "high contrast" against the dark building silhouettes below it.
      paintVerticalGradient(skyGeo, skyRadius, new THREE.Color(0xdfe9f5).multiplyScalar(1.4), new THREE.Color(0x2f6fd8).multiplyScalar(1.6));
      const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
      envScene.add(sky);
      // a ring of dark, varied-height building silhouettes -- what actually
      // gives a reflection its "cityscape" read, rather than just a plain
      // gradient with a bright spot in it.
      // pushed out further and kept shorter than before -- at the old
      // 16-26 distance / up-to-30 height, buildings subtended 50+ degrees
      // from the origin and blotted out almost the entire sky, leaving no
      // bright band for a reflection to pick up. A distant, modest-height
      // ring reads as a proper skyline silhouette with open sky above it.
      const buildingCount = 34;
      const cityMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
      for (let i = 0; i < buildingCount; i++) {
        const angle = (i / buildingCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
        const dist = 30 + Math.random() * 12;
        const h = 3 + Math.random() * 13;
        const w = 2.5 + Math.random() * 4;
        const geo = new THREE.BoxGeometry(w, h, w);
        const mesh = new THREE.Mesh(geo, cityMat);
        mesh.position.set(Math.cos(angle) * dist, h / 2, Math.sin(angle) * dist);
        mesh.rotation.y = Math.random() * Math.PI;
        envScene.add(mesh);
      }
      const ground = new THREE.Mesh(
        new THREE.SphereGeometry(skyRadius, 16, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x050506, side: THREE.BackSide })
      );
      envScene.add(ground);
      // a very hot, tight sun hotspot -- placed along the same direction as
      // keyLight so it agrees with the actual shadow-casting light, but far
      // brighter than the soft environment's own sun since this map is only
      // ever used for point-like specular reflections, never as broad IBL.
      const sunDir = keyLight.position.clone().normalize();
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 16, 16),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4d8).multiplyScalar(40) })
      );
      sun.position.copy(sunDir.multiplyScalar(skyRadius * 0.97));
      envScene.add(sun);
      return envScene;
    }
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const realisticEnvMap = pmremGenerator.fromScene(buildSoftEnvironmentScene(), 0.04).texture;
    // a lower sigma (less blur) than the soft ambient map -- this one wants
    // to stay crisp enough that the buildings/sun hotspot actually read as
    // shapes in a reflection, not another smooth gradient.
    const reflectionEnvMap = pmremGenerator.fromScene(buildReflectionEnvironmentScene(), 0.015).texture;
    pmremGenerator.dispose();

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // default AO radius (0.25 world units) only catches tight crevices --
    // widened (3x again here) so the contact shadow spreads out softly
    // across the floor near a wall, rather than a small sharp smudge right
    // in the corner. A lower distanceExponent spreads the falloff out
    // further instead of concentrating it close-in, and a lower
    // blendIntensity keeps corners from crushing to near-black.
    const gtaoPass = new GTAOPass(scene, camera, width, height, undefined, {
      radius: 3.3,
      distanceExponent: 0.7,
      thickness: 1,
      distanceFallOff: 0.5,
      scale: 1.4,
    });
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 0.9;
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
    // warm wood-plank look: horizontal streaky grain (layered sine noise,
    // stretched along one axis) cut into a few long planks by darker seam
    // lines -- painted light/low-contrast like the other finish textures so
    // it reads as pure shading once multiplied by the room's active color.
    function makeWoodTexture(size) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const grain =
            Math.sin(y * 0.35 + Math.sin(x * 0.05) * 3) * 10 +
            Math.sin(y * 1.7 + x * 0.02) * 6 +
            (Math.random() - 0.5) * 10;
          const v = Math.min(255, Math.max(0, 222 + grain));
          const i = (y * size + x) * 4;
          img.data[i + 0] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = "rgba(70,55,38,0.35)";
      ctx.lineWidth = Math.max(1, size * 0.01);
      const planks = 5;
      for (let i = 1; i < planks; i++) {
        const y = (size / planks) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y);
        ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(4, 4);
      return tex;
    }
    const woodTex = makeWoodTexture(256);

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
        terraces: [], // {id, panel, u0, u1, side, depth} -- a flat roof-height deck with a perimeter railing, drawn along a wall like a balcony but with no stairs down to the ground
        columnBanks: [], // {id, panel, shape, u0, u1} -- a run of 5 evenly-spaced wall columns (square/round), drawn along a wall with the Wall tool
        suppBalconies: [], // {id, panel, u0, u1, side, platformHeight, railingCount} -- a thin floating platform on 2 corner pillars reaching the floor, a glass door, and a roof canopy, no stairs
        floorPillars: [], // {id, x0, x1, z0, z1, shape} -- a floor-area rectangle filled with a grid of floor-to-(ceiling-1ft) pillars (round/square), drawn with the Wall tool's Pillar mode
        ceilingEnabled: false, // a purely decorative slab at wall-height -- never a raycast target; off by default (transparent ceilings noticeably slowed the UI)
      };
    }
    let idSeq = 1;
    let nextFloorId = 2;
    let floors = [{ id: 1, data: makeFloorData(), rooms: [] }];
    let activeFloorId = 1;
    let activeRoomId = null; // id of the room (within the active floor) currently focused for editing, or null for the floor itself
    // true when activeRoomId was set programmatically (e.g. right after an
    // auto-split) rather than by the user tapping into the room -- suppresses
    // the "selected" floor highlight for that one entry without touching
    // pickability, which is keyed off activeRoomId alone.
    let activeRoomSilent = false;
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
      previewColumnBank = null;
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
    // the whole-scene save/load used by the Recent-scenes autosave system --
    // reuses the exact same {floors, activeFloorId} snapshot shape as undo/
    // redo, since it's already a complete, plain-JSON description of every
    // floor's rooms.
    sceneIoApiRef.current = { save: snapshotFloors, load: applySnapshot };

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

    // if a balcony's drawn span reaches all the way to one of its wall's
    // own ends (a real building corner rather than just a spot along a
    // flat run), it wraps 90° onto the adjacent wall sharing that corner
    // -- a short perpendicular wing roughly 5ft long. Reuses the same
    // CORNER_MAP the curved-corner clipping above uses to find which wall
    // shares which corner. Only exterior base walls (not partitions or
    // pulled-out bump-out faces) support this.
    const BALCONY_WRAP_LEN = 5 * FT;
    const BALCONY_WRAP_THRESHOLD = 1.5 * FT;
    function computeBalconyWraps(panelKey, u0, u1) {
      if (!wallDefs[panelKey]) return [];
      const [spanMin, spanMax] = wallSpan(panelKey);
      const wraps = [];
      [["min", u0 - spanMin], ["max", spanMax - u1]].forEach(([edge, gap]) => {
        if (gap > BALCONY_WRAP_THRESHOLD) return;
        const mapping = CORNER_MAP[panelKey + ":" + edge];
        if (!mapping) return;
        const [adjPanel, adjEdge] = mapping;
        const [adjMin, adjMax] = wallSpan(adjPanel);
        const wingU0 = adjEdge === "min" ? adjMin : Math.max(adjMin, adjMax - BALCONY_WRAP_LEN);
        const wingU1 = adjEdge === "min" ? Math.min(adjMax, adjMin + BALCONY_WRAP_LEN) : adjMax;
        if (wingU1 - wingU0 > 1 * FT) wraps.push({ corner: adjEdge, panel: adjPanel, u0: wingU0, u1: wingU1 });
      });
      return wraps;
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
        // widening the bump-out can newly overlap an opening that used to
        // sit entirely on the flat parent wall -- same reassignment as at
        // creation time, so that part of it moves onto the bump-out's face.
        splitOpeningsAcrossBump(bo.panel, bo.u0, bo.u1, bo.id);
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
        const v = Math.max(-(span - MIN_SIZE), depth);
        // pushed close enough to the far wall to be deliberately reaching
        // for it -- snap the rest of the way flush instead of stopping
        // MIN_SIZE short, mirroring how a dragged partition already snaps
        // flush near the opposite wall (see clampPartitionExt).
        return depth < -(span - CLOSE_SNAP_DIST) ? -span : v;
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
    // dark metal by default -- reads better against a concrete finish than
    // a wall-tinted panel did; a room theme still tints .color on top (a
    // hue-tinted metal rail, e.g. neon blue), but the low roughness/high
    // metalness stays fixed so it always looks like metal hardware.
    const PILLAR_DEFAULT_COLOR = 0x474747; // 10% lighter than the previous 0x333333
    const pillarMat = new THREE.MeshStandardMaterial({ color: PILLAR_DEFAULT_COLOR, roughness: 0.32, metalness: 0.8, envMapIntensity: 1.4, envMap: reflectionEnvMap });
    const pillarMatSelected = new THREE.MeshStandardMaterial({ color: new THREE.Color(PILLAR_DEFAULT_COLOR).lerp(new THREE.Color(COLORS.highlight), 0.7), roughness: 0.32, metalness: 0.8, envMapIntensity: 1.4, envMap: reflectionEnvMap });
    // window/door mullions get their own dark frame material -- 80% of the
    // way to black by default, distinct from the railings' metal hardware
    // (less metallic, more like a painted/anodized frame than raw metal).
    const mullionMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.4 });
    // the balcony platform gets its own material too -- a room theme colors
    // it independently from the room's own floor; by default (no theme
    // picked) it matches the wall color instead, same as the balcony's own
    // roof below.
    const balconyPlatformMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.35 });
    // a balcony's own covered ceiling gets its own material too, rather
    // than always just following the walls -- a room theme can give it a
    // deliberately contrasting (often complementary-hue) "roof" color.
    const balconyRoofMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.35 });
    // decorative room ceiling -- 10% transparent (90% opaque) so it doesn't
    // block editing visibility from above; never added to pickList.
    const ceilingMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.6, envMapIntensity: 0.35 });
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
    // a selected prop's own thin white outline, reused for a selected
    // window/door too -- both now read as "a crisp white line plus orange
    // corner/edge handles" rather than windows/doors getting a solid
    // magenta fill instead.
    const whiteOutlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false });
    // window glass: a thin, mostly-transparent, faintly blue-tinted pane
    // that's noticeably more specular (lower roughness) than the matte
    // wall surface it sits inside. Never added to pickList -- it's purely
    // visual and shouldn't intercept taps meant for the floor/room behind it.
    // 20% more reflective than before (lower roughness, a bit more
    // metalness) -- any glass surface (window panes, balcony glass infill)
    // shares this one material, so the bump applies everywhere at once.
    const glassMat = new THREE.MeshStandardMaterial({
      // metalness bumped well above a physically "correct" dielectric value
      // -- at a realistic ~0.05 the Fresnel reflectance at normal incidence
      // is only a few percent and the cityscape map is essentially
      // invisible head-on; a stronger, deliberately-unrealistic metalness
      // plus a much higher envMapIntensity make the reflection actually
      // read as reflection detail rather than just a flat tinted pane.
      // metalness/envMapIntensity both brought down 10% from their earlier
      // bumped values, per a request to make glass a touch less reflective
      // without undoing the "reflection should actually be visible" fix.
      color: 0x9ec8ee, transparent: true, opacity: 0.35, roughness: 0.08, metalness: 0.315, envMapIntensity: 2.88, side: THREE.DoubleSide,
      // its own detailed cityscape reflection map rather than the soft
      // ambient ibl -- glass should visibly reflect *something*, not just
      // tint toward a flat gradient color.
      envMap: reflectionEnvMap,
    });
    // an invisible volume used purely to make thin/hollow things (pillars,
    // window and door cutouts) much easier to tap -- raycasting still hits
    // it (unlike setting mesh.visible=false, which Three.js's Raycaster
    // skips entirely), but it renders as nothing.
    const hotspotMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    // staircases default to matching the wall color, same as the balcony
    // platform/roof; a room theme can still give them their own distinct tone.
    const stairMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.82, metalness: 0.02 });
    // prop shapes, each with its own fixed color -- a flat, saturated
    // plastic finish (low roughness for a clear specular highlight and
    // crisp light/shadow falloff, a light touch of environment reflection
    // rather than heavy) so colors read punchy rather than washed out.
    const PROP_PLASTIC = { roughness: 0.32, metalness: 0.02, envMapIntensity: 0.4 };
    const propMats = {
      sphere: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.sphere, ...PROP_PLASTIC }),
      cone: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cone, ...PROP_PLASTIC }),
      cube: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cube, ...PROP_PLASTIC }),
      cylinder: new THREE.MeshStandardMaterial({ color: PROP_DEFAULT_COLORS.cylinder, ...PROP_PLASTIC }),
      // columns and the jail-cell wall read as part of the building rather
      // than a colored prop, so they share the same material as the walls
      // themselves rather than their own tint.
      colSquare: wallMat,
      colRound: wallMat,
      jailWall: wallMat,
    };
    const PROP_HEIGHT = 8 * FT;
    // the round/louver window trim and the arched/revolving/turnstile door
    // hardware all read as part of the building too -- same wall material,
    // not a separate metal/glass finish.
    const windowFrameMat = wallMat;
    const louverMat = wallMat;
    const LOUVER_TILT = THREE.MathUtils.degToRad(35);
    const doorMetalMat = wallMat;

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
      // a room-to-room connection door is computed fresh every rebuild, not
      // stored/editable state -- excluded from pickList so it can't be
      // individually selected, resized, or deleted (it would just come
      // right back on the next rebuild anyway, as long as the rooms are
      // still touching).
      const isConnectionDoor = typeof c.id === "string" && c.id.startsWith("__conn_");
      if (isPickableTarget && !isConnectionDoor) pickList.push(hmesh);

      if (isPickableTarget && selectedOpeningIdRef.current === c.id) {
        const hlGeo = new THREE.PlaneGeometry(len, h);
        const hlMesh = new THREE.LineSegments(new THREE.EdgesGeometry(hlGeo), whiteOutlineMat);
        hlMesh.renderOrder = 9;
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

    // a single top-center handle on a selected wall/partition -- drag it up
    // or down to change just that one panel's own height (state.panelHeights),
    // the same value the ribbon's "Wall height" slider already edits, just
    // reachable directly in the 3D view like a prop's own height handle.
    function addWallHeightHandle(panelKey, lengthAxis, coord, midU, H) {
      if (!isPickableTarget || selectedPanelRef.current !== panelKey) return;
      const geo = new THREE.BoxGeometry(PROP_HANDLE, PROP_HANDLE, PROP_HANDLE);
      const mesh = new THREE.Mesh(geo, handleMat);
      mesh.renderOrder = 10;
      if (lengthAxis === "x") mesh.position.set(midU, H + PROP_HANDLE * 0.9, coord);
      else mesh.position.set(coord, H + PROP_HANDLE * 0.9, midU);
      mesh.userData = { kind: "resize-handle", target: "wall-height", id: panelKey, edge: "top", ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
      sceneGroup.add(mesh);
      pickList.push(mesh);
    }
    // small corner-ball handles around a selected opening, same look and
    // size as a prop's own corner handles -- nw/ne drag the top edge (plus
    // whichever side they're on), sw/se the bottom edge (windows only --
    // doors are floor-anchored, so they only ever get the top pair). Poke
    // slightly proud of both wall faces and render on top (handleMat has
    // depthTest off) so they're always visible and easy to grab regardless
    // of viewing angle.
    function addOpeningResizeHandles(c, lengthAxis, coord, y0, y1) {
      const T = state.thickness;
      function addHandle(edge, uCenter, yCenter) {
        const geo = lengthAxis === "x"
          ? new THREE.BoxGeometry(PROP_HANDLE, PROP_HANDLE, T + 0.05)
          : new THREE.BoxGeometry(T + 0.05, PROP_HANDLE, PROP_HANDLE);
        const mesh = new THREE.Mesh(geo, handleMat);
        mesh.renderOrder = 10;
        if (lengthAxis === "x") mesh.position.set(uCenter, yCenter, coord);
        else mesh.position.set(coord, yCenter, uCenter);
        mesh.userData = { kind: "resize-handle", target: "opening", id: c.id, edge, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
        sceneGroup.add(mesh);
        if (isPickableTarget) pickList.push(mesh);
      }
      addHandle("nw", c.u0, y1);
      addHandle("ne", c.u1, y1);
      if (!c.isDoor) {
        addHandle("sw", c.u0, y0);
        addHandle("se", c.u1, y0);
      }
    }

    // places an object (built with u=0 as its own center, y in real wall
    // height, thickness/depth along local Z) onto the wall at the given
    // lengthAxis/coord/u -- shared by the round/louver window and
    // arched/revolving/turnstile door assemblies below. Rotation never
    // moves an object's own position, so the axis-dependent u/coord split
    // has to be resolved here rather than by rotating something already
    // positioned; a lengthAxis "z" wall additionally needs its local
    // (u-along-X, thickness-along-Z) geometry rotated 90 degrees so that
    // local X (u) faces along world Z instead.
    function placeOnWall(obj, lengthAxis, coord, u) {
      if (lengthAxis === "x") {
        obj.position.x = u;
        obj.position.z = coord;
      } else {
        obj.rotation.y = Math.PI / 2;
        obj.position.x = coord;
        obj.position.z = u;
      }
      return obj;
    }

    // a genuine circular hole in the wall -- the wall panel spanning the
    // whole opening rectangle is solid except for a true circular cutout
    // (built the same way the arched door's U-shaped hole is: a flat
    // shape with a hole punched in it, extruded to wall thickness), so
    // there's no opaque disc in the middle and no open gap between the
    // window's trim and the surrounding wall. The trim itself is a thin,
    // flat ring flush with each wall face -- not a tube (torus) standing
    // proud of the wall on every side.
    function addRoundWindow(c, lengthAxis, coord, bottomY, topY) {
      const T = state.thickness;
      const uMid = (c.u0 + c.u1) / 2;
      const yMid = (bottomY + topY) / 2;
      const radius = Math.max(0.08, Math.min(c.u1 - c.u0, topY - bottomY) / 2 * 0.86);
      const lu0 = c.u0 - uMid, lu1 = c.u1 - uMid;
      const shape = new THREE.Shape();
      shape.moveTo(lu0, bottomY);
      shape.lineTo(lu0, topY);
      shape.lineTo(lu1, topY);
      shape.lineTo(lu1, bottomY);
      shape.lineTo(lu0, bottomY);
      const hole = new THREE.Path();
      hole.absarc(0, yMid, radius, 0, Math.PI * 2, false);
      shape.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 48 });
      geo.translate(0, 0, -T / 2);
      const wallPanel = new THREE.Mesh(geo, currentWallMat);
      wallPanel.castShadow = true;
      wallPanel.receiveShadow = true;
      sceneGroup.add(placeOnWall(wallPanel, lengthAxis, coord, uMid));

      const trimOuter = radius + Math.max(0.025, radius * 0.08);
      const trimGeo = new THREE.RingGeometry(radius, trimOuter, 48);
      const front = new THREE.Mesh(trimGeo, windowFrameMat);
      front.position.set(0, yMid, T / 2 + 0.002);
      front.receiveShadow = true;
      const back = new THREE.Mesh(trimGeo, windowFrameMat);
      back.position.set(0, yMid, -T / 2 - 0.002);
      back.rotation.y = Math.PI;
      back.receiveShadow = true;
      const trimGroup = new THREE.Group();
      trimGroup.add(front, back);
      sceneGroup.add(placeOnWall(trimGroup, lengthAxis, coord, uMid));
    }

    function addLouverWindow(c, lengthAxis, coord, bottomY, topY) {
      const T = state.thickness;
      const uMid = (c.u0 + c.u1) / 2;
      const len = Math.max(0.05, (c.u1 - c.u0) - 0.06);
      const span = topY - bottomY;
      const count = Math.max(3, Math.round(span / (0.35)));
      const slatH = span / count;
      for (let i = 0; i < count; i++) {
        const yCenter = bottomY + slatH * (i + 0.5);
        const slat = new THREE.Mesh(new THREE.BoxGeometry(len, slatH * 0.55, T * 0.85), louverMat);
        slat.position.y = yCenter;
        slat.rotation.x = LOUVER_TILT;
        slat.castShadow = true;
        slat.receiveShadow = true;
        sceneGroup.add(placeOnWall(slat, lengthAxis, coord, uMid));
      }
    }

    // a true U-shaped doorway -- straight sides the full height of the
    // unit, capped by a semicircular arch -- rather than a full-width
    // rectangle with just a decorative arched panel on top. The hole is
    // confined to this unit's own u0/u1 footprint; wall fills everywhere
    // outside it (the spandrel corners above the arch springline here,
    // and the margins/gaps between units in renderArchedDoorBank below).
    // Built relative to its own center (u=0 at the doorway's midpoint),
    // like every other placeOnWall caller, since placeOnWall's z-axis
    // rotation would otherwise send absolute u coordinates to the wrong
    // world Z.
    const ARCH_UNIT_WIDTH = 6 * FT; // standard door width
    const ARCH_GAP = 3 * FT;
    function addArchedDoorUnit(lengthAxis, coord, unitU0, unitU1, doorBottom, doorTop) {
      const T = state.thickness;
      const width = unitU1 - unitU0;
      const archRadius = Math.max(0.05, Math.min(width / 2, (doorTop - doorBottom) * 0.4));
      const archBaseY = doorTop - archRadius;
      if (archBaseY <= doorBottom + 0.02) return; // door too short/wide for a meaningful arch
      const midU = (unitU0 + unitU1) / 2;
      const u0 = unitU0 - midU, u1 = unitU1 - midU;
      const shape = new THREE.Shape();
      shape.moveTo(u0, archBaseY);
      shape.lineTo(u0, doorTop);
      shape.lineTo(u1, doorTop);
      shape.lineTo(u1, archBaseY);
      shape.lineTo(u0, archBaseY);
      const hole = new THREE.Path();
      hole.absarc(0, archBaseY, archRadius, 0, Math.PI, false);
      shape.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 16 });
      geo.translate(0, 0, -T / 2);
      const mesh = new THREE.Mesh(geo, currentWallMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sceneGroup.add(placeOnWall(mesh, lengthAxis, coord, midU));
    }

    // tiles fixed-width arched-doorway units across the drawn span, each
    // its own true U-shaped hole, with a solid 3ft wall gap separating
    // consecutive doors instead of one door stretched (and left
    // rectangular below the arch) across the whole span.
    function renderArchedDoorBank(c, lengthAxis, coord, bottom, top, addSeg) {
      const width = c.u1 - c.u0;
      const count = Math.max(1, Math.floor((width + ARCH_GAP) / (ARCH_UNIT_WIDTH + ARCH_GAP)));
      const totalWidth = count * ARCH_UNIT_WIDTH + (count - 1) * ARCH_GAP;
      const startU = c.u0 + Math.max(0, (width - totalWidth) / 2);
      if (startU > c.u0 + 0.02) addSeg(c.u0, startU, bottom, top);
      if (c.u1 - (startU + totalWidth) > 0.02) addSeg(startU + totalWidth, c.u1, bottom, top);
      for (let i = 0; i < count; i++) {
        const unitU0 = startU + i * (ARCH_UNIT_WIDTH + ARCH_GAP);
        const unitU1 = unitU0 + ARCH_UNIT_WIDTH;
        addArchedDoorUnit(lengthAxis, coord, unitU0, unitU1, bottom, top);
        if (i < count - 1) addSeg(unitU1, unitU1 + ARCH_GAP, bottom, top);
      }
    }

    // a center post with 3 wall-colored wing panels pivoting around it,
    // filling the doorway in place of a door leaf -- purely visual, the
    // rectangular opening behind it stays the actual pick/resize target.
    // Sized to a fixed standard door width rather than scaling to whatever
    // span was drawn -- renderRevolvingDoorBank below tiles as many of
    // these (with wall spacers between) as fit the drawn span.
    const REVOLVING_POST_RADIUS = 0.25 * FT; // half a foot diameter
    const REVOLVING_UNIT_WIDTH = 6 * FT;     // standard door width
    const REVOLVING_SPACER = 1 * FT;
    function addRevolvingDoorAssembly(lengthAxis, coord, uMid, bottom, top) {
      const radius = Math.max(0.3, (REVOLVING_UNIT_WIDTH / 2) * 0.92);
      const height = Math.max(0.3, top - bottom);
      const midY = (bottom + top) / 2;
      const group = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const wing = new THREE.Mesh(new THREE.BoxGeometry(radius * 2 * 0.94, height * 0.94, 0.03), windowFrameMat);
        wing.position.y = midY;
        wing.rotation.y = (i / 3) * Math.PI;
        wing.castShadow = true;
        group.add(wing);
      }
      const post = new THREE.Mesh(new THREE.CylinderGeometry(REVOLVING_POST_RADIUS, REVOLVING_POST_RADIUS, height, 16), doorMetalMat);
      post.position.y = midY;
      group.add(post);
      sceneGroup.add(placeOnWall(group, lengthAxis, coord, uMid));
    }

    // tiles fixed-width revolving-door units edge-to-edge across the
    // drawn span, with a solid 1ft wall spacer between each unit (and
    // filling any leftover margin at the ends with wall too).
    function renderRevolvingDoorBank(c, lengthAxis, coord, bottom, top, addSeg) {
      const width = c.u1 - c.u0;
      const count = Math.max(1, Math.floor((width + REVOLVING_SPACER) / (REVOLVING_UNIT_WIDTH + REVOLVING_SPACER)));
      const totalWidth = count * REVOLVING_UNIT_WIDTH + (count - 1) * REVOLVING_SPACER;
      const startU = c.u0 + Math.max(0, (width - totalWidth) / 2);
      if (startU > c.u0 + 0.02) addSeg(c.u0, startU, bottom, top);
      if (c.u1 - (startU + totalWidth) > 0.02) addSeg(startU + totalWidth, c.u1, bottom, top);
      for (let i = 0; i < count; i++) {
        const unitU0 = startU + i * (REVOLVING_UNIT_WIDTH + REVOLVING_SPACER);
        const unitU1 = unitU0 + REVOLVING_UNIT_WIDTH;
        addRevolvingDoorAssembly(lengthAxis, coord, (unitU0 + unitU1) / 2, bottom, top);
        if (i < count - 1) addSeg(unitU1, unitU1 + REVOLVING_SPACER, bottom, top);
      }
    }

    // a waist-height post with 3 rotating arms, filling the doorway in
    // place of a door leaf. Fixed-size regardless of the drawn span --
    // renderTurnstileBank below tiles as many of these, placed directly
    // adjacent to one another, as fit the drawn span.
    const TURNSTILE_POST_RADIUS = 0.25 * FT;  // half a foot diameter
    const TURNSTILE_ARM_RADIUS = (1 / 6) * FT; // ~4in diameter
    const TURNSTILE_ARM_LENGTH = 1 * FT;
    const TURNSTILE_UNIT_WIDTH = TURNSTILE_ARM_LENGTH * 2;
    function addTurnstileAssembly(lengthAxis, coord, uMid, bottom, top) {
      const height = Math.max(0.3, top - bottom);
      const armY = Math.min(top - 0.1, bottom + 0.9);
      const group = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(TURNSTILE_POST_RADIUS, TURNSTILE_POST_RADIUS, height, 16), doorMetalMat);
      post.position.y = (bottom + top) / 2;
      group.add(post);
      for (let i = 0; i < 3; i++) {
        const pivot = new THREE.Group();
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(TURNSTILE_ARM_RADIUS, TURNSTILE_ARM_RADIUS, TURNSTILE_ARM_LENGTH, 10), doorMetalMat);
        arm.rotation.z = Math.PI / 2;
        arm.position.set(TURNSTILE_ARM_LENGTH / 2, armY, 0);
        arm.castShadow = true;
        pivot.add(arm);
        pivot.rotation.y = (i / 3) * Math.PI * 2;
        group.add(pivot);
      }
      sceneGroup.add(placeOnWall(group, lengthAxis, coord, uMid));
    }

    // tiles fixed-size turnstiles directly adjacent to one another (no
    // gap) to fill the drawn span from start to finish.
    function renderTurnstileBank(c, lengthAxis, coord, bottom, top) {
      const width = c.u1 - c.u0;
      const count = Math.max(1, Math.floor(width / TURNSTILE_UNIT_WIDTH));
      const totalWidth = count * TURNSTILE_UNIT_WIDTH;
      const startCenter = c.u0 + (width - totalWidth) / 2 + TURNSTILE_UNIT_WIDTH / 2;
      for (let i = 0; i < count; i++) {
        addTurnstileAssembly(lengthAxis, coord, startCenter + i * TURNSTILE_UNIT_WIDTH, bottom, top);
      }
    }

    // a plain glass-paned door -- a flat glass pane filling the doorway
    // with a thin frame border, used for the supported balcony's entrance.
    function addGlassDoor(c, lengthAxis, coord, bottom, top) {
      const width = c.u1 - c.u0;
      const uMid = (c.u0 + c.u1) / 2;
      const h = Math.max(0.1, top - bottom);
      const frameT = 0.1 * FT;
      const d = state.thickness * 0.5;
      const group = new THREE.Group();
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.1, width - frameT * 2), Math.max(0.1, h - frameT * 2)), glassMat);
      pane.position.set(0, bottom + h / 2, 0);
      group.add(pane);
      [bottom + frameT / 2, top - frameT / 2].forEach((ry) => {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(width, frameT, d), doorMetalMat);
        rail.position.set(0, ry, 0);
        group.add(rail);
      });
      [-width / 2 + frameT / 2, width / 2 - frameT / 2].forEach((bx) => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(frameT, h, d), doorMetalMat);
        post.position.set(bx, bottom + h / 2, 0);
        group.add(post);
      });
      sceneGroup.add(placeOnWall(group, lengthAxis, coord, uMid));
    }

    // a barred jail-cell door, a fixed ~10ft-wide unit with a border frame
    // around it -- renderJailWallBank below tiles as many of these, with a
    // 2ft wall gap between each, as fit the drawn span.
    const JAIL_BAR_RADIUS = 0.25 * FT; // 3in radius
    const JAIL_BAR_SPACING = 1 * FT;
    const JAIL_UNIT_WIDTH = 10 * FT;
    const JAIL_GAP = 2 * FT;
    const JAIL_BORDER_THICKNESS = 0.15 * FT;
    function addJailWallDoor(lengthAxis, coord, uMid, width, bottom, top) {
      const d = state.thickness * 0.6;
      const h = Math.max(0.1, top - bottom);
      const barCount = Math.max(2, Math.floor(width / JAIL_BAR_SPACING) + 1);
      const group = new THREE.Group();
      for (let i = 0; i < barCount; i++) {
        const bx = -width / 2 + (barCount === 1 ? width / 2 : (i * width) / (barCount - 1));
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(JAIL_BAR_RADIUS, JAIL_BAR_RADIUS, h * 0.98, 10), doorMetalMat);
        bar.position.set(bx, bottom + h / 2, 0);
        bar.castShadow = true;
        group.add(bar);
      }
      // border frame around the whole unit
      const bt = JAIL_BORDER_THICKNESS;
      [bottom + bt / 2, top - bt / 2].forEach((ry) => {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(width, bt, d), doorMetalMat);
        rail.position.set(0, ry, 0);
        group.add(rail);
      });
      [-width / 2 + bt / 2, width / 2 - bt / 2].forEach((bx) => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(bt, h, d), doorMetalMat);
        post.position.set(bx, bottom + h / 2, 0);
        group.add(post);
      });
      sceneGroup.add(placeOnWall(group, lengthAxis, coord, uMid));
    }

    // tiles fixed-width jail-cell door units across the drawn span, with a
    // solid 2ft wall gap separating consecutive doors.
    function renderJailWallBank(c, lengthAxis, coord, bottom, top, addSeg) {
      const width = c.u1 - c.u0;
      const count = Math.max(1, Math.floor((width + JAIL_GAP) / (JAIL_UNIT_WIDTH + JAIL_GAP)));
      const totalWidth = count * JAIL_UNIT_WIDTH + (count - 1) * JAIL_GAP;
      const startU = c.u0 + Math.max(0, (width - totalWidth) / 2);
      if (startU > c.u0 + 0.02) addSeg(c.u0, startU, bottom, top);
      if (c.u1 - (startU + totalWidth) > 0.02) addSeg(startU + totalWidth, c.u1, bottom, top);
      for (let i = 0; i < count; i++) {
        const unitU0 = startU + i * (JAIL_UNIT_WIDTH + JAIL_GAP);
        const unitU1 = unitU0 + JAIL_UNIT_WIDTH;
        addJailWallDoor(lengthAxis, coord, (unitU0 + unitU1) / 2, JAIL_UNIT_WIDTH, bottom, top);
        if (i < count - 1) addSeg(unitU1, unitU1 + JAIL_GAP, bottom, top);
      }
    }

    // 5 evenly-spaced wall columns (square or round), floor to ceiling,
    // spanning a drawn wall span -- purely decorative, doesn't cut the
    // wall the way a window/door opening does.
    const COLUMN_BANK_COUNT = 5;
    const COLUMN_SIZE = 1 * FT;
    function renderColumnBank(c, lengthAxis, coord, H, thickAxis, normal, T) {
      const width = c.u1 - c.u0;
      const spacing = width / COLUMN_BANK_COUNT;
      // sit proud on the room-interior face of the wall rather than buried
      // inside its thickness, where a floor-to-ceiling column of about the
      // same depth as the wall would otherwise be visually indistinguishable
      // from the wall itself.
      const normalComp = thickAxis === "z" ? normal.z : normal.x;
      const adjCoord = coord - normalComp * (T / 2 + COLUMN_SIZE / 2);
      for (let i = 0; i < COLUMN_BANK_COUNT; i++) {
        const uCenter = c.u0 + spacing * (i + 0.5);
        const geo = c.shape === "round"
          ? new THREE.CylinderGeometry(COLUMN_SIZE / 2, COLUMN_SIZE / 2, H, 20)
          : new THREE.BoxGeometry(COLUMN_SIZE, H, COLUMN_SIZE);
        const mesh = new THREE.Mesh(geo, wallMat);
        mesh.position.y = H / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        sceneGroup.add(placeOnWall(mesh, lengthAxis, adjCoord, uCenter));
      }
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
        if (c.style === "arched") { renderArchedDoorBank(c, lengthAxis, coord, doorBottom, doorTop, addSeg); return; }
        if (c.style === "revolving") { renderRevolvingDoorBank(c, lengthAxis, coord, doorBottom, doorTop, addSeg); return; }
        if (c.style === "turnstile") { renderTurnstileBank(c, lengthAxis, coord, doorBottom, doorTop); return; }
        if (c.style === "jailWall") { renderJailWallBank(c, lengthAxis, coord, doorBottom, doorTop, addSeg); return; }
        if (c.style === "glass") { addGlassDoor(c, lengthAxis, coord, doorBottom, doorTop); return; }
        // "split door in two" -- a single center mullion, like a French
        // door, rather than the window system's full column/row grid.
        if (Math.round(c.dividers || 0) >= 1) {
          const mid = (c.u0 + c.u1) / 2;
          addMullion(mid - 0.021, mid + 0.021, doorBottom, doorTop);
        }
        return;
      }
      // round windows anchor their bottom edge at a fixed 5ft off the
      // floor (roughly mid-wall) instead of the generic vertical centering
      // every other window style uses below.
      if (c.style === "round") {
        const diameter = Math.max(0.3, Math.min(c.u1 - c.u0, c.height ?? DEFAULT_OPENING_HEIGHT));
        const roundBottom = Math.min(5 * FT, Math.max(0, H - diameter - 0.05));
        const roundTop = Math.min(H, roundBottom + diameter);
        addSeg(c.u0, c.u1, 0, roundBottom);
        addSeg(c.u0, c.u1, roundTop, H);
        addOpeningHotspotAndHighlight(c, lengthAxis, coord, roundBottom, roundTop);
        addRoundWindow(c, lengthAxis, coord, roundBottom, roundTop);
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

      if (c.style === "louver") { addLouverWindow(c, lengthAxis, coord, bottomY, topY); return; }

      const n = Math.max(0, Math.round(c.dividers || 0));
      const axis = c.dividerAxis || "vertical";
      const doVertical = axis === "vertical" || axis === "both";
      const doHorizontal = axis === "horizontal" || axis === "both";
      const mullionWidth = 0.042; // 30% thinner than the original 0.05, then 20% thicker again

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
        if (o.material && o.material !== wallMat && o.material !== floorMat && o.material !== wallMatDim && o.material !== floorMatDim && o.material !== wallMatSelected && o.material !== floorMatSelected && o.material !== pillarMat && o.material !== pillarMatSelected && o.material !== ceilingMat && o.material !== selMat && o.material !== selMatPreview && o.material !== handleMat && o.material !== glassMat && o.material !== stairMat && o.material !== hotspotMat && o.material !== windowFrameMat && o.material !== louverMat && o.material !== doorMetalMat && !Object.values(propMats).includes(o.material)) {
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
    // when a window/door is dragged (or a tap-door's default width is
    // clamped) all the way out to a wall's own end -- a corner -- leave a
    // small strip of solid wall there instead of running the opening flush
    // to the edge.
    const EDGE_WALL_MARGIN = 0.5 * FT;
    function applyEdgeMargin(u0, u1, panelKey) {
      const info = getPanelInfo(panelKey);
      if (!info) return [u0, u1];
      let nu0 = u0, nu1 = u1;
      if (nu0 <= info.u0 + 0.02) nu0 = info.u0 + EDGE_WALL_MARGIN;
      if (nu1 >= info.u1 - 0.02) nu1 = info.u1 - EDGE_WALL_MARGIN;
      if (nu1 - nu0 < MIN_OPENING) return [u0, u1]; // wall too short for both margins -- leave it as drawn
      return [nu0, nu1];
    }
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
    let previewColumnBank = null; // {panel, shape, u0, u1} while dragging out a new run of wall columns
    let previewStair = null; // {x0,x1,z0,z1} while dragging out a new staircase footprint
    let previewRoom = null; // {x0,x1,z0,z1} while dragging out a new room's footprint
    let previewPillarArea = null; // {x0,x1,z0,z1} while dragging out a new pillar-grid area
    let measureAnchors = []; // {point: Vector3, text} for the length overlay
    // synthetic door openings for whichever room is currently being built --
    // set by rebuildRoomEntry from computeRoomConnections() just before it,
    // read by openingsFor() alongside a room's own real openings. Never
    // written into room.data.openings itself, so they're recomputed fresh
    // (and silently vanish/reappear) every rebuild rather than being
    // persisted, user-deletable state.
    let currentConnectionDoors = [];

    function defaultStairSteps(height) {
      return Math.max(2, Math.round((height / FT) * 2));
    }

    function columnBanksFor(panelKey) {
      const list = (state.columnBanks || []).filter((c) => c.panel === panelKey).map((c) => ({ ...c }));
      if (previewColumnBank && previewColumnBank.panel === panelKey) list.push({ ...previewColumnBank, id: "__preview__" });
      return list;
    }

    function openingsFor(panelKey) {
      const list = state.openings.filter((o) => o.panel === panelKey).map((o) => ({ ...o }));
      if (previewOpening && previewOpening.panel === panelKey) list.push({ ...previewOpening, id: "__preview__" });
      currentConnectionDoors.filter((o) => o.panel === panelKey).forEach((o) => list.push({ ...o }));
      return list;
    }
    function bumpoutsFor(panelKey) { return state.bumpouts.filter((b) => b.panel === panelKey); }
    // If a new/resized bump-out's u-span now overlaps an existing
    // window/door opening on the same wall, the part of the opening that
    // falls inside the bump-out's span belongs on the bump-out's own far
    // face -- a different plane now, not the original wall -- while
    // whatever's outside the bump-out stays put. Without this, an opening
    // that used to span the whole wall keeps rendering at the original
    // wall's coordinate even where that wall has been pushed or pulled
    // out from under it, leaving it floating in space. Splitting it into
    // up to three independent openings (each reassigned to whichever
    // panel is actually behind it) is what makes each piece sit flush
    // with its own wall and remain independently editable afterward.
    function splitOpeningsAcrossBump(panelKey, bumpU0, bumpU1, bumpoutId) {
      const affected = state.openings.filter((o) => o.panel === panelKey && rangesOverlap(bumpU0, bumpU1, o.u0, o.u1));
      affected.forEach((o) => {
        state.openings = state.openings.filter((oo) => oo.id !== o.id);
        const midU0 = Math.max(o.u0, bumpU0), midU1 = Math.min(o.u1, bumpU1);
        if (midU1 - midU0 > 0.05) {
          state.openings.push({ ...o, id: idSeq++, panel: "bf:" + bumpoutId, u0: midU0, u1: midU1 });
        }
        if (o.u0 < bumpU0 - 0.001) {
          state.openings.push({ ...o, id: idSeq++, panel: panelKey, u0: o.u0, u1: bumpU0 });
        }
        if (o.u1 > bumpU1 + 0.001) {
          state.openings.push({ ...o, id: idSeq++, panel: panelKey, u0: bumpU1, u1: o.u1 });
        }
      });
    }
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
        const seg = makePanel(lengthAxis, coord, a, b, T * 0.7, yb, yt, mullionMat);
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
      columnBanksFor(panelKey).forEach((cb) => renderColumnBank(cb, lengthAxis, coord, H, thickAxis, normal, T));
      addWallHeightHandle(panelKey, lengthAxis, coord, (wallU0 + wallU1) / 2, H);

      selectionsFor(panelKey).forEach((sel) => {
        const u0 = Math.max(wallU0, Math.min(sel.u0, wallU1));
        const u1 = Math.max(wallU0, Math.min(sel.u1, wallU1));
        if (u1 - u0 < 0.05) return;
        const mat = sel.id === "__preview__" ? selMatPreview : selMat;
        const offset = T / 2 + 0.015;
        // two copies, one just inside the wall's face and one just outside
        // it: the solid wall between them means only whichever one faces
        // the camera is ever actually visible, but this way the highlight
        // stays grabbable (to push it into a bump-out) from either side --
        // a single, one-sided offset made it pickable only when orbited to
        // that specific side, since a ray from the other side hits the
        // solid wall first and never reaches it.
        [1, -1].forEach((side) => {
          const geo = new THREE.PlaneGeometry(u1 - u0, H);
          const mesh = new THREE.Mesh(geo, mat);
          let posX, posZ;
          if (lengthAxis === "x") { posX = (u0 + u1) / 2; posZ = coord + side * normal.z * offset; }
          else { posZ = (u0 + u1) / 2; posX = coord + side * normal.x * offset; }
          mesh.position.set(posX, H / 2, posZ);
          mesh.lookAt(mesh.position.clone().add(normal));
          mesh.userData = { kind: "selection", id: sel.id, panel: panelKey, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (sel.id !== "__preview__" && isPickableTarget) pickList.push(mesh);
        });
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
        const seg = makePanel(lengthAxis, p.u, a, b, T * 0.7, yb, yt, mullionMat);
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
      addWallHeightHandle(panelKey, lengthAxis, p.u, (lo + hi) / 2, H);

      // press-and-hold preview: once this partition is the one snapped
      // flush and being held (see tick()), a magenta overlay -- the same
      // material used for every other pending-change preview in the app --
      // shows what's about to happen: nothing extra for "solid", a
      // door-width band for "door", almost the whole span for "fully open".
      if (dragState && (dragState.type === "partition-draw" || dragState.type === "partition-redrag") && dragState.id === p.id && dragState.wallMode > 0) {
        const mid = (lo + hi) / 2;
        const span = dragState.wallMode === 2 ? (hi - lo) - 0.3 : Math.min(WALL_CYCLE_DOOR_WIDTH, hi - lo - 0.4);
        if (span > 0.1) {
          const previewMesh = makePanel(lengthAxis, p.u, mid - span / 2, mid + span / 2, T * 1.06, 0, H, selMatPreview);
          sceneGroup.add(previewMesh);
        }
      }
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
          // pickable regardless of tool -- tapping a floor to select/move a
          // room, or to re-focus a room that's gone inactive (see the
          // onPointerDown floor-tap handling), needs to work no matter which
          // tool happens to be selected, not just Wall/Stairs/Props.
          if (buildingActiveFloor) pickList.push(floor);
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
        if (buildingActiveFloor && !coveredByRoom) pickList.push(floor);
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
        if (buildingActiveFloor) pickList.push(fmesh);
      });

      if (buildingActiveFloor && hudRef.current) {
        hudRef.current.textContent = `${w.toFixed(1)} m\u00a0\u00a0\u00d7\u00a0\u00a0${d.toFixed(1)} m\u00a0\u00a0\u00b7\u00a0\u00a0${state.height.toFixed(1)} m high`;
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
      renderTerraces();
      renderSuppBalconies();
      renderFloorPillars();
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
      // live rectangle preview while dragging out a brand new room with the
      // Room tool -- only drawn once (while building the floor's own
      // top-level content), not once per existing room too.
      if (previewRoom && buildingRoomId == null) {
        const x0 = Math.min(previewRoom.x0, previewRoom.x1), x1 = Math.max(previewRoom.x0, previewRoom.x1);
        const z0 = Math.min(previewRoom.z0, previewRoom.z1), z1 = Math.max(previewRoom.z0, previewRoom.z1);
        const w = x1 - x0, d = z1 - z0;
        if (w > 0.02 && d > 0.02) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), selMatPreview);
          mesh.position.set((x0 + x1) / 2, 0.03, (z0 + z1) / 2);
          sceneGroup.add(mesh);
        }
      }
      // live rectangle preview while dragging out a new pillar-grid area
      // with the Wall tool's Pillar mode.
      if (previewPillarArea && buildingRoomId == null) {
        const x0 = Math.min(previewPillarArea.x0, previewPillarArea.x1), x1 = Math.max(previewPillarArea.x0, previewPillarArea.x1);
        const z0 = Math.min(previewPillarArea.z0, previewPillarArea.z1), z1 = Math.max(previewPillarArea.z0, previewPillarArea.z1);
        const w = x1 - x0, d = z1 - z0;
        if (w > 0.02 && d > 0.02) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), selMatPreview);
          mesh.position.set((x0 + x1) / 2, 0.03, (z0 + z1) / 2);
          sceneGroup.add(mesh);
        }
      }
    }

    // sphere/cube/cone/cylinder props, placed by tapping the floor with the
    // Props tool. Each stores its own w (x-size)/d (z-size)/h (y-size),
    // falling back to the original fixed sizes for props placed before
    // resizing existed. Cube resizes w/d independently (a true rectangle);
    // sphere/cylinder/cone keep w===d (a uniform radius) and only h varies
    // independently, so a corner drag can never make them elliptical.
    function propDefaultDiameter(kind) {
      if (kind === "cone" || kind === "cylinder") return 6 * FT;
      if (kind === "colSquare" || kind === "colRound") return 1 * FT;
      return PROP_HEIGHT;
    }
    function propWidthOf(p) { return p.w != null ? p.w : (p.kind === "jailWall" ? 6 * FT : propDefaultDiameter(p.kind)); }
    function propDepthOf(p) { return p.d != null ? p.d : (p.kind === "jailWall" ? 0.2 * FT : propDefaultDiameter(p.kind)); }
    // a column/pillar defaults to spanning floor-to-ceiling rather than the
    // fixed 8ft other props use, same for a jail-cell wall panel.
    function propHeightOf(p) {
      if (p.h != null) return p.h;
      if (p.kind === "colSquare" || p.kind === "colRound" || p.kind === "jailWall") return state.height;
      return PROP_HEIGHT;
    }
    const PROP_MIN_SIZE = 0.2; // smallest edge/diameter/height a prop can be resized to
    const PROP_MAX_SIZE = 30;
    const PROP_HANDLE = 0.16; // small cube handles -- visually unobtrusive, still easy to grab on touch

    function renderProps() {
      (state.props || []).forEach((p) => {
        const w = propWidthOf(p), d = propDepthOf(p), h = propHeightOf(p);
        // a barred panel rather than a single solid volume -- built as its
        // own group of vertical bar cylinders plus top/bottom rails, since
        // it can't be expressed as one THREE geometry the way every other
        // prop kind below can.
        if (p.kind === "jailWall") {
          const group = new THREE.Group();
          const barR = Math.min(0.02, d * 0.4);
          const barGap = Math.max(0.12, barR * 5);
          const barCount = Math.max(2, Math.floor(w / barGap) + 1);
          for (let i = 0; i < barCount; i++) {
            const bx = -w / 2 + (barCount === 1 ? w / 2 : (i * w) / (barCount - 1));
            const bar = new THREE.Mesh(new THREE.CylinderGeometry(barR, barR, h * 0.98, 8), propMats.jailWall);
            bar.position.set(bx, h / 2, 0);
            bar.castShadow = true;
            group.add(bar);
          }
          [0.03, h - 0.03].forEach((ry) => {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), propMats.jailWall);
            rail.position.set(0, ry, 0);
            group.add(rail);
          });
          group.position.set(p.x, 0, p.z);
          group.userData = { kind: "prop", id: p.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(group);
          if (isPickableTarget) pickList.push(group);
          renderPropSelectionOverlay(p, w, d, h);
          return;
        }
        let geo;
        switch (p.kind) {
          case "sphere":
            geo = new THREE.SphereGeometry(w / 2, 20, 16);
            break;
          case "cube":
          case "colSquare":
            geo = new THREE.BoxGeometry(w, h, d);
            break;
          case "cone":
            geo = new THREE.ConeGeometry(w / 2, h, 24);
            break;
          case "cylinder":
          case "colRound":
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
        renderPropSelectionOverlay(p, w, d, h);
      });
    }

    // the selected-prop bounding wire + 5 resize handles, computed purely
    // from the prop's own w/d/h/position -- shared by every prop kind
    // (including jailWall's group, which has no single mesh of its own to
    // hang this off of).
    function renderPropSelectionOverlay(p, w, d, h) {
      if (!isPickableTarget || selectedPropIdRef.current !== p.id) return;
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
      // each 90° wraparound wing gets its own door cut into the wall it
      // wraps onto, centered along that wing's own short span.
      (bal.wraps || []).forEach((w) => {
        const wMid = (w.u0 + w.u1) / 2;
        const wDoorW = Math.min(doorW, (w.u1 - w.u0) - 0.6);
        if (wDoorW > 0.5) {
          state.openings.push({ id: idSeq++, panel: w.panel, u0: wMid - wDoorW / 2, u1: wMid + wDoorW / 2, height: doorHeightRef.current, isDoor: true, bottomOverride: bal.platformHeight, fromBalcony: bal.id });
        }
      });
    }

    // cuts a single door into the wall directly behind a terrace, centered
    // on its span -- rebuilt from scratch off the terrace's current u0/u1
    // the same way a balcony's door/window cutouts are.
    function regenerateTerraceOpenings(t) {
      state.openings = state.openings.filter((o) => o.fromTerrace !== t.id);
      const doorW = Math.min(6 * FT, (t.u1 - t.u0) - 0.6);
      if (doorW > 1 * FT) {
        const mid = (t.u0 + t.u1) / 2;
        state.openings.push({ id: idSeq++, panel: t.panel, u0: mid - doorW / 2, u1: mid + doorW / 2, height: doorHeightRef.current, isDoor: true, bottomOverride: 0, fromTerrace: t.id });
      }
    }

    // cuts a single glass door into the wall directly behind a supported
    // balcony, centered on its span, sitting on the platform's current
    // height -- rebuilt from scratch whenever the height slider changes.
    function regenerateSuppBalconyOpening(sb) {
      state.openings = state.openings.filter((o) => o.fromSuppBalcony !== sb.id);
      const doorW = Math.min(6 * FT, (sb.u1 - sb.u0) - 0.6);
      if (doorW > 1 * FT) {
        const mid = (sb.u0 + sb.u1) / 2;
        state.openings.push({ id: idSeq++, panel: sb.panel, u0: mid - doorW / 2, u1: mid + doorW / 2, height: doorHeightRef.current, isDoor: true, bottomOverride: sb.platformHeight, style: "glass", fromSuppBalcony: sb.id });
      }
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
        const ceilingMat = (wholeSelected || ceilingSelected) ? wallMatSelected : balconyRoofMat;
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
        const platformHeight = bal.platformHeight || 5 * FT;
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
        // 90° wraparound wing(s) -- when the drawn span reached one of this
        // wall's own corners, a short perpendicular platform continues onto
        // the adjacent wall, with its own railing/pillars and (via
        // regenerateBalconyOpenings) its own door cut into that wall.
        (bal.wraps || []).forEach((w) => {
          const wInfo = getPanelInfo(w.panel);
          if (!wInfo) return;
          const wAxis = wInfo.lengthAxis;
          function wToWorld(u, d) {
            if (wAxis === "x") return { x: u, z: wInfo.coord + wInfo.normal.z * d };
            return { x: wInfo.coord + wInfo.normal.x * d, z: u };
          }
          const wu0 = w.u0, wu1 = w.u1;
          const wUlen = Math.max(0.02, wu1 - wu0);
          const wGeo = wAxis === "x" ? new THREE.BoxGeometry(wUlen, platformHeight, PLATFORM_D) : new THREE.BoxGeometry(PLATFORM_D, platformHeight, wUlen);
          const wMesh = new THREE.Mesh(wGeo, floorLikeMat);
          const wc = wToWorld((wu0 + wu1) / 2, PLATFORM_D / 2);
          wMesh.position.set(wc.x, platformHeight / 2, wc.z);
          wMesh.castShadow = true;
          wMesh.receiveShadow = true;
          addEdges(wMesh);
          wMesh.userData = { kind: "balcony", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(wMesh);
          if (isPickableTarget) pickList.push(wMesh);
          if (!bal.pillarsRemoved) {
            // the near end (at the corner) butts against the main platform
            // and needs no rail; only the outer edge and the free far end do.
            const nearU = w.corner === "min" ? wu0 : wu1;
            const farU = w.corner === "min" ? wu1 : wu0;
            const half = PILLAR_SIZE / 2;
            const outerLen = Math.abs(farU - nearU) - half;
            const totalLen = Math.max(0.01, outerLen + (PLATFORM_D - half));
            const count = Math.max(1, Math.round(totalLen / DEFAULT_PILLAR_SPACING));
            const dir = farU >= nearU ? 1 : -1;
            const nearEdgeU = nearU + dir * half;
            const points = [];
            for (let i = 0; i <= count; i++) {
              const t = (i / count) * totalLen;
              if (t <= outerLen) points.push([nearEdgeU + dir * t, PLATFORM_D - half]);
              else points.push([farU - dir * half, PLATFORM_D - half - (t - outerLen)]);
            }
            points.forEach(([cu, cd]) => {
              const wp = wToWorld(cu, cd);
              const geo = new THREE.BoxGeometry(PILLAR_SIZE, pillarTop - platformHeight, PILLAR_SIZE);
              const mesh = new THREE.Mesh(geo, pillarMatActive);
              mesh.position.set(wp.x, (platformHeight + pillarTop) / 2, wp.z);
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              addEdges(mesh);
              mesh.userData = { kind: "balcony-pillar", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
              sceneGroup.add(mesh);
              if (isPickableTarget) pickList.push(mesh);
            });
            for (let i = 0; i < points.length - 1; i++) {
              const wa = wToWorld(points[i][0], points[i][1]), wb = wToWorld(points[i + 1][0], points[i + 1][1]);
              const dx = wb.x - wa.x, dz = wb.z - wa.z;
              const len = Math.hypot(dx, dz);
              if (len < 0.02) continue;
              const geo = new THREE.BoxGeometry(len, RAIL_H, PILLAR_SIZE);
              const mesh = new THREE.Mesh(geo, pillarMatActive);
              mesh.position.set((wa.x + wb.x) / 2, pillarTop + RAIL_H / 2, (wa.z + wb.z) / 2);
              mesh.rotation.y = Math.atan2(-dz, dx);
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              addEdges(mesh);
              mesh.userData = { kind: "balcony-pillar", id: bal.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
              sceneGroup.add(mesh);
              if (isPickableTarget) pickList.push(mesh);
            }
          }
        });
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

    // a flat deck sitting just above floor level, with a perimeter railing
    // on 3 open sides (the wall side is skipped, same as a balcony's
    // fence) and a door cut into the wall directly behind it -- no stairs
    // down to the ground, since it's already at floor level.
    function renderTerraces() {
      const DEPTH = 10 * FT;
      const PLATFORM_THICKNESS = 0.25;
      const RAIL_TOP_H = 3.5 * FT;
      const POST_SIZE = 0.09;
      const terraceY = 0.5 * FT;
      (state.terraces || []).forEach((t) => {
        const info = getPanelInfo(t.panel);
        if (!info) return;
        const side = t.side || 1;
        const nx = info.normal.x * side, nz = info.normal.z * side;
        const axis = info.lengthAxis;
        const isSelected = isPickableTarget && selectedTerraceIdRef.current === t.id;
        const platMat = isSelected ? floorMatSelected : balconyPlatformMat;
        const postMat = isSelected ? wallMatSelected : wallMat;
        function toWorld(u, d) {
          if (axis === "x") return { x: u, z: info.coord + nz * d };
          return { x: info.coord + nx * d, z: u };
        }
        function addPiece(geo, mat, wx, wy, wz, rotY) {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(wx, wy, wz);
          if (rotY) mesh.rotation.y = rotY;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          addEdges(mesh);
          mesh.userData = { kind: "terrace", id: t.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (isPickableTarget) pickList.push(mesh);
        }
        // platform slab
        {
          const uLen = Math.max(0.02, t.u1 - t.u0);
          const geo = axis === "x" ? new THREE.BoxGeometry(uLen, PLATFORM_THICKNESS, DEPTH) : new THREE.BoxGeometry(DEPTH, PLATFORM_THICKNESS, uLen);
          const w = toWorld((t.u0 + t.u1) / 2, DEPTH / 2);
          addPiece(geo, platMat, w.x, terraceY - PLATFORM_THICKNESS / 2, w.z);
        }
        // perimeter fence posts + top rail, walking the 3 open sides (near
        // edge, outer edge, far edge) by even arc-length spacing -- same
        // approach renderBalconies uses for its own fence.
        const half = POST_SIZE / 2;
        const pu0 = t.u0 + half, pu1 = t.u1 - half, pd0 = half, pd1 = DEPTH - half;
        const sideLen = pd1 - pd0, outerLen = pu1 - pu0;
        const totalLen = Math.max(0.01, sideLen * 2 + outerLen);
        const perimeterLen = DEPTH * 2 + (t.u1 - t.u0);
        const n = Math.max(2, Math.round(perimeterLen / (3 * FT)));
        const points = [];
        for (let i = 0; i <= n; i++) {
          const tt = (i / n) * totalLen;
          let u, d;
          if (tt <= sideLen) { u = pu0; d = pd0 + tt; }
          else if (tt <= sideLen + outerLen) { u = pu0 + (tt - sideLen); d = pd1; }
          else { u = pu1; d = pd1 - (tt - sideLen - outerLen); }
          points.push([u, d]);
        }
        points.forEach(([cu, cd]) => {
          const w = toWorld(cu, cd);
          addPiece(new THREE.BoxGeometry(POST_SIZE, RAIL_TOP_H, POST_SIZE), postMat, w.x, terraceY + RAIL_TOP_H / 2, w.z);
        });
        for (let i = 0; i < points.length - 1; i++) {
          const wa = toWorld(points[i][0], points[i][1]);
          const wb = toWorld(points[i + 1][0], points[i + 1][1]);
          const dx = wb.x - wa.x, dz = wb.z - wa.z;
          const len = Math.hypot(dx, dz);
          if (len < 0.02) continue;
          addPiece(new THREE.BoxGeometry(len, 0.08, POST_SIZE), postMat, (wa.x + wb.x) / 2, terraceY + RAIL_TOP_H, (wa.z + wb.z) / 2, Math.atan2(-dz, dx));
        }
      });
    }

    // a thin floating platform supported by 2 corner pillars that always
    // reach the floor (however high the platform slider is set), with a
    // perimeter railing on the 3 open sides, a glass door cut into the
    // wall behind it (handled by the ordinary opening system), and a
    // rectangular roof canopy a foot above the door -- no stairs.
    function renderSuppBalconies() {
      const DEPTH = 6 * FT;
      const PLATFORM_THICKNESS = 0.25;
      const ROOF_THICKNESS = 0.25;
      const ROOF_GAP = 1 * FT;
      const PILLAR_SIZE = 0.5 * FT;
      const RAIL_TOP_H = 3 * FT;
      const POST_SIZE = 0.09;
      (state.suppBalconies || []).forEach((sb) => {
        const info = getPanelInfo(sb.panel);
        if (!info) return;
        const side = sb.side || 1;
        const nx = info.normal.x * side, nz = info.normal.z * side;
        const axis = info.lengthAxis;
        const isSelected = isPickableTarget && selectedSuppBalconyIdRef.current === sb.id;
        const platMat = isSelected ? floorMatSelected : balconyPlatformMat;
        const railMat = isSelected ? wallMatSelected : wallMat;
        const platformTop = sb.platformHeight;
        function toWorld(u, d) {
          if (axis === "x") return { x: u, z: info.coord + nz * d };
          return { x: info.coord + nx * d, z: u };
        }
        function addPiece(geo, mat, wx, wy, wz, rotY) {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(wx, wy, wz);
          if (rotY) mesh.rotation.y = rotY;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          addEdges(mesh);
          mesh.userData = { kind: "suppbalcony", id: sb.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
          sceneGroup.add(mesh);
          if (isPickableTarget) pickList.push(mesh);
        }
        // platform slab, its top surface at the current height slider
        {
          const uLen = Math.max(0.02, sb.u1 - sb.u0);
          const geo = axis === "x" ? new THREE.BoxGeometry(uLen, PLATFORM_THICKNESS, DEPTH) : new THREE.BoxGeometry(DEPTH, PLATFORM_THICKNESS, uLen);
          const w = toWorld((sb.u0 + sb.u1) / 2, DEPTH / 2);
          addPiece(geo, platMat, w.x, platformTop - PLATFORM_THICKNESS / 2, w.z);
        }
        // 2 support pillars at the platform's outer front corners, always
        // reaching from the floor (y=0) up to the platform's underside.
        const half = PILLAR_SIZE / 2;
        [sb.u0 + half, sb.u1 - half].forEach((pu) => {
          const w = toWorld(pu, DEPTH - half);
          const pillarH = Math.max(0.05, platformTop - PLATFORM_THICKNESS);
          addPiece(new THREE.BoxGeometry(PILLAR_SIZE, pillarH, PILLAR_SIZE), railMat, w.x, pillarH / 2, w.z);
        });
        // perimeter railing on the 3 open sides (the wall side is skipped),
        // walked by even arc-length spacing like a balcony/terrace fence.
        const rhalf = POST_SIZE / 2;
        const pu0 = sb.u0 + rhalf, pu1 = sb.u1 - rhalf, pd0 = rhalf, pd1 = DEPTH - rhalf;
        const sideLen = pd1 - pd0, outerLen = pu1 - pu0;
        const totalLen = Math.max(0.01, sideLen * 2 + outerLen);
        const n = Math.max(2, sb.railingCount || 6);
        const points = [];
        for (let i = 0; i <= n; i++) {
          const tt = (i / n) * totalLen;
          let u, d;
          if (tt <= sideLen) { u = pu0; d = pd0 + tt; }
          else if (tt <= sideLen + outerLen) { u = pu0 + (tt - sideLen); d = pd1; }
          else { u = pu1; d = pd1 - (tt - sideLen - outerLen); }
          points.push([u, d]);
        }
        points.forEach(([cu, cd]) => {
          const w = toWorld(cu, cd);
          addPiece(new THREE.BoxGeometry(POST_SIZE, RAIL_TOP_H, POST_SIZE), railMat, w.x, platformTop + RAIL_TOP_H / 2, w.z);
        });
        for (let i = 0; i < points.length - 1; i++) {
          const wa = toWorld(points[i][0], points[i][1]);
          const wb = toWorld(points[i + 1][0], points[i + 1][1]);
          const dx = wb.x - wa.x, dz = wb.z - wa.z;
          const len = Math.hypot(dx, dz);
          if (len < 0.02) continue;
          addPiece(new THREE.BoxGeometry(len, 0.08, POST_SIZE), railMat, (wa.x + wb.x) / 2, platformTop + RAIL_TOP_H, (wa.z + wb.z) / 2, Math.atan2(-dz, dx));
        }
        // roof canopy, a foot above the glass door's own top edge
        const doorOpening = (state.openings || []).find((o) => o.fromSuppBalcony === sb.id);
        const doorTop = platformTop + (doorOpening ? doorOpening.height : DEFAULT_OPENING_HEIGHT);
        const roofBottom = doorTop + ROOF_GAP;
        {
          const uLen = Math.max(0.02, sb.u1 - sb.u0);
          const geo = axis === "x" ? new THREE.BoxGeometry(uLen, ROOF_THICKNESS, DEPTH) : new THREE.BoxGeometry(DEPTH, ROOF_THICKNESS, uLen);
          const w = toWorld((sb.u0 + sb.u1) / 2, DEPTH / 2);
          addPiece(geo, platMat, w.x, roofBottom + ROOF_THICKNESS / 2, w.z);
        }
      });
    }

    // a grid of floor-to-(ceiling-1ft) pillars filling a drawn floor area,
    // evenly spaced roughly 3ft apart in both directions so the grid always
    // reaches every edge of the dragged rectangle exactly, round or square.
    const PILLAR_DIAMETER = 2 * FT;
    const PILLAR_SPACING = 3 * FT;
    const PILLAR_TOP_GAP = 1 * FT;
    function renderFloorPillars() {
      (state.floorPillars || []).forEach((p) => {
        const isSelected = isPickableTarget && selectedFloorPillarsIdRef.current === p.id;
        const mat = isSelected ? wallMatSelected : wallMat;
        const pillarH = Math.max(0.1, state.height - PILLAR_TOP_GAP);
        const w = Math.max(0.02, p.x1 - p.x0), d = Math.max(0.02, p.z1 - p.z0);
        const countX = Math.max(1, Math.round(w / PILLAR_SPACING) + 1);
        const countZ = Math.max(1, Math.round(d / PILLAR_SPACING) + 1);
        for (let i = 0; i < countX; i++) {
          const x = countX === 1 ? (p.x0 + p.x1) / 2 : p.x0 + w * (i / (countX - 1));
          for (let j = 0; j < countZ; j++) {
            const z = countZ === 1 ? (p.z0 + p.z1) / 2 : p.z0 + d * (j / (countZ - 1));
            const geo = p.shape === "square"
              ? new THREE.BoxGeometry(PILLAR_DIAMETER, pillarH, PILLAR_DIAMETER)
              : new THREE.CylinderGeometry(PILLAR_DIAMETER / 2, PILLAR_DIAMETER / 2, pillarH, 24);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, pillarH / 2, z);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            addEdges(mesh);
            mesh.userData = { kind: "floorPillar", id: p.id, ownerRoomId: buildingRoomId, ownerFloorId: buildingFloorEntry && buildingFloorEntry.id };
            sceneGroup.add(mesh);
            if (isPickableTarget) pickList.push(mesh);
          }
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

    // a plain tap on an undivided floor (see the Room tool's "pending-room-tool"
    // gesture) turns the whole floor into its own room -- a full clone of the
    // floor's data, footprint included, pushed into entry.rooms so it's
    // selectable/editable like any other room; the wall-cycle gesture (see
    // splitFloorWithPartition) does the same but as two rooms tiling the
    // floor instead of one. Either way the floor's own base content should
    // stay hidden underneath them rather than visually competing with it.
    function floorFullyClaimedByRooms(entry) {
      const fp = entry.data.footprint;
      const totalArea = (fp.xMax - fp.xMin) * (fp.zMax - fp.zMin);
      const rooms = entry.rooms || [];
      if (totalArea <= 0 || rooms.length === 0) return false;
      let coveredArea = 0;
      for (let i = 0; i < rooms.length; i++) {
        const rfp = rooms[i].data.footprint;
        if (rfp.xMin < fp.xMin - 0.05 || rfp.xMax > fp.xMax + 0.05 || rfp.zMin < fp.zMin - 0.05 || rfp.zMax > fp.zMax + 0.05) return false;
        for (let j = 0; j < i; j++) {
          const ofp = rooms[j].data.footprint;
          const ox = Math.min(rfp.xMax, ofp.xMax) - Math.max(rfp.xMin, ofp.xMin);
          const oz = Math.min(rfp.zMax, ofp.zMax) - Math.max(rfp.zMin, ofp.zMin);
          if (ox > 0.05 && oz > 0.05) return false; // overlapping rooms -- not a clean tiling
        }
        coveredArea += (rfp.xMax - rfp.xMin) * (rfp.zMax - rfp.zMin);
      }
      return coveredArea >= totalArea - 0.5;
    }

    // finds every pair of rooms on this floor that are flush against each
    // other along a shared wall (their touching edges line up and overlap
    // by enough to fit a door), and returns a doorway for each side of
    // every such pair -- recomputed from scratch on every rebuild, so
    // dragging a room away makes its connections vanish and dragging it
    // back against a neighbor puts them right back, with no separate
    // connect/disconnect bookkeeping needed.
    function computeRoomConnections(entry) {
      const byRoomId = new Map();
      const rooms = entry.rooms || [];
      const TOUCH_EPS = 0.08; // wall-thickness-scale tolerance for "flush"
      const MIN_SHARE = 2 * FT; // shortest shared run worth putting a door in
      const DOOR_W = 6 * FT;
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i], b = rooms[j];
          // a pair the wall-cycle gesture explicitly split as "solid" (or
          // "fully open", which supplies its own wide manual opening
          // instead) opts out of the automatic connecting door here.
          if ((a.blockConnections || []).includes(b.id) || (b.blockConnections || []).includes(a.id)) continue;
          const afp = a.data.footprint, bfp = b.data.footprint;
          const aOX = a.offsetX || 0, aOZ = a.offsetZ || 0;
          const bOX = b.offsetX || 0, bOZ = b.offsetZ || 0;
          const aX0 = afp.xMin + aOX, aX1 = afp.xMax + aOX, aZ0 = afp.zMin + aOZ, aZ1 = afp.zMax + aOZ;
          const bX0 = bfp.xMin + bOX, bX1 = bfp.xMax + bOX, bZ0 = bfp.zMin + bOZ, bZ1 = bfp.zMax + bOZ;
          let aPanel = null, bPanel = null, axis = null;
          if (Math.abs(aX1 - bX0) < TOUCH_EPS) { aPanel = "east"; bPanel = "west"; axis = "z"; }
          else if (Math.abs(bX1 - aX0) < TOUCH_EPS) { aPanel = "west"; bPanel = "east"; axis = "z"; }
          else if (Math.abs(aZ1 - bZ0) < TOUCH_EPS) { aPanel = "south"; bPanel = "north"; axis = "x"; }
          else if (Math.abs(bZ1 - aZ0) < TOUCH_EPS) { aPanel = "north"; bPanel = "south"; axis = "x"; }
          if (!aPanel) continue;
          const lo = axis === "z" ? Math.max(aZ0, bZ0) : Math.max(aX0, bX0);
          const hi = axis === "z" ? Math.min(aZ1, bZ1) : Math.min(aX1, bX1);
          if (hi - lo < MIN_SHARE) continue;
          const w = Math.min(DOOR_W, hi - lo - 0.2);
          if (w < 2 * FT) continue;
          const mid = (lo + hi) / 2;
          const u0 = mid - w / 2, u1 = mid + w / 2;
          const aOff = axis === "z" ? aOZ : aOX;
          const bOff = axis === "z" ? bOZ : bOX;
          const doorH = Math.min(a.data.height, b.data.height, doorHeightRef.current);
          const push = (roomId, panel, off) => {
            if (!byRoomId.has(roomId)) byRoomId.set(roomId, []);
            byRoomId.get(roomId).push({
              id: `__conn_${a.id}_${b.id}_${panel}`, panel,
              u0: u0 - off, u1: u1 - off, height: doorH, isDoor: true, bottomOverride: 0, dividers: 0,
            });
          };
          push(a.id, aPanel, aOff);
          push(b.id, bPanel, bOff);
        }
      }
      return byRoomId;
    }

    // Room tool corner/edge snapping -- given a raw world point the user
    // just dragged to, checks every existing room on this floor (plus the
    // floor's own base footprint) for a corner or edge within a generous
    // radius, and returns the snapped point instead. Corners win over edges
    // when both are in range, since landing exactly on a shared corner is
    // usually the more useful of the two. An edge snap only touches the one
    // axis perpendicular to that edge (sliding freely along its length),
    // which is what makes the new room's near side end up flush and
    // sharing that wall once it's dragged out from there.
    function snapRoomPoint(floorEntry, x, z) {
      const candidates = [{ footprint: floorEntry.data.footprint, offsetX: 0, offsetZ: 0 }];
      (floorEntry.rooms || []).forEach((r) => candidates.push({ footprint: r.data.footprint, offsetX: r.offsetX || 0, offsetZ: r.offsetZ || 0 }));
      let bestCorner = null, bestEdge = null;
      candidates.forEach((c) => {
        const xMin = c.footprint.xMin + c.offsetX, xMax = c.footprint.xMax + c.offsetX;
        const zMin = c.footprint.zMin + c.offsetZ, zMax = c.footprint.zMax + c.offsetZ;
        [[xMin, zMin], [xMax, zMin], [xMin, zMax], [xMax, zMax]].forEach(([cx, cz]) => {
          const dist = Math.hypot(x - cx, z - cz);
          if (dist < ROOM_SNAP_DIST && (!bestCorner || dist < bestCorner.dist)) bestCorner = { x: cx, z: cz, dist };
        });
        [xMin, xMax].forEach((ex) => {
          if (z >= zMin - ROOM_SNAP_DIST && z <= zMax + ROOM_SNAP_DIST) {
            const dist = Math.abs(x - ex);
            if (dist < ROOM_SNAP_DIST && (!bestEdge || dist < bestEdge.dist)) bestEdge = { x: ex, z, dist };
          }
        });
        [zMin, zMax].forEach((ez) => {
          if (x >= xMin - ROOM_SNAP_DIST && x <= xMax + ROOM_SNAP_DIST) {
            const dist = Math.abs(z - ez);
            if (dist < ROOM_SNAP_DIST && (!bestEdge || dist < bestEdge.dist)) bestEdge = { x, z: ez, dist };
          }
        });
      });
      if (bestCorner) return { x: bestCorner.x, z: bestCorner.z };
      if (bestEdge) return { x: bestEdge.x, z: bestEdge.z };
      return { x, z };
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
      // if a room's footprint exactly matches this floor's own, its rooms
      // collectively tile the whole thing, or a split gesture explicitly
      // flagged its own base content as superseded (baseContentReplaced --
      // needed for the notch-delete split, which leaves a real gap rather
      // than tiling the footprint) -- either way the floor's own walls
      // have fully been replaced, so skip rendering them here to avoid
      // the two visually competing (and to leave the room(s) as the only
      // clickable thing in that space).
      const wholeFloorClaimed = !!entry.baseContentReplaced || floorFullyClaimedByRooms(entry);
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
      const connections = computeRoomConnections(entry);
      (entry.rooms || []).forEach((room) => rebuildRoomEntry(entry, room, isActive, connections.get(room.id) || []));
    }

    // a room reuses the exact same rendering path as a floor (rebuildCurrentFloorGeometry)
    // -- it's just parented in its own group, offset horizontally within its floor.
    function rebuildRoomEntry(floorEntry, room, floorIsActive, connectionDoors) {
      const savedState = state;
      const savedGroup = sceneGroup;
      const savedActive = buildingActiveFloor;
      const savedConnectionDoors = currentConnectionDoors;
      currentConnectionDoors = connectionDoors || [];
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
      const isActiveRoom = floorIsActive && activeRoomId === room.id;
      // a gap-split floor's two rooms are genuinely separate, non-touching
      // rooms carved out of the same original one by a single gesture, not
      // drawn independently via the Room tool -- so unlike an ordinary
      // multi-room floor (where two rooms can share a wall plane, and only
      // letting the active one grab it avoids a tug-of-war over the same
      // geometry), EITHER should be directly clickable to edit here. Tapping
      // a wall already promotes its owner to the active room (see the
      // ownerRoomId check in onPointerDown), so this only widens which
      // walls are reachable, not what happens once one is.
      isPickableTarget = isActiveRoom || (floorIsActive && !!floorEntry.allowMultiRoomPick);
      const isSelectedRoom = isActiveRoom && !activeRoomSilent;
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
      currentConnectionDoors = savedConnectionDoors;
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

    // Six finishes -- a *material*, layered on top of whatever color is
    // currently active (the theme wheel's pick, the older tint swatches, or
    // the plain default) rather than each one owning a fixed color of its
    // own. Concrete is the one exception (forceColor): real precast
    // concrete doesn't take a paint tint, so it keeps its own grey
    // regardless of the room's theme. floorLighten (concrete only) blends
    // that fixed color toward white for a lighter poured-slab floor shade;
    // every other finish just gives the floor its own theme/tint color like
    // the wall, at the same roughness/metalness/texture. Order matches the
    // module-level BUILDING_MATERIAL_NAMES array the ribbon button reads.
    const BUILDING_MATERIAL_PRESETS = [
      // default finish -- a flat, saturated plastic (no grain texture, low
      // roughness for a crisp specular highlight) rather than a chalky
      // matte, so the room's colors read punchy out of the box.
      { key: "plastic", roughness: 0.34, metalness: 0.03 },
      { key: "concrete", forceColor: true, color: 0x93999c, roughness: 0.88, metalness: 0.08, texKey: "concrete", floorLighten: 0.2 },
      { key: "metal", roughness: 0.12, metalness: 0.92 },
      { key: "gloss", roughness: 0.22, metalness: 0.06 },
      { key: "vinyl", roughness: 0.55, metalness: 0.0, texKey: "tile" },
      { key: "wood", roughness: 0.48, metalness: 0.02, texKey: "wood" },
    ];
    function wallTexForKey(texKey) {
      if (texKey === "grain") return wallGrainTex;
      if (texKey === "concrete") return concretePanelTex;
      if (texKey === "tile") return gridTileTex;
      if (texKey === "wood") return woodTex;
      return null;
    }
    function floorTexForKey(texKey) {
      if (texKey === "grain") return floorGrainTex;
      if (texKey === "concrete") return concretePanelTex;
      if (texKey === "tile") return gridTileTex;
      if (texKey === "wood") return woodTex;
      return null;
    }
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
    let currentThemeRoofColor = null, currentThemePlatformColor = null, currentThemeStairColor = null;
    function recomputeWallFloorMaterials() {
      const preset = BUILDING_MATERIAL_PRESETS[currentBuildingMaterialIndex];
      const forceColor = !!preset.forceColor;
      const mainColor = forceColor ? preset.color : (currentThemeWallColor != null ? currentThemeWallColor : COLORS.wall);
      const roughness = preset.roughness;
      const metalness = preset.metalness;
      const isGrain = preset.texKey === "grain";
      const map = wallTexForKey(preset.texKey);
      const roughnessMap = isGrain ? wallRoughTex : null;
      // metal/gloss are the "shiny" finishes -- give them the detailed
      // cityscape reflection map instead of the soft ambient one so a
      // shiny wall/floor actually reflects something recognizable.
      const shinyEnvMap = preset.key === "metal" || preset.key === "gloss" ? reflectionEnvMap : null;

      const wallColor = new THREE.Color(mainColor);
      if (currentTintActiveOn) wallColor.lerp(new THREE.Color(currentTintActiveColor), 0.92);
      wallMat.map = map;
      wallMat.roughnessMap = roughnessMap;
      wallMat.color.copy(wallColor);
      wallMat.roughness = roughness;
      wallMat.metalness = metalness;
      wallMat.envMap = shinyEnvMap;
      wallMat.needsUpdate = true;

      // window/door mullions -- same finish as the wall itself (not their
      // own separate dark-metal material), just 20% darker so they still
      // read as a distinct frame rather than disappearing into the pane.
      mullionMat.map = map;
      mullionMat.roughnessMap = roughnessMap;
      mullionMat.color.copy(wallColor).multiplyScalar(0.8);
      mullionMat.roughness = roughness;
      mullionMat.metalness = metalness;
      mullionMat.envMap = shinyEnvMap;
      mullionMat.needsUpdate = true;

      const wallDimColor = new THREE.Color(mainColor).multiplyScalar(0.5);
      if (currentTintInactiveOn) wallDimColor.lerp(new THREE.Color(currentTintInactiveColor), 0.8);
      wallMatDim.map = map;
      wallMatDim.roughnessMap = roughnessMap;
      wallMatDim.color.copy(wallDimColor);
      wallMatDim.roughness = roughness;
      wallMatDim.metalness = metalness;
      wallMatDim.envMap = shinyEnvMap;
      wallMatDim.needsUpdate = true;

      // the room ceiling ("roof") always matches the walls -- a balcony's
      // own covered ceiling already tracks currentWallMat directly, so it
      // follows for free without any change here.
      ceilingMat.map = map;
      ceilingMat.color.copy(wallColor);
      ceilingMat.roughness = roughness;
      ceilingMat.metalness = metalness;
      ceilingMat.envMap = shinyEnvMap;
      ceilingMat.needsUpdate = true;

      // the balcony's own roof/platform and any staircase default to
      // matching the wall color (or a room theme's own distinct tone for
      // each), and now track the Active tint the same way the wall itself
      // does -- previously these three sat outside recomputeWallFloorMaterials
      // entirely, so toggling the tint on/off visibly changed the walls but
      // left these untouched.
      const roofColor = new THREE.Color(currentThemeRoofColor != null ? currentThemeRoofColor : mainColor);
      if (currentTintActiveOn) roofColor.lerp(new THREE.Color(currentTintActiveColor), 0.92);
      balconyRoofMat.color.copy(roofColor);

      const platformColor = new THREE.Color(currentThemePlatformColor != null ? currentThemePlatformColor : mainColor);
      if (currentTintActiveOn) platformColor.lerp(new THREE.Color(currentTintActiveColor), 0.92);
      balconyPlatformMat.color.copy(platformColor);

      const stairColor = new THREE.Color(currentThemeStairColor != null ? currentThemeStairColor : mainColor);
      if (currentTintActiveOn) stairColor.lerp(new THREE.Color(currentTintActiveColor), 0.92);
      stairMat.color.copy(stairColor);

      let floorBase, floorRough, floorMetal, floorMap, floorRoughnessMap;
      if (forceColor && preset.floorLighten != null) {
        floorBase = new THREE.Color(mainColor).lerp(new THREE.Color(0xffffff), preset.floorLighten);
        floorRough = roughness; floorMetal = metalness;
        floorMap = floorTexForKey(preset.texKey);
        floorRoughnessMap = null;
      } else {
        floorBase = currentThemeFloorColor != null ? currentThemeFloorColor : COLORS.floor;
        floorRough = roughness;
        floorMetal = metalness;
        floorMap = floorTexForKey(preset.texKey);
        floorRoughnessMap = isGrain ? floorRoughTex : null;
      }
      const floorColor = new THREE.Color(floorBase);
      if (currentTintActiveOn) floorColor.lerp(new THREE.Color(currentTintActiveColor), 0.92).multiplyScalar(0.94);
      floorMat.map = floorMap;
      floorMat.roughnessMap = floorRoughnessMap;
      floorMat.color.copy(floorColor);
      floorMat.roughness = floorRough;
      floorMat.metalness = floorMetal;
      floorMat.envMap = shinyEnvMap;
      floorMat.needsUpdate = true;

      const floorDimColor = new THREE.Color(floorBase).multiplyScalar(0.5);
      if (currentTintInactiveOn) floorDimColor.lerp(new THREE.Color(currentTintInactiveColor), 0.8).multiplyScalar(0.92);
      floorMatDim.map = floorMap;
      floorMatDim.roughnessMap = floorRoughnessMap;
      floorMatDim.color.copy(floorDimColor);
      floorMatDim.roughness = floorRough;
      floorMatDim.metalness = floorMetal;
      floorMatDim.envMap = shinyEnvMap;
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
    // same mount-ordering issue as applyUltraRealistic above -- nothing
    // else calls this on the very first mount (its own [buildingMaterialIndex]
    // effect fires before this ref exists), so without this direct call
    // wallMat/mullionMat/etc. would sit at their hardcoded constructor
    // colors (mullions included -- a plain dark grey) until the user
    // happened to touch a material/tint/theme control.
    recomputeWallFloorMaterials();

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
    // same mount-ordering issue as recomputeWallFloorMaterials above -- the
    // [tintActiveOn]/[tintInactiveOn] effects fire before these refs exist
    // on the very first mount, so their default-on values would otherwise
    // never actually reach the materials until the user toggled something.
    applyTintInactive(true, 0xff6b1a);
    applyTintActive(true, 0xffffff);

    // colors every prop kind to its own tone from a chosen theme (or, when
    // cleared, reverts each one to its own default color) -- mutating the
    // shared materials directly, so already-placed props update
    // immediately without needing a rebuild.
    function applyPropColors(colors) {
      Object.keys(propMats).forEach((kind) => {
        // columns and the jail wall alias wallMat itself (see propMats)
        // rather than owning a color of their own, so they always match
        // the walls automatically -- recoloring them here would mutate
        // wallMat and repaint every actual wall to whatever their "prop"
        // tone happened to be.
        if (kind === "colSquare" || kind === "colRound" || kind === "jailWall") return;
        propMats[kind].color.set(colors ? colors[kind] : PROP_DEFAULT_COLORS[kind]);
      });
    }
    // the room color theme: either one anchor point (a hue-wheel cell, or a
    // step on the grey ring) expanding into a related palette via
    // themeColorsFor, or a tapped ring on a named image-derived theme
    // supplying every color outright -- either way, one distinct tone
    // reaches each of the wall,
    // floor, stairs, balcony platform, balcony railings, and every prop kind.
    function applyRoomTheme(anchor, slider) {
      if (!anchor) {
        currentThemeWallColor = null;
        currentThemeFloorColor = null;
        currentThemeRoofColor = null;
        currentThemePlatformColor = null;
        currentThemeStairColor = null;
        recomputeWallFloorMaterials();
        pillarMat.color.set(PILLAR_DEFAULT_COLOR);
        applyPropColors(null);
        return;
      }
      let rawPalette;
      if (anchor.type === "theme") {
        const theme = THEME_PALETTES.find((p) => p.name === anchor.name) || THEME_PALETTES[0];
        // the tapped ring's swatch becomes the wall; the lightest of the
        // remaining five becomes the floor and the rest recolor the props/
        // railing -- recomputed from scratch via buildPalette so stairs/
        // platform/roof/props all stay derived consistently from the new
        // roles, same as a hue-wheel pick.
        const i = (anchor.ring != null ? anchor.ring : 0) % theme.swatches.length;
        const wall = theme.swatches[i];
        const rest = theme.swatches.filter((_, j) => j !== i);
        const ranked = rest.map((hex) => ({ hex, l: hexToHsl(hex).l })).sort((a, b) => b.l - a.l);
        const floor = ranked[0].hex;
        const prop = ranked[1] ? ranked[1].hex : ranked[0].hex;
        const railing = ranked[2] ? ranked[2].hex : prop;
        rawPalette = buildPalette(theme.name, wall, floor, railing, prop);
      } else if (anchor.type === "grey") {
        rawPalette = themeColorsFor(0, 0, anchor.midLight);
      } else {
        rawPalette = themeColorsFor(anchor.hueDeg, THEME_SAT, THEME_WALL_MIDLIGHT);
      }
      // the global wheel sliders (hue/sat/light) re-tint every category of
      // whatever's picked -- a preset's own hand-authored colors included --
      // so what got applied always matches what the wheel showed at pick time.
      const hueShift = (slider && slider.hueShift) || 0;
      const satMul = slider && slider.satMul != null ? slider.satMul : 1;
      const lightMul = slider && slider.lightMul != null ? slider.lightMul : 1;
      const adj = (hex) => adjustHex(hex, hueShift, satMul, lightMul);
      const palette = {
        wall: adj(rawPalette.wall), floor: adj(rawPalette.floor), stairs: adj(rawPalette.stairs),
        platform: adj(rawPalette.platform), railing: adj(rawPalette.railing), roof: adj(rawPalette.roof),
        sphere: adj(rawPalette.sphere), cube: adj(rawPalette.cube), cone: adj(rawPalette.cone), cylinder: adj(rawPalette.cylinder),
      };
      currentThemeWallColor = palette.wall;
      currentThemeFloorColor = palette.floor;
      currentThemeRoofColor = palette.roof;
      currentThemePlatformColor = palette.platform;
      currentThemeStairColor = palette.stairs;
      recomputeWallFloorMaterials();
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
      previewColumnBank = null;
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
    const HANDLE_HIT_PX = 42; // bigger than a fingertip in screen space -- these are fiddly to grab otherwise
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
        roomData.height = state.height;
        roomData.thickness = state.thickness;
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

    // true once a partition has been pushed all the way to the wall
    // opposite the one it grew from -- clampPartitionExt already snaps it
    // flush there, so this just checks it landed at that flush value.
    function partitionIsFullSpan(p) {
      const parent = getPanelInfo(p.panel);
      if (!parent || !wallDefs[p.panel]) return false;
      const span = parent.thickAxis === "z" ? state.footprint.zMax - state.footprint.zMin : state.footprint.xMax - state.footprint.xMin;
      return p.ext <= -(span - 0.05);
    }
    // guards the auto-split gestures against firing on stale/cross-floor
    // state -- true only when `state` genuinely is the given floor's own
    // top-level content (activeRoomId null) or its currently active room's
    // data (activeRoomId set), never some other floor's retargeted content.
    function stateMatchesFloorContext(floorEntry) {
      if (!floorEntry) return false;
      if (activeRoomId == null) return floorEntry.data === state;
      return (floorEntry.rooms || []).some((r) => r.id === activeRoomId && r.data === state);
    }

    // lands the two rooms a split just produced in place of whatever was
    // being edited -- the floor's own top-level content (its first-ever
    // split) if activeRoomId is null, or an existing room being subdivided
    // further (splicing it out for its two halves, leaving any other
    // sibling rooms on the floor untouched) otherwise. multiPick controls
    // whether the pair stays mutually pickable regardless of which is
    // active -- true for a real gap between them, false when they still
    // share a wall plane (only one side of a shared wall should ever be
    // grabbable at once, to avoid a tug-of-war over the same geometry).
    function replaceWithSplitRooms(floorEntry, roomA, roomB, multiPick) {
      floorEntry.rooms = floorEntry.rooms || [];
      if (activeRoomId == null) {
        floorEntry.rooms.push(roomA, roomB);
        floorEntry.data.partitions = [];
        floorEntry.data.bumpouts = [];
        // a gap-split's two rooms don't tile the floor's own footprint (the
        // gap is deliberately left uncovered), so floorFullyClaimedByRooms'
        // area check alone would read this floor as "not fully claimed" and
        // let its original walls reappear around/through the gap as a
        // third, unwanted enclosed room -- flag it explicitly instead.
        floorEntry.baseContentReplaced = true;
      } else {
        const idx = floorEntry.rooms.findIndex((r) => r.id === activeRoomId);
        if (idx === -1) floorEntry.rooms.push(roomA, roomB);
        else floorEntry.rooms.splice(idx, 1, roomA, roomB);
      }
      if (multiPick) floorEntry.allowMultiRoomPick = true;
      // land on room A as the (silently) active one -- "silent" keeps its
      // floor from showing the "selected" highlight until the user
      // actually taps into it.
      switchActiveRoom(roomA.id, { silent: true });
    }

    // only attempted for the simple case the wall-cycle gesture is meant
    // for: nothing else already going on in whatever's being edited (the
    // floor's own top-level content, or an existing room being subdivided
    // further) besides this one partition -- otherwise it just keeps the
    // new partition as an ordinary wall instead (same as dragging one has
    // always done), rather than attempting a full-fidelity split of
    // whatever shape it's already in.
    function canAutoSplitFloor() {
      if (activeRoomId == null) {
        const entry = floors.find((f) => f.id === activeFloorId);
        return !!entry && (entry.rooms || []).length === 0 &&
          entry.data.bumpouts.length === 0 && entry.data.partitions.length === 1;
      }
      return state.bumpouts.length === 0 && state.partitions.length === 1;
    }
    // turns the single room a just-snapped-flush partition divided into two
    // fully independent rooms -- each a real Room entity with its own
    // walls, so both can carry their own doors/windows/props and be
    // dragged around separately, exactly like any other extracted room.
    // wallMode (set by the press-and-hold cycle in onPointerMove/tick):
    // 0 = solid wall between them, no connection; 1 = leave it to the
    // ordinary automatic-connecting-door system (computeRoomConnections)
    // now that they're flush-touching; 2 = a wide, floor-to-ceiling opening
    // spanning almost the whole shared wall on both sides, reading as the
    // wall having been removed entirely.
    function splitFloorWithPartition(floorEntry, p, wallMode) {
      const parent = getPanelInfo(p.panel);
      if (!parent) return;
      const fp = state.footprint;
      let rectA, rectB, aPanel, bPanel, openLo, openHi;
      if (parent.thickAxis === "z") {
        // grew in from the north/south wall -- splits along x into a west
        // room (A) and an east room (B), sharing a wall at x = p.u.
        rectA = { xMin: fp.xMin, xMax: p.u, zMin: fp.zMin, zMax: fp.zMax };
        rectB = { xMin: p.u, xMax: fp.xMax, zMin: fp.zMin, zMax: fp.zMax };
        aPanel = "east"; bPanel = "west";
        openLo = fp.zMin; openHi = fp.zMax;
      } else {
        // grew in from the east/west wall -- splits along z into a north
        // room (A) and a south room (B), sharing a wall at z = p.u.
        rectA = { xMin: fp.xMin, xMax: fp.xMax, zMin: fp.zMin, zMax: p.u };
        rectB = { xMin: fp.xMin, xMax: fp.xMax, zMin: p.u, zMax: fp.zMax };
        aPanel = "south"; bPanel = "north";
        openLo = fp.xMin; openHi = fp.xMax;
      }
      const dataA = makeFloorData(); dataA.footprint = rectA; dataA.height = state.height; dataA.thickness = state.thickness;
      const dataB = makeFloorData(); dataB.footprint = rectB; dataB.height = state.height; dataB.thickness = state.thickness;
      const roomA = { id: idSeq++, data: dataA, offsetX: 0, offsetZ: 0 };
      const roomB = { id: idSeq++, data: dataB, offsetX: 0, offsetZ: 0 };
      if (wallMode !== 1) {
        // solid (0) has nothing connecting them at all; fully-open (2)
        // supplies its own wide manual opening below instead of the
        // standard-width automatic one -- either way, suppress that.
        roomA.blockConnections = [roomB.id];
        roomB.blockConnections = [roomA.id];
      }
      if (wallMode === 2) {
        const inset = Math.min(0.15, (openHi - openLo) * 0.04);
        const u0 = openLo + inset, u1 = openHi - inset;
        if (u1 - u0 >= MIN_OPENING) {
          dataA.openings.push({ id: idSeq++, panel: aPanel, u0, u1, height: dataA.height, isDoor: true, bottomOverride: 0, dividers: 0 });
          dataB.openings.push({ id: idSeq++, panel: bPanel, u0, u1, height: dataB.height, isDoor: true, bottomOverride: 0, dividers: 0 });
        }
      }
      // its wall stays touching the other half's along the shared partition
      // plane, so unlike the gap-split below only ONE side should be left
      // pickable at a time (see isPickableTarget in rebuildRoomEntry); tap
      // into the other one via the Room tool to edit its side.
      replaceWithSplitRooms(floorEntry, roomA, roomB, false);
    }

    // true once a bump-out's inward notch has been pushed all the way to
    // the wall opposite the one it grew from -- clampBumpDepth already
    // snaps it flush there, so this just checks it landed at that value.
    function bumpoutIsFullSpan(bo) {
      const parent = getPanelInfo(bo.panel);
      if (!parent || !wallDefs[bo.panel]) return false;
      const span = parent.thickAxis === "z" ? state.footprint.zMax - state.footprint.zMin : state.footprint.xMax - state.footprint.xMin;
      return bo.depth <= -(span - 0.05);
    }
    // same "nothing else going on" gate as canAutoSplitFloor, just for the
    // width-selection version of this gesture instead of the point-anchored
    // partition one -- and, same as there, checked against whichever is
    // currently being edited (the floor's own top-level content, or an
    // existing room being subdivided further).
    function canAutoSplitFloorByBumpout() {
      if (activeRoomId == null) {
        const entry = floors.find((f) => f.id === activeFloorId);
        return !!entry && (entry.rooms || []).length === 0 &&
          entry.data.partitions.length === 0 && entry.data.bumpouts.length === 1;
      }
      return state.partitions.length === 0 && state.bumpouts.length === 1;
    }
    // a selected width pushed flush across the whole room and held there
    // doesn't become a shared wall like the point-partition gesture does --
    // it deletes that whole width outright, leaving two fully independent
    // rooms with a real gap (the notch's own width) between them, each a
    // complete, self-contained room like any other extracted one.
    function splitFloorWithBumpoutGap(floorEntry, bo) {
      const parent = getPanelInfo(bo.panel);
      if (!parent) return;
      const fp = state.footprint;
      let rectA, rectB;
      if (parent.thickAxis === "z") {
        // grew in from the north/south wall -- the gap runs along x,
        // leaving a west room (A) and an east room (B).
        rectA = { xMin: fp.xMin, xMax: bo.u0, zMin: fp.zMin, zMax: fp.zMax };
        rectB = { xMin: bo.u1, xMax: fp.xMax, zMin: fp.zMin, zMax: fp.zMax };
      } else {
        // grew in from the east/west wall -- the gap runs along z,
        // leaving a north room (A) and a south room (B).
        rectA = { xMin: fp.xMin, xMax: fp.xMax, zMin: fp.zMin, zMax: bo.u0 };
        rectB = { xMin: fp.xMin, xMax: fp.xMax, zMin: bo.u1, zMax: fp.zMax };
      }
      const sizeA = parent.thickAxis === "z" ? rectA.xMax - rectA.xMin : rectA.zMax - rectA.zMin;
      const sizeB = parent.thickAxis === "z" ? rectB.xMax - rectB.xMin : rectB.zMax - rectB.zMin;
      if (sizeA < MIN_SIZE || sizeB < MIN_SIZE) return; // the notch landed too close to a corner to leave two real rooms
      const dataA = makeFloorData(); dataA.footprint = rectA; dataA.height = state.height; dataA.thickness = state.thickness;
      const dataB = makeFloorData(); dataB.footprint = rectB; dataB.height = state.height; dataB.thickness = state.thickness;
      const roomA = { id: idSeq++, data: dataA, offsetX: 0, offsetZ: 0 };
      const roomB = { id: idSeq++, data: dataB, offsetX: 0, offsetZ: 0 };
      // the two new rooms sit on opposite sides of a real gap (unlike the
      // point-partition split, which leaves them touching along a shared
      // wall plane), so there's no ambiguity in letting both be clickable
      // at once regardless of which is active.
      replaceWithSplitRooms(floorEntry, roomA, roomB, true);
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

      // Room tool: the one place floor taps do anything now -- selecting or
      // moving an existing room, extracting one from a partitioned floor,
      // selecting a whole undivided floor, or drawing a brand new room from
      // scratch, all live here exclusively. Every other tool used to also
      // treat a floor tap as "select this room," which made it far too easy
      // to accidentally grab/move a room while just trying to click a wall
      // for a window or door -- especially since a click aimed at a wall
      // easily lands on the floor just behind/below it instead.
      if (toolRef.current === "room") {
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        if (floorEntry) {
          const roomHit = pick(e);
          const roomHitKind = roomHit && roomHit.object.userData.kind;
          const roomHitOwner = roomHit && roomHit.object.userData.ownerRoomId;
          if (roomHitKind === "floor" && roomHitOwner != null) {
            // an existing extracted room's own floor -- select it and arm a
            // drag to move it, exactly like the old tool-agnostic behavior.
            const room = (floorEntry.rooms || []).find((r) => r.id === roomHitOwner);
            if (room) {
              pushUndo();
              switchActiveRoom(roomHitOwner);
              const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -roomHit.point.y);
              dragState = {
                type: "room-drag", roomId: roomHitOwner, plane, start: roomHit.point.clone(),
                startOffsetX: room.offsetX || 0, startOffsetZ: room.offsetZ || 0,
              };
              capture(e);
              return;
            }
          }
          if (roomHitKind === "floor" && roomHitOwner == null) {
            const fEntry = floorEntry.data;
            if (!fEntry.partitions || fEntry.partitions.length === 0) {
              // undivided floor -- a plain tap still selects the whole thing
              // as a room (Cut/Copy/Paste/Duplicate/Curved corners); an
              // actual drag draws a brand new room instead, exactly like the
              // window/door tools' own pending-then-draw states decide which
              // gesture this turns out to be.
              const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -roomHit.point.y);
              dragState = {
                type: "pending-room-tool", plane, start: roomHit.point.clone(), hitPoint: roomHit.point.clone(),
                startScreen: { x: e.clientX, y: e.clientY },
              };
              capture(e);
              return;
            }
            // a partitioned floor -- tapping inside one of its regions
            // extracts that region into its own selected, draggable room.
            const rooms = detectRooms();
            const hx = roomHit.point.x, hz = roomHit.point.z;
            const found = rooms.find((r) => r.floorRects.some((fr) => hx >= fr.x0 - 0.02 && hx <= fr.x1 + 0.02 && hz >= fr.z0 - 0.02 && hz <= fr.z1 + 0.02));
            if (found) {
              commitRoomFromFound(found, roomHit.point.clone());
              capture(e);
              return;
            }
          }
          // blank ground, a wall, or anything else -- draw a brand new room
          // from scratch, on the active floor's own ground plane, regardless
          // of what's actually under the cursor there.
          const g = floorGroups.get(activeFloorId);
          if (g) {
            const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -g.position.y);
            const ray = rayFromEvent(e);
            const pt = new THREE.Vector3();
            if (ray.intersectPlane(plane, pt)) {
              pushUndo();
              const snapped = snapRoomPoint(floorEntry, pt.x, pt.z);
              dragState = { type: "room-draw", plane, x0: snapped.x, z0: snapped.z, x1: snapped.x, z1: snapped.z };
              previewRoom = { x0: snapped.x, z0: snapped.z, x1: snapped.x, z1: snapped.z };
              rebuild();
              capture(e);
              return;
            }
          }
        }
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
        } else if (rh.target === "wall-height") {
          // same vertical-drag-plane technique as a prop's own top handle --
          // a plane through the handle's own position, facing the camera
          // horizontally, so the pointer ray's intersection tracks how far
          // up/down the drag moved regardless of viewing angle.
          pushUndo();
          const center = hit.point.clone();
          const camXZ = new THREE.Vector3(interactionCamera.position.x - center.x, 0, interactionCamera.position.z - center.z);
          if (camXZ.lengthSq() < 1e-6) camXZ.set(0, 0, 1); else camXZ.normalize();
          const plane = new THREE.Plane();
          plane.setFromNormalAndCoplanarPoint(camXZ, center);
          dragState = { type: "resize-wall-height", panelKey: rh.id, plane, startH: getPanelHeight(rh.id), startY: hit.point.y };
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
          const ph = bal.platformHeight || 5 * FT;
          setBalconyStairHeight(ph);
          setBalconyPlatformWidth(bal.platformWidth || 10 * FT);
          setBalconyPillarHeight(bal.pillarHeight != null ? bal.pillarHeight : 3 * FT);
          const perimeterLen = (bal.platformWidth || 10 * FT) * 2 + (bal.u1 - bal.u0);
          setBalconyPillarCount(bal.pillarCount || Math.max(2, Math.round(perimeterLen / (3 * FT))));
          setBalconyGlassInfill(!!bal.glassInfill);
          setBalconyStyle(bal.pillarsRemoved ? (bal.ceilingRemoved ? "cantilevered" : "recessed") : "supported");
        }
        return;
      }

      // A rooftop terrace -- minimal selection for now (delete only, no
      // resize/parameter editing yet).
      if (kind === "terrace") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedOpeningId(null);
        setSelectedBalconyId(null);
        setSelectedTerraceId(obj.userData.id);
        return;
      }

      // the supported-balcony assembly -- tapping the platform, a support
      // pillar, the railing, or the roof canopy all select the whole thing.
      if (kind === "suppbalcony") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        const sb = (state.suppBalconies || []).find((s) => s.id === obj.userData.id);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedOpeningId(null);
        setSelectedBalconyId(null);
        setSelectedTerraceId(null);
        setSelectedSuppBalconyId(obj.userData.id);
        if (sb) {
          setSuppBalconyHeight(sb.platformHeight || 6 * FT);
          setSuppBalconyRailingCount(sb.railingCount || 6);
        }
        return;
      }

      // a floor-pillar grid -- tapping any pillar in it selects the whole
      // area (delete-only, like a terrace).
      if (kind === "floorPillar") {
        const ownerRoomId = obj.userData.ownerRoomId ?? null;
        if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
        setSelectedPanel(null);
        setSelectedStairId(null);
        setSelectedPropId(null);
        setSelectedOpeningId(null);
        setSelectedBalconyId(null);
        setSelectedTerraceId(null);
        setSelectedSuppBalconyId(null);
        setSelectedFloorPillarsId(obj.userData.id);
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
          setOpeningStyle(o.style || "grid");
        } else if (o && o.isDoor) {
          setDoorHeight(o.height ?? DEFAULT_OPENING_HEIGHT);
          setDoorSplit(!!o.dividers);
          setDoorStyle(o.style || "standard");
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

      // Selecting/moving/extracting a room by tapping its floor is now the
      // Room tool's job exclusively (handled up top, before pick() even
      // runs) -- every other tool leaves a plain floor tap alone entirely,
      // so a click aimed at a wall for a window/door never gets swallowed
      // as "select this room" just because it landed a hair off the wall.

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
      // Wall tool's Pillar mode: tapping the plain floor and dragging fills
      // that rectangle with a grid of pillars (see renderFloorPillars).
      if (toolRef.current === "move" && pillarShapeRef.current !== "none") {
        if (kind === "floor") {
          const ownerRoomId = obj.userData.ownerRoomId ?? null;
          if (ownerRoomId !== activeRoomId) switchActiveRoom(ownerRoomId);
          pushUndo();
          setSelectedFloorPillarsId(null);
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
          dragState = { type: "pillar-area-draw", plane, x0: hit.point.x, z0: hit.point.z, x1: hit.point.x, z1: hit.point.z };
          capture(e);
        }
        return;
      }
      // Props tool: tapping the floor drops the currently-selected shape
      // right there. Not a drag gesture -- one tap, one prop placed. Balcony,
      // terrace, and the supported balcony are the exceptions -- all three
      // are drawn along a wall (see the pending-balcony/pending-terrace/
      // pending-suppbalcony branches below), so a floor tap does nothing
      // for any of them.
      if (toolRef.current === "props" && propsShapeRef.current !== "balcony" && propsShapeRef.current !== "terrace" && propsShapeRef.current !== "suppBalcony") {
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
        // a deliberate tap on this room's own wall/partition, even if it was
        // already the (silently, auto-landed) active one -- it's genuinely
        // selected now, same as tapping into it via the Room tool would do.
        else if (ownerRoomId != null && activeRoomSilent) switchActiveRoom(ownerRoomId, { silent: false });
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
        // a plain tap places a fixed-width (6ft) door centered on the tap
        // point, floor to the current door-height setting; tap AND drag
        // instead draws a door whose width matches the drag distance --
        // either way floor-to-doorHeight, never scaled by the drag's
        // vertical extent.
        dragState = { type: "pending-door", panelKey, info, hitPoint: hp, startScreen: { x: e.clientX, y: e.clientY } };
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
      } else if (toolRef.current === "props" && propsShapeRef.current === "terrace") {
        // same wall-drag entry point as balcony above, just its own
        // dragState type -- see the terrace-draw handling in
        // onPointerMove/onPointerUp.
        const thickCoord2 = info.thickAxis === "x" ? hit.point.x : hit.point.z;
        const normalComponent2 = info.thickAxis === "x" ? info.normal.x : info.normal.z;
        const side2 = Math.sign((thickCoord2 - info.coord) * normalComponent2) || 1;
        dragState = { type: "pending-terrace", panelKey, info, hitPoint: hp, side: side2, startScreen: { x: e.clientX, y: e.clientY } };
      } else if (toolRef.current === "props" && propsShapeRef.current === "suppBalcony") {
        // same wall-drag entry point as balcony/terrace above, just its
        // own dragState type -- see the suppbalcony-draw handling in
        // onPointerMove/onPointerUp.
        const thickCoord3 = info.thickAxis === "x" ? hit.point.x : hit.point.z;
        const normalComponent3 = info.thickAxis === "x" ? info.normal.x : info.normal.z;
        const side3 = Math.sign((thickCoord3 - info.coord) * normalComponent3) || 1;
        dragState = { type: "pending-suppbalcony", panelKey, info, hitPoint: hp, side: side3, startScreen: { x: e.clientX, y: e.clientY } };
      } else if (toolRef.current === "move" && columnShapeRef.current !== "none") {
        // a run of columns is drawn along a wall exactly like a window --
        // tap and drag to mark its span -- rather than the Wall tool's
        // usual perpendicular push/pull-the-wall-thickness gesture.
        dragState = { type: "pending-column", panelKey, info, hitPoint: hp, startScreen: { x: e.clientX, y: e.clientY } };
      } else {
        dragState = {
          type: "pending", panelKey, info, hitPoint: hp,
          selIdAtPoint: kind === "selection" ? obj.userData.id : null,
          startScreen: { x: e.clientX, y: e.clientY },
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
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const cls = classifyDrag(info, dragState.hitPoint, dx, dy);
          // an inward push straight off a plain base wall (no selection
          // sitting there already) now goes straight into creating a new
          // dividing partition from that point -- no need to hold still
          // first. Re-adjusting an existing bump-out's own depth, dragging
          // a wall outward, or dragging along its length are all
          // unaffected -- this only redirects the one gesture that used to
          // just move/resize the whole wall.
          const ns = worldDirScreen(dragState.hitPoint, info.normal);
          const isInward = (dx * ns.x + dy * ns.y) < 0;
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
              splitOpeningsAcrossBump(dragState.panelKey, sel.u0, sel.u1, id);
              dragState = { type: "panel-extrude", panelKey: "bf:" + id, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
            } else {
              dragState = { type: "panel-extrude", panelKey: dragState.panelKey, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
            }
          } else if (isInward && wallDefs[dragState.panelKey]) {
            const id = idSeq++;
            state.partitions.push({ id, panel: dragState.panelKey, u: panelU(info, dragState.hitPoint), ext: 0 });
            dragState = { type: "partition-draw", id, normal: info.normal, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), baseExt: 0 };
          } else {
            dragState = { type: "panel-extrude", panelKey: dragState.panelKey, thickAxis: info.thickAxis, plane: makeVerticalPlane(info.normal, dragState.hitPoint), start: dragState.hitPoint.clone(), startCoord: info.coord };
          }
          if (dragState.type === "panel-extrude") setSelectedPanel(dragState.panelKey);
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
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: openingHeightRef.current, bottomOverride: 0 };
          rebuild();
        }
        return;
      }

      if (dragState.type === "pending-door") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "door-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u };
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: doorHeightRef.current, isDoor: true };
          rebuild();
        }
        return;
      }

      if (dragState.type === "pending-room-tool") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          // a real drag past the undivided floor's own edge turns this into
          // drawing a brand new room instead of just selecting the whole
          // floor -- the tap point becomes the rectangle's first corner.
          // (uses its own ray, not the shared one below -- that one isn't
          // declared yet this early in the function.)
          const pt = new THREE.Vector3();
          if (!rayFromEvent(e).intersectPlane(dragState.plane, pt)) return;
          const floorEntry = floors.find((f) => f.id === activeFloorId);
          const snappedEnd = floorEntry ? snapRoomPoint(floorEntry, pt.x, pt.z) : { x: pt.x, z: pt.z };
          dragState = {
            type: "room-draw", plane: dragState.plane,
            x0: dragState.start.x, z0: dragState.start.z, x1: snappedEnd.x, z1: snappedEnd.z,
          };
          previewRoom = { x0: dragState.x0, z0: dragState.z0, x1: dragState.x1, z1: dragState.z1 };
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

      if (dragState.type === "pending-terrace") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "terrace-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u, side: dragState.side };
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: 7 * FT };
          rebuild();
        }
        return;
      }

      if (dragState.type === "pending-suppbalcony") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "suppbalcony-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u, side: dragState.side };
          previewOpening = { panel: dragState.panelKey, u0: u, u1: u, height: 7 * FT };
          rebuild();
        }
        return;
      }

      if (dragState.type === "pending-column") {
        const dx = e.clientX - dragState.startScreen.x;
        const dy = e.clientY - dragState.startScreen.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_PX) {
          pushUndo();
          const info = dragState.info;
          const u = panelU(info, dragState.hitPoint);
          dragState = { type: "column-draw", panelKey: dragState.panelKey, plane: panelFacePlane(info, dragState.hitPoint), u0: u, u1: u };
          previewColumnBank = { panel: dragState.panelKey, shape: columnShapeRef.current, u0: u, u1: u };
          rebuild();
        }
        return;
      }

      const ray = rayFromEvent(e);

      if (dragState.type === "panel-extrude") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const delta = dragState.thickAxis === "z" ? pt.z - dragState.start.z : pt.x - dragState.start.x;
        const bumpoutBefore = dragState.panelKey.startsWith("bf:")
          ? state.bumpouts.find((b) => "bf:" + b.id === dragState.panelKey) : null;
        const wasFullSpan = bumpoutBefore ? bumpoutIsFullSpan(bumpoutBefore) : false;
        applyPanelExtrude(dragState.panelKey, dragState.startCoord + delta);
        if (bumpoutBefore) {
          // same idea as a partition landing flush -- reaching the far
          // wall with a selected width also starts the press-and-hold
          // timer (see tick()), just with one outcome (delete the notch,
          // splitting into two separate rooms) instead of a 3-way cycle.
          const nowFullSpan = bumpoutIsFullSpan(bumpoutBefore);
          if (nowFullSpan && !wasFullSpan) {
            playClickSound();
            dragState.holdCycleStart = performance.now();
            dragState.wallMode = 0;
          } else if (!nowFullSpan && wasFullSpan) {
            dragState.holdCycleStart = null;
            dragState.wallMode = 0;
          }
        }
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
              // landing flush against the opposite wall is also the moment
              // the press-and-hold solid -> door -> fully-open cycle (see
              // tick()) starts counting from -- pulling back off the wall
              // below cancels it again.
              dragState.holdCycleStart = now;
              dragState.wallMode = 0;
            } else if (!isFullSpan(newExt) && isFullSpan(p.ext)) {
              dragState.holdCycleStart = null;
              dragState.wallMode = 0;
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
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: openingHeightRef.current, bottomOverride: 0 };
        rebuild();
      } else if (dragState.type === "door-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: doorHeightRef.current, isDoor: true };
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
      } else if (dragState.type === "terrace-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: 7 * FT };
        rebuild();
      } else if (dragState.type === "suppbalcony-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewOpening = { panel: dragState.panelKey, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u), height: 7 * FT };
        rebuild();
      } else if (dragState.type === "column-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const info = getPanelInfo(dragState.panelKey);
        if (!info) return;
        const u = Math.max(info.u0, Math.min(info.u1, snapValue(panelU(info, pt))));
        dragState.u1 = u;
        previewColumnBank = { panel: dragState.panelKey, shape: columnShapeRef.current, u0: Math.min(dragState.u0, u), u1: Math.max(dragState.u0, u) };
        rebuild();
      } else if (dragState.type === "resize-opening") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const o = state.openings.find((oo) => oo.id === dragState.id);
        const info = getPanelInfo(dragState.panelKey);
        if (!o || !info) { dragState = null; return; }
        const MIN_OPENING_H = 0.3; // smallest opening you can resize to vertically
        // corner handles (nw/ne/sw/se) drive both axes at once from the
        // same drag -- west/east adjusts u0/u1, north/south adjusts the
        // height, exactly like each used to independently, just combined
        // into one grab per corner instead of a separate bar per edge.
        const edge = dragState.edge;
        const hasW = edge.includes("w"), hasE = edge.includes("e");
        const hasN = edge.includes("n"), hasS = edge.includes("s");
        if (hasW || hasE) {
          const u = snapValue(panelU(info, pt));
          if (hasW) {
            const newU0 = Math.max(info.u0, Math.min(u, o.u1 - MIN_OPENING));
            if (!wouldOverlapOpeningExcluding(o.panel, newU0, o.u1, o.id) && !wouldOverlapBumpout(o.panel, newU0, o.u1)) o.u0 = newU0;
          } else {
            const newU1 = Math.min(info.u1, Math.max(u, o.u0 + MIN_OPENING));
            if (!wouldOverlapOpeningExcluding(o.panel, o.u0, newU1, o.id) && !wouldOverlapBumpout(o.panel, o.u0, newU1)) o.u1 = newU1;
          }
        }
        if (hasN || hasS) {
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
            if (hasN) {
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
      } else if (dragState.type === "resize-wall-height") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const deltaY = pt.y - dragState.startY;
        const newH = snapValue(dragState.startH + deltaY);
        setPanelHeightValue(dragState.panelKey, newH);
        if (selectedPanelRef.current === dragState.panelKey) setSelectedHeight(getPanelHeight(dragState.panelKey));
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
      } else if (dragState.type === "room-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        // the far corner gets its own chance to snap too (not just the
        // start corner from pointerdown) -- dragging the opposite corner
        // toward another room's edge or corner should catch just as easily.
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        const snapped = floorEntry ? snapRoomPoint(floorEntry, pt.x, pt.z) : { x: pt.x, z: pt.z };
        dragState.x1 = snapped.x;
        dragState.z1 = snapped.z;
        previewRoom = { x0: dragState.x0, z0: dragState.z0, x1: dragState.x1, z1: dragState.z1 };
        rebuild();
      } else if (dragState.type === "pillar-area-draw") {
        const pt = new THREE.Vector3();
        if (!ray.intersectPlane(dragState.plane, pt)) return;
        const fp = state.footprint;
        const margin = (state.thickness || 0.35) / 2 + 0.02;
        const clampedX = Math.min(fp.xMax - margin, Math.max(fp.xMin + margin, pt.x));
        const clampedZ = Math.min(fp.zMax - margin, Math.max(fp.zMin + margin, pt.z));
        dragState.x1 = snapValue(clampedX);
        dragState.z1 = snapValue(clampedZ);
        previewPillarArea = { x0: dragState.x0, z0: dragState.z0, x1: dragState.x1, z1: dragState.z1 };
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
      } else if (dragState.type === "pending-door") {
        // a tap with no meaningful drag -- place the fixed-width default
        // door centered on the tap point, same as the old tap-only behavior.
        pushUndo();
        const info = dragState.info;
        // turnstiles are much narrower than a standard door -- a tap
        // should place exactly one, not a standard-width span that the
        // turnstile bank then subdivides into several.
        const doorWidth = doorStyleRef.current === "turnstile" ? TURNSTILE_UNIT_WIDTH
          : doorStyleRef.current === "jailWall" ? JAIL_UNIT_WIDTH
          : 6 * FT;
        const u = panelU(info, dragState.hitPoint);
        let u0 = u - doorWidth / 2, u1 = u + doorWidth / 2;
        if (u0 < info.u0) { u0 = info.u0; u1 = u0 + doorWidth; }
        if (u1 > info.u1) { u1 = info.u1; u0 = u1 - doorWidth; }
        [u0, u1] = applyEdgeMargin(u0, u1, dragState.panelKey);
        if (u1 - u0 >= MIN_OPENING && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          state.openings = state.openings.filter((o) => !(o.panel === dragState.panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          state.openings.push({ id: idSeq++, panel: dragState.panelKey, u0, u1, height: doorHeightRef.current, isDoor: true, dividers: doorSplitRef.current ? 1 : 0, style: doorStyleRef.current });
        }
      } else if (dragState.type === "pending-room-tool") {
        // a tap with no meaningful drag on an undivided floor -- select the
        // whole floor as a room (Cut/Copy/Paste/Duplicate/Delete/Curved
        // corners), same as tapping an already-partitioned sub-room does.
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        if (floorEntry) commitRoomFromFound({ bbox: floorEntry.data.footprint }, dragState.hitPoint);
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
          if (bo && Math.abs(bo.depth) < 0.04) {
            state.bumpouts = state.bumpouts.filter((b) => b.id !== id);
          } else if (bo && dragState.holdCycleStart != null && dragState.wallMode === 1 && bumpoutIsFullSpan(bo)) {
            // released while flush against the far wall and held long
            // enough -- delete this whole width, splitting the room into
            // two separate ones with a real gap between them (see
            // splitFloorWithBumpoutGap).
            const floorEntry = floors.find((f) => f.id === activeFloorId);
            if (stateMatchesFloorContext(floorEntry) && canAutoSplitFloorByBumpout()) {
              splitFloorWithBumpoutGap(floorEntry, bo);
            }
          }
        }
      } else if (dragState.type === "partition-draw" || dragState.type === "partition-redrag") {
        const p = state.partitions.find((pp) => pp.id === dragState.id);
        if (p && Math.abs(p.ext) < 0.04) {
          state.partitions = state.partitions.filter((pp) => pp.id !== p.id);
        } else if (p && dragState.holdCycleStart != null && partitionIsFullSpan(p)) {
          // released while snapped flush and mid-hold -- the room this
          // partition just closed off becomes two independent rooms (see
          // splitFloorWithPartition), with the boundary the hold cycle
          // landed on: solid, an ordinary door, or fully open.
          const floorEntry = floors.find((f) => f.id === activeFloorId);
          if (stateMatchesFloorContext(floorEntry) && canAutoSplitFloor()) {
            splitFloorWithPartition(floorEntry, p, dragState.wallMode || 0);
          }
        }
      } else if (dragState.type === "opening-draw") {
        let [u0, u1] = [Math.min(dragState.u0, dragState.u1), Math.max(dragState.u0, dragState.u1)];
        [u0, u1] = applyEdgeMargin(u0, u1, dragState.panelKey);
        if (u1 - u0 >= MIN_OPENING && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          // a new opening that overlaps existing ones on the same panel
          // replaces them, rather than being blocked -- drawing a wider
          // window over a narrower one simply supersedes it.
          state.openings = state.openings.filter((o) => !(o.panel === dragState.panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          state.openings.push({
            // floor-anchored (bottomOverride 0) rather than vertically
            // centered in the wall, which is what a bare `height` with no
            // override falls back to.
            id: idSeq++, panel: dragState.panelKey, u0, u1, height: openingHeightRef.current, bottomOverride: 0, dividers: openingDividersRef.current,
            dividerAxis: openingAxisVerticalRef.current && openingAxisHorizontalRef.current ? "both" : openingAxisHorizontalRef.current ? "horizontal" : "vertical",
            style: openingStyleRef.current,
          });
        }
        previewOpening = null;
      } else if (dragState.type === "door-draw") {
        let [u0, u1] = [Math.min(dragState.u0, dragState.u1), Math.max(dragState.u0, dragState.u1)];
        [u0, u1] = applyEdgeMargin(u0, u1, dragState.panelKey);
        if (u1 - u0 >= MIN_OPENING && !wouldOverlapBumpout(dragState.panelKey, u0, u1)) {
          state.openings = state.openings.filter((o) => !(o.panel === dragState.panelKey && rangesOverlap(u0, u1, o.u0, o.u1)));
          state.openings.push({ id: idSeq++, panel: dragState.panelKey, u0, u1, height: doorHeightRef.current, isDoor: true, dividers: doorSplitRef.current ? 1 : 0, style: doorStyleRef.current });
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
          const platformHeight = 5 * FT;
          const style = balconyStyleRef.current;
          const bal = {
            id: bid, panel: dragState.panelKey, u0, u1, dividerAxis, side: dragState.side || 1, platformHeight,
            pillarsRemoved: style !== "supported",
            ceilingRemoved: style !== "recessed",
            wraps: computeBalconyWraps(dragState.panelKey, u0, u1),
          };
          if (!state.balconies) state.balconies = [];
          state.balconies.push(bal);
          regenerateBalconyOpenings(bal);
          // deliberately not auto-selected -- the magenta selection
          // highlight right after drawing one is more distracting than
          // useful; tap it afterward if you want to edit it.
          setBalconyStairHeight(platformHeight);
        }
        previewOpening = null;
      } else if (dragState.type === "terrace-draw") {
        const u0 = Math.min(dragState.u0, dragState.u1);
        const u1 = Math.max(dragState.u0, dragState.u1);
        const MIN_TERRACE = 4 * FT;
        if (u1 - u0 >= MIN_TERRACE) {
          const tid = idSeq++;
          const terrace = { id: tid, panel: dragState.panelKey, u0, u1, side: dragState.side || 1 };
          if (!state.terraces) state.terraces = [];
          state.terraces.push(terrace);
          regenerateTerraceOpenings(terrace);
        }
        previewOpening = null;
      } else if (dragState.type === "suppbalcony-draw") {
        const u0s = Math.min(dragState.u0, dragState.u1);
        const u1s = Math.max(dragState.u0, dragState.u1);
        const MIN_SUPPBAL = 6 * FT;
        if (u1s - u0s >= MIN_SUPPBAL) {
          const supp = { id: idSeq++, panel: dragState.panelKey, u0: u0s, u1: u1s, side: dragState.side || 1, platformHeight: 6 * FT, railingCount: 6 };
          if (!state.suppBalconies) state.suppBalconies = [];
          state.suppBalconies.push(supp);
          regenerateSuppBalconyOpening(supp);
          setSuppBalconyHeight(supp.platformHeight);
          setSuppBalconyRailingCount(supp.railingCount);
        }
        previewOpening = null;
      } else if (dragState.type === "column-draw") {
        const u0 = Math.min(dragState.u0, dragState.u1);
        const u1 = Math.max(dragState.u0, dragState.u1);
        const MIN_COLUMN_BANK = 2 * FT;
        if (u1 - u0 >= MIN_COLUMN_BANK) {
          if (!state.columnBanks) state.columnBanks = [];
          state.columnBanks.push({ id: idSeq++, panel: dragState.panelKey, shape: columnShapeRef.current, u0, u1 });
        }
        previewColumnBank = null;
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
      } else if (dragState.type === "room-draw") {
        const xMin = Math.min(dragState.x0, dragState.x1), xMax = Math.max(dragState.x0, dragState.x1);
        const zMin = Math.min(dragState.z0, dragState.z1), zMax = Math.max(dragState.z0, dragState.z1);
        const floorEntry = floors.find((f) => f.id === activeFloorId);
        if (floorEntry && xMax - xMin >= MIN_ROOM_DRAW_SIZE && zMax - zMin >= MIN_ROOM_DRAW_SIZE) {
          const id = idSeq++;
          const data = makeFloorData();
          data.footprint = { xMin, xMax, zMin, zMax };
          data.height = floorEntry.data.height;
          data.thickness = floorEntry.data.thickness;
          const room = { id, data, offsetX: 0, offsetZ: 0 };
          if (!floorEntry.rooms) floorEntry.rooms = [];
          floorEntry.rooms.push(room);
          switchActiveRoom(id);
        }
        previewRoom = null;
      } else if (dragState.type === "pillar-area-draw") {
        const x0 = Math.min(dragState.x0, dragState.x1), x1 = Math.max(dragState.x0, dragState.x1);
        const z0 = Math.min(dragState.z0, dragState.z1), z1 = Math.max(dragState.z0, dragState.z1);
        if (x1 - x0 >= MIN_STAIR_SIZE && z1 - z0 >= MIN_STAIR_SIZE) {
          if (!state.floorPillars) state.floorPillars = [];
          state.floorPillars.push({ id: idSeq++, x0, x1, z0, z1, shape: pillarShapeRef.current });
        }
        previewPillarArea = null;
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
      previewColumnBank = null;
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
      setCeilingFloorIds(floors.filter((f) => f.data.ceilingEnabled).map((f) => f.id));
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
      ctx.fillStyle = "#ffffff";
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
    function switchActiveRoom(id, { silent = false } = {}) {
      if (activeRoomId === id && activeRoomSilent === silent) return;
      activeRoomId = id;
      activeRoomSilent = silent;
      const floorEntry = floors.find((f) => f.id === activeFloorId);
      if (id == null) {
        state = floorEntry ? floorEntry.data : makeFloorData();
      } else {
        const room = floorEntry && (floorEntry.rooms || []).find((r) => r.id === id);
        state = room ? room.data : makeFloorData();
        if (room) {
          setRoomHeight(room.data.height);
          const cc = room.data.curvedCorners || { enabled: false, radius: 0 };
          const rf = room.data.footprint;
          curvedCornersMaxRadiusRef.current = Math.max(0.1, Math.min((rf.xMax - rf.xMin) / 2, (rf.zMax - rf.zMin) / 2) - 0.15);
          setCurvedCornersOn(cc.enabled);
          setCurvedCornersRadius(Math.min(cc.radius || 0.6, curvedCornersMaxRadiusRef.current));
        }
      }
      setSelectedPanel(null);
      // a silent entry (auto-landed here by our own code, not a user tap)
      // deliberately leaves the room unselected -- no Cut/Copy/Delete arming,
      // no "selected" floor highlight -- it's just made editable.
      if (!silent) setSelectedRoomId(id);
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
      const clamped = Math.max(MIN_WALL_HEIGHT, Math.min(MAX_WALL_HEIGHT, h));
      // deliberately just this one room -- "Room height" is the per-room
      // override; "Layer height" (setActiveFloorHeight) is the uniform,
      // whole-layer control that applies to every room on the floor at once.
      room.data.height = clamped;
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
    function setActiveBalconyStyle(style) {
      const id = selectedBalconyIdRef.current;
      if (id == null) return;
      const bal = (state.balconies || []).find((b) => b.id === id);
      if (!bal) return;
      bal.pillarsRemoved = style !== "supported";
      bal.ceilingRemoved = style !== "recessed";
      rebuild();
    }
    balconyStyleApiRef.current = { setStyle: setActiveBalconyStyle };

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

    function deleteActiveTerrace() {
      const id = selectedTerraceIdRef.current;
      if (id == null) return;
      pushUndo();
      state.terraces = (state.terraces || []).filter((t) => t.id !== id);
      state.openings = state.openings.filter((o) => o.fromTerrace !== id);
      setSelectedTerraceId(null);
      rebuild();
    }
    deleteTerraceRef.current = deleteActiveTerrace;

    function deleteActiveFloorPillars() {
      const id = selectedFloorPillarsIdRef.current;
      if (id == null) return;
      pushUndo();
      state.floorPillars = (state.floorPillars || []).filter((p) => p.id !== id);
      setSelectedFloorPillarsId(null);
      rebuild();
    }
    deleteFloorPillarsRef.current = deleteActiveFloorPillars;

    function setActiveSuppBalconyHeight(h) {
      const id = selectedSuppBalconyIdRef.current;
      if (id == null) return;
      const sb = (state.suppBalconies || []).find((s) => s.id === id);
      if (!sb) return;
      sb.platformHeight = Math.max(2 * FT, Math.min(state.height - 2 * FT, h));
      regenerateSuppBalconyOpening(sb);
      rebuild();
    }
    suppBalconyHeightApiRef.current = { setHeight: setActiveSuppBalconyHeight };

    function setActiveSuppBalconyRailingCount(n) {
      const id = selectedSuppBalconyIdRef.current;
      if (id == null) return;
      const sb = (state.suppBalconies || []).find((s) => s.id === id);
      if (!sb) return;
      sb.railingCount = Math.max(2, Math.min(40, Math.round(n)));
      rebuild();
    }
    suppBalconyRailingCountApiRef.current = { setCount: setActiveSuppBalconyRailingCount };

    function deleteActiveSuppBalcony() {
      const id = selectedSuppBalconyIdRef.current;
      if (id == null) return;
      pushUndo();
      state.suppBalconies = (state.suppBalconies || []).filter((s) => s.id !== id);
      state.openings = state.openings.filter((o) => o.fromSuppBalcony !== id);
      setSelectedSuppBalconyId(null);
      rebuild();
    }
    deleteSuppBalconyRef.current = deleteActiveSuppBalcony;

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
      if (!o) return;
      // a door only ever supports a single center split, unlike a window's
      // full 0-20 divider grid.
      o.dividers = Math.max(0, o.isDoor ? Math.min(1, n) : n);
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
    function setActiveOpeningStyle(style) {
      const id = selectedOpeningIdRef.current;
      if (id == null) return;
      const o = (state.openings || []).find((oo) => oo.id === id);
      if (!o) return;
      o.style = style;
      rebuild();
    }
    openingEditApiRef.current = { setHeight: setActiveOpeningHeight, setDividers: setActiveOpeningDividers, setAxis: setActiveOpeningAxis, setStyle: setActiveOpeningStyle };

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
        state.openings.push({ id: idSeq++, panel: wall, u0, u1, height: DEFAULT_OPENING_HEIGHT, bottomOverride: 0, dividers: 1, dividerAxis: "vertical" });
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
      // wall thickness is a whole-building spec (see setActiveFloorThickness)
      // -- a freshly added story should match it rather than silently
      // reverting to makeFloorData()'s hardcoded default.
      if (belowEntry) newData.thickness = belowEntry.data.thickness;
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
        // a generous 2m gap (not the previous 0.5m) -- close enough to read
        // as "next to" the original, but far enough that the two rooms'
        // near walls are clearly two separate, individually clickable
        // panels instead of an almost-touching sliver that's easy to
        // mis-click as the wrong room.
        offsetX: (roomClipboard.offsetX || 0) + (width + 2) * roomPasteCount,
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
        // same generous 2m gap as pasteRoom, for the same reason -- a near-
        // touching duplicate made its own near wall nearly indistinguishable
        // from the original's, an easy way to end up editing the wrong room.
        offsetX: (room.offsetX || 0) + width + 2,
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
      const clamped = Math.max(MIN_WALL_HEIGHT, Math.min(MAX_WALL_HEIGHT, h));
      entry.data.height = clamped;
      // any wall previously given its own individual height override would
      // otherwise stay stuck at that old value forever, since getPanelHeight()
      // prefers a per-panel override over the room's overall height -- when
      // the user is adjusting the room's overall height, the clear intent is
      // for every wall to track it, so per-wall overrides reset here.
      entry.data.panelHeights = {};
      // "Layer height" is a uniform, whole-layer control -- every room
      // pulled out of this floor (the original, any duplicate, every
      // partitioned sub-room) tracks it together, exactly like wall
      // thickness already applies to a whole floor at once. A room's own
      // "Room height" slider is the one place to give a single room a
      // different height from the rest of its layer.
      (entry.rooms || []).forEach((room) => { room.data.height = clamped; room.data.panelHeights = {}; });
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
      // applies to every layer's walls, and every room pulled out of any of
      // them, not just the active one/room -- wall thickness reads as a
      // whole-building spec, not a per-room override. rebuildAllFloors (not
      // the usual rebuild(), which only touches whichever one floor is
      // currently targeted) is what actually gets every other floor's
      // now-stale geometry to reflect it right away instead of waiting
      // until something else happens to rebuild them.
      const clamped = Math.max(0.03, Math.min(3, t));
      floors.forEach((entry) => {
        entry.data.thickness = clamped;
        (entry.rooms || []).forEach((room) => { room.data.thickness = clamped; });
      });
      rebuildAllFloors();
    }
    wallThicknessApiRef.current = { setThickness: setActiveFloorThickness };

    function setActiveFloorCeiling(enabled) {
      const entry = floors.find((f) => f.id === activeFloorId);
      if (!entry) return;
      entry.data.ceilingEnabled = enabled;
      rebuild();
    }
    ceilingApiRef.current = { setEnabled: setActiveFloorCeiling };

    // toggles ceiling for any layer row directly (not just the active
    // floor), so each row's own checkbox works without switching floors.
    function toggleFloorCeiling(id) {
      const entry = floors.find((f) => f.id === id);
      if (!entry) return;
      entry.data.ceilingEnabled = !entry.data.ceilingEnabled;
      if (id === activeFloorId) rebuild();
      else rebuildFloorEntry(entry, false);
      syncFloorsToReact();
    }
    toggleFloorCeilingRef.current = toggleFloorCeiling;

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

    const floorLabelPool = new Map(); // floorId -> label element
    function updateFloorLabels() {
      const layer = floorLabelLayerRef.current;
      if (!layer) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const camForward = new THREE.Vector3();
      activeCamera.getWorldDirection(camForward);
      const seen = new Set();
      floors.forEach((entry) => {
        const visible = isolatedFloorIds.size > 0 ? isolatedFloorIds.has(entry.id) : !hiddenFloorIds.has(entry.id);
        const g = floorGroups.get(entry.id);
        if (!visible || !g) return;
        seen.add(entry.id);
        let el = floorLabelPool.get(entry.id);
        if (!el) {
          // plain floating text -- no button/pill chrome, just a label,
          // using the exact same font/size as the ribbon's own floating
          // parameter labels (e.g. "Opening height" under the Window tool)
          // -- the ".ribbon-label" class, replicated inline since this is a
          // detached DOM node outside React's own tree.
          el = document.createElement("div");
          el.style.position = "absolute";
          el.style.transform = "translate(0, -50%)";
          el.style.pointerEvents = "auto";
          el.style.cursor = "pointer";
          el.style.fontSize = "9.5px";
          el.style.fontWeight = "500";
          el.style.fontFamily = '"Space Mono", ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace';
          el.style.whiteSpace = "nowrap";
          el.style.background = "none";
          el.style.border = "none";
          el.style.padding = "0";
          el.style.textShadow = "0 1px 3px rgba(0,0,0,0.75)";
          el.style.userSelect = "none";
          layer.appendChild(el);
          floorLabelPool.set(entry.id, el);
        }
        el.onclick = () => selectFloorById(entry.id);
        const isActive = entry.id === activeFloorId;
        // dark mode: fixed white/grey (readable against the dark viewport
        // regardless of whatever the tint swatches happen to be set to);
        // light mode: unchanged, still following the Active/Inactive tint
        // colors like before.
        if (uiThemeRef.current === "dark") {
          el.style.color = isActive ? "#ffffff" : "#9a9a9a";
        } else {
          el.style.color = "#" + new THREE.Color(isActive ? currentTintActiveColor : currentTintInactiveColor).getHexString();
        }
        el.textContent = floorNamesRef.current[entry.id] || `Layer ${floors.findIndex((f) => f.id === entry.id) + 1}`;
        // Anchored in SCREEN space, not world space -- a fixed world-space
        // +X offset would swing to the front/left/behind the building as
        // the camera orbits. Instead project every corner of the floor's
        // footprint (top and bottom) and take the rightmost one on screen,
        // so the label always floats just past the building's own silhouette
        // no matter which way it's currently facing.
        const fp = entry.data.footprint;
        const baseY = g.position.y, topY = baseY + entry.data.height;
        const centerWorld = new THREE.Vector3((fp.xMin + fp.xMax) / 2, baseY + entry.data.height / 2, (fp.zMin + fp.zMax) / 2);
        const centerInFront = centerWorld.clone().sub(activeCamera.position).dot(camForward) > 0;
        if (!centerInFront) { el.style.display = "none"; return; }
        const centerNdc = centerWorld.clone().project(activeCamera);
        let maxScreenX = -Infinity;
        [[fp.xMin, fp.zMin], [fp.xMax, fp.zMin], [fp.xMin, fp.zMax], [fp.xMax, fp.zMax]].forEach(([x, z]) => {
          [baseY, topY].forEach((y) => {
            const p = new THREE.Vector3(x, y, z);
            if (p.clone().sub(activeCamera.position).dot(camForward) <= 0) return;
            const ndc = p.project(activeCamera);
            const sx = (ndc.x * 0.5 + 0.5) * rect.width;
            if (sx > maxScreenX) maxScreenX = sx;
          });
        });
        if (maxScreenX === -Infinity) { el.style.display = "none"; return; }
        const sy = (-centerNdc.y * 0.5 + 0.5) * rect.height;
        if (maxScreenX < -50 || maxScreenX > rect.width + 300 || sy < -100 || sy > rect.height + 100) { el.style.display = "none"; return; }
        el.style.display = "block";
        el.style.left = (maxScreenX + 16) + "px";
        el.style.top = sy + "px";
      });
      floorLabelPool.forEach((el, id) => { if (!seen.has(id)) el.style.display = "none"; });
    }
    function hideFloorLabels() {
      floorLabelPool.forEach((el) => { el.style.display = "none"; });
    }

    function hideOverlayLabels() {
      if (heightLabelRef.current) heightLabelRef.current.style.display = "none";
      measureLabelPool.forEach((elx) => { elx.style.display = "none"; });
      hideFloorLabels();
    }

    let raf;
    let lastTickTime = performance.now();
    function tick() {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTickTime) / 1000);
      lastTickTime = now;

      // the press-and-hold solid -> door -> fully-open cycle needs to keep
      // advancing purely from elapsed time while the pointer sits still (no
      // pointermove events fire during a genuinely stationary hold), so it
      // ticks here rather than only in onPointerMove.
      if (dragState && (dragState.type === "partition-draw" || dragState.type === "partition-redrag") && dragState.holdCycleStart != null) {
        const p = state.partitions.find((pp) => pp.id === dragState.id);
        if (p && partitionIsFullSpan(p)) {
          const newMode = Math.floor((now - dragState.holdCycleStart) / WALL_CYCLE_HOLD_MS) % 3;
          if (newMode !== dragState.wallMode) {
            dragState.wallMode = newMode;
            playClickSound();
            rebuild();
          }
        } else {
          dragState.holdCycleStart = null;
          dragState.wallMode = 0;
        }
      }
      // same idea for a selected width pushed flush -- just one threshold
      // ("armed to delete") instead of a 3-way cycle.
      if (dragState && dragState.type === "panel-extrude" && dragState.panelKey.startsWith("bf:") && dragState.holdCycleStart != null) {
        const bo = state.bumpouts.find((b) => "bf:" + b.id === dragState.panelKey);
        if (bo && bumpoutIsFullSpan(bo)) {
          const armed = now - dragState.holdCycleStart >= WALL_DELETE_HOLD_MS ? 1 : 0;
          if (armed !== dragState.wallMode) {
            dragState.wallMode = armed;
            playClickSound();
            rebuild();
          }
        } else {
          dragState.holdCycleStart = null;
          dragState.wallMode = 0;
        }
      }

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
        // floating layer-select labels are a "looking at the building from
        // outside" affordance -- first-person walk mode hides them, same
        // reasoning as the quad-view panes below.
        hideFloorLabels();
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
        updateFloorLabels();
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
      floorLabelPool.forEach((elx) => elx.remove());
      wallMat.dispose();
      floorMat.dispose();
      wallMatDim.dispose();
      floorMatDim.dispose();
      wallMatSelected.dispose();
      floorMatSelected.dispose();
      pillarMat.dispose();
      pillarMatSelected.dispose();
      mullionMat.dispose();
      ceilingMat.dispose();
      balconyRoofMat.dispose();
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
      clearGroup(envContentGroup);
      groundFadeGeo.dispose();
      groundFadeMat.dispose();
      groundFadeTex.dispose();
      realisticEnvMap.dispose();
      reflectionEnvMap.dispose();
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
  const RECENT_HEIGHT = 150;
  const [layersPanelWidth, setLayersPanelWidth] = useState(148);
  const panelResizeRef = useRef(null);
  const layersScrollRef = useRef(null);
  const scrollStripDragRef = useRef(null);
  const recentScrollInnerRef = useRef(null);
  const newSceneBtnRef = useRef(null);
  const defaultLayersWidth = () => 210;
  useEffect(() => { setLayersPanelWidth(defaultLayersWidth()); }, []);
  const [floorNames, setFloorNames] = useState({});
  const floorNamesRef = useRef({});
  useEffect(() => { floorNamesRef.current = floorNames; }, [floorNames]);
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

  // whether the floating tool-parameters panel above the ribbon has
  // anything to show for the current tool/selection -- mirrors the exact
  // conditions each param group below renders under, so the panel fades
  // out fully (rather than sitting there empty) when none of them apply.
  const showToolPanel =
    // "move" (Wall) always shows something -- the Room group when a room
    // is selected, wall-height controls when a panel is selected, and the
    // Column/Pillar mode selectors the rest of the time (nothing selected).
    tool === "move" ||
    ((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) ||
    ((tool === "door" && selectedOpeningId == null) || (selectedOpeningId != null && selectedOpeningIsDoor)) ||
    tool === "props" ||
    selectedStairId != null ||
    selectedBalconyId != null ||
    selectedOpeningId != null;

  return (
    <div data-theme={uiTheme} style={{ position: "relative", width: "100%", height: "100%", background: "var(--bg-window)", overflow: "hidden", fontFamily: "var(--font-system)", overscrollBehavior: "none" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        [data-theme="dark"] {
          /* ONE content color -- the layers panel, the Recent panel, the
             3D viewport's own background, and the ribbon's fill are all
             this exact same value, seamless against each other. The top
             band is the one deliberately different (darker) tone, and
             --splitter is pinned to that same value too (not a separate
             rgba mix) so every divider reads as a hairline of the top
             band's own color, never its own third shade. */
          --bg-content: #2c2c2e;
          --bg-window: var(--bg-content);
          --bg-panel: var(--bg-content);
          --bg-panel-translucent: var(--bg-content);
          --bg-strip: #1c1c1e;
          --splitter: var(--bg-strip);
          /* a light grey (not the near-black --splitter) for the
             layer/recent panels' own edge against the 3D view and the gap
             above Recent -- matching the tone of the app's other light-grey
             chrome (e.g. --border-separator) rather than crushing to black
             against the dark content. */
          --divider-strong: #59595d;
          --wheel-seam: #000000;
          --bg-control: #3a3a3c;
          --bg-control-hover: #444446;
          --bg-control-pressed: #58585a;
          --bg-floating: rgba(30, 30, 30, 0.78);
          --border-separator: rgba(84, 84, 88, 0.65);
          --border-control: rgba(255, 255, 255, 0.12);
          --text-primary: rgba(255, 255, 255, 0.92);
          --text-secondary: rgba(235, 235, 245, 0.6);
          --text-tertiary: rgba(235, 235, 245, 0.3);
          --scrollbar-track: rgba(255, 255, 255, 0.05);
          --bg-thumb: #ffffff;
        }
        [data-theme="light"] {
          /* same rule as dark: one shared content color for the layers
             panel / Recent panel / 3D viewport / ribbon fill, all
             pixel-identical (no seam when you spin the 3D view right up
             against the sidebar); the top band is the one clearly darker
             tone, and every divider -- the band's own bottom edge, the
             ribbon's top edge, the vertical rules between ribbon groups --
             is pinned to that exact same darker value rather than a
             separate translucent-black mix (which read as crushing to
             near-black in practice). */
          --bg-content: #e5e5e5;
          --bg-window: var(--bg-content);
          --bg-panel: var(--bg-content);
          --bg-panel-translucent: var(--bg-content);
          --bg-strip: #e1e1e1;
          --splitter: var(--bg-strip);
          /* the layer/recent panels' own edge against the 3D view, and the
             gap above Recent -- pinned to the exact same top-band color as
             --splitter, not a separately-picked shade. */
          --divider-strong: var(--splitter);
          --wheel-seam: #cccccc;
          --bg-thumb: #ffffff;
          --bg-control: #ffffff;
          --bg-control-hover: #dcdcdc;
          --bg-control-pressed: #cfcfcf;
          --bg-floating: rgba(255, 255, 255, 0.85);
          --border-separator: rgba(0, 0, 0, 0.14);
          --border-control: rgba(0, 0, 0, 0.13);
          --text-primary: rgba(0, 0, 0, 0.88);
          --text-secondary: rgba(0, 0, 0, 0.56);
          --text-tertiary: rgba(0, 0, 0, 0.3);
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
          /* the reference UI's own clean grotesque sans, applied to the
             whole interface in both themes; the color wheel's own internal
             labels keep a separate monospace (--font-mono) for that
             Teenage-Engineering-tool feel. */
          --font-system: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          --font-mono: "Space Mono", ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
          /* a flat, neutral highlighted state (not an alpha tint) -- the
             mockup's own selected-row grey, sampled directly. */
          --bg-selected: #d6d6d6;
          --bg-selected-hover: #cccccc;
          /* a dark selection ring around a plain text/icon option -- the
             mockup's own "no button chrome, just a ring when picked" look */
          --ring-selected: rgba(0, 0, 0, 0.55);
        }
        [data-theme="dark"] {
          --bg-selected: #48484a;
          --bg-selected-hover: #525254;
          --ring-selected: rgba(255, 255, 255, 0.5);
        }
        .rb-btn {
          font-family: var(--font-system);
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0;
          padding: 6px 9px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          transition: box-shadow 0.12s ease, color 0.12s ease, background 0.12s ease;
          white-space: nowrap;
        }
        .rb-btn:hover { background: var(--bg-control-hover); color: var(--text-primary); }
        .rb-btn.active { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ring-selected); color: var(--text-primary); font-weight: 600; }
        .rb-btn.active:hover { background: var(--bg-control-hover); }
        .rb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .rb-btn:disabled { opacity: 0.35; cursor: default; }
        .rb-input {
          width: 54px; font-family: var(--font-system); font-size: 12.5px; padding: 5px 7px;
          border-radius: 6px; border: 0.5px solid var(--border-control); background: var(--bg-control); color: var(--text-primary);
        }
        .rb-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .rb-range { width: 100%; accent-color: var(--accent); height: 3px; }
        /* the theme wheel's own hue/sat/light sliders -- a bare thin line
           with a small dot, matching the reference exactly (no boxed
           track fill, no big thumb). */
        .rb-bare-range { -webkit-appearance: none; appearance: none; width: 100%; height: 14px; background: transparent; cursor: pointer; margin: 0; display: block; }
        .rb-bare-range::-webkit-slider-runnable-track { height: 1px; background: var(--border-separator); }
        .rb-bare-range::-webkit-slider-thumb { -webkit-appearance: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-primary); margin-top: -3.5px; cursor: pointer; }
        .rb-bare-range::-moz-range-track { height: 1px; background: var(--border-separator); border: none; }
        .rb-bare-range::-moz-range-thumb { width: 8px; height: 8px; border-radius: 50%; background: var(--text-primary); border: none; }
        .rb-radio {
          -webkit-appearance: none; appearance: none;
          width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0; margin: 0;
          border: 1.5px solid var(--border-control); background: var(--bg-control);
          cursor: pointer; position: relative;
        }
        .rb-radio:checked::after {
          content: ""; position: absolute; inset: 2.5px; border-radius: 50%; background: var(--accent);
        }
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
          background: var(--bg-panel);
          border-top: 1px solid var(--splitter);
        }
        .ribbon-section { display: flex; align-items: center; gap: 12px; padding: 0 12px; flex-shrink: 0; }
        .ribbon-divider { width: 1px; align-self: stretch; margin: 8px 0; background: var(--splitter); flex-shrink: 0; }
        .ribbon-group { display: flex; flex-direction: column; gap: 3px; min-width: 108px; flex-shrink: 0; justify-content: center; }
        .ribbon-label {
          font-family: var(--font-mono); font-size: 9.5px; text-transform: none; letter-spacing: 0;
          color: var(--text-secondary); font-weight: 500; white-space: nowrap;
        }
        .panel-title {
          font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--text-primary); font-weight: 600;
        }
        .layers-scroll { position: absolute; inset: 0; overflow-y: auto; padding: 8px 34px 8px 8px; -webkit-overflow-scrolling: touch; touch-action: pan-y; overscroll-behavior: contain; }
        .layers-scroll::-webkit-scrollbar { width: 6px; }
        .layers-scroll::-webkit-scrollbar-thumb { background: var(--border-separator); border-radius: 3px; }
        .layers-scroll::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }
        .layers-scroll::-webkit-scrollbar-track { background: transparent; }
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
      <div ref={floorLabelLayerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }} />

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

      {/* LEFT, below the Layers panel and just above the ribbon: Recent --
          a browser-local autosave history (every ~15s, no server to
          persist to), thumbnails you can click to reload that scene. A
          draggable strip along the bottom scrolls sideways through them
          as the list grows, same idea as the Layers panel's own vertical
          scroll strip. */}
      <div
        style={{
          position: "absolute", bottom: RIBBON_HEIGHT, left: 0, height: RECENT_HEIGHT, width: layersPanelWidth,
          background: "var(--bg-panel)", display: "flex", flexDirection: "column", overflow: "hidden",
          borderRight: "1px solid var(--divider-strong)",
        }}
      >
        {/* a clearly-visible splitter with real breathing room on both
            sides, matching the reference's own gap between its object-type
            list and its "recent" section header. */}
        <div style={{ margin: "10px 12px 0", borderTop: "1px solid var(--divider-strong)" }} />
        <div style={{ padding: "10px 9px 4px" }}>
          <span className="panel-title">Recent</span>
        </div>
        <div
          className="recent-scroll layers-scroll"
          ref={recentScrollInnerRef}
          style={{ position: "static", flex: 1, minHeight: 0, display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start", padding: "0 34px 10px 9px" }}
        >
          {DEFAULT_PRESET_SCENES.map((preset) => (
            <button
              key={preset.id}
              className="rb-btn"
              onClick={() => loadPresetScene(preset)}
              title={preset.name}
              style={{ padding: 2, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
            >
              <img src={preset.thumb} alt="" style={{ width: 56, height: 56, borderRadius: 6, display: "block", background: "var(--bg-thumb)", objectFit: "cover" }} />
            </button>
          ))}
          {recentScenes.length === 0 && (
            <span style={{ fontSize: 9, color: "var(--text-tertiary)", flexBasis: "100%" }}>Autosaves every 15s</span>
          )}
          {recentScenes.map((entry) => (
            <button
              key={entry.id}
              className="rb-btn"
              onClick={() => loadRecentScene(entry)}
              title={`${entry.name} · ${new Date(entry.savedAt).toLocaleTimeString()}`}
              style={{
                padding: 2, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                boxShadow: currentSceneIdRef.current === entry.id ? "inset 0 0 0 1.5px var(--ring-selected)" : "none",
              }}
            >
              {entry.thumb ? (
                <img src={entry.thumb} alt="" style={{ width: 56, height: 56, borderRadius: 6, display: "block", background: "var(--bg-thumb)", objectFit: "cover" }} />
              ) : (
                <div style={{ width: 56, height: 56, borderRadius: 6, background: "var(--bg-thumb)" }} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* LEFT: Layers panel -- docked flush to the left edge, directly
          under the top band (not floating), PowerPoint-style slide list,
          resizable via the handle on its right edge; Recent sits below it,
          just above the ribbon. */}
      <div
        style={{
          position: "absolute", top: TOPBAR_HEIGHT, left: 0, bottom: RIBBON_HEIGHT + RECENT_HEIGHT, width: layersPanelWidth,
          background: "var(--bg-panel)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          borderRight: "1px solid var(--divider-strong)",
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
        <div style={{ padding: "12px 12px 9px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="panel-title">Layers</span>
            {/* drag a layer row down onto Dup or Del to duplicate/delete
                *that* layer, or just click either button to act on
                whichever layer is selected; + always creates a fresh
                default layer. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className="rb-btn"
                style={{ padding: "2px 4px", fontSize: 13, flex: "0 0 auto", background: "transparent", border: "none" }}
                onClick={() => addFloorRef.current()}
                title="Add a new layer with a default room"
              >
                +
              </button>
              <button
                ref={dupBtnRef}
                className="rb-btn"
                style={{
                  padding: "2px 7px", fontSize: 9, flex: "0 0 auto",
                  background: dragOverAction === "dup" ? "rgba(255,255,255,0.18)" : "transparent",
                  border: dragOverAction === "dup" ? "1px solid #fff" : "1px solid var(--splitter)",
                }}
                onClick={() => duplicateFloorRef.current()}
                title="Duplicate the selected layer -- or drag a layer row down onto this button"
              >
                Dup
              </button>
              <button
                ref={delBtnRef}
                className="rb-btn"
                style={{
                  padding: "2px 6px", fontSize: 9, flex: "0 0 auto",
                  display: "flex", alignItems: "center",
                  background: dragOverAction === "del" ? "rgba(255,255,255,0.18)" : "transparent",
                  border: dragOverAction === "del" ? "1px solid #fff" : "1px solid var(--splitter)",
                }}
                onClick={() => deleteFloorRef.current()}
                title="Delete the selected layer -- or drag a layer row down onto this button"
              >
                <Trash2 size={12} />
              </button>
            </div>
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
                    const overBtn = (btnRef) => {
                      if (!btnRef.current) return false;
                      const r = btnRef.current.getBoundingClientRect();
                      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
                    };
                    if (overBtn(dupBtnRef)) {
                      setDragOverAction("dup");
                      setDropInfo(null);
                      return;
                    }
                    if (overBtn(delBtnRef)) {
                      setDragOverAction("del");
                      setDropInfo(null);
                      return;
                    }
                    setDragOverAction(null);
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
                    if (ds.moved && dragOverAction === "dup") {
                      selectFloorRef.current(id);
                      duplicateFloorRef.current();
                    } else if (ds.moved && dragOverAction === "del") {
                      selectFloorRef.current(id);
                      deleteFloorRef.current();
                    } else if (ds.moved && dropInfo) {
                      reorderFloorsRef.current(id, dropInfo.targetId, dropInfo.edge === "above" ? "after" : "before");
                    } else if (!ds.moved) {
                      selectFloorRef.current(id);
                    }
                  }
                  floorDragRef.current = null;
                  setDragFloorId(null);
                  setDropInfo(null);
                  setDragOverAction(null);
                }}
                style={{
                  display: "flex", flexDirection: "row", alignItems: "center", gap: 7, cursor: "grab",
                  // bleeds out past .layers-scroll's own 8px/34px side
                  // padding so the selected-row highlight reaches the
                  // panel's true left edge and as far right as the
                  // scrollbar strip allows, rather than stopping short.
                  padding: "5px 34px 5px 8px", margin: "0 -34px 0 -8px", touchAction: "none",
                  opacity: dragFloorId === id ? 0.4 : 1,
                  background: id === activeFloorIdState ? "var(--bg-selected)" : "transparent",
                }}
              >
                <canvas
                  ref={(el) => { if (el) thumbCanvasMapRef.current.set(id, el); }}
                  width={480}
                  height={480}
                  style={{ borderRadius: 6, display: "block", width: 56, height: 56, flexShrink: 0, background: "var(--bg-thumb)" }}
                />
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, height: 64, flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex" }}>
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
                        style={{
                          color: "var(--text-primary)", fontSize: 9.5, cursor: "text",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          // the wrapping div is a row-direction flex container
                          // sized to content (not stretched full-width), so
                          // the rename hotspot is naturally just the name
                          // text -- no alignSelf override needed here, which
                          // would otherwise fight the wrapper's alignItems:
                          // center and pin the name to the top of its row.
                          maxWidth: "100%", display: "inline-block",
                        }}
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
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-secondary)", fontSize: 8.5, cursor: "pointer" }}>
                      Ceil
                      <input
                        type="checkbox"
                        className="rb-radio"
                        checked={ceilingFloorIds.includes(id)}
                        onChange={() => toggleFloorCeilingRef.current(id)}
                        title="Toggle this layer's ceiling"
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-secondary)", fontSize: 8.5, cursor: "pointer" }}>
                      Iso
                      <input
                        type="checkbox"
                        className="rb-radio"
                        checked={isolatedFloorIdsState.includes(id)}
                        onChange={() => toggleIsolateRef.current(id)}
                        title="Isolate this layer (multiple can be isolated together)"
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-secondary)", fontSize: 8.5, cursor: "pointer" }}>
                      Hide
                      <input
                        type="checkbox"
                        className="rb-radio"
                        checked={hiddenIds.includes(id)}
                        onChange={() => toggleHideRef.current(id)}
                        title="Hide this layer"
                      />
                    </label>
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

        <div style={{ padding: "12px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9.5, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                className="rb-radio"
                checked={groundOn}
                onChange={(e) => {
                  setGroundOn(e.target.checked);
                  groundApiRef.current.setEnabled(e.target.checked);
                }}
              />
              Ground
            </label>
            {groundOn && (
              <button
                className="rb-btn"
                onClick={() => setGroundTheme((i) => (i + 1) % GROUND_THEMES.length)}
                title={`World: ${GROUND_THEME_LABELS[groundTheme]} (tap to cycle: ${GROUND_THEME_LABELS.join(", ")})`}
                style={{
                  padding: 0, width: 18, height: 18, minWidth: 18, borderRadius: "50%", overflow: "hidden",
                  background: "conic-gradient(from 0deg, #6fae55 0turn 0.25turn, #9a9a9a 0.25turn 0.5turn, #f5f5f2 0.5turn 0.75turn, #232323 0.75turn 1turn)",
                  border: "1px solid var(--border-control)", flexShrink: 0,
                }}
              />
            )}
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-secondary)", fontSize: 9.5, marginBottom: 4 }}>
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
          </div>
          <div>
            {/* wall thickness applies to every layer at once (see
                setActiveFloorThickness), so it lives here rather than in
                the per-tool floating panel -- it's a whole-building spec,
                not a transient Wall-tool parameter. */}
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-secondary)", fontSize: 9.5, marginBottom: 4 }}>
              <span>Wall thickness</span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{wallThickness.toFixed(2)} m</span>
            </div>
            <input
              className="rb-range"
              type="range"
              min={0.03}
              max={3}
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
          <div ref={hudRef} style={{ fontSize: 10.5, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }} />
        </div>
      </div>

      {/* TOP: full-width row so the resizable layers panel below can never
          overlap these controls, no matter how wide it's dragged -- a flat
          band behind it (a shade darker than the layers panel below), same
          treatment as the bottom ribbon, rather than the buttons floating
          bare over the 3D view. The band itself stays pointer-events:none
          (like before) so the gap between the two button clusters still
          lets you orbit the camera through it. A single hairline at its
          own bottom edge, in that same darker color, is the only divider
          between it and the lighter content below. */}
      <div
        style={{
          position: "absolute", top: 0, left: 0, right: 0, height: TOPBAR_HEIGHT,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 12px", gap: 12, pointerEvents: "none",
          background: "var(--bg-strip)",
          borderBottom: "1px solid var(--splitter)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto" }}>
          <button
            ref={newSceneBtnRef}
            className="rb-btn"
            onClick={() => {
              currentSceneIdRef.current = `scene_${Date.now()}`;
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
              setTintActiveOn(true);
              setTintActiveColor(0xffffff);
              setTintInactiveOn(true);
              setTintInactiveColor(0xff6b1a);
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
              setDoorHeight(10 * FT);
              setDoorSplit(false);
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
            title="Duplicate the selected room"
            disabled={selectedRoomId == null}
            style={{ display: "flex", alignItems: "center" }}
            onClick={() => duplicateRoomRef.current()}
          >
            <Copy size={16} strokeWidth={2} />
          </button>
          <button
            className="rb-btn"
            title="Delete whatever is currently selected"
            style={{ display: "flex", alignItems: "center" }}
            onClick={() => {
              if (selectedBalconyId != null) deleteBalconyRef.current();
              else if (selectedStairId != null) deleteStairRef.current();
              else if (selectedOpeningId != null) deleteOpeningRef.current();
              else if (selectedPropId != null) deletePropRef.current();
              else if (selectedRoomId != null) deleteRoomRef.current();
            }}
          >
            <Trash2 size={16} strokeWidth={2} />
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

      {/* floats directly over the always-dark 3D canvas, not over any
          themed chrome panel, so it stays a fixed light color in both
          themes rather than following --text-secondary/tertiary (which
          would go dark-on-dark and vanish in light mode). The room
          dimensions readout itself now lives in the Layers panel instead
          of floating here. */}
      <div style={{ position: "absolute", bottom: RIBBON_HEIGHT + 12, right: 16, color: uiTheme === "light" ? "rgba(20,20,20,0.5)" : "rgba(255,255,255,0.45)", textShadow: uiTheme === "light" ? "0 1px 2px rgba(255,255,255,0.6)" : "0 1px 2px rgba(0,0,0,0.5)", fontSize: 8.5, textAlign: "right" }}>
        Drag empty space to orbit (or pan, in a fixed view) &middot; scroll or pinch to zoom &middot; two-finger drag to pan
      </div>

      {/* floating tool-parameters panel -- fades up above the ribbon,
          roughly aligned over the Wall/Window/Door/Stairs/Props group,
          showing whatever's relevant to the active tool/selection instead
          of a fixed row of controls that's always in the ribbon whether
          or not they apply right now. */}
      <div
        style={{
          position: "absolute", left: layersPanelWidth + 20, bottom: RIBBON_HEIGHT + 20, zIndex: 5,
          display: "flex", alignItems: "flex-end", gap: 22, flexWrap: "wrap",
          maxWidth: `calc(100% - ${layersPanelWidth + 40}px)`,
          // no panel chrome -- text and thin sliders float directly over
          // the 3D view, same treatment as the color wheel's own
          // hue/saturation/lightness sliders.
          opacity: showToolPanel ? 1 : 0,
          transform: showToolPanel ? "translateY(0)" : "translateY(8px)",
          pointerEvents: showToolPanel ? "auto" : "none",
          transition: "opacity 0.18s ease, transform 0.18s ease",
          filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.4))",
        }}
      >
        {tool === "move" && selectedPanel == null && (
          <div className="ribbon-group" style={{ minWidth: 220 }}>
            <span className="ribbon-label">Column</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "none", label: "None" },
                { key: "square", label: "Square" },
                { key: "round", label: "Round" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${columnShape === s ? "active" : ""}`}
                  onClick={() => {
                    setColumnShape(s);
                    if (s !== "none") setPillarShape("none");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {tool === "move" && selectedPanel == null && (
          <div className="ribbon-group" style={{ minWidth: 220 }}>
            <span className="ribbon-label">Pillar</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "none", label: "None" },
                { key: "round", label: "Round" },
                { key: "square", label: "Square" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${pillarShape === s ? "active" : ""}`}
                  onClick={() => {
                    setPillarShape(s);
                    if (s !== "none") setColumnShape("none");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
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
                className="rb-bare-range"
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
                    className="rb-radio"
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
                className="rb-bare-range"
                type="range"
                min={0.1}
                max={curvedCornersMaxRadiusRef.current}
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
                className="rb-bare-range"
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
        {((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) && (
          <div className="ribbon-group">
            <span className="ribbon-label">
              {selectedOpeningId != null ? "Selected window height" : "Opening height"} &middot; {(openingHeight / FT).toFixed(2)} ft
            </span>
            <input
              className="rb-bare-range"
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
              className="rb-bare-range"
              type="range"
              min={0}
              max={20}
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
        {((tool === "cut" && selectedOpeningId == null) || (selectedOpeningId != null && !selectedOpeningIsDoor)) && (
          <div className="ribbon-group">
            <span className="ribbon-label">Window style</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "grid", label: "Grid" },
                { key: "round", label: "Round" },
                { key: "louver", label: "Louver" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${openingStyle === s ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    setOpeningStyle(s);
                    if (selectedOpeningId != null) openingEditApiRef.current.setStyle(s);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {((tool === "door" && selectedOpeningId == null) || (selectedOpeningId != null && selectedOpeningIsDoor)) && (
          <div className="ribbon-group">
            <span className="ribbon-label">
              {selectedOpeningId != null ? "Selected door height" : "Door height"} &middot; {(doorHeight / FT).toFixed(2)} ft
            </span>
            <input
              className="rb-bare-range"
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
        {((tool === "door" && selectedOpeningId == null) || (selectedOpeningId != null && selectedOpeningIsDoor)) && (
          <div className="ribbon-group" style={{ minWidth: 260 }}>
            <span className="ribbon-label">Style</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                { key: "standard", label: "Standard" },
                { key: "arched", label: "Arched" },
                { key: "revolving", label: "Revolving" },
                { key: "turnstile", label: "Turnstile" },
                { key: "jailWall", label: "Jail wall" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${doorStyle === s ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    setDoorStyle(s);
                    if (selectedOpeningId != null) openingEditApiRef.current.setStyle(s);
                  }}
                >
                  {label}
                </button>
              ))}
              {doorStyle === "standard" && (
                <button
                  className={`rb-btn ${doorSplit ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    const v = !doorSplit;
                    setDoorSplit(v);
                    if (selectedOpeningId != null) openingEditApiRef.current.setDividers(v ? 1 : 0);
                  }}
                >
                  Split door
                </button>
              )}
            </div>
          </div>
        )}
        {tool === "props" && (
          <div className="ribbon-group" style={{ minWidth: 220 }}>
            <span className="ribbon-label">Prop shape</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "sphere", Icon: Globe },
                { key: "cube", Icon: Box },
                { key: "cone", Icon: Cone },
                { key: "cylinder", Icon: Cylinder },
              ].map(({ key: s, Icon }) => (
                <button
                  key={s}
                  className={`rb-btn ${propsShape === s ? "active" : ""}`}
                  onClick={() => setPropsShape(s)}
                  title={s.charAt(0).toUpperCase() + s.slice(1)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, padding: 0 }}
                >
                  <Icon size={16} strokeWidth={2} />
                </button>
              ))}
              {[
                { key: "balcony", label: "Balcony" },
                { key: "terrace", label: "Terrace" },
                { key: "suppBalcony", label: "Supported Balcony" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${propsShape === s ? "active" : ""}`}
                  onClick={() => setPropsShape(s)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {tool === "props" && propsShape === "balcony" && (
          <div className="ribbon-group" style={{ minWidth: 220 }}>
            <span className="ribbon-label">Balcony style</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "supported", label: "Supported" },
                { key: "recessed", label: "Recessed" },
                { key: "cantilevered", label: "Cantilevered" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${balconyStyle === s ? "active" : ""}`}
                  onClick={() => setBalconyStyle(s)}
                >
                  {label}
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
                className="rb-bare-range"
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
          <div className="ribbon-group" style={{ minWidth: 220 }}>
            <span className="ribbon-label">Balcony style</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { key: "supported", label: "Supported" },
                { key: "recessed", label: "Recessed" },
                { key: "cantilevered", label: "Cantilevered" },
              ].map(({ key: s, label }) => (
                <button
                  key={s}
                  className={`rb-btn ${balconyStyle === s ? "active" : ""}`}
                  onClick={() => {
                    pushUndoRef.current();
                    setBalconyStyle(s);
                    balconyStyleApiRef.current.setStyle(s);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {selectedBalconyId != null && (
          <div className="ribbon-group" style={{ minWidth: 260 }}>
            <span className="ribbon-label">Staircase height &middot; {(balconyStairHeight / FT).toFixed(2)} ft</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="rb-bare-range"
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
              className="rb-bare-range"
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
              className="rb-bare-range"
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
              className="rb-bare-range"
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
        {selectedTerraceId != null && (
          <div className="ribbon-group" style={{ minWidth: 160 }}>
            <span className="ribbon-label">Terrace selected</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="rb-btn" onClick={() => deleteTerraceRef.current()}>Delete</button>
              <button className="rb-btn" onClick={() => setSelectedTerraceId(null)}>Done</button>
            </div>
          </div>
        )}
        {selectedFloorPillarsId != null && (
          <div className="ribbon-group" style={{ minWidth: 160 }}>
            <span className="ribbon-label">Pillars selected</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="rb-btn" onClick={() => deleteFloorPillarsRef.current()}>Delete</button>
              <button className="rb-btn" onClick={() => setSelectedFloorPillarsId(null)}>Done</button>
            </div>
          </div>
        )}
        {selectedSuppBalconyId != null && (
          <div className="ribbon-group" style={{ minWidth: 260 }}>
            <span className="ribbon-label">Platform height &middot; {(suppBalconyHeight / FT).toFixed(2)} ft</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="rb-bare-range"
                type="range"
                min={2}
                max={Math.max(2.5, (floorHeight - 2 * FT) / FT)}
                step={0.1}
                value={suppBalconyHeight / FT}
                onPointerDown={() => pushUndoRef.current()}
                onChange={(e) => {
                  const ft = parseFloat(e.target.value);
                  setSuppBalconyHeight(ft * FT);
                  suppBalconyHeightApiRef.current.setHeight(ft * FT);
                }}
              />
              <button className="rb-btn" onClick={() => deleteSuppBalconyRef.current()}>Delete</button>
              <button className="rb-btn" onClick={() => setSelectedSuppBalconyId(null)}>Done</button>
            </div>
          </div>
        )}
        {selectedSuppBalconyId != null && (
          <div className="ribbon-group" style={{ minWidth: 200 }}>
            <span className="ribbon-label">Railings &middot; {suppBalconyRailingCount}</span>
            <input
              className="rb-bare-range"
              type="range"
              min={2}
              max={40}
              step={1}
              value={suppBalconyRailingCount}
              onPointerDown={() => pushUndoRef.current()}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setSuppBalconyRailingCount(n);
                suppBalconyRailingCountApiRef.current.setCount(n);
              }}
            />
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

      {/* BOTTOM: ribbon -- tools, then snapping/measurements, then viewport controls */}
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
              boxShadow: themeWheelOpen ? "0 0 0 2px var(--ring-selected)" : "none",
            }}
          />
          <button
            className="rb-btn"
            onClick={() => setBuildingMaterialIndex((i) => (i + 1) % BUILDING_MATERIAL_NAMES.length)}
            title={`Finish: ${BUILDING_MATERIAL_NAMES[buildingMaterialIndex]} (click to cycle: ${BUILDING_MATERIAL_NAMES.join(", ")}) -- an overlay on the current theme color, except concrete which keeps its own grey`}
            style={{
              padding: 0, width: 28, height: 28, minWidth: 28, borderRadius: "50%", overflow: "hidden",
              background: "conic-gradient(from 0deg, #9a9a9a 0turn 0.25turn, #232323 0.25turn 0.5turn, #f2c230 0.5turn 0.75turn, #f5f5f2 0.75turn 1turn)",
              border: "1px solid var(--border-control)",
            }}
          />
          <button className={`rb-btn ${tool === "move" ? "active" : ""}`} onClick={() => setTool("move")}>Wall</button>
          <button className={`rb-btn ${tool === "cut" ? "active" : ""}`} onClick={() => setTool("cut")}>Window</button>
          <button className={`rb-btn ${tool === "door" ? "active" : ""}`} onClick={() => setTool("door")}>Door</button>
          <button className={`rb-btn ${tool === "room" ? "active" : ""}`} onClick={() => setTool("room")} title="Tap and drag to draw a new room -- on the floor, or on open ground beside it">Room</button>
          <button className={`rb-btn ${tool === "stairs" ? "active" : ""}`} onClick={() => setTool("stairs")}>Stairs</button>
          <button className={`rb-btn ${tool === "props" ? "active" : ""}`} onClick={() => setTool("props")}>Props</button>
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
          </div>
        </div>

        <div className="ribbon-divider" />

        <div className="ribbon-section">
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button className={`rb-btn ${hiddenLineMode ? "active" : ""}`} onClick={() => setHiddenLineMode((v) => !v)}>Hidden line</button>
            <button className={`rb-btn ${wireframeMode ? "active" : ""}`} onClick={() => setWireframeMode((v) => !v)}>Wireframe</button>
            <button className={`rb-btn ${transparentInactive ? "active" : ""}`} onClick={() => setTransparentInactive((v) => !v)}>Fade inactive</button>
            <button className={`rb-btn ${ultraRealistic ? "active" : ""}`} onClick={() => setUltraRealistic((v) => !v)}>Realistic</button>
          </div>
          <div className="ribbon-group" style={{ minWidth: 110 }}>
            <span className="ribbon-label">Light</span>
            <input
              className="rb-range"
              type="range"
              min={0}
              max={360}
              step={1}
              value={lightAzimuth}
              onChange={(e) => setLightAzimuth(parseFloat(e.target.value))}
            />
          </div>
          <div className="ribbon-group" style={{ minWidth: 150, gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" className="rb-radio" checked={tintActiveOn} onChange={(e) => setTintActiveOn(e.target.checked)} />
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
              <input type="checkbox" className="rb-radio" checked={tintInactiveOn} onChange={(e) => setTintInactiveOn(e.target.checked)} />
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
          mode={themeWheelMode}
          onToggleMode={() => setThemeWheelMode((m) => (m === "hue" ? "theme" : "hue"))}
          onPick={(anchor) => setThemeAnchor(anchor)}
          onClose={() => setThemeWheelOpen(false)}
          hueShift={themeHueShift}
          satMul={themeSatMul}
          lightMul={themeLightMul}
          onSlider={(key, value) => {
            if (key === "hue") setThemeHueShift(value);
            else if (key === "sat") setThemeSatMul(value);
            else if (key === "light") setThemeLightMul(value);
          }}
        />
      )}
    </div>
  );
}
