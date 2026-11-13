import { ENTITIES, PRODUCTS, US_TAX_RULES } from './engine.mjs';
import { IN_THOUSANDS, realSize, thousands, unitCount, unitPrice } from './format.mjs';

// Amounts are in thousands of dollars and units in thousands, so a value per unit is in dollars.
const dollars = thousands;
const whole = unitCount;
const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });
const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const quarterSpans = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
const families = Object.keys(PRODUCTS);
const stageNames = { wip: 'work in process', raw: 'raw materials' };
// What each kind of intercompany charge is called on the page of the entity that earns it, and of the one that pays it.
const revenueNames = {
  US_SERVICES: 'Headquarters services to Switzerland',
  RD_SERVICES: 'R&D services to the United States, at cost plus 10%',
  PL_TOLL_FEE: 'Toll fee from Switzerland',
  BE_WAREHOUSE: 'Warehouse fee from Switzerland',
  IN_SERVICES: 'Service fee from the United States and Switzerland',
  SERVICE_TRUE_UP: 'Year-end fee true-up',
};
// Listed in the order the charges are shown.
const chargeNames = {
  BE_WAREHOUSE: 'Belgian warehouse fee',
  US_SERVICES: 'US headquarters services',
  IN_SERVICES: 'India service fee',
  SERVICE_TRUE_UP: 'India year-end fee true-up',
  RD_SERVICES: 'R&D services from Germany and Poland, at cost plus 10%',
};

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const nameOf = id => ENTITIES[id]?.name ?? id;
const money = value => `${value <= -0.5 ? '−' : ''}${dollars.format(Math.abs(value))}`;
const price = value => `${value <= -0.005 ? '−' : ''}${unitPrice.format(Math.abs(value))}`;

// One side of a row: units, a value per unit and an amount. A side with nothing to show yet is null.
function cells(side, kind) {
  if (!side) return '<td>—</td><td>—</td><td>—</td>';
  // A stock layer that one side does not hold is left empty on that side.
  if (side.absent) return '<td></td><td></td><td></td>';
  if (kind === 'percent') return `<td></td><td></td><td>${Number.isFinite(side.amount) ? percent.format(side.amount) : '—'}</td>`;
  const units = side.units === undefined ? '' : whole.format(side.units);
  // A row of units alone, such as units produced, has no value per unit.
  const each = side.units === undefined || side.amount === undefined ? '' : side.units ? price(side.amount / side.units) : '—';
  // An imported layer is carried at its transfer price plus the customs duty paid on it.
  const duty = side.duty > 0.005 && side.units
    ? `<small class="entity-duty">${price((side.amount - side.duty) / side.units)} price + ${price(side.duty / side.units)} duty</small>` : '';
  return `<td>${units}</td><td>${each}${duty}</td><td>${side.amount === undefined ? '' : money(side.amount)}</td>`;
}

// What a stock layer is called: how and when the units came in.
function layerLabel(id, stage, layer, showOrigin) {
  const monthOf = vintage => `${shortMonths[Number(vintage.slice(5)) - 1]} ${vintage.slice(0, 4)}`;
  // A quarter bought at one price is one layer, named for the quarter. Other layers are named for their month.
  const when = layer.quarter ? `${layer.vintage.slice(5)} ${layer.vintage.slice(0, 4)}` : monthOf(layer.vintage);
  const base = layer.source === 'made' ? `Made ${when}`
    // Goods converted in one month can carry materials bought in two, at two prices.
    : layer.source === 'converted' ? `Converted in Poland ${when}${layer.materials ? `, ${monthOf(layer.materials)} materials` : ''}`
    : layer.source === 'materials' ? (stage === 'wip' ? `In conversion, materials bought ${when}` : `Materials bought ${when}`)
    : id === 'US' ? `Bought from Switzerland ${when}`
    : id === 'CH' ? `Bought from the United States ${when}`
    : `Bought ${when}`;
  const origin = showOrigin && layer.declared ? ` · made in ${layer.declared === 'US' ? 'the US' : 'Poland'}` : '';
  return `${base}${origin}${layer.n ? ` · lot ${layer.n + 1}` : ''}`;
}

// Helpers that add rows to `rows`, reading the budget and actual sides.
function rowHelpers(sides, rows) {
  const heading = text => rows.push({ type: 'heading', text });
  const sub = text => rows.push({ type: 'sub', text });
  const note = text => rows.push({ type: 'note', text });
  // `pick` reads one side. A row is left out when it is empty on both sides, unless `keep` is set.
  const line = (label, pick, { type = 'line', kind, keep = false, indent = true } = {}) => {
    const [planned, done] = sides.map(pick);
    const empty = side => !side || (!side.units && Math.abs(side.amount ?? 0) < 0.005);
    if (!keep && empty(planned) && empty(done)) return;
    rows.push({ type, label, kind, indent, budget: planned, actual: done });
  };
  const amount = pick => side => ({ amount: pick(side) });
  return { heading, sub, note, line, amount };
}

function buildRows({ id, basis, budget, actual }, showLayers) {
  const rows = [];
  const sides = [budget, actual];
  const { heading, sub, line, amount } = rowHelpers(sides, rows);
  const sumOf = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  // Where the units were made is named only when this entity holds goods of both origins at different duty.
  const stockLines = side => [...Object.values(side.costOfSales.products), ...Object.values(side.received), ...(side.inventory?.opening ?? []), ...(side.inventory?.closing ?? [])];
  const showOrigin = new Set(sides.flatMap(stockLines).flatMap(entry => entry.layers).map(layer => layer.declared).filter(Boolean)).size > 1;
  // The layers under a stock line, oldest first. `pick` reads one side's line, or null when that side has nothing to show yet.
  const layers = (stage, pick) => {
    if (!showLayers) return;
    const found = new Map(sides.flatMap(side => pick(side)?.layers ?? []).map(layer => [layer.key, layer]));
    // A layer's key sorts it into the order the layers are sold, on both sides.
    for (const key of [...found.keys()].sort()) {
      rows.push({
        type: 'layer', indent: true, label: layerLabel(id, stage, found.get(key), showOrigin),
        ...Object.fromEntries(['budget', 'actual'].map((name, index) => {
          const line = pick(sides[index]);
          return [name, line ? line.layers.find(layer => layer.key === key) ?? { absent: true } : { absent: true }];
        })),
      });
    }
  };

  // Goods sold, buyer by buyer, because each buyer pays its own price.
  const buyers = [...new Map(sides.flatMap(side => side.sales).map(group => [group.buyer, group])).values()];
  const goodsOf = side => side.sales.flatMap(group => Object.values(group.products));
  const service = budget.service ?? actual.service;
  const other = [...new Set(sides.flatMap(side => side.otherRevenue.map(entry => entry.policy)))];
  heading('Net sales');
  for (const { buyer, external } of buyers) {
    sub(external ? 'To third-party customers' : `To ${nameOf(buyer)} (intercompany)`);
    for (const family of families) {
      line(PRODUCTS[family].name, side => side.sales.find(group => group.buyer === buyer)?.products[family] ?? { units: 0, amount: 0 }, { keep: true });
    }
  }
  if (buyers.length) {
    line('Goods net sales', side => ({ units: sumOf(goodsOf(side), entry => entry.units), amount: sumOf(goodsOf(side), entry => entry.amount) }), { type: 'subtotal', keep: true, indent: false });
  }
  if (service) {
    // A service fee is shown as the cost it was set from and the markup on top.
    const fixed = service.kind === 'fixed';
    // Poland and India charge a fixed fee set from budgeted cost. The warehouse charges its actual cost plus a margin on the fee.
    sub(fixed ? (basis === 'year' ? 'Fixed service fee, four quarters' : 'Fixed quarterly service fee') : 'Warehouse fee on actual cost');
    line(fixed ? 'Budgeted service cost' : 'Warehouse cost', amount(side => side.service.budgetCost), { keep: true });
    line(fixed ? 'Markup' : 'Margin', amount(side => side.service.markup), { keep: true });
    line(fixed ? 'Markup as a share of budgeted cost' : 'Margin as a share of the fee',
      amount(side => fixed ? (side.service.budgetCost ? side.service.markup / side.service.budgetCost : NaN) : side.service.fee ? side.service.markup / side.service.fee : NaN), { kind: 'percent', keep: true });
    line('Service fee charged', amount(side => side.service.fee), { type: 'subtotal', keep: true, indent: false });
    line(revenueNames.SERVICE_TRUE_UP, amount(side => side.service.trueUp), { indent: false });
  }
  const feePolicies = new Set(['PL_TOLL_FEE', 'BE_WAREHOUSE', 'IN_SERVICES', 'SERVICE_TRUE_UP']);
  for (const policy of other) {
    if (service && feePolicies.has(policy)) continue;
    const label = policy === 'CH_ROYALTY' ? `Royalty from Switzerland at ${rate.format(budget.royalty?.rate ?? actual.royalty?.rate ?? 0)}` : revenueNames[policy] ?? policy;
    line(label, amount(side => side.otherRevenue.find(entry => entry.policy === policy)?.amount ?? 0), { keep: true, indent: false });
  }
  line('Year-end transfer price adjustments', amount(side => side.adjustmentRevenue), { indent: false });
  line('Total revenue', amount(side => side.revenue), { type: 'total', keep: true, indent: false });

  // Cost of sales: the units that left finished stock, at the value they were carried at.
  if (buyers.length) {
    heading('Cost of sales');
    for (const family of families) {
      line(PRODUCTS[family].name, side => side.costOfSales.products[family], { keep: true });
      layers('finished', side => side.costOfSales.products[family]);
    }
    line('Year-end transfer price adjustments', amount(side => side.costOfSales.adjustments), { indent: false });
    line(id === 'CH' ? 'Poland toll fee booked outside stock, including the year-end true-up' : 'Fees booked to cost of sales', amount(side => side.costOfSales.fees), { indent: false });
    line('Customs duty on year-end adjustments', amount(side => side.costOfSales.other), { indent: false });
    line('Total cost of sales', amount(side => side.costOfSales.total), { type: 'total', keep: true, indent: false });
  }

  heading('Operating expenses');
  if (budget.royalty?.direction === 'paid' || actual.royalty?.direction === 'paid') {
    sub('Royalty to the United States');
    line('Royalty base: third-party sales of Switzerland and the limited-risk distributors', amount(side => side.royalty?.base ?? 0), { keep: true });
    line(`Royalty at ${rate.format((budget.royalty ?? actual.royalty).rate)} of the base`, amount(side => side.royalty?.amount ?? 0), { type: 'subtotal', keep: true });
  }
  // A year-end true-up follows the fee it corrects.
  const chargeOrder = Object.keys(chargeNames);
  const charges = [...new Set(sides.flatMap(side => side.charges.map(entry => entry.policy)))].filter(policy => policy !== 'CH_ROYALTY')
    .sort((left, right) => chargeOrder.indexOf(left) - chargeOrder.indexOf(right));
  for (const policy of charges) {
    line(chargeNames[policy] ?? policy, amount(side => side.charges.find(entry => entry.policy === policy)?.amount ?? 0), { keep: true, indent: false });
  }
  line(service ? 'Service cost incurred' : 'Own operating costs', amount(side => side.ownCosts), { keep: true, indent: false });
  line('Own R&D cost', amount(side => side.ownResearch), { indent: false });
  line('Total operating expenses', amount(side => side.operatingExpenses), { type: 'total', keep: true, indent: false });

  heading('Result');
  line('Operating profit', amount(side => side.operatingProfit), { type: 'total', keep: true, indent: false });
  line('Operating margin on revenue', amount(side => side.revenue ? side.operatingProfit / side.revenue : NaN), { kind: 'percent', keep: true, indent: false });
  if (service?.kind === 'fixed') {
    line('Markup earned on service cost incurred', amount(side => side.service.cost ? (side.service.fee + side.service.trueUp) / side.service.cost - 1 : NaN), { kind: 'percent', keep: true, indent: false });
  }
  if (budget.usTax) {
    line('US income tax, federal and state, worked out below', amount(side => -side.usTax.total), { keep: true, indent: false });
    line('Profit after tax', amount(side => side.operatingProfit - side.usTax.total), { type: 'total', keep: true, indent: false });
  }

  // Stock at the two ends of the period, at the value it is carried at.
  const stockNames = stock => stock ? stock.map(({ stage, product }) => stage + '/' + product) : [];
  const bins = [...new Set(sides.flatMap(side => [...stockNames(side.inventory?.opening), ...stockNames(side.inventory?.closing)]))];
  heading('Inventory');
  if (!bins.length) rows.push({ type: 'note', text: id === 'PL' ? 'Holds no inventory. The goods it converts belong to Switzerland.' : 'Holds no inventory.' });
  const finished = sides.flatMap(side => Object.values(side.received)).some(entry => entry.units);
  for (const [end, title] of [['opening', 'Beginning of the period'], ['received', 'Finished goods received in the period'], ['closing', 'End of the period']]) {
    if (!bins.length) break;
    if (end === 'received') {
      // Units made, converted or bought. Beginning stock plus these less cost of sales is ending stock.
      if (!finished) continue;
      sub(title);
      for (const family of families) {
        line(PRODUCTS[family].name, side => side.received[family], { keep: true });
        layers('finished', side => side.received[family]);
      }
      line('Finished goods received', side => ({ units: sumOf(Object.values(side.received), entry => entry.units), amount: sumOf(Object.values(side.received), entry => entry.amount) }), { type: 'subtotal', keep: true, indent: false });
      continue;
    }
    sub(title);
    const stockOf = side => side.inventory?.[end] ?? null;
    for (const name of bins) {
      const [stage, product] = name.split('/');
      const bin = side => stockOf(side)?.find(row => row.stage === stage && row.product === product);
      line(`${PRODUCTS[product].name}${stage === 'finished' ? '' : `, ${stageNames[stage]}`}`,
        side => stockOf(side) ? bin(side) ?? { units: 0, amount: 0 } : null, { keep: true });
      layers(stage, bin);
    }
    line(end === 'opening' ? 'Beginning inventory' : 'Ending inventory',
      side => stockOf(side) ? { units: sumOf(stockOf(side), row => row.units), amount: sumOf(stockOf(side), row => row.amount) } : null, { type: 'subtotal', keep: true, indent: false });
  }

  if (budget.made ?? actual.made) {
    heading(id === 'PL' ? 'Units converted for Switzerland' : 'Units produced in the US plant');
    // A plant lists only the lines it makes.
    for (const family of families) line(PRODUCTS[family].name, side => ({ units: side.made[family].units }));
  }
  return rows;
}

// The US parent's income tax, step by step: taxable income, FDDEI, NCTI and BEAT.
// It has amounts only, so it gets its own table with one amount column a side: on a phone the
// amounts then sit beside their labels instead of off to the right of the units and prices.
function buildTaxRows({ budget, actual }) {
  if (!budget.usTax) return [];
  const rows = [];
  const sides = [budget, actual];
  const { sub, line, amount, note } = rowHelpers(sides, rows);
  const rules = US_TAX_RULES;
  const tax = pick => amount(side => pick(side.usTax));
  const flat = { indent: false };
  note(`Federal tax at ${rate.format(rules.federalRate)} under the rules for tax years beginning after 2025, plus state tax at ${rate.format(budget.usTax.stateRate)} of operating profit. Worked out on the period’s figures as if they were a tax year. Every foreign subsidiary is treated as a controlled foreign corporation (CFC) wholly owned by the US parent. Taxable income is taken as US GAAP operating profit, with no interest and no credits other than the NCTI credit.`);

  sub('Taxable income and tax');
  line('Operating profit, US GAAP', tax(t => t.operatingProfit), { keep: true });
  line('State income tax, deductible', tax(t => -t.state), { keep: true });
  line('NCTI inclusion', tax(t => t.ncti.amount), { keep: true });
  line('Section 78 gross-up', tax(t => t.ncti.grossUp), { keep: true });
  line(`Section 250 deduction on FDDEI, ${rate.format(rules.fddeiDeduction)}`, tax(t => -t.fddei.deduction), { keep: true });
  line(`Section 250 deduction on NCTI, ${rate.format(rules.nctiDeduction)}`, tax(t => -t.ncti.deduction), { keep: true });
  line('Taxable income', tax(t => t.taxableIncome), { type: 'subtotal', keep: true, ...flat });
  line(`Federal tax at ${rate.format(rules.federalRate)}`, tax(t => t.taxBeforeCredits), { keep: true });
  line('Foreign tax credit on NCTI', tax(t => -t.credit), { keep: true });
  line('Regular federal tax', tax(t => t.regularTax), { type: 'subtotal', keep: true, ...flat });
  line('Base erosion and anti-abuse tax (BEAT)', tax(t => t.beat.amount), { keep: true });
  line('State income tax', tax(t => t.state), { keep: true });
  line('Total US income tax', tax(t => t.total), { type: 'total', keep: true, ...flat });
  line('Effective rate on operating profit', tax(t => t.operatingProfit ? t.total / t.operatingProfit : NaN), { kind: 'percent', keep: true, ...flat });

  sub('FDDEI: foreign-derived deduction eligible income');
  line('Goods sold to Switzerland and Canada, resold to customers abroad', tax(t => t.fddei.goods), { keep: true });
  line('Royalty from Switzerland, for use of the IP abroad', tax(t => t.fddei.royalty), { keep: true });
  line('Headquarters services fee from Switzerland', tax(t => t.fddei.services), { keep: true });
  line('Cost of goods sold on those goods', tax(t => -t.fddei.goodsCogs), { keep: true });
  line('Headquarters services cost, allocated to the fee', tax(t => -t.fddei.servicesCost), { keep: true });
  line('Other operating expenses and state tax, apportioned on gross receipts', tax(t => -t.fddei.apportionedToForeign), { keep: true });
  line('Foreign-derived share of gross receipts', tax(t => t.fddei.receipts ? t.fddei.foreignShare : NaN), { kind: 'percent', keep: true });
  line('R&D expense, not allocated (memo)', tax(t => t.fddei.research), { keep: true });
  line('FDDEI', tax(t => t.fddei.income), { type: 'subtotal', keep: true, ...flat });
  line('Deduction eligible income from all US sales (memo)', tax(t => t.fddei.dei), { keep: true });
  line('Cut back by the taxable income limit', tax(t => t.fddei.allowed - t.fddei.base));
  line(`Section 250 deduction at ${rate.format(rules.fddeiDeduction)}`, tax(t => t.fddei.deduction), { type: 'subtotal', keep: true, ...flat });

  sub('NCTI: net CFC tested income, each CFC’s profit less its foreign income tax');
  for (const id of budget.usTax.ncti.cfcs.map(cfc => cfc.id)) {
    line(nameOf(id), tax(t => t.ncti.cfcs.find(cfc => cfc.id === id).tested), { keep: true });
  }
  line('Tested losses', tax(t => t.ncti.testedLoss));
  line('NCTI, with no deduction for tangible assets', tax(t => t.ncti.amount), { type: 'subtotal', keep: true, ...flat });
  line('Foreign income taxes on tested income', tax(t => t.ncti.testedTaxes), { keep: true });
  line('Section 78 gross-up of those taxes', tax(t => t.ncti.grossUp), { keep: true });
  line(`Section 250 deduction at ${rate.format(rules.nctiDeduction)}`, tax(t => -t.ncti.deduction), { keep: true });
  line(`US tax on NCTI at ${rate.format(rules.federalRate)}`, tax(t => t.ncti.taxBeforeCredit), { keep: true });
  line(`Deemed-paid credit, ${rate.format(rules.nctiCreditShare)} of the foreign taxes`, tax(t => t.ncti.deemedPaid), { keep: true });
  line('Credit allowed, up to the US tax on NCTI', tax(t => t.ncti.credit), { keep: true });
  line('Excess credit, lost with no carryover', tax(t => t.ncti.excessCredit), { keep: true });
  line('Residual US tax on NCTI', tax(t => t.ncti.residual), { type: 'subtotal', keep: true, ...flat });

  sub('BEAT: base erosion and anti-abuse tax');
  line('R&D services from Germany and Poland, in full', tax(t => t.beat.research), { keep: true });
  line('India service fee', tax(t => t.beat.indiaFee), { keep: true });
  line('Less its cost, excepted under the services cost method', tax(t => -t.beat.indiaCost), { keep: true });
  line('Base erosion tax benefits', tax(t => t.beat.benefits), { type: 'subtotal', keep: true, ...flat });
  line('Deductions, excluding cost of goods sold, section 250 and the excepted cost', tax(t => t.beat.deductions), { keep: true });
  line(`Base erosion percentage, ${rate.format(rules.beatThreshold)} threshold`, tax(t => t.beat.deductions ? t.beat.percentage : NaN), { kind: 'percent', keep: true });
  line('Modified taxable income: taxable income plus base erosion tax benefits', tax(t => t.beat.modifiedTaxableIncome), { keep: true });
  line(`Minimum tax at ${rate.format(rules.beatRate)}`, tax(t => t.beat.minimumTax), { keep: true });
  line('Less regular federal tax after credits', tax(t => -t.regularTax), { keep: true });
  line('BEAT', tax(t => t.beat.amount), { type: 'subtotal', keep: true, ...flat });
  const reasons = new Set(sides.filter(side => side.usTax.beat.deductions && !side.usTax.beat.applies).map(side => !side.usTax.beat.grossReceiptsMet
    ? `the US parent’s gross receipts, ${realSize.format(side.usTax.beat.grossReceipts)} a year, are below the ${realSize.format(rules.beatGrossReceipts)} test`
    : `the base erosion percentage is below ${rate.format(rules.beatThreshold)}`));
  note(reasons.size
    ? `BEAT does not apply where ${[...reasons].join(', and where ')}.`
    : `BEAT applies: the US parent’s gross receipts, ${realSize.format(budget.usTax.beat.grossReceipts)} a year in the budget, are above the ${realSize.format(rules.beatGrossReceipts)} test, and the base erosion percentage is above ${rate.format(rules.beatThreshold)}. The test averages three prior years; the model takes this year’s receipts. Goods bought from Switzerland enter cost of goods sold and are not base erosion payments.`);
  return rows;
}

function rowHtml(row, span = 7) {
  // The text of a full-width row stays in view when a narrow screen scrolls the table sideways.
  if (row.type === 'heading') return `<tr class="entity-heading"><th scope="colgroup" colspan="${span}"><span class="entity-stick">${html(row.text)}</span></th></tr>`;
  if (row.type === 'sub') return `<tr class="entity-sub"><th scope="colgroup" colspan="${span}"><span class="entity-stick">${html(row.text)}</span></th></tr>`;
  if (row.type === 'note') return `<tr class="entity-note"><td colspan="${span}"><span class="entity-stick">${html(row.text)}</span></td></tr>`;
  const label = `<th scope="row" class="${row.indent ? 'entity-indent' : ''}">${html(row.label)}</th>`;
  if (span === 3) return `<tr class="entity-${row.type}">${label}${amountCell(row.budget, row.kind)}${amountCell(row.actual, row.kind)}</tr>`;
  return `<tr class="entity-${row.type}">
    ${label}${cells(row.budget, row.kind)}${cells(row.actual, row.kind)}
  </tr>`;
}

// One amount for one side, for a table with no units or prices.
function amountCell(side, kind) {
  if (!side) return '<td>—</td>';
  if (kind === 'percent') return `<td>${Number.isFinite(side.amount) ? percent.format(side.amount) : '—'}</td>`;
  return `<td>${money(side.amount)}</td>`;
}

/**
 * The entity detail report: one legal entity, by quarter or by year, budget beside actual.
 * `entities` lists the ids the reader can choose from, and `calendar` is the quarter selector
 * shown in the quarterly view. `layers` breaks cost of sales and stock out by when the
 * units came in. `detail.revealed` counts months, three to a quarter.
 */
export function renderEntityDetail({ detail, entities, calendar = '', layers = true }) {
  const { id, basis, period, revealed } = detail;
  const quarter = `Q${period + 1}`;
  const closed = Math.floor(revealed / 3);
  const budgetLabel = basis === 'year' ? 'Budget · full year 2027' : `Budget · ${quarter}`;
  const actualLabel = basis === 'year'
    ? closed ? `Actual · year to date through Q${closed}` : 'Actual · no quarters revealed yet'
    : period < closed ? `Actual · ${quarter}` : `Actual · ${quarter} not revealed yet`;
  const when = basis === 'year' ? 'Full year 2027' : `${quarter} 2027 (${quarterSpans[period]})`;
  const taxRows = buildTaxRows(detail);
  const explain = basis === 'year'
    ? 'The budget column is the full year. The actual column adds up the quarters revealed so far.'
    : 'An actual quarter shows zero until it is revealed.';
  return `
    <section class="panel entity-controls" aria-label="Choose what to show">
      <label class="field">Legal entity
        <select data-detail-entity>${entities.map(entity => `<option value="${html(entity)}" ${entity === id ? 'selected' : ''}>${html(nameOf(entity))} · ${html(ENTITIES[entity].role)}</option>`).join('')}</select>
      </label>
      <div class="entity-basis">
        <span id="detail-basis-label">Amounts</span>
        <div class="segmented" role="group" aria-labelledby="detail-basis-label">
          <button type="button" data-detail-basis="quarter" aria-pressed="${basis === 'quarter'}">Quarterly</button>
          <button type="button" data-detail-basis="year" aria-pressed="${basis === 'year'}">Annual</button>
        </div>
      </div>
      <div class="entity-basis">
        <span id="detail-layers-label">Stock layers</span>
        <div class="segmented" role="group" aria-labelledby="detail-layers-label">
          <button type="button" data-detail-layers="show" aria-pressed="${layers}">Show</button>
          <button type="button" data-detail-layers="hide" aria-pressed="${!layers}">Hide</button>
        </div>
      </div>
    </section>
    ${basis === 'quarter' ? calendar : ''}
    <section class="panel entity-report" aria-labelledby="detail-heading">
      <div class="panel-header"><div><h2 id="detail-heading">${html(nameOf(id))} · ${html(ENTITIES[id].role)}</h2>
        <p class="subtitle">${when} · ${IN_THOUSANDS}, units in thousands · US GAAP · ${explain}</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-labelledby="detail-heading"><table class="entity-table">
        <colgroup span="1"></colgroup><colgroup span="3"></colgroup><colgroup span="3"></colgroup>
        <thead>
          <tr><th scope="col" rowspan="2">Line</th><th scope="colgroup" colspan="3">${html(budgetLabel)}</th><th scope="colgroup" colspan="3" class="entity-actual">${html(actualLabel)}</th></tr>
          <tr><th scope="col">Units, thousands</th><th scope="col">Per unit, USD</th><th scope="col">Amount, ${IN_THOUSANDS}</th><th scope="col" class="entity-actual">Units, thousands</th><th scope="col">Per unit, USD</th><th scope="col">Amount, ${IN_THOUSANDS}</th></tr>
        </thead>
        <tbody>${buildRows(detail, layers).map(rowHtml).join('')}</tbody>
      </table></div>
      <p class="field-note panel-note">Units are in thousands and amounts in ${IN_THOUSANDS}, so the value per unit is in dollars. Each goods line is units times the value per unit. Net sales use the net sales price. Cost of sales and inventory use the value the units are carried at in stock, first in, first out: the oldest layer is sold first. ${layers
        ? 'A layer is the units that came in at one value. For a distributor that is a quarter’s purchases at that quarter’s transfer price plus any customs duty. The plants’ cost moves every month, so their layers are by month. A product line’s value per unit is the average of its layers.'
        : 'Turn on stock layers to see the purchases and prices behind each average.'} To trace a transfer price change, find the new price under Finished goods received in the quarter it takes effect, then follow that layer into cost of sales as the older layers are sold. The lines add up to the entity’s revenue, cost of sales and operating expenses on the Dashboard.</p>
    </section>${taxRows.length ? `
    <section class="panel entity-report" aria-labelledby="tax-heading">
      <div class="panel-header"><div><h2 id="tax-heading">US income tax</h2>
        <p class="subtitle">${when} · ${IN_THOUSANDS} · taxable income, FDDEI, NCTI and BEAT</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-labelledby="tax-heading"><table class="entity-table entity-tax-table">
        <thead><tr><th scope="col">Line</th><th scope="col">${html(budgetLabel)}</th><th scope="col" class="entity-actual">${html(actualLabel)}</th></tr></thead>
        <tbody>${taxRows.map(row => rowHtml(row, 3)).join('')}</tbody>
      </table></div>
    </section>` : ''}`;
}
