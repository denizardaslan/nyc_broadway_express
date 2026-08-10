/**
 * Draws every N train on the real track, at the position the MTA feed implies
 * for *this instant*.
 *
 * The server hands each train a link (the stretch of track between two stops)
 * and the two timestamps that bound it. Position is then a pure function of the
 * clock, which is why the picture is identical in two tabs and survives a
 * reload — there is no simulation carrying state between frames.
 */

const POLL_MS = 15_000;
const STALE_AFTER_S = 90;
const FOLLOW_ZOOM = 15;
const RECONCILE_TAU = 0.35;
const LABEL_ZOOM = 13.5;
/** Nudge each direction onto its own side of the line, as the tracks are. */
const TRACK_OFFSET_PX = 5;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const dom = {
  status: document.getElementById("status"),
  statusDot: document.getElementById("status-dot"),
  statusCount: document.getElementById("status-count"),
  statusNote: document.getElementById("status-note"),
  card: document.getElementById("card"),
  cardBody: document.getElementById("card-body"),
  cardClose: document.getElementById("card-close"),
  strip: document.getElementById("strip"),
  stripSvg: document.getElementById("strip-svg")
};

const map = L.map("map", {
  attributionControl: false,
  zoomControl: false,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  minZoom: 10,
  maxZoom: 17
}).setView([40.72, -73.98], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  detectRetina: true
}).addTo(map);

const trainPane = map.createPane("trains");
trainPane.style.zIndex = 620;
trainPane.style.pointerEvents = "none";

let network = null;
let clockOffset = 0;
const offsetSamples = [];

const trains = new Map();
const geometryCache = new Map();
const stationMarkers = new Map();

let homeBounds = null;
let selection = null; // { kind: "train" | "station", id }
let following = false;
let lastFrame = performance.now();
let stripFrame = 0;
let lastPayload = null;

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

function countdown(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 30) return "now";
  if (seconds < 90) return "1 min";
  return `${Math.round(seconds / 60)} min`;
}

function stationName(stopId) {
  return network?.stations[baseId(stopId)]?.name || "—";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

// ------------------------------------------------------------------- geometry

/**
 * Segment geometry in Leaflet layer pixels, with cumulative lengths so we can
 * address a point by "fraction of the way along". Rebuilt whenever the map's
 * pixel origin changes, i.e. on zoom.
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

/** Point and heading at a fraction along a link. */
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

// -------------------------------------------------------------- the line itself

function drawNetwork() {
  const casing = [];
  const core = [];

  for (const edge of network.edges) {
    const latLngs = edge.path.map(([lat, lon]) => L.latLng(lat, lon));
    casing.push(L.polyline(latLngs, { className: "rail-casing", interactive: false }));
    core.push(L.polyline(latLngs, { className: "rail-core", color: network.route.color, interactive: false }));
  }

  L.layerGroup(casing).addTo(map);
  L.layerGroup(core).addTo(map);

  for (const station of Object.values(network.stations)) {
    const marker = L.circleMarker([station.lat, station.lon], {
      className: station.terminal ? "station station-terminal" : "station",
      radius: station.terminal ? 6.5 : 4,
      weight: 2.5,
      color: "#141414",
      fillColor: "#ffffff",
      fillOpacity: 1,
      bubblingMouseEvents: false
    });

    marker.bindTooltip(station.name, {
      direction: "top",
      offset: [0, -6],
      className: "station-tip",
      permanent: false
    });
    marker.on("click", () => select({ kind: "station", id: station.id }));
    marker.addTo(map);
    stationMarkers.set(station.id, marker);
  }

  homeBounds = L.latLngBounds(Object.values(network.stations).map((s) => [s.lat, s.lon]));
  map.fitBounds(homeBounds, { animate: false, paddingTopLeft: [56, 90], paddingBottomRight: [56, 130] });
  map.setMinZoom(map.getZoom() - 0.5);
}

/**
 * At whole-line zoom a train is a dot; close in it becomes a car with a trail.
 * Drawing the detailed marker at every zoom just turns the line into blobs.
 */
function refreshScale() {
  const zoom = map.getZoom();
  trainPane.dataset.scale = zoom < 12.5 ? "dot" : zoom < 14.5 ? "small" : "full";
}

function refreshLabels() {
  const showAll = map.getZoom() >= LABEL_ZOOM;
  for (const [id, marker] of stationMarkers) {
    const station = network.stations[id];
    const permanent = showAll || station.terminal;
    const tooltip = marker.getTooltip();
    if (!tooltip || tooltip.options.permanent === permanent) continue;
    marker.unbindTooltip();
    marker.bindTooltip(station.name, {
      direction: "top",
      offset: [0, -6],
      className: `station-tip${permanent ? " is-permanent" : ""}`,
      permanent
    });
  }
}

// ---------------------------------------------------------------------- trains

function makeTrainElement(train) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "train";
  element.dataset.id = train.id;
  element.dataset.direction = train.directionId === 0 ? "astoria" : "coney";
  element.setAttribute("aria-label", `N train to ${train.destination || "the end of the line"}`);
  element.innerHTML = '<span class="trail"></span><span class="body"></span><span class="nose"></span>';
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    select({ kind: "train", id: train.id });
  });
  trainPane.append(element);
  return element;
}

function targetFraction(train, now) {
  if (!train.data.segment) return 1;
  const span = train.data.arrivesAt - train.data.departedAt;
  if (!(span > 0)) return 1;
  if (train.data.atStation) return 1;
  return clamp((now - train.data.departedAt) / span, 0, 1);
}

/** Where the train sits on the straight-line diagram, in metres from Astoria. */
function spineMeters(train, fraction) {
  const from = network.stations[baseId(train.data.from || "")];
  const to = network.stations[baseId(train.data.to || "")];
  if (to?.meters === null || to?.meters === undefined) return null;
  if (from?.meters === null || from?.meters === undefined) return to.meters;
  return from.meters + (to.meters - from.meters) * fraction;
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

    const side = train.data.directionId === 0 ? -1 : 1;
    const radians = (train.angle * Math.PI) / 180;
    placed.x += -Math.sin(radians) * TRACK_OFFSET_PX * side;
    placed.y += Math.cos(radians) * TRACK_OFFSET_PX * side;

    train.point = placed;
    train.element.style.transform = `translate3d(${placed.x.toFixed(1)}px, ${placed.y.toFixed(1)}px, 0) rotate(${train.angle.toFixed(1)}deg)`;
    train.element.classList.toggle("is-dwelling", Boolean(train.data.atStation));
    train.spine = spineMeters(train, train.rendered);
  }
}

function syncTrains(payload) {
  const seen = new Set();

  for (const data of payload.trains) {
    seen.add(data.id);
    const existing = trains.get(data.id);

    if (existing) {
      // A new link restarts the fraction at 0, so smoothing towards it would
      // drag the train backwards. Geometry is continuous across links anyway.
      existing.snap = existing.data.segment !== data.segment;
      existing.data = data;
    } else {
      const train = {
        id: data.id,
        data,
        element: null,
        rendered: null,
        angle: null,
        snap: false,
        point: null,
        spine: null
      };
      train.element = makeTrainElement(data);
      trains.set(data.id, train);
    }
  }

  for (const [id, train] of trains) {
    if (seen.has(id)) continue;
    train.element.remove();
    trains.delete(id);
    if (selection?.kind === "train" && selection.id === id) clearSelection();
  }

  applySelectionClasses();
}

// ------------------------------------------------------------- the line strip

function renderStrip(now) {
  if (!network) return;
  const width = Math.round(dom.stripSvg.getBoundingClientRect().width);
  const height = 64;
  if (!width) return;

  const padding = 18;
  const usable = width - padding * 2;
  const axis = height / 2;
  const x = (meters) => padding + (meters / network.spine.length) * usable;

  const parts = [`<line class="strip-axis" x1="${padding}" y1="${axis}" x2="${width - padding}" y2="${axis}"/>`];

  for (const id of network.spine.stops) {
    const station = network.stations[id];
    if (!station || station.meters === null) continue;
    const px = x(station.meters);
    parts.push(`<line class="strip-tick${station.terminal ? " is-terminal" : ""}" x1="${px}" y1="${axis - (station.terminal ? 7 : 4)}" x2="${px}" y2="${axis + (station.terminal ? 7 : 4)}"/>`);
  }

  for (const train of trains.values()) {
    if (train.spine === null || train.spine === undefined) continue;
    const px = x(train.spine);
    const up = train.data.directionId === 0;
    const py = axis + (up ? -13 : 13);
    const selected = selection?.kind === "train" && selection.id === train.id;
    parts.push(`<circle class="strip-train ${up ? "to-astoria" : "to-coney"}${selected ? " is-selected" : ""}" data-id="${escapeHtml(train.id)}" cx="${px.toFixed(1)}" cy="${py}" r="${selected ? 6 : 4.2}"/>`);
  }

  parts.push(`<text class="strip-label" x="${padding}" y="${height - 2}">Astoria–Ditmars Blvd</text>`);
  parts.push(`<text class="strip-label" x="${width - padding}" y="${height - 2}" text-anchor="end">Coney Island–Stillwell Av</text>`);

  dom.stripSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  dom.stripSvg.setAttribute("height", height);
  dom.stripSvg.innerHTML = parts.join("");
}

dom.stripSvg.addEventListener("click", (event) => {
  const id = event.target?.dataset?.id;
  if (id) select({ kind: "train", id });
});

// -------------------------------------------------------------------- details

function arrivalsAt(stationId, now) {
  const rows = [];

  for (const train of trains.values()) {
    for (const stop of train.data.stops) {
      if (baseId(stop.id) !== stationId) continue;
      rows.push({
        seconds: stop.at - now,
        destination: train.data.destination,
        directionId: train.data.directionId,
        id: train.id
      });
      break;
    }
  }

  return rows.filter((row) => row.seconds > -60).sort((a, b) => a.seconds - b.seconds);
}

function trainCard(train, now) {
  const data = train.data;
  const eta = Math.round(data.arrivesAt - now);
  const percent = Math.round((train.rendered ?? 0) * 100);
  const where = data.atStation || !data.segment
    ? `At <strong>${escapeHtml(stationName(data.to))}</strong>`
    : `${escapeHtml(stationName(data.from))} → <strong>${escapeHtml(stationName(data.to))}</strong>`;

  const upcoming = data.stops.slice(0, 6).map((stop) => `
    <li data-at="${stop.at}"><span>${escapeHtml(stationName(stop.id))}</span><em>${countdown(stop.at - now)}</em></li>
  `).join("");

  return `
    <p class="card-kicker">N train</p>
    <h2>to ${escapeHtml(data.destination || "—")}</h2>
    <p class="card-where">${where}</p>
    <div class="progress"><i style="width:${clamp(percent, 2, 100)}%"></i></div>
    <p class="card-eta">Arriving in <strong>${countdown(eta)}</strong>${data.track ? ` · track ${escapeHtml(data.track)}` : ""}</p>
    <button type="button" class="follow ${following ? "is-on" : ""}" id="follow">${following ? "Stop following" : "Follow this train"}</button>
    <ol class="stops">${upcoming}</ol>
    <p class="card-meta">${escapeHtml(data.trainId || data.id)}</p>
  `;
}

function stationCard(station, now) {
  const rows = arrivalsAt(station.id, now);
  const list = rows.length
    ? rows.slice(0, 8).map((row) => `
        <li class="${row.directionId === 0 ? "to-astoria" : "to-coney"}" data-at="${Math.round(now + row.seconds)}">
          <span>${escapeHtml(row.destination || "—")}</span><em>${countdown(row.seconds)}</em>
        </li>
      `).join("")
    : '<li class="empty"><span>No N trains scheduled right now</span></li>';

  return `
    <p class="card-kicker">Station</p>
    <h2>${escapeHtml(station.name)}</h2>
    <ol class="stops arrivals">${list}</ol>
  `;
}

function renderCard() {
  if (!selection) {
    dom.card.hidden = true;
    return;
  }

  const now = serverNow();
  if (selection.kind === "train") {
    const train = trains.get(selection.id);
    if (!train) return clearSelection();
    dom.cardBody.innerHTML = trainCard(train, now);
    document.getElementById("follow")?.addEventListener("click", () => {
      following = !following;
      if (following) map.setView(layerToLatLng(train.point), Math.max(map.getZoom(), FOLLOW_ZOOM));
      renderCard();
    });
  } else {
    const station = network.stations[selection.id];
    if (!station) return clearSelection();
    dom.cardBody.innerHTML = stationCard(station, now);
  }

  dom.card.hidden = false;
}

/**
 * Between polls only the numbers move, so patch them in place. Rebuilding the
 * card every tick would blow away a click the moment the user makes it.
 */
function tickCard() {
  if (!selection || dom.card.hidden) return;
  const now = serverNow();

  if (selection.kind === "train") {
    const train = trains.get(selection.id);
    if (!train) return clearSelection();

    const bar = dom.cardBody.querySelector(".progress i");
    if (bar) bar.style.width = `${clamp(Math.round((train.rendered ?? 0) * 100), 2, 100)}%`;
    const eta = dom.cardBody.querySelector(".card-eta strong");
    if (eta) eta.textContent = countdown(Math.round(train.data.arrivesAt - now));
  }

  for (const row of dom.cardBody.querySelectorAll(".stops li[data-at]")) {
    row.querySelector("em").textContent = countdown(Number(row.dataset.at) - now);
  }
}

function layerToLatLng(point) {
  return map.layerPointToLatLng(L.point(point.x, point.y));
}

function applySelectionClasses() {
  document.body.classList.toggle("has-selection", selection?.kind === "train");
  for (const train of trains.values()) {
    train.element.classList.toggle("is-selected", selection?.kind === "train" && selection.id === train.id);
  }
  for (const [id, marker] of stationMarkers) {
    const element = marker.getElement();
    if (element) element.classList.toggle("is-selected", selection?.kind === "station" && selection.id === id);
  }
}

function select(next) {
  selection = next;
  if (next.kind !== "train") following = false;
  applySelectionClasses();
  renderCard();
}

function clearSelection() {
  selection = null;
  following = false;
  applySelectionClasses();
  dom.card.hidden = true;
}

// --------------------------------------------------------------------- status

function renderStatus() {
  if (!lastPayload) return;

  const age = serverNow() - (lastPayload.fetchedAt ?? serverNow());
  const stale = lastPayload.stale || age > STALE_AFTER_S;
  const count = trains.size;

  dom.statusCount.textContent = `${count} ${count === 1 ? "train" : "trains"}`;
  dom.status.classList.toggle("is-stale", stale);
  dom.statusNote.textContent = lastPayload.error
    ? "feed unreachable — showing last known positions"
    : stale
      ? `feed ${Math.round(age)}s behind`
      : "live from the MTA";
}

function showFailure(message) {
  dom.status.classList.add("is-stale");
  dom.statusCount.textContent = "offline";
  dom.statusNote.textContent = message;
}

// ------------------------------------------------------------------- the loop

function frame(timestamp) {
  const dt = Math.min(0.1, (timestamp - lastFrame) / 1000);
  lastFrame = timestamp;

  if (network) {
    const now = serverNow();
    renderTrains(dt, now);

    if (following && selection?.kind === "train") {
      const train = trains.get(selection.id);
      if (train?.point) map.panTo(layerToLatLng(train.point), { animate: false });
    }

    stripFrame += 1;
    if (stripFrame % 6 === 0) renderStrip(now);
    if (stripFrame % 30 === 0) {
      renderStatus();
      tickCard();
    }
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------- data

async function loadNetwork() {
  const response = await fetch("/api/network");
  if (!response.ok) throw new Error(`network ${response.status}`);
  network = await response.json();
  drawNetwork();
  refreshLabels();
  refreshScale();
}

async function poll() {
  const started = performance.now();
  const response = await fetch("/api/trains", { cache: "no-store" });
  if (!response.ok) throw new Error(`trains ${response.status}`);
  const payload = await response.json();

  const roundTrip = (performance.now() - started) / 1000;
  const sample = payload.serverTime + roundTrip / 2 - Date.now() / 1000;
  offsetSamples.push(sample);
  if (offsetSamples.length > 5) offsetSamples.shift();
  clockOffset = [...offsetSamples].sort((a, b) => a - b)[Math.floor(offsetSamples.length / 2)];

  lastPayload = payload;
  syncTrains(payload);
  renderStatus();
  if (selection) renderCard();
}

async function tick() {
  try {
    await poll();
  } catch (error) {
    showFailure("cannot reach the server");
  }
}

// ---------------------------------------------------------------- interaction

map.on("zoomend viewreset", () => {
  geometryCache.clear();
  for (const train of trains.values()) train.snap = true;
  refreshLabels();
  refreshScale();
});

map.on("dragstart", () => {
  if (following) {
    following = false;
    if (selection) renderCard();
  }
});

map.on("click", clearSelection);
dom.cardClose.addEventListener("click", clearSelection);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearSelection();
});

document.getElementById("zoom-in").addEventListener("click", () => map.zoomIn(1));
document.getElementById("zoom-out").addEventListener("click", () => map.zoomOut(1));
document.getElementById("fit").addEventListener("click", () => {
  following = false;
  map.fitBounds(homeBounds, { paddingTopLeft: [56, 90], paddingBottomRight: [56, 130] });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

window.addEventListener("resize", () => {
  geometryCache.clear();
  renderStrip(serverNow());
});

async function boot() {
  try {
    await loadNetwork();
  } catch (error) {
    showFailure("could not load the line");
    return;
  }

  requestAnimationFrame(frame);
  await tick();
  setInterval(tick, POLL_MS);
}

boot();
