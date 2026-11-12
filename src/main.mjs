import {
  applyGoodsPrices, applyServiceFees, applyYearEndAdjustments, createConfig, CUSTOMS_ROUTES, ENTITIES, explainYear, MAX_ROYALTY_RATE,
  POLICY_LABELS, PRODUCTS, productLineResults, profitAllocation, quarterPricingMonth, reviewGoodsPricing, royaltyCheck, runYear,
  summarizeTaxAndCustoms, TAXED_ENTITIES, upgradeConfig,
} from './engine.mjs';
import { renderBrief } from './brief-view.mjs';
import { landPolygons } from './land.mjs';
import { pricingStatus, readGoodsPriceOverrides, readServiceFees, renderGoodsPricing, useGoodsPriceQuote } from './pricing-view.mjs';
import { MARKET_SHOCK_KEYS, SHOCK_KEYS } from './simulation.mjs';
import { renderYearSummary } from './summary-view.mjs';
import { licenseeLossWarning, readYearEndChoices, royaltyWarning } from './year-end-view.mjs';

const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const storageKey = 'playtp-2027-v1';
// Scenarios saved under the game's earlier name, SimulaTP, are still picked up.
const legacyStorageKey = 'simulatp-2027-v1';
const pageHeader = document.querySelector('#page-header');
const pageBody = document.querySelector('#page-body');
const announcement = document.querySelector('#announcement');
const summaryDialog = document.querySelector('#year-summary');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// How long each month stays on screen while the year runs on its own.
const RUN_STEP_MS = 320;
const navButtons = [...document.querySelectorAll('[data-view]')];
const formatAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatCompactAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const formatPercent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDifference = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const iconPaths = {
  brief: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  map: '<path d="M4 4l5-2 6 3 5-2v16l-5 2-6-3-5 2zM9 2v16m6-13v16"/>',
  pricing: '<path d="M3 5h10l8 8-8 8-10-10z"/><circle cx="7.5" cy="9" r="1"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor"/><circle cx="15" cy="17" r="2.5" fill="currentColor"/>',
  next: '<path d="M5 12h13m-6-6 6 6-6 6"/>',
};
const views = { brief: 'Case brief', dashboard: '2027 performance', map: 'Transaction map', pricing: 'Transfer prices', settings: 'Scenario settings' };
const categoryLabels = { goods: 'Tangible goods', royalty: 'Royalty', services: 'Services' };
const categoryColors = { goods: '#4e73a0', royalty: '#92612e', services: '#227466' };
const shockLabels = { demand: 'Demand', salesPrice: 'Sales price', materialCost: 'Material input cost' };

function icon(name) {
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg></span>`;
}

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function amount(value, formatter = formatAmount) {
  return Number.isFinite(value) ? formatter.format(value) : '—';
}

function signed(value, formatter = formatAmount) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${formatter.format(Object.is(value, -0) ? 0 : value)}`;
}

function varianceClass(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return '';
}

function signedPoints(value) {
  return Number.isFinite(value) ? `${signed(value * 100, formatDifference)} pp` : '—';
}

function labelFor(id) {
  return ENTITIES[id]?.name ?? id;
}

function productFor(id) {
  return PRODUCTS[id]?.name ?? PRODUCTS[id]?.label ?? id;
}

function loadState() {
  const defaults = createConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey));
    if (saved?.config && Number.isInteger(saved.revealed) && saved.revealed >= 0 && saved.revealed <= 12) {
      const { revealed } = saved;
      const unstarted = revealed === 0 && !saved.config.goodsPriceSchedule?.length;
      const config = upgradeConfig(saved.config, !unstarted);
      const restored = unstarted && config.startingPriceMethod === undefined
        ? { ...config, startingPriceMethod: defaults.startingPriceMethod } : config;
      return { config: restored, year: runYear(restored), revealed, returning: true };
    }
  } catch {
    // A malformed or outdated saved scenario should still let the dashboard open.
  }
  return { config: defaults, year: runYear(defaults), revealed: 0, returning: false };
}

function storeState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ config: state.config, revealed: state.revealed }));
  } catch {
    // Scenario controls also work for the current page when local storage is unavailable.
  }
}

function viewFromHash(fallback = 'dashboard') {
  const key = location.hash.slice(1);
  return Object.hasOwn(views, key) ? key : fallback;
}

const initial = loadState();
const state = {
  ...initial,
  // A first visit opens on the case brief. A saved scenario opens on the dashboard.
  view: viewFromHash(initial.returning ? 'dashboard' : 'brief'),
  period: Math.max(0, initial.revealed - 1),
  metric: 'operatingProfit',
  filter: 'all',
  mapEntity: null,
  mapBasis: initial.revealed ? 'actual' : 'budget',
  settingsMessage: '',
  pricingMessage: '',
  yearEndMessage: '',
  // True while the remaining months are being revealed without a stop.
  running: false,
};
let runTimer = null;

function revealButton() {
  if (state.revealed >= 12) return '<button class="button" disabled>All actuals revealed</button>';
  if (state.running) return `<button class="button primary" disabled>Running the year · ${months[state.period]}</button>`;
  return `<button class="button primary" type="button" data-action="reveal">Reveal ${months[state.revealed]} actuals ${icon('next')}</button>`;
}

function runButton() {
  if (state.revealed >= 12) return '<button class="button" type="button" data-action="year-summary">Explain the year</button>';
  if (state.running) return '';
  return `<button class="button" type="button" data-action="run-year" title="Reveal every remaining month without changing transfer prices or fees">${state.revealed ? 'Run the rest of the year' : 'Run the full year'}</button>`;
}

function renderHeader() {
  const reviewButton = state.running ? ''
    : quarterPricingMonth(state.revealed) ? '<button class="button" type="button" data-action="review-prices">Review transfer prices</button>'
    : state.revealed === 12 ? '<button class="button primary" type="button" data-action="review-prices">Year-end review</button>' : '';
  pageHeader.innerHTML = `
    <div>
      <p class="breadcrumb">Simulation <span aria-hidden="true">/</span> FY 2027</p>
      <h1 id="page-title" tabindex="-1">${views[state.view]}</h1>
    </div>
    ${state.view === 'dashboard' ? `<div class="view-controls">${reviewButton}${runButton()}${revealButton()}</div>` : ''}`;
  document.title = `PlayTP · ${views[state.view]}`;
}

function monthStrip() {
  const buttons = shortMonths.map((month, index) => `
    <button type="button" class="month-button ${index < state.revealed ? 'revealed' : ''}" data-period="${index}" aria-label="${months[index]}, ${index < state.revealed ? 'actuals available' : 'budget available'}" aria-pressed="${state.period === index}">
      ${month}<span class="month-status" aria-hidden="true">${index < state.revealed ? 'Actuals' : 'Budget'}</span>
    </button>`).join('');
  return `<section class="panel month-panel" aria-label="Select a reporting month">
    <div class="month-panel-top">
      <strong>Reporting calendar</strong>
      <span class="progress-count">${state.revealed} of 12 actual months revealed</span>
    </div>
    <div class="month-strip">${buttons}</div>
  </section>`;
}

function kpis(budget, actual) {
  const stats = [
    { label: 'Net sales', key: 'revenue' },
    { label: 'Gross profit', key: 'grossProfit' },
    { label: 'Operating profit', key: 'operatingProfit' },
    { label: 'Operating margin', key: 'operatingMargin', isMargin: true },
  ];
  const get = (pnl, key) => key === 'grossProfit' ? pnl.revenue - pnl.cogs : pnl[key];
  return `<section class="kpi-grid" aria-label="${months[state.period]} consolidated KPIs">
    ${stats.map(({ label, key, isMargin }) => {
      const base = get(budget, key);
      const value = actual ? get(actual, key) : base;
      const display = isMargin ? formatPercent : formatCompactAmount;
      const diff = value - base;
      return `<div class="panel kpi">
        <p class="kpi-label">${label}</p>
        <strong class="kpi-number" title="${amount(value, isMargin ? formatPercent : formatAmount)}">${amount(value, display)}</strong>
        <p class="kpi-footer">${actual
          ? `<strong class="${varianceClass(diff)}">${isMargin ? signedPoints(diff) : signed(diff, formatCompactAmount)}</strong> vs ${amount(base, display)} budget`
          : 'Budget'} · ${shortMonths[state.period]}</p>
      </div>`;
    }).join('')}
  </section>`;
}

function chart() {
  const { budget, actual } = state.year;
  const metric = state.metric;
  const options = { operatingProfit: 'Operating profit', revenue: 'Net sales' };
  const values = [...budget, ...actual.slice(0, state.revealed)].map((month) => month.consolidated[metric]);
  const highest = Math.max(1, ...values);
  const lowest = Math.min(0, ...values);
  const range = (highest - lowest) / 4;
  const scale = 10 ** Math.floor(Math.log10(range));
  const step = Math.ceil(range / scale) * scale;
  const top = Math.ceil(highest / step) * step;
  const bottom = Math.floor(lowest / step) * step;
  const ticks = Array.from({ length: 5 }, (_, i) => top - i * ((top - bottom) / 4));
  const percent = (value) => (value - bottom) / (top - bottom) * 100;
  const bar = (value, classes) => `<span class="bar ${classes} ${value < 0 ? 'down' : ''}" data-bottom="${percent(Math.min(0, value))}" data-height="${Math.abs(percent(value) - percent(0))}"></span>`;
  return `<section class="panel" aria-labelledby="chart-heading">
    <div class="panel-header">
      <div><h2 id="chart-heading">Monthly performance</h2><p class="subtitle">Consolidated · USD</p></div>
      <div class="view-controls">
        <div class="legend" aria-label="Series">
          <span class="legend-item"><i class="swatch"></i>Budget</span>
          <span class="legend-item"><i class="swatch actual"></i>Actual</span>
        </div>
        <div class="segmented" aria-label="Chart metric">
          ${Object.entries(options).map(([key, label]) => `<button type="button" data-metric="${key}" aria-pressed="${key === metric}">${label}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="chart-scroll">
      <div class="chart" role="group" aria-label="Monthly ${options[metric].toLowerCase()} chart">
        <div class="chart-axis" aria-hidden="true">${ticks.map((value) => `<span>${amount(value, formatCompactAmount)}</span>`).join('')}</div>
        <div class="chart-plot">
          <i class="zero-line" data-bottom="${percent(0)}" aria-hidden="true"></i>
          ${budget.map((month, index) => {
            const base = month.consolidated[metric];
            const realized = index < state.revealed ? actual[index].consolidated[metric] : null;
            const label = `${months[index]} budget ${amount(base)}${realized === null ? '' : `, actual ${amount(realized)}`}`;
            return `<button type="button" class="bar-group" aria-pressed="${index === state.period}" data-period="${index}" aria-label="${label}" title="${label}">
              ${bar(base, realized === null ? '' : 'paired')}${realized === null ? '' : bar(realized, 'actual')}
            </button>`;
          }).join('')}
        </div>
        <div class="chart-labels" aria-hidden="true">${shortMonths.map((month, index) => `<span class="chart-label ${state.period === index ? 'selected' : ''}">${month}</span>`).join('')}</div>
      </div>
    </div>
  </section>`;
}

function annualTable() {
  return `<section class="panel" aria-labelledby="annual-heading">
    <div class="panel-header"><div><h2 id="annual-heading">12-month budget and actuals</h2><p class="subtitle">Consolidated · USD</p></div></div>
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">Budget sales</th><th scope="col">Actual sales</th><th scope="col">Budget profit</th><th scope="col">Actual profit</th><th scope="col">Profit variance</th><th scope="col">Budget margin</th><th scope="col">Actual margin</th></tr></thead>
        <tbody>
          ${state.year.budget.map(({ consolidated: budget }, index) => {
            const actual = index < state.revealed ? state.year.actual[index].consolidated : null;
            const variance = actual ? actual.operatingProfit - budget.operatingProfit : null;
            return `<tr class="${index === state.period ? 'selected-row' : ''}">
              <td><button class="table-select" type="button" data-period="${index}" aria-pressed="${index === state.period}">${months[index]}</button></td>
              <td>${amount(budget.revenue)}</td><td>${amount(actual?.revenue)}</td>
              <td>${amount(budget.operatingProfit)}</td><td>${amount(actual?.operatingProfit)}</td>
              <td class="${varianceClass(variance)}">${signed(variance)}</td>
              <td>${amount(budget.operatingMargin, formatPercent)}</td><td>${amount(actual?.operatingMargin, formatPercent)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function metricList(rows) {
  return `<ul class="detail-list">${rows.map(([label, value]) => `<li><span>${html(label)}</span><strong>${html(value)}</strong></li>`).join('')}</ul>`;
}

function variancePanel(bridge) {
  const labels = {
    revenue: 'Net sales variance',
    volume: 'Volume and mix',
    salesPrice: 'Sales price',
    materials: 'Material input costs',
    otherCogs: 'Other cost of goods sold',
    operatingExpenses: 'Operating expenses',
    operatingProfit: 'Operating profit variance',
    operatingMargin: 'Operating margin variance',
    check: 'Unexplained difference',
  };
  return `<section class="panel breakdown" aria-labelledby="bridge-heading">
    <div class="panel-header"><div><h2 id="bridge-heading">Variance bridge</h2><p class="subtitle">${months[state.period]} · actual vs budget</p></div></div>
    ${bridge ? metricList(Object.entries(labels).filter(([key]) => Number.isFinite(bridge[key])).map(([key, label]) => [
      label, key === 'operatingMargin' ? signedPoints(bridge[key]) : signed(bridge[key], key === 'check' ? formatDifference : formatAmount),
    ])) : '<p class="empty-state">Release this month’s actuals to see its variance bridge.</p>'}
  </section>`;
}

function entityPanel(budget, actual) {
  const pnl = actual ?? budget;
  const labels = [
    ['revenue', 'Net sales'],
    ['cogs', 'Cost of goods sold'],
    ['otherOperatingExpenses', 'Other operating expenses'],
    ['rdExpense', 'R&D expense'],
    ['operatingProfit', 'Operating profit'],
    ['operatingMargin', 'Operating margin'],
  ];
  return `<section class="panel" aria-labelledby="entity-heading">
    <div class="panel-header"><div><h2 id="entity-heading">Entity results</h2><p class="subtitle">${months[state.period]} · ${actual ? 'Actual' : 'Budget'} · USD</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="entity-heading"><table>
      <thead><tr><th scope="col">Entity</th>${labels.map(([, label]) => `<th scope="col">${html(label)}</th>`).join('')}</tr></thead>
      <tbody>${[['Consolidated', pnl.consolidated], ...Object.entries(pnl.entities)].map(([id, row]) => `
        <tr>
          <td class="table-name">${html(labelFor(id))}</td>
          ${labels.map(([key]) => `<td>${amount(row[key], key === 'operatingMargin' ? formatPercent : formatAmount)}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="field-note panel-note">All monthly figures are US GAAP. ${state.revealed === 12
      ? 'The arm’s-length ranges are tested on the local statutory results shown below.'
      : 'Local statutory results, which the arm’s-length ranges are tested on, are published with the December close.'}</p>
  </section>`;
}

const serviceRoles = { PL: 'Toll manufacturing for Switzerland', IN: 'Shared services for the United States and Switzerland' };

// The fee is fixed for the month and the cost is not, so the markup moves every month.
function servicePanel(budget, actual) {
  const month = actual ?? budget;
  const { policies, ranges = createConfig().ranges } = state.config;
  const policy = { PL: [policies.polandMarkup, ranges.toll], IN: [policies.indiaServicesMarkup, ranges.services] };
  const row = (id) => {
    const { cost, fee } = month.services[id];
    const planned = budget.services[id].cost;
    const [target, range] = policy[id];
    const units = id === 'PL'
      ? ` · ${amount(month.capacity.PL.used, formatNumber)} units converted${actual ? `, budget ${amount(budget.capacity.PL.used, formatNumber)}` : ''}` : '';
    return `<tr>
      <th scope="row" class="table-name">${html(labelFor(id))}<small class="pricing-margin-target">${serviceRoles[id]}${units}</small></th>
      <td>${amount(cost)}${actual ? `<small class="pricing-margin-target ${varianceClass(planned - cost)}">${signed(cost - planned)} vs budget</small>` : ''}</td>
      <td>${amount(planned)}</td>
      <td>${amount(fee)}</td>
      <td>${amount(cost ? fee / cost - 1 : 0, formatPercent)}</td>
      <td>${amount(target, formatPercent)}<small class="pricing-margin-target">Range ${amount(range.low, formatPercent)}–${amount(range.high, formatPercent)}, full year</small></td>
    </tr>`;
  };
  return `<section class="panel" aria-labelledby="service-heading">
    <div class="panel-header"><div><h2 id="service-heading">Service fees and costs</h2><p class="subtitle">${months[state.period]} · ${actual ? 'Actual' : 'Budget'} · USD · a fixed monthly fee against a cost that moves</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="service-heading"><table class="service-table">
      <thead><tr><th scope="col">Service provider</th><th scope="col">Cost</th><th scope="col">Budget cost</th><th scope="col">Fixed fee</th><th scope="col">Markup on cost</th><th scope="col">Policy markup</th></tr></thead>
      <tbody>${row('PL')}${row('IN')}</tbody>
    </table></div>
    <p class="field-note panel-note">Each fee is budgeted annual cost plus the policy markup, divided by twelve. Part of Poland’s cost is fixed overhead. In a slow month its cost falls by less than its output and the fee does not fall at all, so its markup rises. A busy month does the reverse.</p>
  </section>`;
}

const statusLabels = { within: 'Within range', below: 'Below range', above: 'Above range' };

// Local accounts for the year. They exist only once December is closed.
function statPanel() {
  const { stat, yearEnd } = state.year.actual[11];
  if (state.revealed < 12 || !stat) return '';
  const tested = new Map(yearEnd.map(entry => [entry.id, entry]));
  return `<section class="panel" aria-labelledby="stat-heading">
    <div class="panel-header"><div><h2 id="stat-heading">Local statutory results</h2><p class="subtitle">Full year 2027 · USD · operating profit on US GAAP and in the local statutory (stat) accounts</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="stat-heading"><table class="stat-table">
      <thead><tr><th scope="col">Entity</th><th scope="col">US GAAP profit</th><th scope="col">Operating expenses</th>
        <th scope="col">Stat adjustment</th><th scope="col">Local stat profit</th><th scope="col">Tested result</th><th scope="col">Range</th><th scope="col">Result</th></tr></thead>
      <tbody>${Object.entries(stat).map(([id, row]) => {
        const entry = tested.get(id);
        return `<tr class="${entry && entry.statusAfter !== 'within' ? 'pricing-out-of-policy' : ''}">
          <th scope="row" class="table-name">${html(labelFor(id))}</th>
          <td>${amount(row.gaapProfit)}</td><td>${amount(row.base)}</td>
          <td>${row.adjustment ? signed(row.adjustment) : amount(0)}<small class="pricing-margin-target">${row.rate ? signed(row.rate, formatPercent) : amount(0, formatPercent)} of expenses</small></td>
          <td>${amount(row.operatingProfit)}</td>
          <td>${entry ? `${amount(entry.marginAfter, formatPercent)}<small class="pricing-margin-target">${entry.service ? 'Markup on cost' : 'Operating margin'} · US GAAP ${amount(entry.gaapAfter, formatPercent)}</small>` : '—'}</td>
          <td>${entry ? `${amount(entry.low, formatPercent)}–${amount(entry.high, formatPercent)}` : '—'}</td>
          <td>${entry ? `<span class="status-chip ${entry.statusAfter === 'within' ? 'ok' : 'miss'}">${statusLabels[entry.statusAfter]}</span>` : '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="field-note panel-note">A positive stat adjustment is extra cost in the local accounts, which lowers local profit. The rate is applied to operating expenses outside R&amp;D and goods purchased. Local income tax for the year is charged on these results.</p>
  </section>`;
}

function productLinePanel(budget, actual) {
  const lines = productLineResults(actual ?? budget);
  const total = lines.reduce((sum, line) => ({
    units: sum.units + line.units, revenue: sum.revenue + line.revenue, cogs: sum.cogs + line.cogs,
  }), { units: 0, revenue: 0, cogs: 0 });
  const row = (name, line, className = '') => `<tr class="${className}">
    <td class="table-name">${html(name)}</td><td>${amount(line.units, formatNumber)}</td><td>${amount(line.revenue)}</td>
    <td>${amount(line.cogs)}</td><td>${amount(line.revenue - line.cogs)}</td>
    <td>${amount(line.revenue ? (line.revenue - line.cogs) / line.revenue : 0, formatPercent)}</td>
  </tr>`;
  return `<section class="panel" aria-labelledby="product-heading">
    <div class="panel-header"><div><h2 id="product-heading">Product lines</h2><p class="subtitle">${months[state.period]} · ${actual ? 'Actual' : 'Budget'} · third-party sales at group cost · USD</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="product-heading"><table>
      <thead><tr><th scope="col">Product family</th><th scope="col">Units sold</th><th scope="col">Net sales</th><th scope="col">Cost of goods sold</th><th scope="col">Gross profit</th><th scope="col">Gross margin</th></tr></thead>
      <tbody>${lines.map((line) => row(productFor(line.product), line)).join('')}${row('All product lines', total, 'total-row')}</tbody>
    </table></div>
  </section>`;
}

function customsRouteLabel({ from, to }) {
  // Swiss-owned goods ship from and to the Belgian warehouse.
  return `${mapLabel(from === 'CH' ? 'BE' : from)} → ${mapLabel(to === 'CH' ? 'BE' : to)}`;
}

function taxPanel(budget, actual) {
  const { tax, customs } = summarizeTaxAndCustoms(state.config, [actual ?? budget]);
  const basis = `${months[state.period]} · ${actual ? 'Actual' : 'Budget'} · USD`;
  return `<div class="dashboard-detail">
    <section class="panel" aria-labelledby="tax-heading">
      <div class="panel-header"><div><h2 id="tax-heading">Income tax</h2><p class="subtitle">${basis} · each entity’s rate applied to its operating profit</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-labelledby="tax-heading"><table>
        <thead><tr><th scope="col">Entity</th><th scope="col">Operating profit</th><th scope="col">Tax rate</th><th scope="col">Income tax</th></tr></thead>
        <tbody>${TAXED_ENTITIES.map((id) => `<tr>
          <td class="table-name">${html(labelFor(id))}</td><td>${amount(tax.entities[id].profit)}</td>
          <td>${amount(tax.entities[id].rate, formatPercent)}</td><td>${amount(tax.entities[id].tax)}</td>
        </tr>`).join('')}
        <tr class="total-row"><td class="table-name">All entities</td><td>${amount(tax.profit)}</td><td>${amount(tax.effectiveRate, formatPercent)}</td><td>${amount(tax.total)}</td></tr>
        </tbody>
      </table></div>
    </section>
    <section class="panel breakdown" aria-labelledby="customs-heading">
      <div class="panel-header"><div><h2 id="customs-heading">Customs duty</h2><p class="subtitle">${basis} · duty on declared transfer prices</p></div></div>
      ${metricList([
        ...CUSTOMS_ROUTES.map((route) => {
          const entry = customs.routes[route.key];
          return [`${customsRouteLabel(route)} · ${formatPercent.format(entry.rate)}`, amount(entry.duty)];
        }),
        ['Total duty', amount(customs.total)],
      ])}
      <p class="field-note panel-note">Memo. Duty is not deducted from operating profit. Shipments from Belgium to Germany and France stay inside the EU.</p>
    </section>
  </div>`;
}

function controlPanels(budget, actual) {
  const { capacity, reconciliation } = actual ?? budget;
  const reconciliationNames = {
    ledgerDifference: 'Transaction ledger',
    intercompanyDifference: 'Intercompany balances',
    profitDifference: 'Consolidated profit',
    inventoryDifference: 'Inventory roll-forward',
  };
  const capacityRows = Object.entries(capacity).map(([id, entry]) => [
    labelFor(id),
    `${amount(entry.used, formatNumber)} of ${amount(entry.limit, formatNumber)} units`,
  ]);
  return `<div class="detail-stack">
    <section class="panel breakdown" aria-labelledby="capacity-heading">
      <div class="panel-header"><h2 id="capacity-heading">Production capacity</h2></div>${metricList(capacityRows)}
    </section>
    <section class="panel breakdown" aria-labelledby="reconcile-heading">
      <div class="panel-header"><div><h2 id="reconcile-heading">Reconciliation</h2><p class="subtitle">Control differences · USD</p></div></div>
      ${metricList(Object.entries(reconciliationNames).filter(([key]) => Number.isFinite(reconciliation[key])).map(([key, label]) => [
        // Rounding first keeps a difference of a fraction of a cent from showing as -0.00.
        label, amount(Math.round(reconciliation[key] * 100) / 100 || 0, formatDifference),
      ]))}
    </section>
  </div>`;
}

function renderDashboard() {
  const budget = state.year.budget[state.period];
  const actual = state.period < state.revealed ? state.year.actual[state.period] : null;
  const bridge = actual ? state.year.variance[state.period] : null;
  pageBody.innerHTML = `
    ${monthStrip()}
    ${kpis(budget.consolidated, actual?.consolidated)}
    ${chart()}
    ${entityPanel(budget, actual)}
    ${statPanel()}
    ${servicePanel(budget, actual)}
    ${productLinePanel(budget, actual)}
    ${taxPanel(budget, actual)}
    <div class="dashboard-detail">${variancePanel(bridge)}${controlPanels(budget, actual)}</div>
    ${annualTable()}
    ${inventoryPanel(budget, actual)}`;
  for (const element of pageBody.querySelectorAll('[data-bottom]')) {
    element.style.bottom = `${element.dataset.bottom}%`;
    if (element.dataset.height !== undefined) element.style.height = `${element.dataset.height}%`;
  }
}

function inventoryPanel(budget, actual) {
  const { inventory } = actual ?? budget;
  const stages = { raw: 'Raw materials', wip: 'Work in process', finished: 'Finished goods' };
  const units = (lots) => amount(lots.reduce((total, lot) => total + lot.quantity, 0), formatNumber);
  const value = (lots) => amount(lots.reduce((total, lot) => total + lot.quantity * lot.unitValue, 0));
  return `<section class="panel" aria-labelledby="inventory-heading">
    <div class="panel-header"><div><h2 id="inventory-heading">FIFO inventory roll-forward</h2><p class="subtitle">${months[state.period]} · ${actual ? 'Actual' : 'Budget'} · units and local carrying value in USD</p></div></div>
    <div class="table-scroll"><table>
      <thead><tr><th scope="col">Owner</th><th scope="col">Custodian</th><th scope="col">Product family</th><th scope="col">Stage</th><th scope="col">Opening</th><th scope="col">Receipts</th><th scope="col">Issues</th><th scope="col">Closing</th><th scope="col">Closing value</th></tr></thead>
      <tbody>${inventory.map((bin) => `<tr>
        <td class="table-name">${html(labelFor(bin.owner))}</td><td>${html(labelFor(bin.custodian))}</td>
        <td>${html(productFor(bin.product))}</td><td>${html(stages[bin.stage] ?? bin.stage)}</td>
        <td>${units(bin.opening)}</td><td>${units(bin.receipts)}</td><td>${units(bin.issues)}</td><td>${units(bin.closing)}</td><td>${value(bin.closing)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

const mapNodes = {
  US: { position: [19, 49], coordinates: [-97, 38], manufacturing: true },
  CA: { position: [17, 14], coordinates: [-106, 56] },
  UK: { position: [37, 12], coordinates: [-1, 52] },
  BE: { position: [51, 9], coordinates: [4.4, 50.8] },
  DE: { position: [64, 12], coordinates: [10, 51] },
  PL: { position: [67, 29], coordinates: [19, 52], manufacturing: true },
  CH: { position: [49, 44], coordinates: [8, 47] },
  FR: { position: [35, 31], coordinates: [2.3, 46.6] },
  IN: { position: [84, 36], coordinates: [78, 22] },
  APAC: { position: [84, 64], coordinates: [103.8, 1.35] },
  UNRELATED: { position: [49, 69] },
  THIRD_PARTY: { position: [31, 86] },
};
const mapRole = {
  US: 'Manufacturer · IP · HQ',
  CH: 'European principal',
  PL: 'Toll manufacturing',
  BE: 'Warehouse operator',
  DE: 'Limited-risk distributor',
  FR: 'Limited-risk distributor',
  UK: 'Limited-risk distributor',
  APAC: 'Full-fledged distributor',
  CA: 'Full-fledged distributor',
  IN: 'Shared services',
  UNRELATED: 'Swiss direct customer',
  THIRD_PARTY: 'External sales',
};
const manufacturingIcon = '<svg class="map-factory-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V11l6-4v4l6-4v4h3l1-7h2l1 8v9H3zm4-5h1m4 0h1m4 0h1"/></svg>';

function mapLabel(id) {
  return id === 'THIRD_PARTY' ? 'Third-party customers' : labelFor(id);
}

function mapProjection(lon, lat, width, height) {
  return [(lon + 180) / 360 * width, (84 - lat) / 144 * height];
}

function mapGoodsRoute(transaction) {
  if (transaction.category !== 'goods' || !transaction.quantity) return '';
  const from = transaction.from === 'CH' ? 'BE' : transaction.from;
  const to = transaction.to === 'CH' ? 'BE' : transaction.to;
  return `${mapLabel(from)} → ${mapLabel(to)}`;
}

function mapEdges(transactions) {
  const edges = new Map();
  function add(from, to, category, weight) {
    const key = [from, to, category].join('/');
    const edge = edges.get(key) ?? { from, to, category, weight: 0 };
    edge.weight += Math.abs(weight);
    edges.set(key, edge);
  }
  for (const transaction of transactions) {
    const { from, to, category, amount: total, quantity, policy } = transaction;
    if (category === 'goods') {
      if (quantity) add(from === 'CH' ? 'BE' : from, to === 'CH' ? 'BE' : to, category, quantity);
    } else {
      if (total && (state.filter === 'all' || state.filter === category)) add(from, to, category, total);
      if (policy === 'PL_TOLL_BUDGET' && ['all', 'goods'].includes(state.filter) && quantity) add('PL', 'BE', 'goods', quantity);
    }
  }
  return [...edges.values()].filter(({ from, to }) => mapNodes[from] && mapNodes[to]);
}

function drawMap() {
  const canvas = document.querySelector('#transaction-canvas');
  if (!canvas) return;
  const stage = canvas.parentElement;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const ratio = devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  for (const polygon of landPolygons) {
    ctx.beginPath();
    for (const ring of polygon) {
      for (const [index, [lon, lat]] of ring.entries()) {
        const [x, y] = mapProjection(lon, lat, width, height);
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = '#e6eef7';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#d0deed';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  const boxes = Object.fromEntries([...stage.querySelectorAll('[data-map-entity]')].map((node) => {
    const id = node.dataset.mapEntity;
    const { position: [left, top], coordinates } = mapNodes[id];
    const x = left * width / 100;
    const y = top * height / 100;
    if (coordinates) {
      const [mapX, mapY] = mapProjection(...coordinates, width, height);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(mapX, mapY);
      ctx.strokeStyle = '#7c94b2';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mapX, mapY, 2.3, 0, 2 * Math.PI);
      ctx.fillStyle = '#526f95';
      ctx.fill();
    }
    return [id, { x, y, halfW: node.offsetWidth / 2 + 2, halfH: node.offsetHeight / 2 + 2 }];
  }));
  for (const edge of mapEdges(mapTransactions({ forMap: true }))) {
    const { from, to, category, weight } = edge;
    const start = boxes[from];
    const end = boxes[to];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) continue;
    const curves = { goods: 0.17, royalty: 0.28, services: -0.24 };
    const bend = curves[category] * Math.min(distance, 400);
    const cx = (start.x + end.x) / 2 - dy / distance * bend;
    const cy = (start.y + end.y) / 2 + dx / distance * bend;
    const takeoff = Math.min(start.halfW / Math.abs(cx - start.x), start.halfH / Math.abs(cy - start.y), 0.9);
    const landing = Math.min(end.halfW / Math.abs(cx - end.x), end.halfH / Math.abs(cy - end.y), 0.9);
    const x1 = start.x + (cx - start.x) * takeoff;
    const y1 = start.y + (cy - start.y) * takeoff;
    const x2 = end.x + (cx - end.x) * landing;
    const y2 = end.y + (cy - end.y) * landing;
    const thickness = 1.15 + Math.min(Math.log10(weight || 1) * 0.19, 0.9);
    ctx.globalAlpha = state.mapEntity ? 0.93 : 0.77;
    ctx.strokeStyle = categoryColors[category];
    ctx.lineWidth = thickness;
    ctx.setLineDash(category === 'royalty' ? [6, 4] : category === 'services' ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
    ctx.fillStyle = categoryColors[category];
    const angle = Math.atan2(y2 - cy, x2 - cx);
    const arrow = 6;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrow * Math.cos(angle - 0.45), y2 - arrow * Math.sin(angle - 0.45));
    ctx.lineTo(x2 - arrow * Math.cos(angle + 0.45), y2 - arrow * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function mapTransactions({ forMap = false, entity = state.mapEntity } = {}) {
  const month = state.year[state.mapBasis][state.period];
  return month.transactions.filter((transaction) => {
    const { category, from, to, policy } = transaction;
    const isToll = forMap && policy === 'PL_TOLL_BUDGET';
    if (state.filter !== 'all' && state.filter !== category && !(isToll && state.filter === 'goods')) return false;
    if (!entity || entity === from || entity === to) return true;
    if (category === 'goods' && entity === 'BE' && (from === 'CH' || to === 'CH')) return true;
    return isToll && entity === 'BE';
  });
}

function mapTable(transactions) {
  if (!transactions.length) return '<p class="empty-state">There are no matching transactions for this month.</p>';
  return `<div class="table-scroll"><table aria-label="Transaction ledger">
    <thead><tr><th scope="col">Transaction</th><th scope="col">From → to</th><th scope="col">Product family</th><th scope="col">Goods route</th><th scope="col">Units</th><th scope="col">USD per unit</th><th scope="col">Amount</th></tr></thead>
    <tbody>${transactions.map((transaction) => {
      const { from, to, category, policy, product, quantity, amount: total, external } = transaction;
      const unitPrice = category === 'goods' && quantity && !external ? amount(total / quantity) : '—';
      return `<tr>
        <td><span class="legend-item"><i class="swatch ${html(category)}"></i></span> <span class="table-name">${html(POLICY_LABELS[policy] ?? policy)}</span></td>
        <td>${html(mapLabel(from))} → ${html(mapLabel(to))}</td>
        <td>${html(productFor(product) || '—')}</td><td>${html(mapGoodsRoute(transaction) || '—')}</td>
        <td>${quantity ? amount(quantity, formatNumber) : '—'}</td><td>${unitPrice}</td><td>${amount(total)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderMap() {
  if (state.period >= state.revealed) state.mapBasis = 'budget';
  const filters = { all: 'All flows', ...categoryLabels };
  let visibleNodes = Object.entries(mapNodes);
  if (state.filter !== 'all') {
    const matching = mapTransactions({ forMap: true, entity: null });
    const participants = new Set();
    for (const { from, to, quantity, amount: total } of matching) {
      if (!quantity && !total) continue;
      participants.add(from);
      participants.add(to);
    }
    // The legal parties and the actual shipment endpoints can differ.
    for (const { from, to } of mapEdges(matching)) {
      participants.add(from);
      participants.add(to);
    }
    if (!participants.has(state.mapEntity)) state.mapEntity = null;
    visibleNodes = visibleNodes.filter(([id]) => participants.has(id));
  }
  const transactions = mapTransactions();
  pageBody.innerHTML = `
    <section class="panel" aria-labelledby="map-heading">
      <div class="panel-header">
        <div><h2 id="map-heading">Entities and flows</h2><p class="subtitle">Select an entity to view its transactions.</p></div>
        <div class="segmented" aria-label="Flow category">
          ${Object.entries(filters).map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="map-tools">
        <div class="view-controls">
          <label class="field">Month<select data-map-period>${months.map((month, index) => `<option value="${index}" ${state.period === index ? 'selected' : ''}>${month}</option>`).join('')}</select></label>
          <label class="field">Results<select data-map-basis><option value="budget">Budget</option><option value="actual" ${state.period < state.revealed ? '' : 'disabled'} ${state.mapBasis === 'actual' ? 'selected' : ''}>Actuals</option></select></label>
        </div>
        <div class="legend" aria-label="Flow legend">
          ${Object.entries(categoryLabels).map(([key, label]) => `<span class="legend-item"><i class="swatch ${key}"></i>${label}</span>`).join('')}
        </div>
      </div>
      <div class="map-scroll">
        <div class="map-stage">
          <canvas id="transaction-canvas" aria-hidden="true"></canvas>
          ${visibleNodes.map(([id, { manufacturing }]) => `<button type="button" data-map-entity="${id}" class="map-node ${id === 'US' || id === 'CH' ? 'principal' : ''} ${state.mapEntity && state.mapEntity !== id ? 'muted' : ''}" aria-pressed="${state.mapEntity === id}"><strong class="map-node-title">${html(mapLabel(id))}${manufacturing ? manufacturingIcon : ''}</strong><span>${mapRole[id]}</span></button>`).join('')}
        </div>
        <p class="map-credit">Goods arrows follow shipment routes. Asia and India markers are illustrative. <a href="https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/" target="_blank" rel="noopener noreferrer">Natural Earth</a></p>
      </div>
    </section>
    <section class="panel" aria-labelledby="flows-heading">
      <div class="panel-header">
        <div><h2 id="flows-heading">${state.mapEntity ? html(mapLabel(state.mapEntity)) : 'Transaction ledger'}</h2><p class="subtitle">${months[state.period]} · ${state.mapBasis === 'budget' ? 'Budget' : 'Actual'} · ${transactions.length} ${transactions.length === 1 ? 'transaction' : 'transactions'} · USD</p></div>
        ${state.mapEntity ? '<button type="button" class="button" data-action="clear-map-entity">Clear entity filter</button>' : ''}
      </div>
      ${mapTable(transactions)}
    </section>`;
  for (const node of document.querySelectorAll('[data-map-entity]')) {
    const [left, top] = mapNodes[node.dataset.mapEntity].position;
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
  }
  drawMap();
}

const policyFields = [
  ['lrdMargin', 'European LRD target operating margin'],
  ['ffdMargin', 'Asian and Canadian FFD target operating margin'],
  ['polandMarkup', 'Poland toll markup on budgeted cost'],
  ['belgiumMargin', 'Belgium warehouse target operating margin'],
  ['usServicesMarkup', 'US headquarters services markup'],
  ['indiaServicesMarkup', 'India shared services markup on budgeted cost'],
  ['royaltyRate', 'Swiss royalty to US, share of covered sales', MAX_ROYALTY_RATE * 100],
  ['usToSwissMarkup', 'US → Swiss cross-supply markup'],
  ['swissToUsMarkup', 'Swiss → US cross-supply markup'],
];

const rangeFields = [
  ['lrd', 'low', 'European LRD range, low'], ['lrd', 'high', 'European LRD range, high'],
  ['ffd', 'low', 'Asian and Canadian FFD range, low'], ['ffd', 'high', 'Asian and Canadian FFD range, high'],
  ['toll', 'low', 'Poland toll markup range, low'], ['toll', 'high', 'Poland toll markup range, high'],
  ['services', 'low', 'India services markup range, low'], ['services', 'high', 'India services markup range, high'],
];
const marketVariationLabels = { demand: 'Demand variation by market (±%)', salesPrice: 'Sales price variation by market (±%)' };
const correlationPairs = [[0, 1], [0, 2], [1, 2]];
const distributionColumns = [['min', 'Minimum'], ['mode', 'Most likely'], ['max', 'Maximum']];

function numberInput(name, value, { min, max, step = 'any', label, describedBy, disabled = false } = {}) {
  return `<input type="number" name="${name}" value="${html(value)}" step="${step}" ${min === undefined ? '' : `min="${min}"`} ${max === undefined ? '' : `max="${max}"`} ${label ? `aria-label="${html(label)}"` : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} ${disabled ? 'disabled' : 'required'}>`;
}

function percentInput(value) {
  return Number((value * 100).toFixed(8));
}

// The margin target is shown to two decimals. An unchanged field keeps the exact stored target.
function marginInput(value) {
  return Number((value * 100).toFixed(2));
}

function annualBudgetMargin(budget) {
  const totals = budget.reduce((year, { consolidated }) => ({
    revenue: year.revenue + consolidated.revenue,
    profit: year.profit + consolidated.operatingProfit,
  }), { revenue: 0, profit: 0 });
  return totals.profit / totals.revenue;
}

function rdAllocationLabel(usShare) {
  const foreignShare = 1 - usShare;
  return `Germany ${formatPercent.format(foreignShare * 0.60)} · Poland ${formatPercent.format(foreignShare * 0.40)} of total R&D`;
}

function renderSettings() {
  const defaults = createConfig();
  const {
    simulation, capacity, policies, annualOperatingMargin, rd = defaults.rd, ranges = defaults.ranges,
    tax = defaults.tax, customs = defaults.customs, priceFloor = defaults.priceFloor, services = defaults.services,
  } = state.config;
  const marketVariation = simulation.marketVariation ?? { demand: 0, salesPrice: 0 };
  // A scenario saved before these settings existed runs without them.
  const serviceCostVariation = simulation.serviceCostVariation ?? 0;
  const statAdjustment = simulation.statAdjustment ?? { max: 0, mean: 0 };
  const royalty = royaltyCheck(state.config);
  // Applying a scenario starts a new year, so the budget is the projection that matters here.
  const licensee = profitAllocation(state.year.budget);
  const marginLocked = state.revealed > 0;
  const target = annualOperatingMargin ?? annualBudgetMargin(state.year.budget);
  pageBody.innerHTML = `
    <form id="scenario-form" class="settings-form">
      <section class="panel" aria-labelledby="annual-plan-heading">
        <div class="panel-header"><div><h2 id="annual-plan-heading">Annual financial plan</h2><p class="subtitle">2027 consolidated budget and R&D assumptions</p></div></div>
        <div class="form-fields">
          <div class="scenario-plan-fields">
            <label class="field">Consolidated target operating margin (%)${numberInput('annualOperatingMargin', marginInput(target), { disabled: marginLocked })}</label>
            <label class="field">R&amp;D as a share of consolidated sales (%)${numberInput('rd.salesRate', percentInput(rd.salesRate), { min: 0, max: 10 })}</label>
            <label class="field">US share of R&amp;D (%)${numberInput('rd.usShare', percentInput(rd.usShare), { min: 0, max: 100 })}</label>
          </div>
          <p class="field-note">${marginLocked
            ? 'The margin target is locked once January actuals are revealed. Start a new scenario to change it.'
            : 'Set the margin before revealing January. The model recalculates goods costs to meet the annual budget target.'}</p>
          <p class="field-note"><span id="rd-allocation">${rdAllocationLabel(rd.usShare)}</span>. The US funds their work at actual cost plus 10%.</p>
        </div>
      </section>
      <div class="form-grid">
        <div class="detail-stack">
          <section class="panel" aria-labelledby="shock-heading">
            <div class="panel-header"><div><h2 id="shock-heading">Monthly shocks</h2><p class="subtitle">Triangular distributions · percentage changes</p></div></div>
            <div class="shock-table"><table>
              <thead><tr><th scope="col">Shock</th>${distributionColumns.map(([, label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead>
              <tbody>${SHOCK_KEYS.map((key) => `<tr>
                <td>${shockLabels[key]}</td>
                ${distributionColumns.map(([bound, label]) => `<td>${numberInput(`shock.${key}.${bound}`, percentInput(simulation.distributions[key][bound]), { min: -100, label: `${shockLabels[key]} ${label.toLowerCase()} (%)` })}</td>`).join('')}
              </tr>`).join('')}</tbody>
            </table></div>
            <div class="form-fields">
              <div class="field-pair">
                ${MARKET_SHOCK_KEYS.map((key) => `<label class="field">${marketVariationLabels[key]}${numberInput(`marketVariation.${key}`, percentInput(marketVariation[key]), { min: 0, max: 100 })}</label>`).join('')}
              </div>
              <p class="field-note">The shocks above move every market together. Each market’s demand and sales price also move by up to this much on their own each month. Enter 0 to keep all markets in step.</p>
              <label class="field">Service cost variation in Poland and India (±%)${numberInput('serviceCostVariation', percentInput(serviceCostVariation), { min: 0, max: 99 })}</label>
              <p class="field-note">Each service provider’s own cost moves by up to this much each month, on top of the effect of volume.</p>
              <label class="field">Simulation seed<input name="seed" value="${html(simulation.seed)}" maxlength="100" required></label>
            </div>
          </section>
          <section class="panel" aria-labelledby="corr-heading">
            <div class="panel-header"><div><h2 id="corr-heading">Shock correlations</h2><p class="subtitle">Correlation between each pair of underlying shocks</p></div></div>
            <div class="form-fields">
              ${correlationPairs.map(([i, j]) => `<label class="field">${shockLabels[SHOCK_KEYS[i]]} and ${shockLabels[SHOCK_KEYS[j]]}${numberInput(`corr.${i}.${j}`, simulation.correlation[i][j], { min: -1, max: 1 })}</label>`).join('')}
              <p class="field-note">Use coefficients from −1 to 1. All three coefficients must form a valid correlation matrix.</p>
            </div>
          </section>
        </div>
        <div class="detail-stack">
          <section class="panel" aria-labelledby="production-heading">
            <div class="panel-header"><div><h2 id="production-heading">Production capacity</h2><p class="subtitle">Maximum units per month, across all three product families</p></div></div>
            <div class="form-fields field-pair">
              ${Object.entries(capacity).map(([id, limit]) => `<label class="field">${html(labelFor(id))}${numberInput(`capacity.${id}`, limit, { min: 0, step: 1 })}</label>`).join('')}
            </div>
          </section>
          <section class="panel" aria-labelledby="pricing-heading">
            <div class="panel-header"><div><h2 id="pricing-heading">Transfer pricing policies</h2><p class="subtitle">Targets and markups as percentages</p></div></div>
            <div class="form-fields">
              <div class="field-pair">
                ${policyFields.map(([key, label, max = 100]) => key === 'royaltyRate'
                  ? `<label class="field ${royalty.belowResearch || licensee.licenseeLoss ? 'field-flag' : ''}" id="royalty-field">${label}${numberInput(`policy.${key}`, percentInput(policies[key]), { min: 0, max, describedBy: 'royalty-warning royalty-loss-warning' })}</label>`
                  : `<label class="field">${label}${numberInput(`policy.${key}`, percentInput(policies[key]), { min: 0, max })}</label>`).join('')}
              </div>
              <p class="field-note">The royalty can be set anywhere from 0% to ${MAX_ROYALTY_RATE * 100}%.</p>
              <p id="royalty-warning" class="field-warning" role="status" ${royalty.belowResearch ? '' : 'hidden'}>${royalty.belowResearch ? html(royaltyWarning(royalty)) : ''}</p>
              <p id="royalty-loss-warning" class="field-warning" role="status" data-before-royalty="${licensee.swissBeforeRoyalty}" data-royalty-base="${licensee.royaltyBase}" ${licensee.licenseeLoss ? '' : 'hidden'}>${licensee.licenseeLoss ? html(licenseeLossWarning({ ...licensee, royaltyRate: royalty.royaltyRate })) : ''}</p>
            </div>
          </section>
          <section class="panel" aria-labelledby="floor-heading">
            <div class="panel-header"><div><h2 id="floor-heading">Goods price floor</h2><p class="subtitle">A lower limit on every goods transfer price</p></div></div>
            <div class="form-fields">
              <label class="check-field"><input type="checkbox" name="priceFloor.enabled" ${priceFloor.enabled ? 'checked' : ''}> Never price goods below standard cost plus a markup</label>
              <label class="field">Floor markup on standard cost (%)${numberInput('priceFloor.markup', percentInput(priceFloor.markup), { min: 0, max: 100 })}</label>
              <p class="field-note">Standard cost is budget materials and conversion, plus the Polish toll fee on goods the Swiss principal sells. While the rule is on, starting prices, policy prices, prices you enter and year-end credits cannot take a price below the floor.</p>
            </div>
          </section>
          <section class="panel" aria-labelledby="service-settings-heading">
            <div class="panel-header"><div><h2 id="service-settings-heading">Service fees</h2><p class="subtitle">Poland and India charge a fixed monthly fee</p></div></div>
            <div class="form-fields">
              <label class="field">Fixed overhead share of Poland’s conversion cost (%)${numberInput('services.polandFixedShare', percentInput(services.polandFixedShare), { min: 0, max: 100 })}</label>
              <p class="field-note">Each fee is the provider’s budgeted annual cost plus its policy markup, divided by twelve. The fixed share is measured at normal volume and does not fall when Poland converts fewer units. Enter 0 for a fully variable cost.</p>
            </div>
          </section>
          <section class="panel" aria-labelledby="stat-settings-heading">
            <div class="panel-header"><div><h2 id="stat-settings-heading">US GAAP to local statutory adjustment</h2><p class="subtitle">Revealed at the December close · share of each local entity’s operating expenses</p></div></div>
            <div class="form-fields">
              <div class="field-pair">
                <label class="field">Largest adjustment (%)${numberInput('statAdjustment.max', percentInput(statAdjustment.max), { min: 0, max: 100 })}</label>
                <label class="field">Average adjustment (%)${numberInput('statAdjustment.mean', percentInput(statAdjustment.mean), { min: 0, max: 100 })}</label>
              </div>
              <p class="field-note">Each entity outside the United States draws its own adjustment for the year. It can add or remove local cost. The arm’s-length ranges and local income tax are tested on the adjusted results. Enter 0 for both to keep local results equal to US GAAP.</p>
            </div>
          </section>
          <section class="panel" aria-labelledby="ranges-heading">
            <div class="panel-header"><div><h2 id="ranges-heading">Arm’s-length ranges</h2><p class="subtitle">Full-year operating margins for distributors and markups on cost for Poland and India, as percentages</p></div></div>
            <div class="form-fields">
              <div class="field-pair">
                ${rangeFields.map(([kind, bound, label]) => `<label class="field">${label}${numberInput(`range.${kind}.${bound}`, percentInput(ranges[kind][bound]), { min: 0, max: 100 })}</label>`).join('')}
              </div>
              <p class="field-note">A tested entity is flagged only when its full-year result leaves its range. Each range must contain the target above.</p>
            </div>
          </section>
          <section class="panel breakdown" aria-labelledby="royalty-heading">
            <div class="panel-header"><div><h2 id="royalty-heading">Swiss royalty to US</h2><p class="subtitle">${amount(policies.royaltyRate, formatPercent)} of ultimate European LRD third-party net sales plus Swiss direct sales to unrelated distributors. Asian related-party distributor sales are excluded.</p></div></div>
          </section>
        </div>
      </div>
      <section class="panel" aria-labelledby="tax-settings-heading">
        <div class="panel-header"><div><h2 id="tax-settings-heading">Income tax and customs duty</h2><p class="subtitle">Illustrative rates, as percentages</p></div></div>
        <div class="form-fields">
          <div class="rate-fields">
            ${TAXED_ENTITIES.map((id) => `<label class="field">${html(labelFor(id))} income tax${numberInput(`tax.${id}`, percentInput(tax.rates[id]), { min: 0, max: 99 })}</label>`).join('')}
          </div>
          <div class="rate-fields">
            ${CUSTOMS_ROUTES.map((route) => `<label class="field">${html(customsRouteLabel(route))} duty${numberInput(`duty.${route.key}`, percentInput(customs.rates[route.key]), { min: 0, max: 99 })}</label>`).join('')}
          </div>
          <p class="field-note">Income tax is each entity’s rate applied to its operating profit, and to its local statutory profit once the year is closed. Duty is charged on the declared transfer price of goods that cross a customs border and is reported as a memo. It is not deducted from operating profit.</p>
        </div>
      </section>
      <div id="scenario-message" aria-live="polite">${state.settingsMessage ? `<p class="form-message">${html(state.settingsMessage)}</p>` : ''}</div>
      <div class="panel form-footer">
        <p class="field-note">Applying a scenario recalculates all 12 months, resets the reveal sequence, and clears saved transfer prices.</p>
        <div class="view-controls"><button type="button" class="button" data-action="defaults">Restore defaults</button><button class="button primary" type="submit">Apply scenario</button></div>
      </div>
    </form>`;
}

function readSettings(form) {
  const data = new FormData(form);
  const config = createConfig();
  const enteredTarget = data.get('annualOperatingMargin');
  const previousTarget = state.config.annualOperatingMargin ?? annualBudgetMargin(state.year.budget);
  const displayedTarget = marginInput(previousTarget);
  config.annualOperatingMargin = enteredTarget === null || Number(enteredTarget) === displayedTarget
    ? previousTarget : Number(enteredTarget) / 100;
  config.rd.salesRate = Number(data.get('rd.salesRate')) / 100;
  config.rd.usShare = Number(data.get('rd.usShare')) / 100;
  config.simulation.seed = String(data.get('seed')).trim();
  for (const key of Object.keys(config.capacity)) config.capacity[key] = Number(data.get(`capacity.${key}`));
  for (const [key] of policyFields) config.policies[key] = Number(data.get(`policy.${key}`)) / 100;
  for (const [kind, bound] of rangeFields) config.ranges[kind][bound] = Number(data.get(`range.${kind}.${bound}`)) / 100;
  for (const key of MARKET_SHOCK_KEYS) config.simulation.marketVariation[key] = Number(data.get(`marketVariation.${key}`)) / 100;
  for (const id of TAXED_ENTITIES) config.tax.rates[id] = Number(data.get(`tax.${id}`)) / 100;
  for (const { key } of CUSTOMS_ROUTES) config.customs.rates[key] = Number(data.get(`duty.${key}`)) / 100;
  config.priceFloor = { enabled: data.get('priceFloor.enabled') === 'on', markup: Number(data.get('priceFloor.markup')) / 100 };
  config.services.polandFixedShare = Number(data.get('services.polandFixedShare')) / 100;
  config.simulation.serviceCostVariation = Number(data.get('serviceCostVariation')) / 100;
  config.simulation.statAdjustment = { max: Number(data.get('statAdjustment.max')) / 100, mean: Number(data.get('statAdjustment.mean')) / 100 };
  for (const key of SHOCK_KEYS) {
    for (const [bound] of distributionColumns) {
      config.simulation.distributions[key][bound] = Number(data.get(`shock.${key}.${bound}`)) / 100;
    }
  }
  for (const [i, j] of correlationPairs) {
    const value = Number(data.get(`corr.${i}.${j}`));
    config.simulation.correlation[i][j] = value;
    config.simulation.correlation[j][i] = value;
  }
  return config;
}

function stopRun() {
  clearTimeout(runTimer);
  runTimer = null;
  state.running = false;
}

function revealNext() {
  state.period = state.revealed;
  state.revealed += 1;
  state.mapBasis = 'actual';
  state.pricingMessage = '';
  state.yearEndMessage = '';
}

/** Open the pop-up that explains where each tested entity finished the year, and why. */
function openYearSummary() {
  if (state.revealed !== 12 || !summaryDialog) return;
  const { config } = state;
  const explanations = explainYear(config, state.year);
  summaryDialog.innerHTML = renderYearSummary({
    explanations,
    untouched: !(config.goodsPriceSchedule?.length || config.serviceFeeSchedule?.length),
    adjusted: explanations.some(entry => entry.adjustment),
  });
  if (!summaryDialog.open) summaryDialog.showModal();
  summaryDialog.querySelector('.summary-body').scrollTop = 0;
  summaryDialog.querySelector('#year-summary-title').focus();
}

/** Reveal every remaining month at the prices and fees now in force, then explain the year. */
function runFullYear() {
  if (state.running || state.revealed >= 12) return;
  state.running = true;
  const step = () => {
    revealNext();
    // Without motion the year closes in one step.
    while (reducedMotion.matches && state.revealed < 12) revealNext();
    if (state.revealed < 12) {
      if (state.view === 'dashboard') render();
      runTimer = setTimeout(step, RUN_STEP_MS);
      return;
    }
    stopRun();
    storeState();
    render();
    announcement.textContent = 'December actuals revealed. The year is closed.';
    openYearSummary();
  };
  step();
}

/** Start the same year again from January, with prices, fees and year-end choices back at their start. */
function replayYear() {
  stopRun();
  const config = { ...state.config, goodsPriceSchedule: [], serviceFeeSchedule: [], yearEnd: createConfig().yearEnd };
  state.config = config;
  state.year = runYear(config);
  state.revealed = 0;
  state.period = 0;
  state.mapBasis = 'budget';
  state.settingsMessage = '';
  state.pricingMessage = '';
  state.yearEndMessage = '';
  storeState();
  if (summaryDialog?.open) summaryDialog.close();
  announcement.textContent = 'The same year is ready to replay from January.';
  if (state.view === 'dashboard') render();
  else {
    location.hash = 'dashboard';
    setView('dashboard');
  }
  document.querySelector('#page-title').focus();
}

function applyScenario(config, message) {
  const year = runYear(config);
  stopRun();
  state.config = config;
  state.year = year;
  state.revealed = 0;
  state.period = 0;
  state.mapBasis = 'budget';
  state.settingsMessage = `${message} Full-year budget operating margin is ${formatPercent.format(annualBudgetMargin(year.budget))}.`;
  state.pricingMessage = '';
  state.yearEndMessage = '';
  storeState();
  render();
}

function render() {
  for (const button of navButtons) {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  renderHeader();
  if (state.view === 'brief') pageBody.innerHTML = renderBrief({ config: state.config, revealed: state.revealed });
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'map') renderMap();
  if (state.view === 'pricing') {
    const review = reviewGoodsPricing(state.config, state.revealed);
    const budget = state.year.budget.reduce((year, { consolidated }) => ({
      revenue: year.revenue + consolidated.revenue, operatingProfit: year.operatingProfit + consolidated.operatingProfit,
    }), { revenue: 0, operatingProfit: 0 });
    pageBody.innerHTML = renderGoodsPricing({
      ...review, revealed: state.revealed, message: state.pricingMessage, yearEndMessage: state.yearEndMessage,
      serviceBudget: state.year.budget.map(month => month.services),
      budget: { ...budget, operatingMargin: budget.operatingProfit / budget.revenue, ...summarizeTaxAndCustoms(state.config, state.year.budget) },
    });
  }
  if (state.view === 'settings') renderSettings();
}

function setView(view, { focus = false } = {}) {
  if (view === state.view) return;
  state.view = view;
  render();
  if (focus) document.querySelector('#page-title').focus();
  window.scrollTo(0, 0);
}

function focusAfterRender(button) {
  const { action, period, metric, filter, mapEntity } = button.dataset;
  const className = ['month-button', 'bar-group', 'table-select'].find((key) => button.classList.contains(key));
  const selector = action ? `[data-action="${action}"]`
    : period !== undefined && className ? `.${className}[data-period="${period}"]`
    : metric ? `[data-metric="${metric}"]`
    : filter ? `[data-filter="${filter}"]`
    : mapEntity ? `[data-map-entity="${mapEntity}"]`
    : null;
  if (selector) document.querySelector(selector)?.focus({ preventScroll: true });
}

for (const button of navButtons) {
  button.insertAdjacentHTML('afterbegin', icon(button.dataset.view));
  button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (location.hash !== `#${view}`) location.hash = view;
    setView(view, { focus: true });
  });
}

window.addEventListener('hashchange', () => setView(viewFromHash(), { focus: state.view === 'brief' }));
window.addEventListener('resize', () => {
  if (state.view === 'map') drawMap();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-goods-price-quote')) {
    useGoodsPriceQuote(button);
    return;
  }
  const { action, period, metric, filter, mapEntity } = button.dataset;
  if (action === 'run-year') {
    runFullYear();
    return;
  }
  if (action === 'year-summary') {
    openYearSummary();
    return;
  }
  if (action === 'close-summary') {
    summaryDialog.close();
    return;
  }
  if (action === 'replay-year') {
    replayYear();
    return;
  }
  if (state.running && (action === 'reveal' || period !== undefined)) return;
  if (action === 'reveal' && state.revealed < 12) {
    revealNext();
    storeState();
    announcement.textContent = `${months[state.period]} actuals revealed.`;
  } else if (action === 'review-prices' || action === 'start') {
    if (summaryDialog?.open) summaryDialog.close();
    const view = action === 'start' ? 'dashboard' : 'pricing';
    location.hash = view;
    setView(view, { focus: true });
    return;
  } else if (action === 'defaults') {
    applyScenario(createConfig(), 'Default scenario restored. All 12 months are ready to reveal.');
    focusAfterRender(button);
    return;
  } else if (action === 'clear-map-entity') {
    state.mapEntity = null;
  } else if (period !== undefined) {
    state.period = Number(period);
  } else if (metric) {
    state.metric = metric;
  } else if (filter) {
    state.filter = filter;
  } else if (mapEntity) {
    state.mapEntity = state.mapEntity === mapEntity ? null : mapEntity;
  } else {
    return;
  }
  const scrollPositions = [...pageBody.querySelectorAll('.month-strip, .chart-scroll, .map-scroll, .table-scroll')].map((element) => element.scrollLeft);
  render();
  for (const [index, element] of [...pageBody.querySelectorAll('.month-strip, .chart-scroll, .map-scroll, .table-scroll')].entries()) {
    element.scrollLeft = scrollPositions[index] ?? 0;
  }
  if (action === 'reveal') {
    const month = document.querySelector('.month-button[aria-pressed="true"]');
    const strip = month?.parentElement;
    if (strip && month.offsetLeft + month.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = month.offsetLeft - strip.clientWidth + month.offsetWidth + 6;
    }
    if (state.revealed === 12) month?.focus({ preventScroll: true });
  }
  focusAfterRender(button);
  // Closing December by hand ends the year the same way the automatic run does.
  if (action === 'reveal' && state.revealed === 12) openYearSummary();
});

// A click on the backdrop closes the pop-up. Escape closes it without any help.
summaryDialog?.addEventListener('click', (event) => {
  if (event.target === summaryDialog) summaryDialog.close();
});
summaryDialog?.addEventListener('close', () => {
  (document.querySelector('[data-action="year-summary"]') ?? document.querySelector('#page-title'))?.focus({ preventScroll: true });
});

pageBody.addEventListener('change', (event) => {
  const select = event.target;
  if (select.matches('[data-map-period]')) state.period = Number(select.value);
  else if (select.matches('[data-map-basis]')) state.mapBasis = select.value;
  else return;
  const selector = select.matches('[data-map-period]') ? '[data-map-period]' : '[data-map-basis]';
  renderMap();
  document.querySelector(selector).focus({ preventScroll: true });
});

// Flag the royalty as it is typed, before the scenario is applied. The rate is never blocked.
function updateRoyaltyWarning(form) {
  const royalty = form.elements['policy.royaltyRate'];
  const research = form.elements['rd.salesRate'];
  const belowResearch = royalty.value !== '' && research.value !== '' && royalty.valueAsNumber < research.valueAsNumber;
  const warning = form.querySelector('#royalty-warning');
  warning.hidden = !belowResearch;
  warning.textContent = belowResearch
    ? royaltyWarning({ royaltyRate: royalty.valueAsNumber / 100, researchRate: research.valueAsNumber / 100 }) : '';

  // The licensee's budget profit falls in a straight line with the rate, so the typed
  // rate can be projected from the applied scenario without rerunning the year.
  const lossWarning = form.querySelector('#royalty-loss-warning');
  const swissBeforeRoyalty = Number(lossWarning.dataset.beforeRoyalty);
  const royaltyBase = Number(lossWarning.dataset.royaltyBase);
  const royaltyRate = royalty.valueAsNumber / 100;
  const swiss = swissBeforeRoyalty - royaltyRate * royaltyBase;
  const licenseeLoss = royalty.value !== '' && Number.isFinite(swiss) && swiss <= -0.005;
  lossWarning.hidden = !licenseeLoss;
  lossWarning.textContent = licenseeLoss ? licenseeLossWarning({
    royaltyRate, swiss, swissBeforeRoyalty, breakEvenRate: royaltyBase ? swissBeforeRoyalty / royaltyBase : null,
  }) : '';
  form.querySelector('#royalty-field').classList.toggle('field-flag', belowResearch || licenseeLoss);
}

pageBody.addEventListener('input', (event) => {
  const { name, form } = event.target;
  if (name === 'policy.royaltyRate' || name === 'rd.salesRate') updateRoyaltyWarning(form);
  if (name !== 'rd.usShare' || !event.target.validity.valid) return;
  document.querySelector('#rd-allocation').textContent = rdAllocationLabel(event.target.valueAsNumber / 100);
});

pageBody.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'goods-pricing-form') {
    event.preventDefault();
    try {
      const priced = applyGoodsPrices(state.config, state.revealed, readGoodsPriceOverrides(form));
      const config = applyServiceFees(priced, state.revealed, readServiceFees(form));
      if (config !== state.config) {
        const year = runYear(config);
        reviewGoodsPricing(config, state.revealed);
        state.year = year;
        state.config = config;
        state.pricingMessage = `New prices and fees apply from ${months[state.revealed]}. The forecast has been updated.`;
        storeState();
      } else {
        state.pricingMessage = 'The current transfer prices and fees are still in effect.';
      }
      render();
      document.querySelector('#goods-pricing-form button[type="submit"]').focus({ preventScroll: true });
    } catch (error) {
      document.querySelector('#goods-pricing-message').innerHTML = pricingStatus(error.message, true);
    }
    return;
  }
  if (form.id === 'year-end-form') {
    event.preventDefault();
    try {
      const config = applyYearEndAdjustments(state.config, state.revealed, readYearEndChoices(form));
      if (config !== state.config) {
        state.year = runYear(config);
        state.config = config;
        state.yearEndMessage = 'Year-end adjustments posted to the December close.';
        storeState();
      } else {
        state.yearEndMessage = 'The year-end adjustments are unchanged.';
      }
      render();
      document.querySelector('#year-end-form button[type="submit"]').focus({ preventScroll: true });
    } catch (error) {
      document.querySelector('#year-end-message').innerHTML = pricingStatus(error.message, true);
    }
    return;
  }
  if (form.id !== 'scenario-form') return;
  event.preventDefault();
  try {
    applyScenario(readSettings(form), 'Scenario applied. All 12 budget months have been recalculated.');
    document.querySelector('#scenario-form button[type="submit"]').focus({ preventScroll: true });
  } catch (error) {
    document.querySelector('#scenario-message').innerHTML = `<p role="alert" class="form-error">${html(error.message)}</p>`;
  }
});

render();
