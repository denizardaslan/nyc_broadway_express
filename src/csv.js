// Minimal CSV reader for GTFS text files.
//
// GTFS only quotes fields that contain commas (stop names, headsigns), so the
// common case is a plain split. We pay for the quote-aware scan only on the
// lines that actually need it, which matters because stop_times.txt is ~36 MB.

function splitQuoted(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
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
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell);
  return cells;
}

function splitLine(line) {
  return line.includes('"') ? splitQuoted(line) : line.split(",");
}

/**
 * Streams a GTFS file line by line so callers can skip rows they do not need
 * without materialising the whole table.
 *
 * @param {string} text raw file contents
 * @param {(row: Record<string, string>) => void} onRow
 */
export function eachRow(text, onRow) {
  const header = [];
  let start = 0;
  let isHeader = true;

  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) {
      if (start > text.length) break;
      continue;
    }

    const cells = splitLine(line);
    if (isHeader) {
      header.push(...cells.map((cell) => cell.replace(/^﻿/, "").trim()));
      isHeader = false;
      continue;
    }

    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i];
    onRow(row);
  }
}

export function parseCsv(text) {
  const rows = [];
  eachRow(text, (row) => rows.push(row));
  return rows;
}
