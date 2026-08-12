import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { decodeFeed } from "./src/gtfsrt.js";
import { buildNetwork, NETWORK_VERSION, stationId } from "./src/network.js";
import { DepartureMemory, indexNetwork, locateTrip, progressAt, easeProgress } from "./src/positions.js";
import { measurePath, pointAt } from "./src/geo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const cacheDir = path.join(__dirname, ".cache");
const gtfsZip = path.join(cacheDir, "gtfs_subway.zip");
const networkCache = path.join(cacheDir, `network.v${NETWORK_VERSION}.json`);

const STATIC_GTFS_URL = process.env.GTFS_URL || "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
// Overridable so the app can be developed offline against tools/mock-feed.js.
const REALTIME_URL = process.env.REALTIME_URL
  || "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw";
const PORT = Number(process.env.PORT || 4173);
const ROUTE_ID = process.env.ROUTE_ID || "N";

const GTFS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_REFRESH_MS = 15_000;
const FEED_TIMEOUT_MS = 10_000;
const IDLE_AFTER_MS = 5 * 60 * 1000;
const MAX_STOPS_PER_TRAIN = 14;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

let network;
let networkIndex;
let networkResponse;
let segmentPaths;
const memory = new DepartureMemory();

let feed = { trains: [], feedTime: null, fetchedAt: 0, error: null };
let lastRequestAt = Date.now();
let refreshing = null;

// ---------------------------------------------------------------- static data

async function fileAgeMs(file) {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function ensureGtfsBundle() {
  await mkdir(cacheDir, { recursive: true });
  if ((await fileAgeMs(gtfsZip)) < GTFS_MAX_AGE_MS) return;

  const response = await fetch(STATIC_GTFS_URL);
  if (!response.ok) throw new Error(`Static GTFS download failed: ${response.status}`);
  await writeFile(gtfsZip, Buffer.from(await response.arrayBuffer()));
}

async function loadNetwork() {
  await ensureGtfsBundle();

  const zipAge = await fileAgeMs(gtfsZip);
  const cacheAge = await fileAgeMs(networkCache);
  if (cacheAge < zipAge) {
    try {
      return JSON.parse(await readFile(networkCache, "utf8"));
    } catch {
      // fall through and rebuild
    }
  }

  const built = buildNetwork(await readFile(gtfsZip), { routeId: ROUTE_ID });
  await writeFile(networkCache, JSON.stringify(built));
  return built;
}

/** Segment geometry with cumulative distances, for placing trains along track. */
function measureSegments(source) {
  const measured = new Map();
  for (const [key, segment] of Object.entries(source.segments)) {
    measured.set(key, measurePath(segment.path.map(([lat, lon]) => ({ lat, lon }))));
  }
  return measured;
}

// ------------------------------------------------------------------- realtime

function tripPathId(tripId = "") {
  const marker = tripId.lastIndexOf("_");
  return marker === -1 ? "" : tripId.slice(marker + 1);
}

function collectTrips(entities) {
  const trips = new Map();

  for (const entity of entities) {
    const update = entity.tripUpdate;
    if (!update?.trip?.tripId) continue;
    const pathId = tripPathId(update.trip.tripId);
    if (update.trip.routeId !== ROUTE_ID && !pathId.startsWith(`${ROUTE_ID}..`)) continue;

    trips.set(update.trip.tripId, {
      id: entity.id || update.trip.tripId,
      tripId: update.trip.tripId,
      pathId,
      routeId: update.trip.routeId || ROUTE_ID,
      directionId: update.trip.directionId,
      trainId: update.trip.nyct?.trainId || null,
      isAssigned: update.trip.nyct?.isAssigned ?? null,
      stopTimeUpdates: update.stopTimeUpdates,
      vehicle: null
    });
  }

  // Vehicle entities ride alongside their trip update and carry the "stopped at
  // a platform" flag, which is the one thing trip updates cannot express.
  for (const entity of entities) {
    const vehicle = entity.vehicle;
    const trip = vehicle && trips.get(vehicle.trip?.tripId);
    if (trip) trip.vehicle = vehicle;
  }

  return [...trips.values()];
}

function coordinatesFor(placement, progress) {
  if (!placement.segmentKey) {
    return { lat: placement.to.lat, lon: placement.to.lon };
  }
  const geometry = segmentPaths.get(placement.segmentKey);
  if (!geometry) return { lat: placement.to.lat, lon: placement.to.lon };
  return pointAt(geometry, geometry.length * easeProgress(progress));
}

function directionOf(placement, trip) {
  const from = placement.from ? network.stations[placement.from.id] : null;
  const to = network.stations[placement.to.id];
  if (from && to && from.spine !== null && to.spine !== null && from.spine !== to.spine) {
    return to.spine > from.spine ? 1 : 0;
  }
  if (Number.isFinite(trip.directionId)) return trip.directionId;
  return network.patterns[trip.pathId]?.directionId ?? null;
}

function serialiseTrain(trip, placement, now) {
  const progress = progressAt(placement, now);
  const position = coordinatesFor(placement, progress);
  const destinationId = stationId(placement.updates[placement.updates.length - 1].stopId);

  return {
    id: trip.tripId,
    trainId: trip.trainId,
    pathId: trip.pathId,
    directionId: directionOf(placement, trip),
    destination: network.stations[destinationId]?.name || null,
    destinationId,
    from: placement.fromStopId,
    to: placement.toStopId,
    segment: placement.segmentKey,
    departedAt: placement.departedAt,
    arrivesAt: placement.arrivesAt,
    atStation: placement.atStation,
    track: placement.track,
    lat: Number(position.lat.toFixed(5)),
    lon: Number(position.lon.toFixed(5)),
    progress: Number(progress.toFixed(4)),
    stops: placement.updates.slice(0, MAX_STOPS_PER_TRAIN).map((update) => ({
      id: update.stopId,
      at: update.arrival
    }))
  };
}

async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const response = await fetch(REALTIME_URL, {
      signal: controller.signal,
      headers: { "user-agent": "nyc-broadway-express (github.com/denizardaslan/nyc_broadway_express)" }
    });
    if (!response.ok) throw new Error(`Realtime feed responded ${response.status}`);
    return decodeFeed(Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

async function refreshFeed() {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const decoded = await fetchFeed();
      const now = Date.now() / 1000;
      const trains = [];

      for (const trip of collectTrips(decoded.entities)) {
        const placement = locateTrip(networkIndex, trip, now, memory);
        if (placement) trains.push(serialiseTrain(trip, placement, now));
      }

      trains.sort((a, b) => (network.stations[stationId(a.to)]?.spine ?? 0) - (network.stations[stationId(b.to)]?.spine ?? 0));
      memory.prune(now);
      feed = { trains, feedTime: decoded.header.timestamp || null, fetchedAt: Date.now(), error: null };
    } catch (error) {
      feed = { ...feed, error: error.message };
      console.error("[feed]", error.message);
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

async function currentFeed() {
  const age = Date.now() - feed.fetchedAt;
  if (age > FEED_REFRESH_MS || (feed.error && age > 3_000)) await refreshFeed();
  return feed;
}

function trainsPayload() {
  const now = Date.now() / 1000;
  const ageSeconds = feed.fetchedAt ? (Date.now() - feed.fetchedAt) / 1000 : null;

  return {
    serverTime: Number(now.toFixed(3)),
    feedTime: feed.feedTime,
    fetchedAt: feed.fetchedAt ? Math.round(feed.fetchedAt / 1000) : null,
    ageSeconds: ageSeconds === null ? null : Number(ageSeconds.toFixed(1)),
    stale: Boolean(feed.error) || (ageSeconds !== null && ageSeconds > 120),
    error: feed.error,
    source: "MTA GTFS Realtime — N/Q/R/W feed",
    count: feed.trains.length,
    trains: feed.trains
  };
}

// ------------------------------------------------------------------- http bits

function send(request, response, status, body, contentType, cacheControl) {
  const accepted = request.headers["accept-encoding"] || "";
  const canGzip = accepted.includes("gzip") && body.length > 1024;
  const payload = canGzip ? gzipSync(body) : body;
  const etag = `"${createHash("sha1").update(payload).digest("base64url").slice(0, 20)}"`;

  const headers = {
    "content-type": contentType,
    "cache-control": cacheControl,
    etag,
    vary: "accept-encoding"
  };
  if (canGzip) headers["content-encoding"] = "gzip";

  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  headers["content-length"] = payload.length;
  response.writeHead(status, headers);
  response.end(request.method === "HEAD" ? undefined : payload);
}

function sendJson(request, response, status, value, cacheControl = "no-store") {
  send(request, response, status, Buffer.from(JSON.stringify(value)), "application/json; charset=utf-8", cacheControl);
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicDir, relative));

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath);
    const cacheControl = extension === ".html" ? "no-cache" : "public, max-age=300";
    send(request, response, 200, body, mimeTypes[extension] || "application/octet-stream", cacheControl);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  lastRequestAt = Date.now();

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/{2,}/g, "/");

    if (pathname === "/api/network" || pathname === "/api/route") {
      sendJson(request, response, 200, networkResponse, "public, max-age=600");
      return;
    }

    if (pathname === "/api/trains") {
      await currentFeed();
      sendJson(request, response, 200, trainsPayload());
      return;
    }

    if (pathname === "/api/health") {
      sendJson(request, response, feed.error ? 503 : 200, {
        ok: !feed.error,
        stations: Object.keys(network.stations).length,
        segments: Object.keys(network.segments).length,
        trains: feed.trains.length,
        feedAgeSeconds: feed.fetchedAt ? Math.round((Date.now() - feed.fetchedAt) / 1000) : null,
        error: feed.error
      });
      return;
    }

    await serveStatic(request, response, pathname);
  } catch (error) {
    console.error(error);
    sendJson(request, response, 500, { error: error.message });
  }
});

async function start() {
  network = await loadNetwork();
  networkIndex = indexNetwork(network);
  segmentPaths = measureSegments(network);
  networkResponse = {
    version: network.version,
    generatedAt: network.generatedAt,
    route: network.route,
    stations: network.stations,
    segments: network.segments,
    patterns: network.patterns,
    edges: network.edges,
    spine: network.spine
  };

  await refreshFeed();

  setInterval(() => {
    if (Date.now() - lastRequestAt < IDLE_AFTER_MS) refreshFeed();
  }, FEED_REFRESH_MS);

  server.listen(PORT, () => {
    console.log(`${network.route.id} line live map → http://localhost:${PORT}`);
    console.log(`  ${Object.keys(network.stations).length} stations, ${Object.keys(network.segments).length} track links, ${feed.trains.length} trains in service`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
