// Builds the static picture of the line from the GTFS bundle.
//
// The important idea here is that the N is not one line. It runs express over
// the Manhattan Bridge by day and local through the Montague tunnel and Lower
// Manhattan at night, with a handful of Second Avenue trips on top. Fourteen
// distinct stopping patterns share the corridor.
//
// So instead of picking one shape and pretending every train follows it, we cut
// every shape into *segments* — one per consecutive stop pair — and key them by
// stop pair. A train is then always located on the segment it is actually
// travelling, whichever pattern it is running.

import { eachRow } from "./csv.js";
import { measurePath, projectOnto, sliceBetween, toMeters } from "./geo.js";
import { readZipEntry, readZipIndex } from "./zip.js";

const NETWORK_VERSION = 4;

/** GTFS platform ids carry a direction suffix; the station itself does not. */
export function stationId(stopId = "") {
  return stopId.replace(/[NS]$/, "");
}

function toSeconds(time = "") {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  if (!Number.isFinite(hours)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function metresApart(a, b) {
  const p = toMeters(a.lat, a.lon);
  const q = toMeters(b.lat, b.lon);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * Pins a cut segment to the platforms at either end. Shapes normally run
 * straight through a station, but a few (the Second Avenue trips) stop short of
 * it, which would otherwise leave a train hanging 100 m off the platform.
 */
function anchorToStations(path, from, to) {
  const anchored = [...path];
  if (metresApart(anchored[0], from) < 250) anchored[0] = { lat: from.lat, lon: from.lon };
  const last = anchored.length - 1;
  if (metresApart(anchored[last], to) < 250) anchored[last] = { lat: to.lat, lon: to.lon };
  return anchored;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Merges a stopping pattern into the spine, inserting stops the spine does not
 * have yet. Only runs of new stops that are *bounded* on both sides by known
 * stops are inserted — an unbounded run means a branch (the Second Avenue
 * trips), which belongs on the map but not on a single linear diagram.
 */
function mergeIntoSpine(spine, sequence) {
  let anchor = -1;
  let pending = [];

  for (const stop of sequence) {
    const found = spine.indexOf(stop);

    if (found === -1) {
      if (anchor >= 0) pending.push(stop);
      continue;
    }

    if (found <= anchor) {
      pending = [];
      continue;
    }

    if (pending.length) {
      // Keep the new stops next to the stop they follow, not floating in front
      // of the next known one — that is what puts the Manhattan Bridge platform
      // at Canal St beside the Broadway platform rather than beside DeKalb Av.
      spine.splice(anchor + 1, 0, ...pending);
      anchor = found + pending.length;
      pending = [];
    } else {
      anchor = found;
    }
  }
}

function buildSpine(patterns, stations, segments) {
  const southbound = [...patterns.values()]
    .map((pattern) => (pattern.directionId === 1 ? pattern.stops : [...pattern.stops].reverse()))
    .map((stops) => stops.map(stationId))
    .sort((a, b) => b.length - a.length);

  const stops = [...southbound[0]];
  for (const sequence of southbound.slice(1)) mergeIntoSpine(stops, sequence);

  // Position each spine stop by real track distance where we have it, falling
  // back to straight-line distance for pairs no pattern actually runs.
  const meters = [0];
  for (let i = 1; i < stops.length; i += 1) {
    const segment = segments.get(`${stops[i - 1]}S>${stops[i]}S`) || segments.get(`${stops[i]}N>${stops[i - 1]}N`);
    let gap = segment?.meters;
    if (!gap) {
      const a = stations.get(stops[i - 1]);
      const b = stations.get(stops[i]);
      gap = a && b ? Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 84_400) : 800;
    }
    meters.push(meters[i - 1] + gap);
  }

  return { stops, meters, length: meters[meters.length - 1] };
}

/** Deduplicated geometry for drawing: each physical link is drawn once. */
function buildEdges(segments) {
  const edges = [];
  const seen = new Set();

  for (const [key, segment] of segments) {
    const [from, to] = key.split(">");
    const pair = [stationId(from), stationId(to)].sort().join("~");
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({ from: stationId(from), to: stationId(to), path: segment.path });
  }

  return edges;
}

export function buildNetwork(zipBuffer, { routeId = "N" } = {}) {
  const index = readZipIndex(zipBuffer);
  const read = (name) => readZipEntry(zipBuffer, index, name);

  const routeMeta = {};
  eachRow(read("routes.txt"), (row) => {
    if (row.route_id === routeId) Object.assign(routeMeta, row);
  });

  const tripMeta = new Map();
  eachRow(read("trips.txt"), (row) => {
    if (row.route_id !== routeId) return;
    tripMeta.set(row.trip_id, {
      pathId: row.shape_id,
      directionId: Number(row.direction_id),
      headsign: row.trip_headsign
    });
  });

  const stations = new Map();
  eachRow(read("stops.txt"), (row) => {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    stations.set(row.stop_id, { id: row.stop_id, name: row.stop_name, lat, lon });
  });

  const shapes = new Map();
  eachRow(read("shapes.txt"), (row) => {
    if (!row.shape_id?.startsWith(`${routeId}..`)) return;
    const list = shapes.get(row.shape_id) || shapes.set(row.shape_id, []).get(row.shape_id);
    list.push({
      sequence: Number(row.shape_pt_sequence),
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon)
    });
  });
  for (const [id, points] of shapes) {
    points.sort((a, b) => a.sequence - b.sequence);
    shapes.set(id, measurePath(points));
  }

  // stop_times.txt is the big one; keep only the rows belonging to our route.
  const tripStops = new Map();
  eachRow(read("stop_times.txt"), (row) => {
    if (!tripMeta.has(row.trip_id)) return;
    const list = tripStops.get(row.trip_id) || tripStops.set(row.trip_id, []).get(row.trip_id);
    list.push({
      sequence: Number(row.stop_sequence),
      stopId: row.stop_id,
      arrival: toSeconds(row.arrival_time),
      departure: toSeconds(row.departure_time)
    });
  });

  const patterns = new Map();
  const travelTimes = new Map();

  for (const [tripId, stops] of tripStops) {
    stops.sort((a, b) => a.sequence - b.sequence);
    const meta = tripMeta.get(tripId);
    const stopIds = stops.map((stop) => stop.stopId);

    const existing = patterns.get(meta.pathId);
    if (!existing || existing.stops.length < stopIds.length) {
      patterns.set(meta.pathId, {
        id: meta.pathId,
        directionId: meta.directionId,
        headsign: meta.headsign,
        stops: stopIds,
        trips: (existing?.trips || 0) + 1
      });
    } else {
      existing.trips += 1;
    }

    for (let i = 1; i < stops.length; i += 1) {
      const key = `${stops[i - 1].stopId}>${stops[i].stopId}`;
      const gap = stops[i].arrival - stops[i - 1].departure;
      if (!Number.isFinite(gap) || gap <= 0) continue;
      const list = travelTimes.get(key) || travelTimes.set(key, []).get(key);
      list.push(gap);
    }
  }

  // Cut every pattern's shape at its stops to get per-stop-pair track geometry.
  const segments = new Map();
  for (const pattern of patterns.values()) {
    const shape = shapes.get(pattern.id);
    if (!shape) continue;

    const distances = pattern.stops.map((stopId) => {
      const station = stations.get(stationId(stopId)) || stations.get(stopId);
      return station ? projectOnto(shape, station.lat, station.lon).distance : null;
    });

    for (let i = 1; i < pattern.stops.length; i += 1) {
      const key = `${pattern.stops[i - 1]}>${pattern.stops[i]}`;
      if (distances[i - 1] === null || distances[i] === null) continue;

      const from = stations.get(stationId(pattern.stops[i - 1]));
      const to = stations.get(stationId(pattern.stops[i]));
      if (!from || !to) continue;

      const path = anchorToStations(sliceBetween(shape, distances[i - 1], distances[i]), from, to);
      const meters = measurePath(path).length;
      const existing = segments.get(key);
      // Different patterns can traverse the same pair; keep the most direct.
      if (existing && existing.meters <= meters) continue;

      segments.set(key, {
        meters,
        seconds: median(travelTimes.get(key) || [Math.max(45, meters / 11)]),
        path: path.map((point) => [round(point.lat, 5), round(point.lon, 5)])
      });
    }
  }

  // Stations actually served, in spine order.
  const served = new Map();
  for (const pattern of patterns.values()) {
    for (const stopId of pattern.stops) {
      const id = stationId(stopId);
      if (!served.has(id) && stations.has(id)) served.set(id, stations.get(id));
    }
  }

  const spine = buildSpine(patterns, served, segments);
  const spineIndex = new Map(spine.stops.map((id, index) => [id, index]));

  const terminals = new Set();
  for (const pattern of patterns.values()) {
    terminals.add(stationId(pattern.stops[0]));
    terminals.add(stationId(pattern.stops[pattern.stops.length - 1]));
  }

  return {
    version: NETWORK_VERSION,
    generatedAt: new Date().toISOString(),
    route: {
      id: routeId,
      name: routeMeta.route_long_name || routeId,
      color: routeMeta.route_color ? `#${routeMeta.route_color}` : "#FCCC0A",
      textColor: routeMeta.route_text_color ? `#${routeMeta.route_text_color}` : "#000000"
    },
    stations: Object.fromEntries(
      [...served].map(([id, station]) => [
        id,
        {
          id,
          name: station.name,
          lat: round(station.lat, 5),
          lon: round(station.lon, 5),
          spine: spineIndex.get(id) ?? null,
          meters: spineIndex.has(id) ? Math.round(spine.meters[spineIndex.get(id)]) : null,
          terminal: terminals.has(id)
        }
      ])
    ),
    segments: Object.fromEntries(
      [...segments].map(([key, segment]) => [
        key,
        { meters: Math.round(segment.meters), seconds: Math.round(segment.seconds), path: segment.path }
      ])
    ),
    patterns: Object.fromEntries(
      [...patterns].map(([id, pattern]) => [
        id,
        {
          directionId: pattern.directionId,
          headsign: pattern.headsign,
          stops: pattern.stops
        }
      ])
    ),
    edges: buildEdges(segments),
    spine: { stops: spine.stops, meters: spine.meters.map((value) => Math.round(value)), length: Math.round(spine.length) }
  };
}

export { NETWORK_VERSION };
