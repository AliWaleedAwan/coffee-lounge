// Requirement → test traceability check (TEST_PLAN.md §11).
// Fails if any SRS requirement is missing from docs/traceability.csv, if a row has no
// tests, or if a row names a test that TEST_PLAN.md does not define.
// Usage: node scripts/check-traceability.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(root + path, 'utf8');

const plan = read('docs/TEST_PLAN.md');
const srs = read('docs/source/Coffee_Lounge_Requirements_Specification_v2.md');
const rows = parseCsv(read('docs/traceability.csv'));

/** Minimal RFC 4180 parser (quoted fields, doubled quotes); returns objects keyed by header. */
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((f) => f !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// Test IDs defined in the plan: first cell of a table row, plus documented ranges.
const defined = new Set(
  [...plan.matchAll(/^\| (AT-\d+|CT-\d+|PT-\d+|AC-[A-Z]+-\d+|UAT-\d+|SEC-ALL|ARCH-\d+) \|/gm)].map(
    (m) => m[1],
  ),
);
for (const m of plan.matchAll(/^\| (AC-[A-Z]+)-(\d+(?:\/\d+)+) \|/gm)) {
  for (const n of m[2].split('/')) defined.add(`${m[1]}-${n}`);
}
const ranges = [
  [/SITE-N1…N9/, (i) => `SITE-N${i}`, 9],
  [/HW-01…HW-10/, (i) => `HW-${String(i).padStart(2, '0')}`, 10],
  [/HOST-H1…H18/, (i) => `HOST-H${i}`, 18],
  [/DRILL-1…4/, (i) => `DRILL-${i}`, 4],
  [/UX-J1…J8/, (i) => `UX-J${i}`, 8],
];
for (const [pattern, name, count] of ranges) {
  if (pattern.test(plan)) for (let i = 1; i <= count; i += 1) defined.add(name(i));
}

const errors = [];
const referenced = new Set();
for (const row of rows) {
  const tests = row.tests
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tests.length === 0) errors.push(`${row.requirement_id}: no tests`);
  for (const t of tests) {
    referenced.add(t);
    if (!defined.has(t)) errors.push(`${row.requirement_id}: unknown test ${t}`);
  }
}

const srsIds = [
  ...new Set(
    [...srs.matchAll(/^- \*\*((?:MENU|TABLE|ORD|KDS|INV|PAY|FIN|RPT|OPS)-\d{3})/gm)].map(
      (m) => m[1],
    ),
  ),
];
const traced = new Set(rows.map((r) => r.requirement_id));
const missing = srsIds.filter((id) => !traced.has(id));
if (missing.length > 0) errors.push(`SRS requirements missing: ${missing.join(', ')}`);

const orphans = [...defined].filter((t) => /^(AT|CT|PT)-/.test(t) && !referenced.has(t));
console.log(
  `SRS requirements: ${srsIds.length} · rows: ${rows.length} · tests defined: ${defined.size} · referenced: ${referenced.size}`,
);
if (orphans.length > 0)
  console.log(`Tests not linked to any requirement (info): ${orphans.join(', ')}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('TRACEABILITY OK');
