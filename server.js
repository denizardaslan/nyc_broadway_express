import http from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const cacheDir = path.join(__dirname, ".cache");
const gtfsZip = path.join(cacheDir, "gtfs_subway.zip");

const STATIC_GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const REALTIME_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw";
const PORT = Number(process.env.PORT || 4173);
const ROUTE_ID = "N";

let staticDataPromise;
let realtimeCache = { at: 0, payload: null };

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureStaticGtfs() {
  await mkdir(cacheDir, { recursive: true });
  if (await exists(gtfsZip)) return;

  const response = await fetch(STATIC_GTFS_URL);
  if (!response.ok) throw new Error(`Static GTFS download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(gtfsZip, bytes);
}

function unzipText(entry) {
  return new Promise((resolve, reject) => {
    execFile("unzip", ["-p", gtfsZip, entry], { maxBuffer: 80 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  const header = rows.shift() || [];
  return rows.filter((r) => r.length === header.length).map((r) => {
    const item = {};
    header.forEach((key, index) => {
      item[key] = r[index];
    });
    return item;
  });
}

function stopBase(stopId = "") {
  return stopId.replace(/[NS]$/, "");
}

function distance(a, b) {
  const dx = a.lon - b.lon;
  const dy = a.lat - b.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestShapeIndex(shape, stop) {
  let best = 0;
  let bestDistance = Infinity;
  shape.forEach((point, index) => {
    const d = distance(point, stop);
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return best;
}

function interpolate(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    lat: a.lat + (b.lat - a.lat) * clamped,
    lon: a.lon + (b.lon - a.lon) * clamped
  };
}

async function loadStaticData() {
  await ensureStaticGtfs();

  const [tripsText, shapesText, stopsText, stopTimesText] = await Promise.all([
    unzipText("trips.txt"),
    unzipText("shapes.txt"),
    unzipText("stops.txt"),
    unzipText("stop_times.txt")
  ]);

  const trips = parseCsv(tripsText).filter((trip) => trip.route_id === ROUTE_ID);
  const shapeUse = new Map();
  const nTripIds = new Set();
  for (const trip of trips) {
    nTripIds.add(trip.trip_id);
    shapeUse.set(trip.shape_id, (shapeUse.get(trip.shape_id) || 0) + 1);
  }

  const chosenShapeId = [...shapeUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const shape = parseCsv(shapesText)
    .filter((point) => point.shape_id === chosenShapeId)
    .sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence))
    .map((point) => ({
      lat: Number(point.shape_pt_lat),
      lon: Number(point.shape_pt_lon)
    }));

  const stopsByBase = new Map();
  for (const stop of parseCsv(stopsText)) {
    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopsByBase.set(stop.stop_id, {
      id: stop.stop_id,
      name: stop.stop_name,
      lat,
      lon
    });
  }

  const routeStops = new Map();
  for (const row of parseCsv(stopTimesText)) {
    if (!nTripIds.has(row.trip_id)) continue;
    const base = stopBase(row.stop_id);
    const stop = stopsByBase.get(base) || stopsByBase.get(row.stop_id);
    if (stop && !routeStops.has(base)) routeStops.set(base, { ...stop, id: base });
  }

  const stations = [...routeStops.values()]
    .map((stop) => ({ ...stop, shapeIndex: nearestShapeIndex(shape, stop) }))
    .filter((stop) => Number.isFinite(stop.shapeIndex))
    .sort((a, b) => a.shapeIndex - b.shapeIndex);

  const stationsByBase = new Map(stations.map((station) => [station.id, station]));

  return {
    routeId: ROUTE_ID,
    routeName: "N Broadway Express",
    color: "#FCCC0A",
    shape,
    stations,
    stationsByBase,
    generatedAt: new Date().toISOString()
  };
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, cursor];
    shift += 7;
  }
  throw new Error("Unterminated protobuf varint");
}

function readField(buffer, offset) {
  const [tag, afterTag] = readVarint(buffer, offset);
  const field = tag >> 3;
  const wire = tag & 7;
  let value;
  let next = afterTag;

  if (wire === 0) {
    [value, next] = readVarint(buffer, afterTag);
  } else if (wire === 1) {
    value = buffer.subarray(afterTag, afterTag + 8);
    next = afterTag + 8;
  } else if (wire === 2) {
    const [length, start] = readVarint(buffer, afterTag);
    value = buffer.subarray(start, start + length);
    next = start + length;
  } else if (wire === 5) {
    value = buffer.subarray(afterTag, afterTag + 4);
    next = afterTag + 4;
  } else {
    throw new Error(`Unsupported protobuf wire type ${wire}`);
  }

  return { field, wire, value, next };
}

function asString(value) {
  return Buffer.from(value).toString("utf8");
}

function parseEvent(buffer) {
  const event = {};
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 2 && item.wire === 0) event.time = item.value;
  }
  return event;
}

function parseStopTimeUpdate(buffer) {
  const update = {};
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 1 && item.wire === 0) update.stopSequence = item.value;
    if (item.field === 2 && item.wire === 2) update.arrival = parseEvent(item.value);
    if (item.field === 3 && item.wire === 2) update.departure = parseEvent(item.value);
    if (item.field === 4 && item.wire === 2) update.stopId = asString(item.value);
  }
  return update;
}

function parseTripDescriptor(buffer) {
  const trip = {};
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 1 && item.wire === 2) trip.tripId = asString(item.value);
    if (item.field === 5 && item.wire === 2) trip.routeId = asString(item.value);
    if (item.field === 6 && item.wire === 0) trip.directionId = item.value;
  }
  return trip;
}

function parseTripUpdate(buffer) {
  const tripUpdate = { trip: {}, stopTimeUpdates: [] };
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 1 && item.wire === 2) tripUpdate.trip = parseTripDescriptor(item.value);
    if (item.field === 2 && item.wire === 2) tripUpdate.stopTimeUpdates.push(parseStopTimeUpdate(item.value));
  }
  return tripUpdate;
}

function parseVehiclePosition(buffer) {
  const vehicle = { trip: {} };
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 1 && item.wire === 2) vehicle.trip = parseTripDescriptor(item.value);
    if (item.field === 3 && item.wire === 0) vehicle.currentStopSequence = item.value;
    if (item.field === 4 && item.wire === 0) vehicle.currentStatus = item.value;
    if (item.field === 5 && item.wire === 0) vehicle.timestamp = item.value;
    if (item.field === 7 && item.wire === 2) vehicle.stopId = asString(item.value);
  }
  return vehicle;
}

function parseEntity(buffer) {
  const entity = {};
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 1 && item.wire === 2) entity.id = asString(item.value);
    if (item.field === 3 && item.wire === 2) entity.tripUpdate = parseTripUpdate(item.value);
    if (item.field === 4 && item.wire === 2) entity.vehicle = parseVehiclePosition(item.value);
  }
  return entity;
}

function parseFeed(buffer) {
  const entities = [];
  for (let offset = 0; offset < buffer.length;) {
    const item = readField(buffer, offset);
    offset = item.next;
    if (item.field === 2 && item.wire === 2) entities.push(parseEntity(item.value));
  }
  return entities;
}

function trainPosition(staticData, stopUpdates, nowSeconds) {
  const usable = stopUpdates
    .map((update) => ({
      stopId: update.stopId,
      base: stopBase(update.stopId),
      time: update.arrival?.time || update.departure?.time
    }))
    .filter((update) => update.stopId && Number.isFinite(update.time))
    .sort((a, b) => a.time - b.time);

  const nextIndex = usable.findIndex((update) => update.time >= nowSeconds - 60);
  const next = usable[nextIndex === -1 ? usable.length - 1 : nextIndex];
  const previous = nextIndex > 0 ? usable[nextIndex - 1] : null;
  const nextStation = staticData.stationsByBase.get(next?.base);
  const previousStation = staticData.stationsByBase.get(previous?.base);

  if (!nextStation) return null;
  if (!previousStation || !previous || previous.time >= next.time) {
    return {
      lat: nextStation.lat,
      lon: nextStation.lon,
      progress: 1,
      nextStop: nextStation,
      nextTime: next.time
    };
  }

  return {
    ...interpolate(previousStation, nextStation, (nowSeconds - previous.time) / (next.time - previous.time)),
    progress: Math.max(0, Math.min(1, (nowSeconds - previous.time) / (next.time - previous.time))),
    previousStop: previousStation,
    nextStop: nextStation,
    nextTime: next.time
  };
}

function inferredRouteId(entity) {
  const trip = entity.tripUpdate?.trip || {};
  const candidates = [trip.routeId, entity.id, trip.tripId].filter(Boolean);
  if (candidates.some((value) => value === ROUTE_ID)) return ROUTE_ID;
  if (candidates.some((value) => value.endsWith(ROUTE_ID))) return ROUTE_ID;
  if (candidates.some((value) => value.includes(`_${ROUTE_ID}`))) return ROUTE_ID;
  return trip.routeId || "";
}

function inferredDirection(trip, stopUpdates) {
  if (Number.isFinite(trip.directionId)) return trip.directionId;
  if (trip.tripId?.includes("..S")) return 1;
  if (trip.tripId?.includes("..N")) return 0;
  const firstStop = stopUpdates.find((update) => update.stopId)?.stopId || "";
  if (firstStop.endsWith("S")) return 1;
  if (firstStop.endsWith("N")) return 0;
  return null;
}

function positionFromVehicle(staticData, vehicle, tripUpdate, nowSeconds) {
  const stopUpdates = tripUpdate?.stopTimeUpdates || [];
  const stopId = vehicle.stopId;
  const currentStation = staticData.stationsByBase.get(stopBase(stopId));
  const currentUpdateIndex = stopUpdates.findIndex((update) => (
    update.stopSequence === vehicle.currentStopSequence || update.stopId === stopId
  ));
  const nextUpdate = stopUpdates
    .slice(Math.max(0, currentUpdateIndex))
    .find((update) => (update.arrival?.time || update.departure?.time || 0) >= nowSeconds - 120);
  const nextStation = staticData.stationsByBase.get(stopBase(nextUpdate?.stopId));
  const nextTime = nextUpdate?.arrival?.time || nextUpdate?.departure?.time;

  if (!currentStation && !nextStation) return null;
  if (vehicle.currentStatus !== 2 || !currentStation || !nextStation || currentStation.id === nextStation.id) {
    return {
      lat: (currentStation || nextStation).lat,
      lon: (currentStation || nextStation).lon,
      previousStop: currentStation,
      nextStop: nextStation || currentStation,
      nextTime: nextTime || nowSeconds
    };
  }

  const previousUpdate = stopUpdates[currentUpdateIndex - 1];
  const previousTime = previousUpdate?.arrival?.time || previousUpdate?.departure?.time || vehicle.timestamp || nowSeconds;
  return {
    ...interpolate(currentStation, nextStation, (nowSeconds - previousTime) / Math.max(1, nextTime - previousTime)),
    previousStop: currentStation,
    nextStop: nextStation,
    nextTime
  };
}

async function getRealtimeTrains() {
  const nowMs = Date.now();
  if (realtimeCache.payload && nowMs - realtimeCache.at < 15_000) return realtimeCache.payload;

  const staticData = await staticDataPromise;
  const response = await fetch(REALTIME_URL, {
    headers: { "User-Agent": "nyc-n-train-live-demo/1.0" }
  });
  if (!response.ok) throw new Error(`Realtime feed failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const entities = parseFeed(buffer);
  const nowSeconds = Math.floor(nowMs / 1000);
  const trains = [];
  const tripUpdatesByTripId = new Map();

  for (const entity of entities) {
    if (!entity.tripUpdate || inferredRouteId(entity) !== ROUTE_ID) continue;
    tripUpdatesByTripId.set(entity.tripUpdate.trip.tripId, entity.tripUpdate);
  }

  for (const entity of entities) {
    const vehicle = entity.vehicle;
    if (!vehicle || inferredRouteId({ id: entity.id, tripUpdate: { trip: vehicle.trip } }) !== ROUTE_ID) continue;
    if (vehicle.timestamp && nowSeconds - vehicle.timestamp > 15 * 60) continue;
    const update = tripUpdatesByTripId.get(vehicle.trip.tripId);
    const position = positionFromVehicle(staticData, vehicle, update, nowSeconds)
      || trainPosition(staticData, update?.stopTimeUpdates || [], nowSeconds);
    if (!position) continue;
    const directionId = inferredDirection(vehicle.trip, update?.stopTimeUpdates || [{ stopId: vehicle.stopId }]);

    trains.push({
      id: entity.id || vehicle.trip.tripId,
      tripId: vehicle.trip.tripId,
      directionId,
      direction: directionId === 1 ? "Coney Island-bound" : "Astoria-bound",
      lat: position.lat,
      lon: position.lon,
      nextStop: position.nextStop?.name,
      previousStop: position.previousStop?.name,
      nextArrival: new Date(position.nextTime * 1000).toISOString(),
      minutesToNext: Math.max(0, Math.round((position.nextTime - nowSeconds) / 60)),
      status: vehicle.currentStatus,
      vehicleTimestamp: vehicle.timestamp ? new Date(vehicle.timestamp * 1000).toISOString() : null
    });
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "MTA GTFS Realtime N/Q/R/W feed",
    trains
  };
  realtimeCache = { at: nowMs, payload };
  return payload;
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

staticDataPromise = loadStaticData();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/route") {
      const staticData = await staticDataPromise;
      json(response, 200, {
        routeId: staticData.routeId,
        routeName: staticData.routeName,
        color: staticData.color,
        shape: staticData.shape,
        stations: staticData.stations.map(({ shapeIndex, ...station }) => station),
        generatedAt: staticData.generatedAt
      });
      return;
    }

    if (url.pathname === "/api/trains") {
      json(response, 200, await getRealtimeTrains());
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`NYC N Train Live running at http://localhost:${PORT}`);
});
