/**
 * A living picture of one subway line.
 *
 * There is no interface here on purpose — the map, the line and the trains are
 * the whole piece. What keeps it honest is underneath: the server hands each
 * train a link (the stretch of track between two stops) and the two timestamps
 * that bound it, and position is a pure function of those and the clock. No
 * simulation carries state between frames, so the picture is the same in two
 * tabs and survives a reload.
 */

const POLL_MS = 15_000;
const THEME_CHECK_MS = 5 * 60_000;
const IDLE_RESTORE_MS = 25_000;
const RECONCILE_TAU = 0.35;
const TRACK_OFFSET_PX = 4.5;
const RIPPLE_MS = 2600;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TILES = {
  day: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
  night: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
};

const dom = {
  count: document.getElementById("count"),
  pulse: document.getElementById("pulse")
};

const map = L.map("map", {
  attributionControl: false,
  zoomControl: false,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  minZoom: 9,
  maxZoom: 17
}).setView([40.72, -73.98], 11);

const tiles = L.tileLayer(TILES.day, { maxZoom: 19, detectRetina: true }).addTo(map);

const trainPane = map.createPane("trains");
trainPane.style.zIndex = 620;
trainPane.style.pointerEvents = "none";

let network = null;
let homeBounds = null;
let clockOffset = 0;
const offsetSamples = [];

const trains = new Map();
const geometryCache = new Map();

let theme = null;
let lastFrame = performance.now();
let userMovedAt = 0;
let restoring = false;

// ------------------------------------------------------------------ utilities

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const baseId = (stopId = "") => stopId.replace(/[NS]$/, "");
const serverNow = () => Date.now() / 1000 + clockOffset;

/** Matches the easing the server uses, so both agree on where a train is. */
function ease(t) {
  const smooth = t * t * (3 - 2 * t);
  return t * 0.55 + smooth * 0.45;
}

function shortestAngle(from, to) {
  return ((to - from + 540) % 360) - 180;
}

// --------------------------------------------------------------- day and night

function newYorkHour() {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
  return Number(formatted);
}

function intendedTheme() {
  const forced = new URLSearchParams(location.search).get("theme");
  if (forced === "day" || forced === "night") return forced;
  const hour = newYorkHour();
  return Number.isFinite(hour) && (hour >= 19 || hour < 6) ? "night" : "day";
}

function applyTheme() {
  const next = intendedTheme();
  if (next === theme) return;
  theme = next;
  document.documentElement.dataset.theme = theme;
  tiles.setUrl(TILES[theme]);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#0b0d12" : "#f4f1e8");
}

// ------------------------------------------------------------------- geometry

function geometryFor(key) {
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const segment = network.segments[key];
  if (!segment) return null;

  const points = segment.path.map(([lat, lon]) => map.latLngToLayerPoint(L.latLng(lat, lon)));
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += points[i].distanceTo(points[i - 1]);
    cumulative.push(total);
  }

  const geometry = { points, cumulative, length: total };
  geometryCache.set(key, geometry);
  return geometry;
}

function pointAlong(geometry, fraction) {
  const target = clamp(fraction, 0, 1) * geometry.length;
  let index = 0;
  while (index < geometry.cumulative.length - 2 && geometry.cumulative[index + 1] < target) index += 1;

  const start = geometry.cumulative[index];
  const span = geometry.cumulative[index + 1] - start || 1;
  const t = clamp((target - start) / span, 0, 1);
  const a = geometry.points[index];
  const b = geometry.points[index + 1] ?? a;

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  };
}

// -------------------------------------------------------------- the line drawn

function drawNetwork() {
  const casing = [];
  const core = [];

  for (const edge of network.edges) {
    const latLngs = edge.path.map(([lat, lon]) => L.latLng(lat, lon));
    casing.push(L.polyline(latLngs, { className: "rail-casing", interactive: false }));
    core.push(L.polyline(latLngs, { className: "rail-core", interactive: false }));
  }

  L.layerGroup(casing).addTo(map);
  L.layerGroup(core).addTo(map);

  for (const station of Object.values(network.stations)) {
    L.circleMarker([station.lat, station.lon], {
      className: station.terminal ? "stop stop-terminal" : "stop",
      radius: station.terminal ? 4.5 : 2.6,
      interactive: false
    }).addTo(map);
  }

  homeBounds = L.latLngBounds(Object.values(network.stations).map((s) => [s.lat, s.lon]));
  frameLine(false);
}

/** The composition: the line, centred, with room to breathe. */
function framePadding() {
  const short = Math.min(window.innerWidth, window.innerHeight);
  const inset = clamp(Math.round(short * 0.11), 26, 90);
  return { paddingTopLeft: [inset, inset + 42], paddingBottomRight: [inset, inset + 52] };
}

function frameLine(animate) {
  if (!homeBounds) return;
  map.flyToBounds(homeBounds, { ...framePadding(), duration: animate ? 2.4 : 0, animate });
}

// ---------------------------------------------------------------------- trains

function makeTrainElement(data) {
  const element = document.createElement("div");
  element.className = "train";
  element.dataset.direction = data.directionId === 0 ? "astoria" : "coney";
  element.innerHTML = '<span class="trail"></span><span class="glow"></span><span class="car"></span>';
  trainPane.append(element);
  return element;
}

/** A ring where a train is standing at a platform. The line's heartbeat. */
function ripple(stationBaseId) {
  if (reduceMotion) return;
  const station = network.stations[stationBaseId];
  if (!station) return;

  const point = map.latLngToLayerPoint([station.lat, station.lon]);
  const ring = document.createElement("span");
  ring.className = "ripple";
  // The keyframes animate transform, so the position travels as a variable.
  ring.style.setProperty("--x", `${point.x.toFixed(1)}px`);
  ring.style.setProperty("--y", `${point.y.toFixed(1)}px`);
  trainPane.append(ring);
  setTimeout(() => ring.remove(), RIPPLE_MS);
}

function targetFraction(train, now) {
  const data = train.data;
  if (!data.segment) return 1;
  const span = data.arrivesAt - data.departedAt;
  if (!(span > 0)) return 1;
  if (data.atStation) return 1;
  return clamp((now - data.departedAt) / span, 0, 1);
}

function renderTrains(dt, now) {
  for (const train of trains.values()) {
    const target = ease(targetFraction(train, now));

    if (train.rendered === null || train.snap) {
      train.rendered = target;
      train.snap = false;
    } else {
      const pull = reduceMotion ? 1 : 1 - Math.exp(-dt / RECONCILE_TAU);
      train.rendered += (target - train.rendered) * pull;
    }

    const geometry = train.data.segment ? geometryFor(train.data.segment) : null;
    let placed;

    if (geometry) {
      placed = pointAlong(geometry, train.rendered);
    } else {
      const station = network.stations[baseId(train.data.to || "")];
      if (!station) continue;
      const point = map.latLngToLayerPoint([station.lat, station.lon]);
      placed = { x: point.x, y: point.y, angle: train.angle ?? 0 };
    }

    train.angle = train.angle === null
      ? placed.angle
      : train.angle + shortestAngle(train.angle, placed.angle) * (reduceMotion ? 1 : Math.min(1, dt * 6));

    // Each direction rides its own side of the track, as the tracks are laid.
    const side = train.data.directionId === 0 ? -1 : 1;
    const radians = (train.angle * Math.PI) / 180;
    const x = placed.x - Math.sin(radians) * TRACK_OFFSET_PX * side;
    const y = placed.y + Math.cos(radians) * TRACK_OFFSET_PX * side;

    train.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${train.angle.toFixed(1)}deg)`;
    train.element.classList.toggle("is-still", Boolean(train.data.atStation));
  }
}

function syncTrains(payload) {
  const seen = new Set();

  for (const data of payload.trains) {
    seen.add(data.id);
    const existing = trains.get(data.id);

    if (existing) {
      // A new link restarts the fraction at 0, so easing towards it would drag
      // the train backwards. Geometry is continuous across links anyway.
      existing.snap = existing.data.segment !== data.segment;
      const arrived = data.atStation && existing.dwellingAt !== data.to;
      existing.dwellingAt = data.atStation ? data.to : null;
      existing.data = data;
      if (arrived) ripple(baseId(data.to));
    } else {
      trains.set(data.id, {
        data,
        element: makeTrainElement(data),
        rendered: null,
        angle: null,
        snap: false,
        dwellingAt: data.atStation ? data.to : null
      });
    }
  }

  for (const [id, train] of trains) {
    if (seen.has(id)) continue;
    train.element.classList.add("is-leaving");
    setTimeout(() => train.element.remove(), 700);
    trains.delete(id);
  }

  dom.count.textContent = payload.trains.length;
  dom.pulse.classList.toggle("is-stale", Boolean(payload.stale));
  document.body.classList.remove("is-adrift");
}

// ------------------------------------------------------------------- the loop

function frame(timestamp) {
  const dt = Math.min(0.1, (timestamp - lastFrame) / 1000);
  lastFrame = timestamp;

  if (network) {
    renderTrains(dt, serverNow());

    if (userMovedAt && Date.now() - userMovedAt > IDLE_RESTORE_MS) {
      userMovedAt = 0;
      restoring = true;
      frameLine(true);
    }
  }

  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------- data

async function loadNetwork() {
  const response = await fetch("/api/network");
  if (!response.ok) throw new Error(`network ${response.status}`);
  network = await response.json();
  drawNetwork();
}

async function poll() {
  const started = performance.now();
  const response = await fetch("/api/trains", { cache: "no-store" });
  if (!response.ok) throw new Error(`trains ${response.status}`);
  const payload = await response.json();

  const roundTrip = (performance.now() - started) / 1000;
  offsetSamples.push(payload.serverTime + roundTrip / 2 - Date.now() / 1000);
  if (offsetSamples.length > 5) offsetSamples.shift();
  clockOffset = [...offsetSamples].sort((a, b) => a - b)[Math.floor(offsetSamples.length / 2)];

  syncTrains(payload);
}

async function tick() {
  try {
    await poll();
  } catch {
    document.body.classList.add("is-adrift");
  }
}

// ---------------------------------------------------- gestures, quietly allowed

map.on("zoomend viewreset", () => {
  geometryCache.clear();
  for (const train of trains.values()) train.snap = true;
  for (const ring of trainPane.querySelectorAll(".ripple")) ring.remove();
});

map.on("dragstart zoomstart", () => {
  if (!restoring) userMovedAt = Date.now();
});

map.on("moveend", () => {
  restoring = false;
});

let resizeTimer;
window.addEventListener("resize", () => {
  geometryCache.clear();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!userMovedAt) frameLine(false);
  }, 250);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    applyTheme();
    tick();
  }
});

async function boot() {
  applyTheme();
  setInterval(applyTheme, THEME_CHECK_MS);

  try {
    await loadNetwork();
  } catch {
    document.body.classList.add("is-adrift");
    return;
  }

  requestAnimationFrame(frame);
  await tick();
  setInterval(tick, POLL_MS);
  requestAnimationFrame(() => document.body.classList.add("is-awake"));
}

boot();
