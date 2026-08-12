import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildNetwork, stationId } from "../src/network.js";
import { indexNetwork } from "../src/positions.js";
import { measurePath, projectOnto } from "../src/geo.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, ".cache", "gtfs_subway.zip");

// The bundle is downloaded on first run of the server and is gitignored, so
// these checks only run where it is present.
const options = existsSync(bundle)
  ? {}
  : { skip: "no .cache/gtfs_subway.zip — run `node server.js` once" };

let network;
function load() {
  network ??= buildNetwork(readFileSync(bundle));
  return network;
}

test("splits every stopping pattern into per-stop-pair track geometry", options, () => {
  const built = load();

  assert.ok(Object.keys(built.patterns).length >= 10, "the N runs many patterns, not one");
  assert.ok(Object.keys(built.segments).length > 90);

  for (const [id, pattern] of Object.entries(built.patterns)) {
    for (let i = 1; i < pattern.stops.length; i += 1) {
      const key = `${pattern.stops[i - 1]}>${pattern.stops[i]}`;
      assert.ok(built.segments[key], `pattern ${id} has no geometry for ${key}`);
    }
  }
});

test("covers both the Manhattan Bridge express and the late-night tunnel run", options, () => {
  const built = load();
  const named = (name) => Object.values(built.stations).filter((station) => station.name === name);

  // Two different Canal St platforms: Broadway (tunnel route) and the bridge.
  assert.equal(named("Canal St").length, 2, "both Canal St platforms should be present");
  assert.ok(named("Whitehall St-South Ferry").length, "late-night routing runs via Whitehall");
  assert.ok(named("96 St").length, "Second Avenue trips reach 96 St");
});

test("segments follow the track and land on their stations", options, () => {
  const built = load();

  for (const [key, segment] of Object.entries(built.segments)) {
    const [from, to] = key.split(">");
    const a = built.stations[stationId(from)];
    const b = built.stations[stationId(to)];
    const start = segment.path[0];
    const end = segment.path[segment.path.length - 1];

    const near = (station, point) => Math.hypot(
      (station.lat - point[0]) * 111_320,
      (station.lon - point[1]) * 84_400
    );

    assert.ok(near(a, start) < 5, `${key} starts ${near(a, start).toFixed(0)}m from ${a.name}`);
    assert.ok(near(b, end) < 5, `${key} ends ${near(b, end).toFixed(0)}m from ${b.name}`);

    // Track distance is never shorter than the straight line between stations.
    const straight = near(a, [b.lat, b.lon]);
    assert.ok(segment.meters >= straight - 5, `${key} is shorter than the crow flies`);
    assert.ok(segment.seconds > 0 && segment.seconds < 900, `${key} has odd running time`);
  }
});

test("orders the whole line so every pattern runs along it in one direction", options, () => {
  const built = load();

  for (const [id, pattern] of Object.entries(built.patterns)) {
    const positions = pattern.stops
      .map((stop) => built.stations[stationId(stop)]?.spine)
      .filter((value) => value !== null && value !== undefined);

    for (let i = 1; i < positions.length; i += 1) {
      const forwards = pattern.directionId === 1
        ? positions[i] > positions[i - 1]
        : positions[i] < positions[i - 1];
      assert.ok(forwards, `pattern ${id} doubles back at position ${i}`);
    }
  }
});

test("every stop can be reached from a neighbouring stop", options, () => {
  const index = indexNetwork(load());

  for (const pattern of Object.values(load().patterns)) {
    for (const stop of pattern.stops.slice(1)) {
      assert.ok(index.predecessors.get(stop)?.length, `nothing leads into ${stop}`);
    }
  }
});

test("stations sit on the shapes they are cut from", options, () => {
  const built = load();
  let worst = 0;

  for (const segment of Object.values(built.segments).slice(0, 40)) {
    const measured = measurePath(segment.path.map(([lat, lon]) => ({ lat, lon })));
    const middle = segment.path[Math.floor(segment.path.length / 2)];
    worst = Math.max(worst, projectOnto(measured, middle[0], middle[1]).offset);
  }

  assert.ok(worst < 1, `geometry drifted ${worst.toFixed(2)}m off its own path`);
});
