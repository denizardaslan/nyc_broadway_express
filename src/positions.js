// Where is a train, right now?
//
// The MTA feed does not publish coordinates. It publishes, per trip, the stops
// still ahead of it and when it expects to reach them. Everything else is
// inference, and the quality of the map comes down to doing that inference
// honestly:
//
//   * The stop a train is heading *to* is the first update still in the future.
//   * The stop it came *from* is the update before it — but the MTA prunes
//     stops once they are passed, so usually there is no "before". We recover
//     it from the trip's stopping pattern (the trip id carries its path id).
//   * The departure time is then either published, remembered from the poll
//     where we watched the train move on, or estimated from the scheduled
//     running time for that pair of stops.
//
// Given a from-stop, a to-stop and two timestamps, the position is a pure
// function of the clock — which is why a page reload lands a train exactly
// where it was, instead of somewhere else.

import { clamp } from "./geo.js";
import { stationId } from "./network.js";
import { VEHICLE_STATUS } from "./gtfsrt.js";

/** Fallback running time when a stop pair has no scheduled trip at all. */
const FALLBACK_SEGMENT_SECONDS = 90;

/** How far back a departure we only just noticed is assumed to have happened. */
const OBSERVATION_SLACK_SECONDS = 15;

/** Drop trips whose whole schedule is this far in the past. */
const STALE_TRIP_SECONDS = 180;

/**
 * Trains do not travel at a constant speed between stations — they accelerate
 * out and brake in. A touch of ease-in-out tracks that better than a straight
 * line, and it also makes mid-segment movement the fastest part of the trip,
 * which is the part you can actually see.
 */
const EASE_WEIGHT = 0.45;

export function easeProgress(t) {
  const smooth = t * t * (3 - 2 * t);
  return t * (1 - EASE_WEIGHT) + smooth * EASE_WEIGHT;
}

/** Precomputes the lookups locateTrip needs, so each poll stays O(trips). */
export function indexNetwork(network) {
  const predecessors = new Map();
  const successors = new Map();

  for (const key of Object.keys(network.segments)) {
    const [from, to] = key.split(">");
    (predecessors.get(to) || predecessors.set(to, []).get(to)).push(from);
    (successors.get(from) || successors.set(from, []).get(from)).push(to);
  }

  return { network, predecessors, successors };
}

function segmentFor(index, from, to) {
  return index.network.segments[`${from}>${to}`];
}

/**
 * The stop before `stopId` on this trip. Preference order: the trip's own
 * stopping pattern, then the only track link that leads into the stop.
 */
function previousStopOf(index, pathId, stopId) {
  const pattern = index.network.patterns[pathId];
  if (pattern) {
    const at = pattern.stops.indexOf(stopId);
    if (at > 0) return pattern.stops[at - 1];
    if (at === 0) return null;
  }

  const options = index.predecessors.get(stopId) || [];
  if (options.length === 1) return options[0];
  // Ambiguous (an express and a local both feed this stop): pick the shortest
  // link, which is the one a train is most likely to have just run.
  return options
    .map((from) => ({ from, meters: segmentFor(index, from, stopId)?.meters ?? Infinity }))
    .sort((a, b) => a.meters - b.meters)[0]?.from ?? null;
}

function eventTime(event) {
  const time = event?.time;
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Feed updates reduced to `{stopId, arrival, departure}`, in schedule order. */
function usableUpdates(stopTimeUpdates) {
  const updates = [];

  for (const update of stopTimeUpdates) {
    if (!update.stopId) continue;
    const arrival = eventTime(update.arrival);
    const departure = eventTime(update.departure);
    if (arrival === null && departure === null) continue;
    updates.push({
      stopId: update.stopId,
      arrival: arrival ?? departure,
      departure: departure ?? arrival,
      track: update.nyct?.actualTrack || update.nyct?.scheduledTrack || null
    });
  }

  return updates.sort((a, b) => a.arrival - b.arrival);
}

/**
 * Remembers, per trip, which link it is on and when we decided it left. Keeping
 * the departure stable is what stops a train rubber-banding when the MTA
 * revises its arrival estimate mid-trip.
 */
export class DepartureMemory {
  constructor() {
    this.entries = new Map();
  }

  /** @returns {number} the departure time to use for this trip and link. */
  resolve(tripId, segmentKey, estimate, now) {
    const previous = this.entries.get(tripId);

    if (previous && previous.segmentKey === segmentKey) {
      previous.touchedAt = now;
      return previous.departedAt;
    }

    // First time we see this trip on this link. If we were already watching it
    // on the link that feeds into this one, it left about the moment we noticed.
    const observed = previous && previous.segmentKey?.split(">")[1] === segmentKey.split(">")[0]
      ? now - OBSERVATION_SLACK_SECONDS
      : estimate;

    const departedAt = Math.min(observed, now);
    this.entries.set(tripId, { segmentKey, departedAt, touchedAt: now });
    return departedAt;
  }

  prune(now, maxAgeSeconds = 3600) {
    for (const [tripId, entry] of this.entries) {
      if (now - entry.touchedAt > maxAgeSeconds) this.entries.delete(tripId);
    }
  }
}

/**
 * @returns {null | object} the train's placement, or null if the feed does not
 * say enough to place it.
 */
export function locateTrip(index, trip, now, memory) {
  const updates = usableUpdates(trip.stopTimeUpdates || []);
  if (!updates.length) return null;

  const last = updates[updates.length - 1];
  if (last.arrival < now - STALE_TRIP_SECONDS) return null;

  const stations = index.network.stations;
  const stationOf = (stopId) => stations[stationId(stopId)] || null;

  let ahead = updates.findIndex((update) => update.departure >= now);
  if (ahead === -1) ahead = updates.length - 1;

  const target = updates[ahead];
  const toStation = stationOf(target.stopId);
  if (!toStation) return null;

  const arrivesAt = target.arrival;
  const published = ahead > 0 ? updates[ahead - 1] : null;
  const fromStopId = published ? published.stopId : previousStopOf(index, trip.pathId, target.stopId);
  const fromStation = fromStopId ? stationOf(fromStopId) : null;
  const segment = fromStopId ? segmentFor(index, fromStopId, target.stopId) : null;

  const stoppedHere = trip.vehicle?.currentStatus === VEHICLE_STATUS.STOPPED_AT
    && trip.vehicle?.stopId === target.stopId;

  // No usable predecessor: the train is sitting at its origin, or the feed only
  // knows about one stop. Park it on the platform rather than guess.
  if (!fromStation || !segment) {
    return {
      fromStopId: null,
      toStopId: target.stopId,
      from: null,
      to: toStation,
      departedAt: arrivesAt,
      arrivesAt,
      atStation: true,
      segmentKey: null,
      track: target.track,
      updates
    };
  }

  const segmentKey = `${fromStopId}>${target.stopId}`;
  const estimate = arrivesAt - (segment.seconds || FALLBACK_SEGMENT_SECONDS);
  const departedAt = published
    ? published.departure
    : memory.resolve(trip.tripId, segmentKey, estimate, now);

  return {
    fromStopId,
    toStopId: target.stopId,
    from: fromStation,
    to: toStation,
    departedAt: Math.min(departedAt, arrivesAt - 5),
    arrivesAt,
    atStation: stoppedHere,
    segmentKey,
    track: target.track,
    updates
  };
}

/** Fraction of the link covered at `now`, matching what the browser draws. */
export function progressAt(placement, now) {
  if (!placement.segmentKey) return 1;
  const span = placement.arrivesAt - placement.departedAt;
  if (!(span > 0)) return 1;
  if (placement.atStation) return 1;
  return clamp((now - placement.departedAt) / span, 0, 1);
}
