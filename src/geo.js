// Local equirectangular projection. Over a 35 km corridor at NYC's latitude the
// error is well under a metre, and it keeps every distance calculation to plain
// arithmetic instead of great-circle trigonometry.

const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;
const REFERENCE_LATITUDE = 40.7;
const LON_SCALE = Math.cos(REFERENCE_LATITUDE * DEG) * EARTH_RADIUS * DEG;
const LAT_SCALE = EARTH_RADIUS * DEG;

export function toMeters(lat, lon) {
  return { x: lon * LON_SCALE, y: lat * LAT_SCALE };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Wraps a lat/lon polyline with cumulative distances so we can address any
 * point on it by "metres travelled from the start".
 */
export function measurePath(points) {
  const projected = points.map((point) => toMeters(point.lat, point.lon));
  const cumulative = [0];
  let total = 0;

  for (let i = 1; i < projected.length; i += 1) {
    total += Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y);
    cumulative.push(total);
  }

  return { points, projected, cumulative, length: total };
}

/** Nearest point on the path to a coordinate, expressed as metres along it. */
export function projectOnto(path, lat, lon) {
  const target = toMeters(lat, lon);
  let best = { offset: Infinity, distance: 0 };

  for (let i = 0; i < path.projected.length - 1; i += 1) {
    const a = path.projected[i];
    const b = path.projected[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lengthSquared = vx * vx + vy * vy;
    if (lengthSquared < 1e-9) continue;

    const t = clamp(((target.x - a.x) * vx + (target.y - a.y) * vy) / lengthSquared, 0, 1);
    const offset = Math.hypot(target.x - (a.x + vx * t), target.y - (a.y + vy * t));

    if (offset < best.offset) {
      best = { offset, distance: path.cumulative[i] + Math.sqrt(lengthSquared) * t };
    }
  }

  return best;
}

/** Interpolated lat/lon at a given distance along the path. */
export function pointAt(path, distance) {
  const bounded = clamp(distance, 0, path.length);
  let index = 0;
  while (index < path.cumulative.length - 2 && path.cumulative[index + 1] < bounded) index += 1;

  const spanStart = path.cumulative[index];
  const span = path.cumulative[index + 1] - spanStart || 1;
  const t = clamp((bounded - spanStart) / span, 0, 1);
  const a = path.points[index];
  const b = path.points[index + 1] ?? a;

  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t
  };
}

/** The sub-polyline between two distances, keeping the original vertices. */
export function sliceBetween(path, from, to) {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const slice = [pointAt(path, start)];

  for (let i = 0; i < path.cumulative.length; i += 1) {
    if (path.cumulative[i] > start + 0.5 && path.cumulative[i] < end - 0.5) slice.push(path.points[i]);
  }

  slice.push(pointAt(path, end));
  return from <= to ? slice : slice.reverse();
}
