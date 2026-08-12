/**
 * NYC N Train — the original single scene: the city behind, the line in front,
 * the trains on it. No controls, no panels.
 *
 * What changed underneath (and only underneath): the server places each train
 * on the stretch of track it is actually running, bounded by two timestamps,
 * and this file evaluates that placement against a server-synchronised clock
 * every frame. Position is a pure function of feed + time, so a reload lands
 * every train exactly where it was.
 */

const REFRESH_MS = 15_000;
const RECONCILE_TAU = 0.35;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const map = L.map("map", {
  attributionControl: false,
  boxZoom: false,
  doubleClickZoom: false,
  dragging: false,
  keyboard: false,
  scrollWheelZoom: false,
  touchZoom: false,
  zoomControl: false,
  zoomDelta: 0.1,
  zoomSnap: 0.1
}).setView([40.735, -73.985], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
  maxZoom: 20
}).addTo(map);

const fallbackEl = document.querySelector("#fallback");
const trainLayer = L.DomUtil.create("div", "train-layer", map.getPanes().overlayPane);
const trains = new Map();

let network = null;
let clockOffset = 0;
const offsetSamples = [];
const geometryCache = new Map();
let lastFrameTime = performance.now();
let animationStarted = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shortestAngle(from, to) {
  return ((to - from + 540) % 360) - 180;
}

const serverNow = () => Date.now() / 1000 + clockOffset;

/** Matches the easing the server uses, so both agree on where a train is. */
function ease(t) {
  const smooth = t * t * (3 - 2 * t);
  return t * 0.55 + smooth * 0.45;
}

// ------------------------------------------------------------------- geometry

/**
 * Track geometry in layer pixels per stop-pair link, with cumulative lengths.
 * Rebuilt whenever the map's pixel origin changes (zoom, resize).
 */
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

// ------------------------------------------------------------------- the line

function drawNetwork() {
  const rails = [];
  const lines = [];
  const centers = [];

  // Every physical link the N uses — bridge and tunnel routes alike — drawn in
  // the original three passes: black rail, yellow line, dotted centre.
  for (const edge of network.edges) {
    const latLngs = edge.path.map(([lat, lon]) => L.latLng(lat, lon));
    rails.push(L.polyline(latLngs, {
      className: "route-rail",
      color: "#171717",
      interactive: false,
      opacity: 1,
      weight: 13
    }));
    lines.push(L.polyline(latLngs, {
      className: "route-line",
      color: network.route.color || "#fccc0a",
      interactive: false,
      opacity: 1,
      weight: 7
    }));
    centers.push(L.polyline(latLngs, {
      className: "route-center",
      color: "#171717",
      interactive: false,
      opacity: 0.9,
      weight: 1.25
    }));
  }

  L.layerGroup(rails).addTo(map);
  L.layerGroup(lines).addTo(map);
  L.layerGroup(centers).addTo(map);

  map.fitBounds(
    L.latLngBounds(Object.values(network.stations).map((s) => [s.lat, s.lon])),
    {
      animate: false,
      paddingTopLeft: [82, 36],
      paddingBottomRight: [64, 36]
    }
  );
}

// --------------------------------------------------------------------- trains

function makeTrainElement(directionId) {
  const node = document.createElement("div");
  node.className = "train";
  node.dataset.direction = directionId === 1 ? "south" : "north";
  node.innerHTML = [
    '<span class="motion motion-a"></span>',
    '<span class="motion motion-b"></span>',
    '<span class="motion motion-c"></span>',
    '<span class="car"></span>',
    '<span class="beacon"></span>'
  ].join("");
  trainLayer.append(node);
  return node;
}

function targetFraction(train, now) {
  const data = train.data;
  if (!data.segment) return 1;
  const span = data.arrivesAt - data.departedAt;
  if (!(span > 0)) return 1;
  if (data.atStation) return 1;
  return clamp((now - data.departedAt) / span, 0, 1);
}

function renderFrame(nowMs) {
  const dt = Math.min(0.1, (nowMs - lastFrameTime) / 1000);
  lastFrameTime = nowMs;

  if (network) {
    const now = serverNow();

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
        const station = network.stations[(train.data.to || "").replace(/[NS]$/, "")];
        if (!station) continue;
        const point = map.latLngToLayerPoint([station.lat, station.lon]);
        placed = { x: point.x, y: point.y, angle: train.angle ?? 0 };
      }

      train.angle = train.angle === null
        ? placed.angle
        : train.angle + shortestAngle(train.angle, placed.angle) * (reduceMotion ? 1 : Math.min(1, dt * 6));

      train.element.style.transform =
        `translate3d(${placed.x.toFixed(1)}px, ${placed.y.toFixed(1)}px, 0) rotate(${train.angle.toFixed(1)}deg)`;
    }
  }

  requestAnimationFrame(renderFrame);
}

function syncTrains(payload) {
  const seen = new Set();

  for (const data of payload.trains) {
    seen.add(data.id);
    const existing = trains.get(data.id);

    if (existing) {
      // A new link restarts the fraction at 0; easing towards it would drag
      // the train backwards. Geometry is continuous across links anyway.
      existing.snap = existing.data.segment !== data.segment;
      existing.data = data;
      existing.element.classList.toggle("is-predicting", !data.atStation);
    } else {
      const element = makeTrainElement(data.directionId);
      element.dataset.trainId = data.id;
      element.classList.toggle("is-predicting", !data.atStation);
      trains.set(data.id, { data, element, rendered: null, angle: null, snap: false });
      requestAnimationFrame(() => element.classList.add("is-live"));
    }
  }

  for (const [id, train] of trains) {
    if (!seen.has(id)) {
      train.element.classList.add("is-leaving");
      setTimeout(() => train.element.remove(), 300);
      trains.delete(id);
    }
  }

  fallbackEl.classList.remove("is-visible");
}

// ----------------------------------------------------------------------- data

async function loadNetwork() {
  const response = await fetch("/api/network");
  if (!response.ok) throw new Error("N hattı yüklenemedi");
  network = await response.json();
  drawNetwork();
}

async function refreshTrains() {
  const started = performance.now();
  const response = await fetch("/api/trains", { cache: "no-store" });
  if (!response.ok) throw new Error("Canlı tren verisi alınamadı");
  const payload = await response.json();

  const roundTrip = (performance.now() - started) / 1000;
  offsetSamples.push(payload.serverTime + roundTrip / 2 - Date.now() / 1000);
  if (offsetSamples.length > 5) offsetSamples.shift();
  clockOffset = [...offsetSamples].sort((a, b) => a - b)[Math.floor(offsetSamples.length / 2)];

  syncTrains(payload);
}

function handleViewChange() {
  geometryCache.clear();
  for (const train of trains.values()) train.snap = true;
}

async function boot() {
  try {
    await loadNetwork();
    await refreshTrains();

    map.on("zoomend viewreset", handleViewChange);
    map.on("resize", handleViewChange);

    if (!animationStarted) {
      animationStarted = true;
      requestAnimationFrame(renderFrame);
    }

    setInterval(() => {
      refreshTrains().catch(() => {
        fallbackEl.textContent = "";
      });
    }, REFRESH_MS);
  } catch {
    fallbackEl.textContent = "";
    fallbackEl.classList.add("is-visible");
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && network) refreshTrains().catch(() => {});
});

boot();
