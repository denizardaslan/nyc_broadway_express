/**
 * A stand-in for the MTA realtime feed, for working offline.
 *
 * It runs trains along the line's real stopping patterns and scheduled running
 * times, and publishes them the way the MTA does: only the stops still ahead of
 * each train, with predicted arrival times. That means the server's inference —
 * recovering the stop behind a train, estimating when it left — is exercised
 * exactly as it is in production.
 *
 *   node tools/mock-feed.js &
 *   REALTIME_URL=http://127.0.0.1:4174/feed node server.js
 */

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildNetwork, NETWORK_VERSION } from "../src/network.js";
import { feedMessage, tripUpdateEntity, vehicleEntity } from "../test/helpers.js";
import { VEHICLE_STATUS } from "../src/gtfsrt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PORT = Number(process.env.MOCK_PORT || 4174);
const HEADWAY_SECONDS = 330;
const DWELL_SECONDS = 30;

async function loadNetwork() {
  try {
    return JSON.parse(await readFile(path.join(root, ".cache", `network.v${NETWORK_VERSION}.json`), "utf8"));
  } catch {
    // Fall through to the raw bundle.
  }

  try {
    return buildNetwork(await readFile(path.join(root, ".cache", "gtfs_subway.zip")));
  } catch {
    console.error("No GTFS bundle yet. Run `node server.js` once to fetch it, then start this again.");
    process.exit(1);
  }
}

const network = await loadNetwork();

/** One pattern per direction: the busiest daytime service. */
const patterns = [0, 1].map((directionId) => {
  const candidates = Object.entries(network.patterns)
    .filter(([, pattern]) => pattern.directionId === directionId)
    .sort((a, b) => Math.abs(a[1].stops.length - 32) - Math.abs(b[1].stops.length - 32));
  return { id: candidates[0][0], ...candidates[0][1] };
});

/** Cumulative seconds from the start of the pattern to each stop. */
function schedule(pattern) {
  const times = [0];
  for (let i = 1; i < pattern.stops.length; i += 1) {
    const link = network.segments[`${pattern.stops[i - 1]}>${pattern.stops[i]}`];
    times.push(times[i - 1] + (link?.seconds || 90) + DWELL_SECONDS);
  }
  return times;
}

const schedules = new Map(patterns.map((pattern) => [pattern.id, schedule(pattern)]));

function buildFeed(now) {
  const entities = [];

  for (const pattern of patterns) {
    const times = schedules.get(pattern.id);
    const runtime = times[times.length - 1];

    // Departures are anchored to absolute time, so a train keeps its identity
    // and its departure for the whole run instead of resetting on a cycle.
    const first = Math.floor((now - runtime) / HEADWAY_SECONDS) + 1;
    const last = Math.floor(now / HEADWAY_SECONDS);

    for (let index = first; index <= last; index += 1) {
      const departedAt = index * HEADWAY_SECONDS;
      const ahead = times
        .map((offset, stopIndex) => ({ stopId: pattern.stops[stopIndex], at: Math.round(departedAt + offset) }))
        .filter((stop) => stop.at >= now - 20);
      if (!ahead.length) continue;

      const tripId = `${String(index % 1_000_000).padStart(6, "0")}_${pattern.id}`;
      const dwelling = ahead[0].at - now < 4;

      entities.push(tripUpdateEntity({
        id: tripId,
        trip: { tripId, routeId: "N", directionId: pattern.directionId, trainId: `0${pattern.directionId} ${index % 10_000}` },
        stops: ahead.map((stop) => ({
          stopId: stop.stopId,
          arrival: stop.at,
          departure: stop.at + DWELL_SECONDS
        }))
      }));

      entities.push(vehicleEntity({
        id: tripId,
        trip: { tripId, routeId: "N", directionId: pattern.directionId },
        stopId: ahead[0].stopId,
        status: dwelling ? VEHICLE_STATUS.STOPPED_AT : VEHICLE_STATUS.IN_TRANSIT_TO,
        timestamp: Math.round(now)
      }));
    }
  }

  return feedMessage(entities, Math.round(now));
}

http.createServer((request, response) => {
  const body = buildFeed(Date.now() / 1000);
  response.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
  response.end(body);
}).listen(PORT, () => {
  console.log(`mock N feed → http://127.0.0.1:${PORT}/feed`);
});
