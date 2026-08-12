// A tiny GTFS Realtime decoder — only the fields this app reads, so we can stay
// dependency-free. Field numbers come from gtfs-realtime.proto plus the NYCT
// extension (field 1001 on TripDescriptor and StopTimeUpdate).

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, cursor];
    shift += 7;
    if (shift > 63) throw new Error("Protobuf varint too long");
  }

  throw new Error("Unterminated protobuf varint");
}

/** Walks a protobuf message, handing each field to the reducer. */
function eachField(buffer, onField) {
  let offset = 0;

  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset);
    const field = tag >> 3;
    const wire = tag & 7;

    if (wire === WIRE_VARINT) {
      const [value, next] = readVarint(buffer, afterTag);
      onField(field, wire, value);
      offset = next;
    } else if (wire === WIRE_LENGTH) {
      const [length, start] = readVarint(buffer, afterTag);
      const end = start + length;
      if (end > buffer.length) throw new Error("Protobuf length delimiter overruns buffer");
      onField(field, wire, buffer.subarray(start, end));
      offset = end;
    } else if (wire === WIRE_64BIT) {
      onField(field, wire, buffer.subarray(afterTag, afterTag + 8));
      offset = afterTag + 8;
    } else if (wire === WIRE_32BIT) {
      onField(field, wire, buffer.subarray(afterTag, afterTag + 4));
      offset = afterTag + 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

const text = (value) => Buffer.from(value).toString("utf8");

function decodeStopTimeEvent(buffer) {
  const event = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_VARINT) event.delay = value;
    if (field === 2 && wire === WIRE_VARINT) event.time = value;
  });
  return event;
}

function decodeNyctStopTimeUpdate(buffer) {
  const extra = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) extra.scheduledTrack = text(value);
    if (field === 2 && wire === WIRE_LENGTH) extra.actualTrack = text(value);
  });
  return extra;
}

function decodeStopTimeUpdate(buffer) {
  const update = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_VARINT) update.stopSequence = value;
    if (field === 2 && wire === WIRE_LENGTH) update.arrival = decodeStopTimeEvent(value);
    if (field === 3 && wire === WIRE_LENGTH) update.departure = decodeStopTimeEvent(value);
    if (field === 4 && wire === WIRE_LENGTH) update.stopId = text(value);
    if (field === 5 && wire === WIRE_VARINT) update.scheduleRelationship = value;
    if (field === 1001 && wire === WIRE_LENGTH) update.nyct = decodeNyctStopTimeUpdate(value);
  });
  return update;
}

function decodeNyctTripDescriptor(buffer) {
  const extra = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) extra.trainId = text(value);
    if (field === 2 && wire === WIRE_VARINT) extra.isAssigned = value === 1;
    if (field === 3 && wire === WIRE_VARINT) extra.direction = value;
  });
  return extra;
}

function decodeTripDescriptor(buffer) {
  const trip = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) trip.tripId = text(value);
    if (field === 2 && wire === WIRE_LENGTH) trip.startTime = text(value);
    if (field === 3 && wire === WIRE_LENGTH) trip.startDate = text(value);
    if (field === 5 && wire === WIRE_LENGTH) trip.routeId = text(value);
    if (field === 6 && wire === WIRE_VARINT) trip.directionId = value;
    if (field === 1001 && wire === WIRE_LENGTH) trip.nyct = decodeNyctTripDescriptor(value);
  });
  return trip;
}

function decodeTripUpdate(buffer) {
  const tripUpdate = { trip: {}, stopTimeUpdates: [] };
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) tripUpdate.trip = decodeTripDescriptor(value);
    if (field === 2 && wire === WIRE_LENGTH) tripUpdate.stopTimeUpdates.push(decodeStopTimeUpdate(value));
    if (field === 4 && wire === WIRE_VARINT) tripUpdate.timestamp = value;
    if (field === 5 && wire === WIRE_VARINT) tripUpdate.delay = value;
  });
  return tripUpdate;
}

function decodeVehiclePosition(buffer) {
  const vehicle = { trip: {} };
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) vehicle.trip = decodeTripDescriptor(value);
    if (field === 3 && wire === WIRE_VARINT) vehicle.currentStopSequence = value;
    if (field === 4 && wire === WIRE_VARINT) vehicle.currentStatus = value;
    if (field === 5 && wire === WIRE_VARINT) vehicle.timestamp = value;
    if (field === 7 && wire === WIRE_LENGTH) vehicle.stopId = text(value);
  });
  return vehicle;
}

function decodeEntity(buffer) {
  const entity = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) entity.id = text(value);
    if (field === 3 && wire === WIRE_LENGTH) entity.tripUpdate = decodeTripUpdate(value);
    if (field === 4 && wire === WIRE_LENGTH) entity.vehicle = decodeVehiclePosition(value);
  });
  return entity;
}

function decodeHeader(buffer) {
  const header = {};
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) header.version = text(value);
    if (field === 3 && wire === WIRE_VARINT) header.timestamp = value;
  });
  return header;
}

export function decodeFeed(buffer) {
  const feed = { header: {}, entities: [] };
  eachField(buffer, (field, wire, value) => {
    if (field === 1 && wire === WIRE_LENGTH) feed.header = decodeHeader(value);
    if (field === 2 && wire === WIRE_LENGTH) feed.entities.push(decodeEntity(value));
  });
  return feed;
}

/** Vehicle.current_status values, named for readability at the call site. */
export const VEHICLE_STATUS = {
  INCOMING_AT: 0,
  STOPPED_AT: 1,
  IN_TRANSIT_TO: 2
};
