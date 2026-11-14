// The Entity detail report for every legal entity, as one Excel workbook: a contents sheet, a sheet
// per entity and a Parameters sheet. It uses the same rows as the page, with stock layers, and keeps
// the amounts as numbers. Beside each Amount column a Formula column works the amount out again from
// units, values per unit, other lines and the named rates on the Parameters sheet, so a reader can
// see how each line is built and trace it to its inputs. Lines with no formula are the model's inputs.
import { ENTITIES, FIXED_ASSET_CLASSES, FIXED_ASSETS, PAYMENT_TERMS, PRODUCTS, US_BONDS, US_TAX_RULES, entityDetail, reportParameters } from './engine.mjs';
import { balanceDate, buildBalanceRows, buildRows, buildTaxRows, reportLabels } from './entity-view.mjs';
import { columnName, sheetName, xlsxWorkbook } from './xlsx.mjs';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NAVY = '1E2F4F';
const GREY = '5D6B80';
const FORMULA_FILL = 'F1F6FD';
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
  wrap: { wrap: true },
};
// How a row of each kind looks: its label, and its numbers.
const looks = {
  line: { label: {}, number: {} },
  layer: { label: { color: GREY, indent: 2 }, number: { color: GREY } },
  subtotal: { label: { bold: true, color: NAVY, border: 'top' }, number: { bold: true, color: NAVY, border: 'top' } },
  total: { label: { bold: true, color: NAVY, fill: 'F6F8FB', border: 'top' }, number: { bold: true, color: NAVY, fill: 'F6F8FB', border: 'top' } },
};
const SIDES = ['budget', 'actual'];
// Each side has four columns: units, value per unit, amount, and the formula that works the amount out.
const COLUMNS = SIDES.map((name, index) => {
  const at = column => columnName(1 + index * 4 + column);
  return { units: at(0), each: at(1), amount: at(2), formula: at(3) };
});
const WIDTHS = [62, 11, 11, 14, 14, 11, 11, 14, 14];
const FIRST_ROW = 7;

const cell = (value, look = {}) => ({ value, style: Object.keys(look).length ? look : undefined });
const quoted = name => `'${name.replaceAll("'", "''")}'`;

// Names for the duty rates: the importing block, where the goods were made, and the product line.
const BLOCK_NAMES = { EU: 'Europe', US: 'US', CA: 'Canada', APAC: 'Asia' };
const ORIGIN_NAMES = { US: 'US', EU: 'Poland' };
const PRODUCT_NAMES = { A: 'Precision', B: 'Control', C: 'Industrial' };
const dutyName = (block, origin, product) => `Duty_${BLOCK_NAMES[block]}_from_${ORIGIN_NAMES[origin]}_${PRODUCT_NAMES[product]}`;

// The Parameters sheet: every rate a formula uses, each with a workbook name.
function parameterList(config) {
  const rates = reportParameters(config);
  const rules = US_TAX_RULES;
  const list = [
    { section: 'Income tax rates by entity' },
    ...Object.entries(rates.taxRates).map(([id, value]) => ({ name: `Rate_Tax_${id}`, text: `${ENTITIES[id].name} income tax rate`, value })),
    { section: 'US federal and state tax, for tax years beginning after 2025' },
    { name: 'Rate_Federal', text: 'Federal income tax rate', value: rules.federalRate },
    { name: 'Rate_State', text: 'State income tax rate: the US rate above less the federal rate', formula: 'MAX(0,Rate_Tax_US-Rate_Federal)' },
    { name: 'Rate_FDDEI_Deduction', text: 'Section 250 deduction on foreign-derived deduction eligible income (FDDEI)', value: rules.fddeiDeduction },
    { name: 'Rate_NCTI_Deduction', text: 'Section 250 deduction on net CFC tested income (NCTI) and its gross-up', value: rules.nctiDeduction },
    { name: 'Rate_NCTI_Credit', text: 'Share of the foreign taxes on tested income deemed paid', value: rules.nctiCreditShare },
    { name: 'Rate_BEAT', text: 'BEAT rate on modified taxable income', value: rules.beatRate },
    { name: 'BEAT_Threshold', text: 'Base erosion percentage at which BEAT applies', value: rules.beatThreshold },
    { name: 'BEAT_Gross_Receipts', text: 'Annual gross receipts at which BEAT applies, USD thousands', value: rules.beatGrossReceipts, format: 'whole' },
    { section: 'Royalty and services' },
    { name: 'Rate_Royalty', text: 'Royalty from Switzerland to the US, on third-party sales of Switzerland and the limited-risk distributors', value: rates.royaltyRate },
    { name: 'Markup_US_Services', text: 'Markup on the cost of the US headquarters services to Switzerland', value: rates.usServicesMarkup },
    { name: 'Markup_RD_Services', text: 'Markup on the R&D services Germany and Poland provide the United States', value: rates.rdMarkup },
    { name: 'Margin_Belgian_Warehouse', text: 'Margin the Belgian warehouse earns, as a share of its fee', value: rates.belgiumMargin },
    ...Object.entries(rates.indiaShares).map(([id, value]) => ({ name: `India_Share_${id}`, text: `Share of India’s service fee charged to ${id === 'US' ? 'the United States' : ENTITIES[id].name}`, value })),
    { section: 'Fixed assets: useful life in years, depreciated straight line on cost' },
    ...Object.entries(FIXED_ASSETS).flatMap(([id, assets]) => Object.entries(assets).map(([kind, asset]) => ({
      name: `Life_${id}_${kind === 'buildings' ? 'Buildings' : 'Equipment'}`, text: `${ENTITIES[id].name}: ${FIXED_ASSET_CLASSES[kind].toLowerCase()}`, value: asset.life, format: 'whole',
    }))),
    { section: 'Financing and payment terms' },
    { name: 'Rate_Bond_Interest', text: 'Coupon on the US parent’s bonds, held by outside investors', value: US_BONDS.rate },
    { name: 'Days_Third_Party', text: 'Payment terms with customers and suppliers, days', value: PAYMENT_TERMS.thirdParty.days, format: 'whole' },
    { name: 'Days_Group', text: 'Payment terms between group companies, days', value: PAYMENT_TERMS.related.days, format: 'whole' },
    { section: 'Customs duty, on the declared transfer price, by importing block, where the goods were made and product line' },
  ];
  for (const [lane, products] of Object.entries(rates.dutyRates)) {
    const [block, origin] = lane.split('.');
    for (const [product, value] of Object.entries(products)) {
      const into = block === 'US' ? 'the US' : block === 'EU' ? 'Europe (with Switzerland and the UK)' : BLOCK_NAMES[block];
      list.push({ name: dutyName(block, origin, product), text: `Into ${into}, made in ${origin === 'US' ? 'the US' : 'Poland'}: ${PRODUCTS[product].name}`, value });
    }
  }
  return { list, blocks: rates.customsBlocks };
}

function parametersSheet(list) {
  const rows = [
    [cell('Parameters', style.title)],
    [cell('The rates the formulas on the entity sheets use. Each value has a workbook name, such as Rate_Royalty, that the formulas refer to.', style.subtitle)],
    [cell('Change a value here and every formula that uses it is worked out again; the Amount columns keep the model’s figures.', style.subtitle)],
    [],
    [cell('Name', style.headerLeft), cell('What it is', style.headerLeft), cell('Value', style.header)],
  ];
  const names = [];
  for (const entry of list) {
    if (entry.section) {
      rows.push([cell(entry.section, style.heading), cell(undefined, style.heading), cell(undefined, style.heading)]);
      continue;
    }
    const look = { format: entry.format ?? 'percent' };
    names.push({ name: entry.name, ref: `Parameters!$C$${rows.length + 1}` });
    rows.push([cell(entry.name), cell(entry.text, style.wrap), entry.formula ? { formula: entry.formula, style: look } : cell(entry.value, look)]);
  }
  return { sheet: { name: 'Parameters', columns: [36, 96, 12], rows, freeze: { rows: 5 } }, names };
}

// Lays out one entity's sheet: the report rows, with a duty row under each layer that carries duty,
// and the US tax rows below. Cells are filled in later, once every sheet's row numbers are known.
function layout(detail, blocks) {
  const lines = [];
  const add = (kind, row = null, extra = {}) => lines.push({ kind, row, ...extra });
  const duty = side => Boolean(side && !side.absent && side.duty > 0.005 && side.units);
  for (const row of buildRows(detail, true)) {
    add('row', row);
    if (row.type === 'layer' && SIDES.some(name => duty(row[name]))) add('duty', row, { duty });
  }
  // The balance sheet: start of the period in the Units column, end in the Amount column.
  add('blank');
  add('header');
  for (const row of buildBalanceRows(detail)) add('row', row);
  const tax = buildTaxRows(detail);
  if (tax.length) {
    add('blank');
    add('row', { type: 'heading', text: 'US income tax · USD thousands, in the Amount columns' });
    for (const row of tax) add('row', row);
  }
  lines.forEach((line, index) => { line.number = FIRST_ROW + index; });
  const byKey = new Map(lines.filter(line => line.kind === 'row' && line.row.key).map(line => [line.row.key, line]));
  return { id: detail.id, detail, lines, byKey, order: [...byKey.keys()], block: blocks[detail.id], formulas: SIDES.map(() => new Map()) };
}

// Works out the formula for one row on one side, or null where the row is an input or has nothing to show.
function formulaFor(sheet, line, side, sheets) {
  const memo = sheet.formulas[side];
  const key = line.row.key;
  if (memo.has(key)) {
    if (memo.get(key) === undefined) throw new Error(`The formulas for ${key} on ${sheet.id} refer back to themselves.`);
    return memo.get(key);
  }
  const values = line.row[SIDES[side]];
  const period = sheet.detail[SIDES[side]];
  let formula = null;
  if (line.row.calc && values && !values.absent && period && typeof values.amount === 'number' && Number.isFinite(values.amount)) {
    memo.set(key, undefined);
    formula = tidy(line.row.calc(helpers(sheet, side, line, sheets)) || null);
  }
  memo.set(key, formula);
  return formula;
}

// A line that is not on the sheet is zero: its term is dropped, so a formula reads as it would by hand.
function tidy(formula) {
  return formula && formula.replace(/[+-]0(?=[),]|$)/g, '');
}

// The references a formula is written with. `v` is a row's worked-out value: its formula where it has
// one, otherwise its amount. A row that is not on the sheet is zero.
function helpers(sheet, side, line, sheets) {
  const columns = COLUMNS[side];
  const at = (target, key) => target.byKey.get(key);
  const valueRef = (target, found) => ({
    sheet: target, column: formulaFor(target, found, side, sheets) ? columns.formula : columns.amount, number: found.number,
  });
  const text = ref => `${ref.sheet === sheet ? '' : `${quoted(sheetName(ENTITIES[ref.sheet.id].name))}!`}${ref.column}${ref.number}`;
  // Consecutive cells in one column are written as a range.
  const compact = refs => {
    const parts = [];
    for (const ref of refs) {
      const last = parts.at(-1);
      if (last && last.sheet === ref.sheet && last.column === ref.column && last.to + 1 === ref.number) last.to = ref.number;
      else parts.push({ ...ref, to: ref.number });
    }
    return parts.map(part => part.to === part.number ? text(part) : `${text(part)}:${part.column}${part.to}`);
  };
  const keys = (target, list) => list.map(key => at(target, key)).filter(Boolean).map(found => valueRef(target, found));
  return {
    self: line.row.key,
    side: sheet.detail[SIDES[side]],
    has: key => sheet.byKey.has(key),
    keys: prefix => sheet.order.filter(key => key.startsWith(prefix) && !sheet.byKey.get(key).row.group),
    children: parent => sheet.order.filter(key => sheet.byKey.get(key).row.group === parent),
    v: key => at(sheet, key) ? text(valueRef(sheet, at(sheet, key))) : '0',
    a: key => at(sheet, key) ? `${columns.amount}${at(sheet, key).number}` : '0',
    u: key => at(sheet, key) ? `${columns.units}${at(sheet, key).number}` : '0',
    e: key => at(sheet, key) ? `${columns.each}${at(sheet, key).number}` : '0',
    // A balance at the start of the period, in the Units column of a balance sheet line.
    s: key => at(sheet, key) ? `${columns.units}${at(sheet, key).number}` : '0',
    sum: list => {
      const parts = compact(keys(sheet, list));
      return !parts.length ? '0' : parts.length === 1 && !parts[0].includes(':') ? parts[0] : `SUM(${parts.join(',')})`;
    },
    // A single range, or null when the rows are not next to each other in one column.
    range: list => {
      const parts = compact(keys(sheet, list));
      return parts.length === 1 ? parts[0] : null;
    },
    // Another entity's line, or null when that entity is not in the workbook.
    x: (id, key) => {
      const target = sheets.get(id);
      if (!target) return null;
      return at(target, key) ? text(valueRef(target, at(target, key))) : '0';
    },
    sumAcross: (ids, list) => {
      if (ids.some(id => !sheets.has(id))) return null;
      const refs = ids.flatMap(id => keys(sheets.get(id), list));
      return refs.length ? `SUM(${compact(refs).join(',')})` : '0';
    },
  };
}

// Units, value per unit, amount and formula for one side of a row.
function sideCells(line, side, sheet, sheets) {
  const values = line.row[SIDES[side]];
  const kind = line.row.kind;
  const look = (looks[line.row.type] ?? looks.line).number;
  const formulaLook = { ...look, fill: look.fill ?? FORMULA_FILL };
  if (!values || values.absent) return [null, null, null, cell(undefined, formulaLook)];
  const number = format => cell(undefined, { ...look, format });
  const formula = formulaFor(sheet, line, side, sheets);
  const result = formula ? { formula, style: { ...formulaLook, format: kind === 'percent' ? 'percent' : 'whole' } } : cell(undefined, formulaLook);
  if (kind === 'percent') return [number(), number(), cell(values.amount, { ...look, format: 'percent' }), result];
  if (kind === 'times' || kind === 'days') {
    const format = kind === 'times' ? 'cents' : 'whole';
    return [number(), number(), cell(values.amount, { ...look, format }), formula ? { formula, style: { ...formulaLook, format } } : result];
  }
  if (kind === 'balance') {
    const at = value => value === undefined ? number() : cell(value, { ...look, format: 'whole' });
    return [at(values.start), number(), at(values.end), result];
  }
  const units = values.units === undefined ? number() : cell(values.units, { ...look, format: 'whole' });
  const each = values.units && values.amount !== undefined ? cell(values.amount / values.units, { ...look, format: 'cents' }) : number();
  const amount = values.amount === undefined ? number() : cell(values.amount, { ...look, format: 'whole' });
  return [units, each, amount, result];
}

// The duty inside an imported layer is the layer's value before duty times the duty rate.
function dutyCells(line, side, sheet) {
  const layer = line.row[SIDES[side]];
  const look = looks.layer.number;
  if (!line.duty(layer)) return [null, null, null, cell(undefined, { ...look, fill: FORMULA_FILL })];
  const columns = COLUMNS[side];
  // Where the goods were made is recorded when it changes the rate. Otherwise both origins pay the same rate.
  const origin = layer.declared ?? (sheet.block === 'US' ? 'EU' : 'US');
  const formula = `(${columns.amount}${line.number - 1}-${columns.amount}${line.number})*${dutyName(sheet.block, origin, line.row.product)}`;
  return [null, cell(layer.duty / layer.units, { ...look, format: 'cents' }), cell(layer.duty, { ...look, format: 'whole' }),
    { formula, style: { ...look, fill: FORMULA_FILL, format: 'whole' } }];
}

function entitySheet(sheet, sheets) {
  const { detail } = sheet;
  const { budgetLabel, actualLabel, when, explain } = reportLabels(detail);
  const entity = ENTITIES[detail.id];
  const group = text => [cell(text, style.headerGroup), cell(undefined, style.headerGroup), cell(undefined, style.headerGroup), cell(undefined, style.headerGroup)];
  const rows = [
    [cell(`${entity.name} · ${entity.role}`, style.title)],
    [cell(`${when} · Amounts in USD thousands, units in thousands, value per unit in USD · US GAAP`, style.subtitle)],
    [cell(`${explain} Each Formula column works its Amount out again; a blank Formula cell is an input to the model. Rates are on the Parameters sheet.`, style.subtitle)],
    [],
    [cell('Line', style.headerLeft), ...group(budgetLabel), ...group(actualLabel)],
    [cell(undefined, style.headerLeft), ...SIDES.flatMap(() => ['Units, thousands', 'Per unit, USD', 'Amount, USD thousands', 'Formula, USD thousands']
      .map((text, index) => cell(text, index === 3 ? { ...style.header, fill: 'E3ECF8' } : style.header)))],
  ];
  const width = 1 + SIDES.length * 4;
  for (const line of sheet.lines) {
    const { row } = line;
    if (line.kind === 'blank') rows.push([]);
    else if (line.kind === 'header') {
      const dates = name => [detail[name].balance.start, detail[name].balance.end].map(balanceDate);
      const head = (text, index) => cell(text, index === 3 ? { ...style.header, fill: 'E3ECF8' } : style.header);
      rows.push([cell('Balance sheet · USD thousands', style.headerLeft), ...SIDES.flatMap(name => {
        const [start, end] = dates(name);
        return [`Start: ${start}`, '', `End: ${end}`, 'Formula, end'].map(head);
      })]);
    }
    else if (line.kind === 'duty') {
      rows.push([cell('of which customs duty', { ...looks.layer.label, indent: 3 }), ...dutyCells(line, 0, sheet), ...dutyCells(line, 1, sheet)]);
    } else if (row.type === 'heading') rows.push([cell(row.text, style.heading), ...Array.from({ length: width - 1 }, () => cell(undefined, style.heading))]);
    else if (row.type === 'sub') rows.push([cell(row.text, style.sub)]);
    else if (row.type === 'note') rows.push([cell(row.text, style.note)]);
    else {
      const look = looks[row.type] ?? looks.line;
      const label = { ...look.label, indent: look.label.indent ?? (row.indent ? 1 : 0) };
      rows.push([cell(row.label, label), ...sideCells(line, 0, sheet, sheets), ...sideCells(line, 1, sheet, sheets)]);
    }
  }
  const last = rows.length;
  // A formula result $500 or more away from the model's amount turns red.
  const flags = COLUMNS.map(({ amount, formula }) => ({
    range: `${formula}${FIRST_ROW}:${formula}${last}`,
    formula: `AND(ISNUMBER(${formula}${FIRST_ROW}),ISNUMBER(${amount}${FIRST_ROW}),ABS(${formula}${FIRST_ROW}-${amount}${FIRST_ROW})>=0.5)`,
  }));
  return {
    name: entity.name, columns: WIDTHS, rows, flags,
    freeze: { rows: 6, columns: 1 },
    merges: ['A5:A6', `${COLUMNS[0].units}5:${COLUMNS[0].formula}5`, `${COLUMNS[1].units}5:${COLUMNS[1].formula}5`],
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
    [cell('Entity', style.headerLeft), cell('Role', style.headerLeft), cell(`Operating profit · ${budgetLabel}`, style.header), cell(`Operating profit · ${actualLabel}`, style.header),
      cell('Return on assets · budget', style.header), cell('Return on assets · actual', style.header)],
  ];
  const links = [];
  for (const detail of details) {
    const entity = ENTITIES[detail.id];
    links.push({ ref: `A${rows.length + 1}`, sheet: sheetName(entity.name) });
    const roa = side => side.ratios ? cell(side.ratios.returnOnAssets, { format: 'percent' }) : null;
    rows.push([cell(entity.name, style.link), cell(entity.role), cell(detail.budget.operatingProfit, { format: 'whole' }), cell(detail.actual.operatingProfit, { format: 'whole' }),
      roa(detail.budget), roa(detail.actual)]);
  }
  links.push({ ref: `A${rows.length + 1}`, sheet: 'Parameters' });
  rows.push([cell('Parameters', style.link), cell('Tax, royalty, service and duty rates, asset lives, the bond coupon and payment terms')]);
  rows.push([],
    [cell('Each entity sheet lists the same lines as the Entity detail page: net sales by buyer, cost of sales with the FIFO stock layers behind it, operating expenses with depreciation, the result to profit after tax and inventory. Then the balance sheet, with the start of the period in the Units column and the end in the Amount column, and the ratios for the period. The United States sheet ends with the US income tax computation.', style.subtitle)],
    [cell('Beside each Amount column, a Formula column works the amount out again: units times the value per unit, the sum of the lines or layers it is made of, duty as the value before duty times the duty rate, ending stock as beginning stock plus goods received less cost of sales, and fees, royalty and tax from the lines and rates they are set from, on the same sheet or another.', style.subtitle)],
    [cell('A blank Formula cell marks an input: a cost, a fee set on the Transfer prices page, or an adjustment. A formula result that differs from its amount by $500 or more turns red, for example after a value is changed.', style.subtitle)]);
  return { name: 'Contents', columns: [34, 30, 22, 22, 16, 16], rows, freeze: { rows: 6 }, links };
}

// The workbook and its file name, for the period shown on the page.
export function entityWorkbook({ config, year, entities, basis, period, revealed, created = new Date() }) {
  const details = entities.map(id => entityDetail(config, year, id, { basis, period, revealed, layers: 'quarter' }));
  const { list, blocks } = parameterList(config);
  const sheets = new Map(details.map(detail => [detail.id, layout(detail, blocks)]));
  const parameters = parametersSheet(list);
  const exported = created.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const bytes = xlsxWorkbook({
    sheets: [contentsSheet(details, { exported }), ...[...sheets.values()].map(sheet => entitySheet(sheet, sheets)), parameters.sheet],
    names: parameters.names,
    created,
  });
  const fileName = `PlayTP entity detail ${basis === 'year' ? 'full year 2027' : `Q${period + 1} 2027`}.xlsx`;
  return { bytes, fileName };
}
