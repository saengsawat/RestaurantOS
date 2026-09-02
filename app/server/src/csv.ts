/**
 * A CSV reader (E22-T2), hand-rolled and dependency-free like everything else
 * in this repo.
 *
 * The input is a real spreadsheet export, so it handles what spreadsheets
 * actually emit rather than what a tidy example looks like: quoted fields,
 * doubled quotes inside them, embedded commas and newlines, CRLF endings, a
 * trailing newline, and the UTF-8 BOM that Excel writes at the front of every
 * file it saves as CSV. That BOM is not cosmetic: unstripped it turns the
 * header `name` into `﻿name` and the whole import fails to find a column
 * that is plainly sitting there.
 *
 * Errors carry the physical LINE NUMBER, because the person fixing the file is
 * looking at it in a spreadsheet where the header is line 1. A quoted field
 * may span lines, so a record's line is where the record STARTS.
 */

export interface CsvRecord {
  /** 1-based physical line where this record begins, as the sheet shows it */
  line: number;
  fields: string[];
}

export type CsvResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; line: number; reason: string };

/**
 * Parse CSV text into records. Structural failure refuses the WHOLE file
 * (E22-T2: all-or-nothing parse), because a file that does not parse cannot
 * be partially trusted: an unterminated quote silently swallows every row
 * after it, and applying "what we could read" would be applying half a menu.
 */
export function parseCsv(text: string): CsvResult {
  // the BOM, if any, belongs to the encoding and not to the first header
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let started = false; // this record has content, so a bare newline ends it

  const endField = () => { fields.push(field); field = ""; started = true; };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; continue; } // "" is one quote
        quoted = false;
        // after a closing quote only a delimiter, a line ending, or the end of
        // the file is legal. Anything else (`"abc"def`) means the file is not
        // the shape it claims to be, and guessing would corrupt a price.
        const next = input[i + 1];
        if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
          return { ok: false, line, reason: `unexpected text after a closing quote` };
        }
        continue;
      }
      if (ch === "\n") line++;
      field += ch;
      continue;
    }

    if (ch === '"') {
      // a quote only opens a field at its start; mid-field it is literal,
      // which is how an unescaped inch mark (6" bowl) survives
      if (field === "") { quoted = true; started = true; continue; }
      field += ch;
      continue;
    }
    if (ch === ",") { endField(); continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++; // CRLF is one ending
      line++;
      // a wholly empty line produces no record at all, which is how the gaps
      // a spreadsheet leaves between sections stay out of the row numbering
      if (started || fields.length) endRecord();
      recordLine = line; // whatever comes next begins here
      continue;
    }
    field += ch;
    started = true;
  }

  if (quoted) return { ok: false, line: recordLine, reason: "a quoted field is never closed" };
  // a trailing newline is not an empty final row
  if (started || fields.length) endRecord();

  return { ok: true, records };
}

/** Blank rows are what a spreadsheet leaves behind between sections; they are
 *  not data and not an error. */
export function isBlankRecord(record: CsvRecord): boolean {
  return record.fields.every((f) => f.trim() === "");
}
