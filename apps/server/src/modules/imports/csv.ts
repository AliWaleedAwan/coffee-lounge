/**
 * CSV as Excel and Google Sheets save it ("CSV UTF-8", docs/templates/README.md): comma
 * separated, fields optionally in double quotes with "" for a quote, line breaks inside
 * quotes allowed, CRLF or LF, an optional byte-order mark. Each record keeps the line it
 * starts on, so errors can name the row the clerk sees in the spreadsheet.
 */
export interface CsvRecord {
  /** 1-based line of the file where the record starts (the header is line 1). */
  line: number;
  values: string[];
}

export class CsvError extends Error {
  override name = 'CsvError';
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

export function parseCsv(text: string): CsvRecord[] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endField = () => {
    values.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ line: start, values });
    values = [];
  };
  while (i < input.length) {
    const c = input[i] ?? '';
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field.trim() !== '') throw new CsvError(line, 'A quote in the middle of a value');
      field = '';
      quoted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new CsvError(start, 'A quoted value is not closed');
  if (field !== '' || values.length > 0) endRecord();
  return records
    .map((r) => ({ line: r.line, values: r.values.map((v) => v.trim()) }))
    .filter((r) => r.values.some((v) => v !== ''));
}
