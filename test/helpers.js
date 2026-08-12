// Minimal protobuf encoder + a toy network, so the position logic can be tested
// without reaching the MTA or unpacking the real GTFS bundle.

function varint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining > 127) {
    bytes.push((remaining % 128) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

const tag = (field, wire) => varint(field * 8 + wire);
export const nested = (field, body) => Buffer.concat([tag(field, 2), varint(body.length), body]);
export const uint = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);
export const str = (field, value) => nested(field, Buffer.from(value, "utf8"));
export const message = (...parts) => Buffer.concat(parts);

export function stopTimeUpdate({ stopId, arrival, departure, track }) {
  const parts = [str(4, stopId)];
  if (arrival) parts.push(nested(2, uint(2, arrival)));
  if (departure) parts.push(nested(3, uint(2, departure)));
  if (track) parts.push(nested(1001, str(2, track)));
  return nested(2, message(...parts));
}

export function tripDescriptor({ tripId, routeId = "N", directionId, trainId }) {
  const parts = [str(1, tripId)];
  if (routeId) parts.push(str(5, routeId));
  if (Number.isFinite(directionId)) parts.push(uint(6, directionId));
  if (trainId) parts.push(nested(1001, message(str(1, trainId), uint(2, 1))));
  return message(...parts);
}

export function tripUpdateEntity({ id, trip, stops }) {
  return nested(2, message(
    str(1, id),
    nested(3, message(nested(1, tripDescriptor(trip)), ...stops.map(stopTimeUpdate)))
  ));
}

export function vehicleEntity({ id, trip, stopId, status, timestamp }) {
  const parts = [nested(1, tripDescriptor(trip))];
  if (Number.isFinite(status)) parts.push(uint(4, status));
  if (timestamp) parts.push(uint(5, timestamp));
  if (stopId) parts.push(str(7, stopId));
  return nested(2, message(str(1, id), nested(4, message(...parts))));
}

export function feedMessage(entities, timestamp = 1_700_000_000) {
  return message(nested(1, message(str(1, "2.0"), uint(3, timestamp))), ...entities);
}

/**
 * A straight four-stop line running north (A) to south (D), 1 km apart, shaped
 * like the real thing: suffixed platform ids, a spine, per-link geometry.
 */
export function toyNetwork() {
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  const ids = ["A", "B", "C", "D"];
  const stations = {};
  ids.forEach((id, index) => {
    stations[id] = {
      id,
      name: names[index],
      lat: 40.8 - index * 0.009,
      lon: -73.95,
      spine: index,
      meters: index * 1000,
      terminal: index === 0 || index === ids.length - 1
    };
  });

  const segments = {};
  for (let i = 1; i < ids.length; i += 1) {
    const south = `${ids[i - 1]}S>${ids[i]}S`;
    const north = `${ids[i]}N>${ids[i - 1]}N`;
    const a = stations[ids[i - 1]];
    const b = stations[ids[i]];
    const geometry = [[a.lat, a.lon], [(a.lat + b.lat) / 2, a.lon], [b.lat, b.lon]];
    segments[south] = { meters: 1000, seconds: 120, path: geometry };
    segments[north] = { meters: 1000, seconds: 120, path: [...geometry].reverse() };
  }

  return {
    version: 0,
    route: { id: "N", name: "Toy", color: "#FCCC0A" },
    stations,
    segments,
    patterns: {
      "N..S01R": { directionId: 1, headsign: "Delta", stops: ["AS", "BS", "CS", "DS"] },
      "N..N01R": { directionId: 0, headsign: "Alpha", stops: ["DN", "CN", "BN", "AN"] }
    },
    edges: [],
    spine: { stops: ids, meters: [0, 1000, 2000, 3000], length: 3000 }
  };
}
