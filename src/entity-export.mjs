// The Entity detail report for every legal entity, as one Excel workbook: a contents sheet and a sheet per entity.
// It uses the same rows as the page, with stock layers, and keeps the amounts as numbers so they can be added up and traced.
import { ENTITIES, entityDetail } from './engine.mjs';
import { buildRows, buildTaxRows, reportLabels } from './entity-view.mjs';
import { sheetName, xlsxWorkbook } from './xlsx.mjs';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NAVY = '1E2F4F';
const GREY = '5D6B80';
const style = {
  title: { bold: true, size: 14, color: NAVY },
  subtitle: { color: GREY },
  header: { bold: true, fill: 'F6F8FB', border: 'bottom', wrap: true, align: 'right' },
  headerLeft: { bold: true, fill: 'F6F8FB', border: 'bottom', wrap: true },
  headerGroup: { bold: true, fill: 'F6F8FB', align: 'center' },
  heading: { bold: true, color: NAVY, fill: 'EEF3F9' },
  sub: { bold: true, color: GREY },
  note: { italic: true, color: GREY, wrap: true },
  link: { underline: true, color: '1F5FA8' },
};
// How a row of each kind looks: its label, and its numbers.
const looks = {
  line: { label: {}, number: {} },
  layer: { label: { color: GREY, indent: 2 }, number: { color: GREY } },
  subtotal: { label: { bold: true, color: NAVY, border: 'top' }, number: { bold: true, color: NAVY, border: 'top' } },
  total: { label: { bold: true, color: NAVY, fill: 'F6F8FB', border: 'top' }, number: { bold: true, color: NAVY, fill: 'F6F8FB', border: 'top' } },
};
const WIDTHS = [64, 13, 13, 15, 13, 13, 15];
const SIDE_COLUMNS = 3;

const cell = (value, look = {}) => ({ value, style: Object.keys(look).length ? look : undefined });

// Units, value per unit and amount for one side of a row. A side with nothing to show is left empty.
function sideCells(side, kind, look) {
  if (!side || side.absent) return [null, null, null];
  const number = format => cell(undefined, { ...look, format });
  if (kind === 'percent') return [number(), number(), cell(side.amount, { ...look, format: 'percent' })];
  const units = side.units === undefined ? number() : cell(side.units, { ...look, format: 'whole' });
  const each = side.units && side.amount !== undefined ? cell(side.amount / side.units, { ...look, format: 'cents' }) : number();
  const amount = side.amount === undefined ? number() : cell(side.amount, { ...look, format: 'whole' });
  return [units, each, amount];
}

// One report row as one or more sheet rows. A layer carried with customs duty gets a row for the duty in it.
function sheetRows(row) {
  const width = 1 + 2 * SIDE_COLUMNS;
  const across = (first, look) => [cell(first, look), ...Array.from({ length: width - 1 }, () => cell(undefined, look))];
  if (row.type === 'heading') return [across(row.text, style.heading)];
  if (row.type === 'sub') return [[cell(row.text, style.sub)]];
  if (row.type === 'note') return [[cell(row.text, style.note)]];
  const look = looks[row.type] ?? looks.line;
  const label = { ...look.label, indent: look.label.indent ?? (row.indent ? 1 : 0) };
  const rows = [[cell(row.label, label), ...sideCells(row.budget, row.kind, look.number), ...sideCells(row.actual, row.kind, look.number)]];
  const duty = side => side && !side.absent && side.duty > 0.005 && side.units ? side : null;
  if (duty(row.budget) || duty(row.actual)) {
    const dutyCells = side => duty(side)
      ? [null, cell(side.duty / side.units, { ...looks.layer.number, format: 'cents' }), cell(side.duty, { ...looks.layer.number, format: 'whole' })]
      : [null, null, null];
    rows.push([cell('of which customs duty', { ...looks.layer.label, indent: label.indent + 1 }), ...dutyCells(row.budget), ...dutyCells(row.actual)]);
  }
  return rows;
}

function entitySheet(detail) {
  const { budgetLabel, actualLabel, when, explain } = reportLabels(detail);
  const entity = ENTITIES[detail.id];
  const rows = [
    [cell(`${entity.name} · ${entity.role}`, style.title)],
    [cell(`${when} · Amounts in USD thousands, units in thousands, value per unit in USD · US GAAP`, style.subtitle)],
    [cell(explain, style.subtitle)],
    [],
    [cell('Line', style.headerLeft), cell(budgetLabel, style.headerGroup), cell(undefined, style.headerGroup), cell(undefined, style.headerGroup),
      cell(actualLabel, style.headerGroup), cell(undefined, style.headerGroup), cell(undefined, style.headerGroup)],
    [cell(undefined, style.headerLeft), ...[0, 1].flatMap(() => ['Units, thousands', 'Per unit, USD', 'Amount, USD thousands'].map(text => cell(text, style.header)))],
  ];
  for (const row of buildRows(detail, true)) rows.push(...sheetRows(row));
  const tax = buildTaxRows(detail);
  if (tax.length) {
    rows.push([], ...sheetRows({ type: 'heading', text: 'US income tax · USD thousands, in the Amount columns' }));
    for (const row of tax) rows.push(...sheetRows(row));
  }
  return {
    name: entity.name,
    columns: WIDTHS,
    rows,
    freeze: { rows: 6, columns: 1 },
    merges: ['A5:A6', 'B5:D5', 'E5:G5'],
  };
}

function contentsSheet(details, { exported }) {
  const [first] = details;
  const { when, budgetLabel, actualLabel } = reportLabels(first);
  const closed = Math.floor(first.revealed / 3);
  const rows = [
    [cell('PlayTP · Entity detail', style.title)],
    [cell(`${when} · every legal entity, with stock layers`, style.subtitle)],
    [cell(`Exported ${exported}. Amounts are in USD thousands and units in thousands, so a value per unit is in US dollars. Amounts are kept unrounded; the cells show whole thousands.`, style.subtitle)],
    [cell(closed ? `Actual quarters revealed: Q1${closed > 1 ? `–Q${closed}` : ''} 2027.` : 'No actual quarters revealed yet: the actual columns show zero.', style.subtitle)],
    [],
    [cell('Entity', style.headerLeft), cell('Role', style.headerLeft), cell(`Operating profit · ${budgetLabel}`, style.header), cell(`Operating profit · ${actualLabel}`, style.header)],
  ];
  const links = [];
  for (const detail of details) {
    const entity = ENTITIES[detail.id];
    links.push({ ref: `A${rows.length + 1}`, sheet: sheetName(entity.name) });
    rows.push([cell(entity.name, style.link), cell(entity.role), cell(detail.budget.operatingProfit, { format: 'whole' }), cell(detail.actual.operatingProfit, { format: 'whole' })]);
  }
  rows.push([], [cell('Each entity sheet lists the same lines as the Entity detail page: net sales by buyer, cost of sales with the FIFO stock layers behind it, operating expenses, the result and inventory. The United States sheet ends with the US income tax computation.', style.subtitle)]);
  return { name: 'Contents', columns: [34, 30, 22, 22], rows, freeze: { rows: 6 }, links };
}

// The workbook and its file name, for the period shown on the page.
export function entityWorkbook({ config, year, entities, basis, period, revealed, created = new Date() }) {
  const details = entities.map(id => entityDetail(config, year, id, { basis, period, revealed, layers: 'quarter' }));
  const exported = created.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const bytes = xlsxWorkbook({ sheets: [contentsSheet(details, { exported }), ...details.map(entitySheet)], created });
  const fileName = `PlayTP entity detail ${basis === 'year' ? 'full year 2027' : `Q${period + 1} 2027`}.xlsx`;
  return { bytes, fileName };
}
