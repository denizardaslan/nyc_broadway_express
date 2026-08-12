// Just enough ZIP to read GTFS archives, so the server does not depend on an
// `unzip` binary being present on the host.

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new Error("Not a ZIP archive: end of central directory not found");
}

/** @returns {Map<string, {method: number, offset: number, compressedSize: number}>} */
export function readZipIndex(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    entries.set(name, { method, offset, compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(buffer, index, name) {
  const entry = index.get(name);
  if (!entry) throw new Error(`Missing ${name} in GTFS archive`);
  if (buffer.readUInt32LE(entry.offset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Corrupt local header for ${name}`);
  }

  const nameLength = buffer.readUInt16LE(entry.offset + 26);
  const extraLength = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return body.toString("utf8");
  if (entry.method === 8) return inflateRawSync(body).toString("utf8");
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
}
