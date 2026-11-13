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
const EXCEL_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2v8m0 0L5 7m3 3 3-3M3 12v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

// Formulas for the Excel export. Each takes `f`, which turns a row's key into a cell reference
// (see entity-export.mjs), and returns the formula without its equals sign, or null for none.
const unitsTimesValue = f => `${f.u(f.self)}*${f.e(f.self)}`;
const sumOfLayers = f => f.children(f.self).length ? f.sum(f.children(f.self)) : null;
// Revenue lines that follow from a line elsewhere: the royalty from the Swiss royalty base, the
// headquarters fee from its cost, and R&D services from the R&D cost they recharge.
const otherRevenueCalc = {
  CH_ROYALTY: f => f.x('CH', 'royalty/base') && `${f.x('CH', 'royalty/base')}*Rate_Royalty`,
  US_SERVICES: f => `-${f.v('tax/fddei/servicesCost')}*(1+Markup_US_Services)`,
  RD_SERVICES: f => `${f.v('ownResearch')}*(1+Markup_RD_Services)`,
};
// Charges are the other side's revenue: India's fee is split between its two customers.
const chargeCalc = id => ({
  BE_WAREHOUSE: f => f.x('BE', 'service/fee'),
  US_SERVICES: f => f.x('US', 'other/US_SERVICES'),
  IN_SERVICES: f => f.x('IN', 'service/fee') && `${f.x('IN', 'service/fee')}*India_Share_${id}`,
  SERVICE_TRUE_UP: f => f.x('IN', 'service/trueUp') && `${f.x('IN', 'service/trueUp')}*India_Share_${id}`,
  RD_SERVICES: f => f.x('DE', 'ownResearch') && f.x('PL', 'ownResearch') && `(${f.x('DE', 'ownResearch')}+${f.x('PL', 'ownResearch')})*(1+Markup_RD_Services)`,
});

// Helpers that add rows to `rows`, reading the budget and actual sides.
function rowHelpers(sides, rows) {
  const heading = text => rows.push({ type: 'heading', text });
  const sub = text => rows.push({ type: 'sub', text });
  const note = text => rows.push({ type: 'note', text });
  // `pick` reads one side. A row is left out when it is empty on both sides, unless `keep` is set.
  // `key` names the row and `calc` says how its amount is worked out, for the formulas in the Excel export.
  const line = (label, pick, { type = 'line', kind, keep = false, indent = true, key, calc } = {}) => {
    const [planned, done] = sides.map(pick);
    const empty = side => !side || (!side.units && Math.abs(side.amount ?? 0) < 0.005);
    if (!keep && empty(planned) && empty(done)) return;
    rows.push({ type, label, kind, indent, key, calc, budget: planned, actual: done });
  };
  const amount = pick => side => ({ amount: pick(side) });
  return { heading, sub, note, line, amount };
}

export function buildRows({ id, basis, budget, actual }, showLayers) {
  const rows = [];
  const sides = [budget, actual];
  const { heading, sub, line, amount } = rowHelpers(sides, rows);
  const sumOf = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  // Where the units were made is named only when this entity holds goods of both origins at different duty.
  const stockLines = side => [...Object.values(side.costOfSales.products), ...Object.values(side.received), ...(side.inventory?.opening ?? []), ...(side.inventory?.closing ?? [])];
  const showOrigin = new Set(sides.flatMap(stockLines).flatMap(entry => entry.layers).map(layer => layer.declared).filter(Boolean)).size > 1;
  // The layers under a stock line, oldest first. `pick` reads one side's line, or null when that side has nothing to show yet.
  const layers = (stage, pick, parent, product) => {
    if (!showLayers) return;
    const found = new Map(sides.flatMap(side => pick(side)?.layers ?? []).map(layer => [layer.key, layer]));
    // A layer's key sorts it into the order the layers are sold, on both sides.
    for (const key of [...found.keys()].sort()) {
      rows.push({
        type: 'layer', indent: true, label: layerLabel(id, stage, found.get(key), showOrigin),
        key: `${parent}#${key}`, group: parent, product, calc: unitsTimesValue,
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
      line(PRODUCTS[family].name, side => side.sales.find(group => group.buyer === buyer)?.products[family] ?? { units: 0, amount: 0 },
        { keep: true, key: `sales/${buyer}/${family}`, calc: unitsTimesValue });
    }
  }
  if (buyers.length) {
    line('Goods net sales', side => ({ units: sumOf(goodsOf(side), entry => entry.units), amount: sumOf(goodsOf(side), entry => entry.amount) }),
      { type: 'subtotal', keep: true, indent: false, key: 'goods', calc: f => f.sum(f.keys('sales/')) });
  }
  if (service) {
    // A service fee is shown as the cost it was set from and the markup on top.
    const fixed = service.kind === 'fixed';
    // Poland and India charge a fixed fee set from budgeted cost. The warehouse charges its actual cost plus a margin on the fee.
    sub(fixed ? (basis === 'year' ? 'Fixed service fee, four quarters' : 'Fixed quarterly service fee') : 'Warehouse fee on actual cost');
    // A fixed fee is set on the Transfer prices page, so its markup is the fee less the budgeted cost.
    // The warehouse fee grosses its own operating cost up to leave its margin on the fee.
    line(fixed ? 'Budgeted service cost' : 'Warehouse cost', amount(side => side.service.budgetCost),
      { keep: true, key: 'service/cost', calc: fixed ? null : f => f.v('ownCosts') });
    line(fixed ? 'Markup' : 'Margin', amount(side => side.service.markup), {
      keep: true, key: 'service/markup',
      calc: fixed ? f => `${f.a('service/fee')}-${f.a('service/cost')}` : f => `${f.v('service/cost')}/(1-Margin_Belgian_Warehouse)-${f.v('service/cost')}`,
    });
    line(fixed ? 'Markup as a share of budgeted cost' : 'Margin as a share of the fee',
      amount(side => fixed ? (side.service.budgetCost ? side.service.markup / side.service.budgetCost : NaN) : side.service.fee ? side.service.markup / side.service.fee : NaN),
      { kind: 'percent', keep: true, key: 'service/share', calc: f => `${f.v('service/markup')}/${f.v(fixed ? 'service/cost' : 'service/fee')}` });
    line('Service fee charged', amount(side => side.service.fee),
      { type: 'subtotal', keep: true, indent: false, key: 'service/fee', calc: f => `${f.v('service/cost')}+${f.v('service/markup')}` });
    line(revenueNames.SERVICE_TRUE_UP, amount(side => side.service.trueUp), { indent: false, key: 'service/trueUp' });
  }
  const feePolicies = new Set(['PL_TOLL_FEE', 'BE_WAREHOUSE', 'IN_SERVICES', 'SERVICE_TRUE_UP']);
  for (const policy of other) {
    if (service && feePolicies.has(policy)) continue;
    const label = policy === 'CH_ROYALTY' ? `Royalty from Switzerland at ${rate.format(budget.royalty?.rate ?? actual.royalty?.rate ?? 0)}` : revenueNames[policy] ?? policy;
    line(label, amount(side => side.otherRevenue.find(entry => entry.policy === policy)?.amount ?? 0),
      { keep: true, indent: false, key: `other/${policy}`, calc: otherRevenueCalc[policy] });
  }
  line('Year-end transfer price adjustments', amount(side => side.adjustmentRevenue), { indent: false, key: 'adjustments' });
  line('Total revenue', amount(side => side.revenue), {
    type: 'total', keep: true, indent: false, key: 'revenue',
    calc: f => f.sum(['goods', 'service/fee', 'service/trueUp', ...f.keys('other/'), 'adjustments']),
  });

  // Cost of sales: the units that left finished stock, at the value they were carried at.
  if (buyers.length) {
    heading('Cost of sales');
    for (const family of families) {
      // A product line's cost of sales is the stock layers sold, oldest first.
      line(PRODUCTS[family].name, side => side.costOfSales.products[family], { keep: true, key: `cogs/${family}`, calc: sumOfLayers });
      layers('finished', side => side.costOfSales.products[family], `cogs/${family}`, family);
    }
    line('Year-end transfer price adjustments', amount(side => side.costOfSales.adjustments), { indent: false, key: 'cogs/adjustments' });
    line(id === 'CH' ? 'Poland toll fee booked outside stock, including the year-end true-up' : 'Fees booked to cost of sales', amount(side => side.costOfSales.fees), { indent: false, key: 'cogs/fees' });
    line('Customs duty on year-end adjustments', amount(side => side.costOfSales.other), { indent: false, key: 'cogs/other' });
    line('Total cost of sales', amount(side => side.costOfSales.total), {
      type: 'total', keep: true, indent: false, key: 'cogs',
      calc: f => f.sum([...families.map(family => `cogs/${family}`), 'cogs/adjustments', 'cogs/fees', 'cogs/other']),
    });
  }

  heading('Operating expenses');
  if (budget.royalty?.direction === 'paid' || actual.royalty?.direction === 'paid') {
    sub('Royalty to the United States');
    line('Royalty base: third-party sales of Switzerland and the limited-risk distributors', amount(side => side.royalty?.base ?? 0), {
      keep: true, key: 'royalty/base',
      calc: f => f.sumAcross(['CH', 'DE', 'FR', 'UK'], families.map(family => `sales/customers/${family}`)),
    });
    line(`Royalty at ${rate.format((budget.royalty ?? actual.royalty).rate)} of the base`, amount(side => side.royalty?.amount ?? 0),
      { type: 'subtotal', keep: true, key: 'royalty', calc: f => `${f.v('royalty/base')}*Rate_Royalty` });
  }
  // A year-end true-up follows the fee it corrects.
  const chargeOrder = Object.keys(chargeNames);
  const charges = [...new Set(sides.flatMap(side => side.charges.map(entry => entry.policy)))].filter(policy => policy !== 'CH_ROYALTY')
    .sort((left, right) => chargeOrder.indexOf(left) - chargeOrder.indexOf(right));
  for (const policy of charges) {
    line(chargeNames[policy] ?? policy, amount(side => side.charges.find(entry => entry.policy === policy)?.amount ?? 0),
      { keep: true, indent: false, key: `charge/${policy}`, calc: chargeCalc(id)[policy] });
  }
  line(service ? 'Service cost incurred' : 'Own operating costs', amount(side => side.ownCosts), { keep: true, indent: false, key: 'ownCosts' });
  line('Own R&D cost', amount(side => side.ownResearch), { indent: false, key: 'ownResearch' });
  line('Total operating expenses', amount(side => side.operatingExpenses), {
    type: 'total', keep: true, indent: false, key: 'opex',
    calc: f => f.sum(['royalty', ...f.keys('charge/'), 'ownCosts', 'ownResearch']),
  });

  heading('Result');
  line('Operating profit', amount(side => side.operatingProfit), {
    type: 'total', keep: true, indent: false, key: 'op',
    calc: f => `${f.v('revenue')}${f.has('cogs') ? `-${f.v('cogs')}` : ''}-${f.v('opex')}`,
  });
  line('Operating margin on revenue', amount(side => side.revenue ? side.operatingProfit / side.revenue : NaN),
    { kind: 'percent', keep: true, indent: false, key: 'margin', calc: f => `${f.v('op')}/${f.v('revenue')}` });
  if (service?.kind === 'fixed') {
    line('Markup earned on service cost incurred', amount(side => side.service.cost ? (side.service.fee + side.service.trueUp) / side.service.cost - 1 : NaN),
      { kind: 'percent', keep: true, indent: false, key: 'markupEarned', calc: f => `(${f.v('service/fee')}+${f.v('service/trueUp')})/${f.v('ownCosts')}-1` });
  }
  if (budget.usTax) {
    line('US income tax, federal and state, worked out below', amount(side => -side.usTax.total),
      { keep: true, indent: false, key: 'usTax', calc: f => `-${f.v('tax/total')}` });
    line('Profit after tax', amount(side => side.operatingProfit - side.usTax.total),
      { type: 'total', keep: true, indent: false, key: 'afterTax', calc: f => `${f.v('op')}+${f.v('usTax')}` });
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
        line(PRODUCTS[family].name, side => side.received[family], { keep: true, key: `received/${family}`, calc: sumOfLayers });
        layers('finished', side => side.received[family], `received/${family}`, family);
      }
      line('Finished goods received', side => ({ units: sumOf(Object.values(side.received), entry => entry.units), amount: sumOf(Object.values(side.received), entry => entry.amount) }),
        { type: 'subtotal', keep: true, indent: false, key: 'received', calc: f => f.sum(families.map(family => `received/${family}`)) });
      continue;
    }
    sub(title);
    const stockOf = side => side.inventory?.[end] ?? null;
    for (const name of bins) {
      const [stage, product] = name.split('/');
      const bin = side => stockOf(side)?.find(row => row.stage === stage && row.product === product);
      // Finished stock at the end is the stock at the start, plus what came in, less what was sold.
      // Other stock, and stock at the start, is the layers it holds.
      const key = `stock/${end}/${stage}/${product}`;
      const rollForward = f => `${f.v(`stock/opening/finished/${product}`)}+${f.v(`received/${product}`)}-${f.v(`cogs/${product}`)}`;
      line(`${PRODUCTS[product].name}${stage === 'finished' ? '' : `, ${stageNames[stage]}`}`,
        side => stockOf(side) ? bin(side) ?? { units: 0, amount: 0 } : null,
        { keep: true, key, calc: end === 'closing' && stage === 'finished' ? rollForward : sumOfLayers });
      layers(stage, bin, key, product);
    }
    line(end === 'opening' ? 'Beginning inventory' : 'Ending inventory',
      side => stockOf(side) ? { units: sumOf(stockOf(side), row => row.units), amount: sumOf(stockOf(side), row => row.amount) } : null,
      { type: 'subtotal', keep: true, indent: false, key: `stock/${end}`, calc: f => f.sum(f.keys(`stock/${end}/`)) });
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
export function buildTaxRows({ budget, actual }) {
  if (!budget.usTax) return [];
  const rows = [];
  const sides = [budget, actual];
  const { sub, line, amount, note } = rowHelpers(sides, rows);
  const rules = US_TAX_RULES;
  const tax = pick => amount(side => pick(side.usTax));
  const flat = { indent: false };
  note(`Federal tax at ${rate.format(rules.federalRate)} under the rules for tax years beginning after 2025, plus state tax at ${rate.format(budget.usTax.stateRate)} of operating profit. Worked out on the period’s figures as if they were a tax year. Every foreign subsidiary is treated as a controlled foreign corporation (CFC) wholly owned by the US parent. Taxable income is taken as US GAAP operating profit, with no interest and no credits other than the NCTI credit.`);

  // The formulas follow usIncomeTax in engine.mjs step by step. Shared pieces:
  const v = (f, key) => f.v(`tax/${key}`);
  // FDDEI before the limit: the lower of FDDEI and deduction eligible income, if that is positive.
  const fddeiBase = f => `IF(${v(f, 'fddei/dei')}>0,MAX(0,MIN(${v(f, 'fddei/income')},${v(f, 'fddei/dei')})),0)`;
  // The section 250 limit: both deductions are cut back in proportion where they exceed taxable income before them.
  const limit = f => {
    const claimed = `(${fddeiBase(f)}+${v(f, 'ncti')}+${v(f, 'grossUp')})`;
    const before = `(${v(f, 'operatingProfit')}-${v(f, 'state')}+${v(f, 'ncti')}+${v(f, 'grossUp')})`;
    return `IF(${claimed}>0,MIN(1,MAX(0,${before})/${claimed}),1)`;
  };
  const cfcRange = f => f.range(f.keys('tax/cfc/'));
  // A CFC's foreign tax follows its statutory profit once the year is closed, which the sheets do not show.
  const beforeStat = calc => f => f.side.months === 12 ? null : calc(f);

  sub('Taxable income and tax');
  line('Operating profit, US GAAP', tax(t => t.operatingProfit), { keep: true, key: 'tax/operatingProfit', calc: f => f.v('op') });
  line('State income tax, deductible', tax(t => -t.state), { keep: true, key: 'tax/stateDeduction', calc: f => `-MAX(0,${v(f, 'operatingProfit')})*Rate_State` });
  line('NCTI inclusion', tax(t => t.ncti.amount), { keep: true, key: 'tax/inclusion', calc: f => v(f, 'ncti') });
  line('Section 78 gross-up', tax(t => t.ncti.grossUp), { keep: true, key: 'tax/inclusionGrossUp', calc: f => v(f, 'grossUp') });
  line(`Section 250 deduction on FDDEI, ${rate.format(rules.fddeiDeduction)}`, tax(t => -t.fddei.deduction), { keep: true, key: 'tax/fddeiDeductionTaken', calc: f => `-${v(f, 'fddei/deduction')}` });
  line(`Section 250 deduction on NCTI, ${rate.format(rules.nctiDeduction)}`, tax(t => -t.ncti.deduction), { keep: true, key: 'tax/nctiDeductionTaken', calc: f => v(f, 'ncti/deduction') });
  line('Taxable income', tax(t => t.taxableIncome), {
    type: 'subtotal', keep: true, ...flat, key: 'tax/taxableIncome',
    calc: f => f.sum(['operatingProfit', 'stateDeduction', 'inclusion', 'inclusionGrossUp', 'fddeiDeductionTaken', 'nctiDeductionTaken'].map(key => `tax/${key}`)),
  });
  line(`Federal tax at ${rate.format(rules.federalRate)}`, tax(t => t.taxBeforeCredits), { keep: true, key: 'tax/federal', calc: f => `MAX(0,${v(f, 'taxableIncome')})*Rate_Federal` });
  line('Foreign tax credit on NCTI', tax(t => -t.credit), { keep: true, key: 'tax/creditTaken', calc: f => `-${v(f, 'ncti/credit')}` });
  line('Regular federal tax', tax(t => t.regularTax), { type: 'subtotal', keep: true, ...flat, key: 'tax/regular', calc: f => `${v(f, 'federal')}+${v(f, 'creditTaken')}` });
  line('Base erosion and anti-abuse tax (BEAT)', tax(t => t.beat.amount), { keep: true, key: 'tax/beatTaken', calc: f => v(f, 'beat') });
  line('State income tax', tax(t => t.state), { keep: true, key: 'tax/state', calc: f => `-${v(f, 'stateDeduction')}` });
  line('Total US income tax', tax(t => t.total), { type: 'total', keep: true, ...flat, key: 'tax/total', calc: f => `${v(f, 'regular')}+${v(f, 'beatTaken')}+${v(f, 'state')}` });
  line('Effective rate on operating profit', tax(t => t.operatingProfit ? t.total / t.operatingProfit : NaN),
    { kind: 'percent', keep: true, ...flat, key: 'tax/effective', calc: f => `${v(f, 'total')}/${v(f, 'operatingProfit')}` });

  sub('FDDEI: foreign-derived deduction eligible income');
  // Other operating expenses leave out R&D, which is not allocated, and the headquarters cost, which is allocated to its fee.
  const otherExpenses = f => `(${f.v('opex')}-${f.v('ownResearch')}-${f.v('charge/RD_SERVICES')})`;
  line('Goods sold to Switzerland and Canada, resold to customers abroad', tax(t => t.fddei.goods), {
    keep: true, key: 'tax/fddei/goods',
    // Year-end adjustments the US books are on its sales to Canada.
    calc: f => f.sum([...f.keys('sales/CH/'), ...f.keys('sales/CA/'), 'adjustments']),
  });
  line('Royalty from Switzerland, for use of the IP abroad', tax(t => t.fddei.royalty), { keep: true, key: 'tax/fddei/royalty', calc: f => f.v('other/CH_ROYALTY') });
  line('Headquarters services fee from Switzerland', tax(t => t.fddei.services), { keep: true, key: 'tax/fddei/services', calc: f => f.v('other/US_SERVICES') });
  line('Cost of goods sold on those goods', tax(t => -t.fddei.goodsCogs), { keep: true, key: 'tax/fddei/goodsCogs' });
  line('Headquarters services cost, allocated to the fee', tax(t => -t.fddei.servicesCost), { keep: true, key: 'tax/fddei/servicesCost' });
  line('Other operating expenses and state tax, apportioned on gross receipts', tax(t => -t.fddei.apportionedToForeign), {
    keep: true, key: 'tax/fddei/apportioned',
    calc: f => `-(${otherExpenses(f)}+${v(f, 'fddei/servicesCost')}+${v(f, 'state')})*${v(f, 'fddei/share')}`,
  });
  line('Foreign-derived share of gross receipts', tax(t => t.fddei.receipts ? t.fddei.foreignShare : NaN), {
    kind: 'percent', keep: true, key: 'tax/fddei/share',
    calc: f => `(${v(f, 'fddei/goods')}+${v(f, 'fddei/royalty')}+${v(f, 'fddei/services')})/${f.v('revenue')}`,
  });
  line('R&D expense, not allocated (memo)', tax(t => t.fddei.research), { keep: true, key: 'tax/fddei/research', calc: f => `${f.v('ownResearch')}+${f.v('charge/RD_SERVICES')}` });
  line('FDDEI', tax(t => t.fddei.income), {
    type: 'subtotal', keep: true, ...flat, key: 'tax/fddei/income',
    calc: f => f.sum(['goods', 'royalty', 'services', 'goodsCogs', 'servicesCost', 'apportioned'].map(key => `tax/fddei/${key}`)),
  });
  line('Deduction eligible income from all US sales (memo)', tax(t => t.fddei.dei), {
    keep: true, key: 'tax/fddei/dei', calc: f => `${f.v('revenue')}-${f.v('cogs')}-${otherExpenses(f)}-${v(f, 'state')}`,
  });
  line('Cut back by the taxable income limit', tax(t => t.fddei.allowed - t.fddei.base), { key: 'tax/fddei/cutBack', calc: f => `${fddeiBase(f)}*(${limit(f)}-1)` });
  line(`Section 250 deduction at ${rate.format(rules.fddeiDeduction)}`, tax(t => t.fddei.deduction), {
    type: 'subtotal', keep: true, ...flat, key: 'tax/fddei/deduction', calc: f => `Rate_FDDEI_Deduction*${fddeiBase(f)}*${limit(f)}`,
  });

  sub('NCTI: net CFC tested income, each CFC’s profit less its foreign income tax');
  for (const id of budget.usTax.ncti.cfcs.map(cfc => cfc.id)) {
    line(nameOf(id), tax(t => t.ncti.cfcs.find(cfc => cfc.id === id).tested), {
      keep: true, key: `tax/cfc/${id}`,
      calc: beforeStat(f => f.x(id, 'op') && `${f.x(id, 'op')}-MAX(0,Rate_Tax_${id}*${f.x(id, 'op')})`),
    });
  }
  line('Tested losses', tax(t => t.ncti.testedLoss), { key: 'tax/testedLoss', calc: f => cfcRange(f) && `SUMIF(${cfcRange(f)},"<0")` });
  line('NCTI, with no deduction for tangible assets', tax(t => t.ncti.amount), { type: 'subtotal', keep: true, ...flat, key: 'tax/ncti', calc: f => cfcRange(f) && `MAX(0,SUM(${cfcRange(f)}))` });
  line('Foreign income taxes on tested income', tax(t => t.ncti.testedTaxes), { keep: true, key: 'tax/testedTaxes' });
  line('Section 78 gross-up of those taxes', tax(t => t.ncti.grossUp), {
    keep: true, key: 'tax/grossUp',
    // The share of tested income that is included, times the foreign taxes on it.
    calc: f => cfcRange(f) && `IF(SUMIF(${cfcRange(f)},">0")>0,${v(f, 'ncti')}/SUMIF(${cfcRange(f)},">0"),0)*${v(f, 'testedTaxes')}`,
  });
  line(`Section 250 deduction at ${rate.format(rules.nctiDeduction)}`, tax(t => -t.ncti.deduction), {
    keep: true, key: 'tax/ncti/deduction', calc: f => `-Rate_NCTI_Deduction*(${v(f, 'ncti')}+${v(f, 'grossUp')})*${limit(f)}`,
  });
  line(`US tax on NCTI at ${rate.format(rules.federalRate)}`, tax(t => t.ncti.taxBeforeCredit), {
    keep: true, key: 'tax/ncti/usTax',
    // The federal tax on the share of taxable income that is the NCTI basket.
    calc: f => `IF(${v(f, 'taxableIncome')}>0,${v(f, 'federal')}*MIN(1,MAX(0,${v(f, 'ncti')}+${v(f, 'grossUp')}+${v(f, 'ncti/deduction')})/${v(f, 'taxableIncome')}),0)`,
  });
  line(`Deemed-paid credit, ${rate.format(rules.nctiCreditShare)} of the foreign taxes`, tax(t => t.ncti.deemedPaid), {
    keep: true, key: 'tax/ncti/deemedPaid', calc: f => `Rate_NCTI_Credit*${v(f, 'grossUp')}`,
  });
  line('Credit allowed, up to the US tax on NCTI', tax(t => t.ncti.credit), { keep: true, key: 'tax/ncti/credit', calc: f => `MIN(${v(f, 'ncti/deemedPaid')},${v(f, 'ncti/usTax')})` });
  line('Excess credit, lost with no carryover', tax(t => t.ncti.excessCredit), { keep: true, key: 'tax/ncti/excess', calc: f => `${v(f, 'ncti/deemedPaid')}-${v(f, 'ncti/credit')}` });
  line('Residual US tax on NCTI', tax(t => t.ncti.residual), { type: 'subtotal', keep: true, ...flat, key: 'tax/ncti/residual', calc: f => `MAX(0,${v(f, 'ncti/usTax')}-${v(f, 'ncti/credit')})` });

  sub('BEAT: base erosion and anti-abuse tax');
  line('R&D services from Germany and Poland, in full', tax(t => t.beat.research), { keep: true, key: 'tax/beat/research', calc: f => f.v('charge/RD_SERVICES') });
  line('India service fee', tax(t => t.beat.indiaFee), { keep: true, key: 'tax/beat/indiaFee', calc: f => f.v('charge/IN_SERVICES') });
  line('Less its cost, excepted under the services cost method', tax(t => -t.beat.indiaCost), {
    keep: true, key: 'tax/beat/indiaCost', calc: f => f.x('IN', 'ownCosts') && `-${f.x('IN', 'ownCosts')}*India_Share_US`,
  });
  line('Base erosion tax benefits', tax(t => t.beat.benefits), {
    type: 'subtotal', keep: true, ...flat, key: 'tax/beat/benefits',
    // The markup on India's fee, with its year-end true-up, counts only if it is positive.
    calc: f => `${v(f, 'beat/research')}+MAX(0,${v(f, 'beat/indiaFee')}+${v(f, 'beat/indiaCost')}+${f.v('charge/SERVICE_TRUE_UP')})`,
  });
  line('Deductions, excluding cost of goods sold, section 250 and the excepted cost', tax(t => t.beat.deductions), {
    keep: true, key: 'tax/beat/deductions', calc: f => `${f.v('opex')}+${v(f, 'state')}+${v(f, 'beat/indiaCost')}`,
  });
  line(`Base erosion percentage, ${rate.format(rules.beatThreshold)} threshold`, tax(t => t.beat.deductions ? t.beat.percentage : NaN), {
    kind: 'percent', keep: true, key: 'tax/beat/percentage', calc: f => `${v(f, 'beat/benefits')}/${v(f, 'beat/deductions')}`,
  });
  line('Modified taxable income: taxable income plus base erosion tax benefits', tax(t => t.beat.modifiedTaxableIncome), {
    keep: true, key: 'tax/beat/modified', calc: f => `${v(f, 'taxableIncome')}+${v(f, 'beat/benefits')}`,
  });
  line(`Minimum tax at ${rate.format(rules.beatRate)}`, tax(t => t.beat.minimumTax), { keep: true, key: 'tax/beat/minimum', calc: f => `Rate_BEAT*MAX(0,${v(f, 'beat/modified')})` });
  line('Less regular federal tax after credits', tax(t => -t.regularTax), { keep: true, key: 'tax/beat/lessRegular', calc: f => `-${v(f, 'regular')}` });
  line('BEAT', tax(t => t.beat.amount), {
    type: 'subtotal', keep: true, ...flat, key: 'tax/beat',
    // BEAT applies when annual gross receipts reach the threshold and the base erosion percentage reaches 3%.
    calc: f => f.side.months && `IF(AND(${f.v('revenue')}*12/${f.side.months}>=BEAT_Gross_Receipts,${v(f, 'beat/percentage')}>=BEAT_Threshold),MAX(0,${v(f, 'beat/minimum')}+${v(f, 'beat/lessRegular')}),0)`,
  });
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
// The column labels and period wording, shared by the page and the Excel export.
export function reportLabels({ basis, period, revealed }) {
  const quarter = `Q${period + 1}`;
  const closed = Math.floor(revealed / 3);
  return {
    budgetLabel: basis === 'year' ? 'Budget · full year 2027' : `Budget · ${quarter}`,
    actualLabel: basis === 'year'
      ? closed ? `Actual · year to date through Q${closed}` : 'Actual · no quarters revealed yet'
      : period < closed ? `Actual · ${quarter}` : `Actual · ${quarter} not revealed yet`,
    when: basis === 'year' ? 'Full year 2027' : `${quarter} 2027 (${quarterSpans[period]})`,
    explain: basis === 'year'
      ? 'The budget column is the full year. The actual column adds up the quarters revealed so far.'
      : 'An actual quarter shows zero until it is revealed.',
  };
}

export function renderEntityDetail({ detail, entities, calendar = '', layers = true }) {
  const { id, basis, period } = detail;
  const { budgetLabel, actualLabel, when, explain } = reportLabels(detail);
  const taxRows = buildTaxRows(detail);
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
      <div class="entity-export">
        <button type="button" class="button" data-action="export-entities" aria-describedby="export-scope">${EXCEL_ICON}Export to Excel</button>
        <span class="field-note" id="export-scope">All entities · ${basis === 'year' ? 'full year 2027' : `Q${period + 1} 2027`} · with stock layers</span>
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
