import test from "node:test";
import assert from "node:assert/strict";

import { decodeFeed, VEHICLE_STATUS } from "../src/gtfsrt.js";
import { DepartureMemory, indexNetwork, locateTrip, progressAt } from "../src/positions.js";
import { measurePath, pointAt } from "../src/geo.js";
import { feedMessage, toyNetwork, tripUpdateEntity, vehicleEntity } from "./helpers.js";

const NOW = 1_700_000_000;

function trips(entities) {
  const decoded = decodeFeed(feedMessage(entities));
  const byTrip = new Map();

  for (const entity of decoded.entities) {
    if (!entity.tripUpdate) continue;
    const tripId = entity.tripUpdate.trip.tripId;
    byTrip.set(tripId, {
      id: entity.id,
      tripId,
      pathId: tripId.slice(tripId.lastIndexOf("_") + 1),
      directionId: entity.tripUpdate.trip.directionId,
      stopTimeUpdates: entity.tripUpdate.stopTimeUpdates,
      vehicle: null
    });
  }
  for (const entity of decoded.entities) {
    const trip = entity.vehicle && byTrip.get(entity.vehicle.trip?.tripId);
    if (trip) trip.vehicle = entity.vehicle;
  }

  return [...byTrip.values()];
}

const index = indexNetwork(toyNetwork());

const southbound = (stops) => tripUpdateEntity({
  id: "e1",
  trip: { tripId: "010000_N..S01R", directionId: 1 },
  stops
});

test("decodes trip updates, NYCT extensions and vehicles", () => {
  const decoded = decodeFeed(feedMessage([
    tripUpdateEntity({
      id: "e1",
      trip: { tripId: "010000_N..S01R", directionId: 1, trainId: "01 1234+ CIS/DIT" },
      stops: [{ stopId: "CS", arrival: NOW + 60, departure: NOW + 90, track: "B1" }]
    }),
    vehicleEntity({
      id: "e1",
      trip: { tripId: "010000_N..S01R" },
      stopId: "CS",
      status: VEHICLE_STATUS.IN_TRANSIT_TO,
      timestamp: NOW - 5
    })
  ]));

  assert.equal(decoded.header.timestamp, 1_700_000_000);
  assert.equal(decoded.entities.length, 2);

  const update = decoded.entities[0].tripUpdate;
  assert.equal(update.trip.trainId ?? update.trip.nyct.trainId, "01 1234+ CIS/DIT");
  assert.equal(update.stopTimeUpdates[0].stopId, "CS");
  assert.equal(update.stopTimeUpdates[0].arrival.time, NOW + 60);
  assert.equal(update.stopTimeUpdates[0].nyct.actualTrack, "B1");

  const vehicle = decoded.entities[1].vehicle;
  assert.equal(vehicle.currentStatus, VEHICLE_STATUS.IN_TRANSIT_TO);
  assert.equal(vehicle.stopId, "CS");
});

test("places a train between the stop it left and the stop it is heading to", () => {
  // The feed still lists the stop behind the train, with a real departure time.
  const [trip] = trips([southbound([
    { stopId: "BS", arrival: NOW - 130, departure: NOW - 120 },
    { stopId: "CS", arrival: NOW + 120, departure: NOW + 130 }
  ])]);

  const placement = locateTrip(index, trip, NOW, new DepartureMemory());
  assert.equal(placement.fromStopId, "BS");
  assert.equal(placement.toStopId, "CS");
  assert.equal(placement.segmentKey, "BS>CS");
  assert.equal(progressAt(placement, NOW), 0.5);
});

test("recovers the stop behind the train when the feed has pruned it", () => {
  // This is the normal MTA case: only stops still ahead are published.
  const [trip] = trips([southbound([
    { stopId: "CS", arrival: NOW + 60, departure: NOW + 70 },
    { stopId: "DS", arrival: NOW + 200, departure: NOW + 210 }
  ])]);

  const placement = locateTrip(index, trip, NOW, new DepartureMemory());
  assert.equal(placement.fromStopId, "BS", "predecessor comes from the stopping pattern");
  assert.equal(placement.segmentKey, "BS>CS");
  // Scheduled running time is 120s and the train is 60s from Charlie.
  assert.equal(placement.departedAt, NOW - 60);
  assert.equal(progressAt(placement, NOW), 0.5);
});

test("a stop_id on the vehicle is the stop ahead, never the stop behind", () => {
  const [trip] = trips([
    southbound([
      { stopId: "CS", arrival: NOW + 60, departure: NOW + 70 },
      { stopId: "DS", arrival: NOW + 200, departure: NOW + 210 }
    ]),
    vehicleEntity({
      id: "e1",
      trip: { tripId: "010000_N..S01R" },
      stopId: "CS",
      status: VEHICLE_STATUS.IN_TRANSIT_TO,
      timestamp: NOW
    })
  ]);

  const placement = locateTrip(index, trip, NOW, new DepartureMemory());
  assert.equal(placement.toStopId, "CS", "the vehicle's stop is where it is going");
  assert.equal(placement.fromStopId, "BS");
  assert.ok(progressAt(placement, NOW) < 1);
});

test("holds a train on the platform while the vehicle reports STOPPED_AT", () => {
  const [trip] = trips([
    southbound([
      { stopId: "CS", arrival: NOW - 20, departure: NOW + 15 },
      { stopId: "DS", arrival: NOW + 150, departure: NOW + 160 }
    ]),
    vehicleEntity({
      id: "e1",
      trip: { tripId: "010000_N..S01R" },
      stopId: "CS",
      status: VEHICLE_STATUS.STOPPED_AT,
      timestamp: NOW
    })
  ]);

  const placement = locateTrip(index, trip, NOW, new DepartureMemory());
  assert.equal(placement.atStation, true);
  assert.equal(placement.toStopId, "CS");
  assert.equal(progressAt(placement, NOW), 1);
});

test("position depends only on the feed and the clock, so a reload is stable", () => {
  const stops = [
    { stopId: "CS", arrival: NOW + 60, departure: NOW + 70 },
    { stopId: "DS", arrival: NOW + 200, departure: NOW + 210 }
  ];
  const memory = new DepartureMemory();
  const first = locateTrip(index, trips([southbound(stops)])[0], NOW, memory);
  const second = locateTrip(index, trips([southbound(stops)])[0], NOW, memory);

  assert.deepEqual(
    { ...first, updates: undefined },
    { ...second, updates: undefined }
  );
  assert.equal(progressAt(first, NOW + 30), progressAt(second, NOW + 30));
});

test("keeps moving forward when the MTA pushes the arrival estimate back", () => {
  const memory = new DepartureMemory();
  const at = (arrival, now) => progressAt(
    locateTrip(index, trips([southbound([
      { stopId: "CS", arrival, departure: arrival + 10 },
      { stopId: "DS", arrival: arrival + 140, departure: arrival + 150 }
    ])])[0], now, memory),
    now
  );

  const start = at(NOW + 60, NOW);
  const delayed = at(NOW + 90, NOW + 20); // train slowed down; arrival slips
  const later = at(NOW + 100, NOW + 40);

  assert.ok(start > 0 && start < 1);
  assert.ok(delayed >= start, `progress went backwards: ${start} -> ${delayed}`);
  assert.ok(later >= delayed, `progress went backwards: ${delayed} -> ${later}`);
});

test("parks a train at its origin when there is no stop behind it", () => {
  const [trip] = trips([southbound([
    { stopId: "AS", arrival: NOW + 120, departure: NOW + 130 },
    { stopId: "BS", arrival: NOW + 260, departure: NOW + 270 }
  ])]);

  const placement = locateTrip(index, trip, NOW, new DepartureMemory());
  assert.equal(placement.fromStopId, null);
  assert.equal(placement.toStopId, "AS");
  assert.equal(placement.atStation, true);
});

test("drops trips whose schedule has fully expired", () => {
  const [trip] = trips([southbound([
    { stopId: "DS", arrival: NOW - 900, departure: NOW - 880 }
  ])]);

  assert.equal(locateTrip(index, trip, NOW, new DepartureMemory()), null);
});

test("walks the real track geometry rather than cutting the corner", () => {
  const network = toyNetwork();
  const geometry = measurePath(network.segments["BS>CS"].path.map(([lat, lon]) => ({ lat, lon })));
  const midpoint = pointAt(geometry, geometry.length / 2);
  const [a, , b] = network.segments["BS>CS"].path;

  assert.ok(Math.abs(midpoint.lat - (a[0] + b[0]) / 2) < 1e-6);
  assert.ok(geometry.length > 900 && geometry.length < 1100, `link measured ${geometry.length}m`);
});
