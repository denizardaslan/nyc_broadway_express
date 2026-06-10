const REFRESH_MS = 20_000;
const LINE_COLOR = "#fccc0a";
const MAX_VISIBLE_TRAINS = 26;
const TANGENT_LOOKAHEAD = 22;
const DEFAULT_METERS_PER_SECOND = 10.5;
const MAX_METERS_PER_SECOND = 18;
const MAX_CORRECTION_METERS = 420;
const CORRECTION_SECONDS = 22;
const VELOCITY_BLEND = 0.42;

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

let routeLatLngs = [];
let routeLine;
let routeSamples = [];
let totalRouteDistance = 0;
let totalRouteMeters = 0;
let lastFrameTime = performance.now();
let animationStarted = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function interpolatePoint(a, b, t) {
  return L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

function pointDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function directionSign(directionId) {
  return directionId === 1 ? -1 : 1;
}

function shortestAngle(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function pixelsPerMeter() {
  return totalRouteMeters ? totalRouteDistance / totalRouteMeters : 0;
}

function defaultVelocity(directionId) {
  return directionSign(directionId) * DEFAULT_METERS_PER_SECOND * pixelsPerMeter();
}

function shouldPredict(item) {
  return item.status === 2;
}

function velocityForItem(item) {
  return shouldPredict(item) ? defaultVelocity(item.directionId) : 0;
}

function clampVelocity(velocity) {
  const max = MAX_METERS_PER_SECOND * pixelsPerMeter();
  return clamp(velocity, -max, max);
}

function clampCorrection(distance) {
  const max = Math.max(8, MAX_CORRECTION_METERS * pixelsPerMeter());
  return clamp(distance, -max, max);
}

function rebuildRouteSamples() {
  const points = routeLatLngs.map((latLng) => map.latLngToLayerPoint(latLng));
  routeSamples = [];
  totalRouteDistance = 0;
  totalRouteMeters = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = pointDistance(a, b);
    if (length < 0.1) continue;
    const meters = routeLatLngs[index].distanceTo(routeLatLngs[index + 1]);

    routeSamples.push({
      a,
      b,
      angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI,
      distance: totalRouteDistance,
      length,
      meters
    });
    totalRouteDistance += length;
    totalRouteMeters += meters;
  }
}

function projectToRoute(latLng) {
  const point = map.latLngToLayerPoint(latLng);
  let best = null;

  for (const segment of routeSamples) {
    const vx = segment.b.x - segment.a.x;
    const vy = segment.b.y - segment.a.y;
    const wx = point.x - segment.a.x;
    const wy = point.y - segment.a.y;
    const t = clamp((wx * vx + wy * vy) / (segment.length * segment.length), 0, 1);
    const candidate = interpolatePoint(segment.a, segment.b, t);
    const offRoute = pointDistance(point, candidate);

    if (!best || offRoute < best.offRoute) {
      best = {
        angle: segment.angle,
        distance: segment.distance + segment.length * t,
        offRoute,
        point: candidate
      };
    }
  }

  return best || { angle: -90, distance: 0, point };
}

function rawPointAtDistance(distance) {
  const bounded = clamp(distance, 0, totalRouteDistance);
  const last = routeSamples[routeSamples.length - 1];
  const segment = routeSamples.find((item) => bounded <= item.distance + item.length) || last;
  const t = clamp((bounded - segment.distance) / segment.length, 0, 1);

  return {
    segment,
    point: interpolatePoint(segment.a, segment.b, t)
  };
}

function tangentAngleAtDistance(distance, directionId) {
  const sign = directionSign(directionId);
  const behind = rawPointAtDistance(distance - sign * TANGENT_LOOKAHEAD).point;
  const ahead = rawPointAtDistance(distance + sign * TANGENT_LOOKAHEAD).point;
  return Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180 / Math.PI;
}

function pointAtDistance(distance, directionId) {
  const sampled = rawPointAtDistance(distance);
  return {
    angle: tangentAngleAtDistance(distance, directionId),
    point: sampled.point
  };
}

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

function placeTrain(train) {
  const projected = pointAtDistance(train.distance, train.directionId);
  train.element.style.transform = `translate3d(${projected.point.x}px, ${projected.point.y}px, 0) rotate(${projected.angle}deg)`;
}

function renderFrame(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  for (const train of trains.values()) {
    const correctionStep = train.correction * Math.min(1, dt / CORRECTION_SECONDS);
    train.correction -= correctionStep;
    train.distance = clamp(train.distance + train.velocity * dt + correctionStep, 0, totalRouteDistance);
    const routeAngle = tangentAngleAtDistance(train.distance, train.directionId);
    train.angle = (train.angle ?? routeAngle) + shortestAngle(train.angle ?? routeAngle, routeAngle) * 0.18;
    train.distanceRatio = totalRouteDistance ? train.distance / totalRouteDistance : 0;
    const projected = rawPointAtDistance(train.distance);
    train.element.style.transform = `translate3d(${projected.point.x}px, ${projected.point.y}px, 0) rotate(${train.angle}deg)`;
  }

  requestAnimationFrame(renderFrame);
}

function syncTrainsToMap() {
  rebuildRouteSamples();
  for (const train of trains.values()) {
    train.distance = clamp(train.distanceRatio * totalRouteDistance, 0, totalRouteDistance);
    const projected = pointAtDistance(train.distance, train.directionId);
    train.velocity = 0;
    train.correction = 0;
    train.element.style.transform = `translate3d(${projected.point.x}px, ${projected.point.y}px, 0) rotate(${projected.angle}deg)`;
  }
}

function chooseVisualTrains(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const buckets = new Map();
  const selected = [];
  const used = new Set();

  for (const id of trains.keys()) {
    const item = byId.get(id);
    if (!item) continue;
    if (selected.length >= MAX_VISIBLE_TRAINS) break;

    const projected = projectToRoute(L.latLng(item.lat, item.lon));
    const key = Math.round(projected.distance / 42);
    const bucketCount = buckets.get(key) || 0;
    if (bucketCount >= 2) continue;

    buckets.set(key, bucketCount + 1);
    selected.push({ item, offset: directionSign(trains.get(id).directionId) * bucketCount * 22, projected });
    used.add(id);
  }

  const sorted = items.filter((item) => !used.has(item.id)).sort((a, b) => {
    const aTime = Date.parse(a.vehicleTimestamp || a.nextArrival || 0);
    const bTime = Date.parse(b.vehicleTimestamp || b.nextArrival || 0);
    return bTime - aTime;
  });

  for (const item of sorted) {
    const projected = projectToRoute(L.latLng(item.lat, item.lon));
    const key = Math.round(projected.distance / 42);
    const bucketCount = buckets.get(key) || 0;
    if (bucketCount >= 2) continue;

    buckets.set(key, bucketCount + 1);
    selected.push({ item, offset: directionSign(item.directionId) * bucketCount * 22, projected });
    if (selected.length >= MAX_VISIBLE_TRAINS) break;
  }

  return selected;
}

async function loadRoute() {
  const response = await fetch("/api/route");
  if (!response.ok) throw new Error("N hattı yüklenemedi");
  const route = await response.json();

  routeLatLngs = route.shape.map((point) => L.latLng(point.lat, point.lon));

  L.polyline(routeLatLngs, {
    className: "route-rail",
    color: "#171717",
    interactive: false,
    opacity: 1,
    weight: 13
  }).addTo(map);

  L.polyline(routeLatLngs, {
    className: "route-line",
    color: LINE_COLOR,
    interactive: false,
    opacity: 1,
    weight: 7
  }).addTo(map);

  routeLine = L.polyline(routeLatLngs, {
    className: "route-center",
    color: "#171717",
    interactive: false,
    opacity: 0.9,
    weight: 1.25
  }).addTo(map);

  map.fitBounds(routeLine.getBounds(), {
    animate: false,
    paddingTopLeft: [82, 36],
    paddingBottomRight: [64, 36]
  });
  rebuildRouteSamples();
}

async function refreshTrains() {
  const response = await fetch("/api/trains");
  if (!response.ok) throw new Error("Canlı tren verisi alınamadı");
  const payload = await response.json();
  const seen = new Set();
  const visualTrains = chooseVisualTrains(payload.trains);

  for (const { item, offset, projected } of visualTrains) {
    seen.add(item.id);
    const rawTargetDistance = clamp(projected.distance + offset, 0, totalRouteDistance);
    const existing = trains.get(item.id);
    const observedAt = Date.parse(payload.updatedAt) || Date.now();
    const predictive = shouldPredict(item);

    if (existing) {
      const elapsed = Math.max(1, (observedAt - existing.lastObservedAt) / 1000);
      const observedDelta = rawTargetDistance - existing.lastObservedDistance;
      const observedVelocity = clampVelocity((rawTargetDistance - existing.lastObservedDistance) / elapsed);
      const expectedDirection = directionSign(existing.directionId);
      const directionallyValid = Math.sign(observedVelocity || expectedDirection) === expectedDirection;

      existing.velocity = predictive && elapsed > 4 && directionallyValid && Math.abs(observedDelta) > 0.5
        ? existing.velocity * (1 - VELOCITY_BLEND) + observedVelocity * VELOCITY_BLEND
        : velocityForItem(item);
      existing.velocity = clampVelocity(existing.velocity);
      existing.element.classList.toggle("is-predicting", predictive);
      existing.correction = clampCorrection(existing.correction + rawTargetDistance - existing.distance);
      existing.lastObservedAt = observedAt;
      existing.lastObservedDistance = rawTargetDistance;
    } else {
      const element = makeTrainElement(item.directionId);
      element.dataset.trainId = item.id;
      const target = pointAtDistance(rawTargetDistance, item.directionId);
      const train = {
        correction: 0,
        directionId: item.directionId,
        distance: rawTargetDistance,
        distanceRatio: totalRouteDistance ? rawTargetDistance / totalRouteDistance : 0,
        element,
        lastObservedAt: observedAt,
        lastObservedDistance: rawTargetDistance,
        velocity: velocityForItem(item)
      };
      train.angle = target.angle;
      trains.set(item.id, train);
      element.classList.toggle("is-predicting", predictive);
      train.element.style.transform = `translate3d(${target.point.x}px, ${target.point.y}px, 0) rotate(${target.angle}deg)`;
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

async function boot() {
  try {
    await loadRoute();
    await refreshTrains();
    map.on("resize", syncTrainsToMap);

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

boot();
