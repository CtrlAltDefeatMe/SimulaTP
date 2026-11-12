import { DISTRIBUTOR_COST_RATE, ENTITIES, POLICY_LABELS, PRODUCTS } from './engine.mjs';
import { allocationPanel, renderYearEnd } from './year-end-view.mjs';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactPercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 4 });
const markupPercent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const monthNames = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const reviewMonths = [3, 6, 9];
const statusLabels = { within: 'Within range', below: 'Below range', above: 'Above range', off: 'Out of policy' };
const resultColumns = [
  ['revenue', 'Net sales', dollars],
  ['rdExpense', 'R&D expense', dollars],
  ['operatingProfit', 'Operating profit', dollars],
  ['operatingMargin', 'Operating margin', percent],
];
function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function entityName(id) {
  if (id === 'consolidated') return 'Consolidated';
  return ENTITIES[id]?.name ?? id;
}

function productName(id) {
  return PRODUCTS[id]?.name ?? id;
}

function monthName(month) {
  return monthNames.format(new Date(Date.UTC(2027, month - 1, 1)));
}

function periodLabel(month) {
  return `${monthName(month)}–December 2027`;
}

function format(value, formatter = dollars) {
  return Number.isFinite(value) ? formatter.format(value) : '—';
}

function priceInput(route, price) {
  const label = `${productName(price.product)} new price in USD per unit, ${entityName(route.from)} to ${entityName(route.to)}`;
  return `<div class="price-input">
    <span aria-hidden="true">$</span>
    <input type="number" inputmode="decimal" min="${Number.isFinite(price.floor) ? price.floor.toFixed(2) : 0}" step="0.01" aria-label="${html(label)}"
      aria-describedby="pricing-override-help"
      data-goods-price-route="${html(route.key)}" data-goods-price-product="${html(price.product)}">
  </div>`;
}

function policyPriceButton(route, price) {
  if (!Number.isFinite(price.recommended)) return '—';
  const display = dollars.format(price.recommended);
  const label = `Use policy price ${display} for ${productName(price.product)}, ${entityName(route.from)} to ${entityName(route.to)}`;
  return `<button class="pricing-quote" type="button" aria-label="${html(label)}" data-goods-price-quote="${price.recommended.toFixed(2)}">${display}</button>`;
}

function shortPolicy(route) {
  if (route.policy === 'LRD_GOODS' || route.policy === 'FFD_GOODS') {
    const method = route.policy === 'LRD_GOODS' ? 'LRD OM' : 'FFD OM';
    return Number.isFinite(route.targetMargin) ? `${method} ${compactPercent.format(route.targetMargin)}` : method;
  }
  if (route.policy === 'US_TO_CH' || route.policy === 'CH_TO_US') {
    return Number.isFinite(route.markup) ? `Cost + ${compactPercent.format(route.markup)}` : 'Cost plus';
  }
  return route.policyLabel ?? POLICY_LABELS[route.policy] ?? '';
}

// The current price as a markup on the supplier's standard cost. A price below cost shows in red.
function costMarkup(price) {
  if (!Number.isFinite(price.standardCost) || !price.standardCost) return '—';
  const markup = price.applied / price.standardCost - 1;
  const atFloor = Number.isFinite(price.floor) && price.applied <= price.floor;
  return `<span class="${markup < 0 ? 'negative' : ''}">${markup < 0 ? '−' : ''}${markupPercent.format(Math.abs(markup))}</span>${atFloor ? '<small class="pricing-margin-target">At the floor</small>' : ''}`;
}

function pricingTable(routes, editing, priceFloor) {
  const rule = `${priceFloor
    ? `Price floor: standard cost plus ${compactPercent.format(priceFloor.markup)}. No price can go below it.`
    : 'No price floor is set. A price can go below standard cost.'} Import duty is paid by the buyer on top of the price and becomes part of its cost of sales.`;
  return `<section class="panel" aria-labelledby="goods-pricing-table-heading">
    <div class="panel-header"><div><h2 id="goods-pricing-table-heading">Goods prices by channel</h2><p class="subtitle">USD per unit · ${rule}</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="goods-pricing-table-heading">
      <table class="pricing-table" aria-labelledby="goods-pricing-table-heading">
        <thead><tr>
          <th scope="col">Channel</th><th scope="col">TP policy</th><th scope="col">Product family</th>
          <th scope="col">Standard cost</th><th scope="col">Current price</th><th scope="col">Markup on cost</th>
          <th scope="col">Policy price</th><th scope="col">New price</th>
        </tr></thead>
        ${routes.map(route => `<tbody data-pricing-channel="${html(route.key)}">
          ${route.prices.map((price, index) => `<tr>
            ${index === 0 ? `<th scope="rowgroup" class="pricing-channel" rowspan="${route.prices.length}">
              ${html(entityName(route.from))} <span aria-hidden="true">→</span><span class="visually-hidden"> to </span> ${html(entityName(route.to))}
            </th><td class="pricing-policy" rowspan="${route.prices.length}">${html(shortPolicy(route))}</td>` : ''}
            <th scope="row" class="pricing-family">${html(productName(price.product))}</th>
            <td>${format(price.standardCost)}${Number.isFinite(price.floor) ? `<small class="pricing-margin-target">Floor ${format(price.floor)}</small>` : ''}</td>
            <td>${format(price.applied)}${price.duty ? `<small class="pricing-margin-target">+ ${markupPercent.format(price.duty)} import duty</small>` : ''}</td>
            <td>${costMarkup(price)}</td>
            <td>${editing ? policyPriceButton(route, price) : format(price.recommended)}</td>
            <td class="pricing-edit">${editing ? priceInput(route, price) : '—'}</td>
          </tr>`).join('')}
          ${editing && route.note ? `<tr class="pricing-route-note"><td colspan="8">${html(route.note)}</td></tr>` : ''}
        </tbody>`).join('')}
      </table>
    </div>
  </section>`;
}

const serviceNames = { PL: 'Toll manufacturing', IN: 'Shared services' };

function feeInput(service) {
  const label = `New monthly fee in USD, ${entityName(service.id)}`;
  return `<div class="price-input">
    <span aria-hidden="true">$</span>
    <input type="number" inputmode="decimal" min="0" step="0.01" aria-label="${html(label)}"
      aria-describedby="pricing-override-help" data-service-fee="${html(service.id)}">
  </div>`;
}

function policyFeeButton(service) {
  if (!Number.isFinite(service.recommended)) return '—';
  const display = dollars.format(service.recommended);
  const label = `Use policy fee ${display} a month for ${entityName(service.id)}`;
  return `<button class="pricing-quote" type="button" aria-label="${html(label)}" data-goods-price-quote="${service.recommended.toFixed(2)}">${display}</button>`;
}

// Poland and India are paid a fixed monthly fee, so their markup moves with their cost.
function serviceFeeTable(services, actual, serviceBudget, editing) {
  const total = (months, id, key) => months.reduce((sum, month) => sum + month[id][key], 0);
  // The year so far against the budget for the same months, so a slow season is not read as a saving.
  const toDate = (id) => {
    if (!actual.length) return null;
    const months = actual.map(month => month.services);
    const cost = total(months, id, 'cost');
    return { cost, budget: total(serviceBudget.slice(0, actual.length), id, 'cost'), fees: total(months, id, 'fee') };
  };
  return `<section class="panel" aria-labelledby="service-fee-heading">
    <div class="panel-header"><div><h2 id="service-fee-heading">Service fees</h2><p class="subtitle">USD per month · a fixed fee set from budgeted cost plus the policy markup</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="service-fee-heading">
      <table class="pricing-table service-fee-table" aria-labelledby="service-fee-heading">
        <thead><tr>
          <th scope="col">Service</th><th scope="col">TP policy</th><th scope="col">Budget cost per month</th><th scope="col">Cost to date</th>
          <th scope="col">Markup to date</th><th scope="col">Current fee</th><th scope="col">Policy fee</th><th scope="col">New fee</th>
        </tr></thead>
        <tbody>${services.map((service) => {
          const ytd = toDate(service.id);
          return `<tr>
            <th scope="row" class="pricing-channel">${html(entityName(service.id))} <span aria-hidden="true">→</span><span class="visually-hidden"> to </span> ${html(service.customers.map(entityName).join(', '))}
              <small class="pricing-margin-target">${serviceNames[service.id]}</small></th>
            <td class="pricing-policy">Cost + ${compactPercent.format(service.target)}<small class="pricing-margin-target">Range ${compactPercent.format(service.low)}–${compactPercent.format(service.high)}</small></td>
            <td>${format(service.budgetCost)}</td>
            <td>${ytd ? `${format(ytd.cost)}<small class="pricing-margin-target">${ytd.cost < ytd.budget ? '−' : '+'}${markupPercent.format(Math.abs(ytd.cost / ytd.budget - 1))} vs budget to date</small>` : '—'}</td>
            <td>${ytd ? percent.format(ytd.fees / ytd.cost - 1) : '—'}</td>
            <td>${format(service.fee)}<small class="pricing-margin-target">${markupPercent.format(service.fee / service.budgetCost - 1)} on budget cost</small></td>
            <td>${editing ? policyFeeButton(service) : format(service.recommended)}</td>
            <td class="pricing-edit">${editing ? feeInput(service) : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <p class="field-note panel-note">The policy fee is the monthly fee for the rest of the year that brings the full-year markup on cost back to target, counting what has already been charged.</p>
  </section>`;
}

function entityResultsPanel(revealed, rows, routes) {
  const showForecast = revealed < 12;
  const actualHeading = revealed ? `YTD actuals through ${monthName(revealed)}` : 'YTD actuals';
  const title = showForecast ? 'YTD actuals and full-year forecast' : 'Full-year actuals';
  const detail = showForecast
    ? 'US GAAP. The forecast combines YTD actuals with budget assumptions for the remaining months at current transfer prices and fees. Range checks are provisional until December, when they move to local statutory results.'
    : 'January through December 2027 · US GAAP, with each range tested on the local statutory result';
  const columnHeadings = (isForecast = false) => resultColumns.map(([, label], index) =>
    `<th scope="col"${isForecast && index === 0 ? ' class="pricing-forecast-first"' : ''}>${html(label)}</th>`).join('');
  const targets = new Map(routes.map(({ to, targetMargin }) => [to, targetMargin]));
  const resultCells = (result, policy, isForecast = false) => resultColumns.map(([key, , formatter], index) => {
    let policyDetails = '';
    if (key === 'operatingMargin' && Number.isFinite(policy?.target)) {
      // One short line each, so the margin column stays narrow.
      const detail = text => `<small class="pricing-margin-target">${text}</small>`;
      const stat = policy.basis === 'stat';
      const name = policy.measure === 'markup' ? 'markup' : policy.label || 'margin';
      if (stat && Number.isFinite(policy.forecast)) {
        if (Number.isFinite(policy.gaap)) policyDetails += detail(`US GAAP ${html(name)} ${percent.format(policy.gaap)}`);
        policyDetails += detail(`Local stat ${html(name)} ${percent.format(policy.forecast)}`);
      } else if (Number.isFinite(policy.forecast) && format(policy.forecast, percent) !== format(result?.[key], percent)) {
        policyDetails += detail(`${html(policy.label || 'Policy margin')} ${percent.format(policy.forecast)}`);
      }
      if (Number.isFinite(policy.low) && policy.low !== policy.high) {
        policyDetails += detail(`Range ${percent.format(policy.low)}–${percent.format(policy.high)}`);
      }
      policyDetails += detail(`Target ${percent.format(policy.target)}`);
      if (policy.outOfPolicy) {
        policyDetails += `<small class="pricing-policy-status">${statusLabels[policy.status] ?? statusLabels.off}</small>`;
        if (policy.exposure > 0) policyDetails += `<small class="pricing-policy-status">Tax at risk ${dollars.format(policy.exposure)}</small>`;
      } else if (policy.status === 'within' && Number.isFinite(policy.low) && Number.isFinite(policy.forecast)) {
        policyDetails += `<small class="pricing-policy-ok">${statusLabels.within}</small>`;
      }
    }
    const forecastClasses = index === 0 ? 'pricing-forecast-value pricing-forecast-first' : 'pricing-forecast-value';
    return `<td${isForecast ? ` class="${forecastClasses}"` : ''}>${format(result?.[key], formatter)}${policyDetails}</td>`;
  }).join('');
  return `<section class="panel pricing-results" aria-labelledby="pricing-results-heading">
    <div class="panel-header"><div><h2 id="pricing-results-heading">${title}</h2><p class="subtitle">${detail}</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="pricing-results-heading"><table class="pricing-results-table ${showForecast ? 'has-forecast' : ''}" aria-labelledby="pricing-results-heading">
      <colgroup span="1"></colgroup><colgroup span="${resultColumns.length}"></colgroup>${showForecast ? `<colgroup span="${resultColumns.length}"></colgroup>` : ''}
      <thead>
        ${showForecast ? `<tr>
          <th scope="col" rowspan="2">Entity</th>
          <th scope="colgroup" colspan="${resultColumns.length}">${actualHeading}</th>
          <th scope="colgroup" colspan="${resultColumns.length}" class="pricing-forecast-cell">Full-year forecast</th>
        </tr>` : ''}
        <tr>${showForecast ? '' : '<th scope="col">Entity</th>'}${columnHeadings()}${showForecast ? columnHeadings(true) : ''}</tr>
      </thead>
      <tbody>${rows.map(({ id, ytd, fullYear, policy }) => {
        const comparison = policy ?? { target: targets.get(id) };
        const rowClass = id === 'consolidated' ? 'pricing-total' : '';
        const statusClass = comparison.outOfPolicy ? 'pricing-out-of-policy' : '';
        return `<tr class="${[rowClass, statusClass].filter(Boolean).join(' ')}">
          <th scope="row" class="table-name">${html(entityName(id))}</th>
          ${resultCells(revealed ? ytd : null, showForecast ? undefined : comparison)}${showForecast ? resultCells(fullYear, comparison, true) : ''}
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </section>`;
}

function openingInventoryPanel(routes, openingPriceMethod) {
  const notes = routes.filter(route => route.openingNote);
  return `<section class="panel pricing-assumptions" aria-labelledby="pricing-assumptions-heading">
    <div class="panel-header"><h2 id="pricing-assumptions-heading">January opening inventory and starting prices</h2></div>
    <div class="pricing-assumptions-copy">
      <p>The model assumes each distributor opens January 1 with two months of base demand per product family, one month per lot. FIFO issues the November 2026 lot first, at 97% of the historical reference transfer price. The December 2026 lot carries 100% of that reference price.</p>
      <p>The historical reference price equals the distributor’s base net resale price less operating expenses and the historical operating margin. The assumptions are ${compactPercent.format(DISTRIBUTOR_COST_RATE.lrd)} for expenses and 3% for margin at LRDs, and ${compactPercent.format(DISTRIBUTOR_COST_RATE.ffd)} for expenses and 7.5% for margin at FFDs. Both percentages are applied to the base net resale price. Where a distributor imports from another customs block, that reference is its landed cost: the transfer price plus the duty it pays on top.</p>
      <p>During the year each distributor orders enough to hold about two months of base demand. A new transfer price applies to new shipments only, and the older stock is sold first. A price change therefore reaches a distributor’s cost of sales about two months after it takes effect.</p>
      <p>When a scenario starts, the model sets transfer prices for new shipments to target each distributor’s full-year budget margin, using the FIFO costs and quantities expected to enter cost of sales. January’s margin can differ from the annual target because it reflects the cost of the opening lots sold that month.</p>
      ${openingPriceMethod === 'legacy' ? '<p class="pricing-assumptions-note">This in-progress scenario started with the prior pricing method. The FIFO-based starting prices apply to new or reset scenarios.</p>' : ''}
      ${notes.length ? `<ul class="pricing-assumptions-note">${notes.map(route => `<li><strong>${html(entityName(route.from))} to ${html(entityName(route.to))}.</strong> ${html(route.openingNote)}</li>`).join('')}</ul>` : ''}
    </div>
  </section>`;
}

export function pricingStatus(message, error = false) {
  if (!message) return '';
  return error
    ? `<p class="form-error" role="alert">${html(message)}</p>`
    : `<p class="form-message" role="status">${html(message)}</p>`;
}

export function renderGoodsPricing(review) {
  const { revealed, effectiveMonth, routes, message, entityResults, openingPriceMethod } = review;
  const editing = reviewMonths.includes(revealed) && effectiveMonth === revealed + 1;
  const nextReview = reviewMonths.find(month => month > revealed);
  const yearEnd = revealed === 12 && review.yearEnd
    ? renderYearEnd({ ...review, message: review.yearEndMessage }) : '';
  const results = `${yearEnd}${entityResultsPanel(revealed, entityResults, routes)}${allocationPanel(review)}`;
  const assumptions = openingInventoryPanel(routes, openingPriceMethod);
  const prices = `${pricingTable(routes, editing, review.priceFloor)}${serviceFeeTable(review.services, review.actual, review.serviceBudget, editing)}`;
  if (!editing) return `${results}${assumptions}
    ${nextReview ? `<section class="panel pricing-period" aria-labelledby="pricing-review-heading">
      <div>
        <p class="pricing-period-label">Next quarterly review</p>
        <h2 id="pricing-review-heading">${monthName(nextReview)} close</h2>
      </div>
      <div class="pricing-period-copy"><p>Reveal ${monthName(nextReview)} actuals to review ${periodLabel(nextReview + 1)} prices and fees.</p></div>
    </section>` : ''}
    ${prices}`;

  return `${results}${assumptions}<form id="goods-pricing-form" class="pricing-form">
    <section class="panel pricing-period" aria-labelledby="pricing-period-heading">
      <div>
        <p class="pricing-period-label">${monthName(revealed)} close · price review</p>
        <h2 id="pricing-period-heading">${periodLabel(effectiveMonth)}</h2>
      </div>
      <div class="pricing-period-copy">
        <p id="pricing-override-help">Select a policy price or fee, or enter your own in USD. Goods prices are per unit and service fees are per month. Blank fields keep their current values.</p>
      </div>
    </section>
    ${prices}
    <div class="panel form-footer pricing-footer">
      <div id="goods-pricing-message">${pricingStatus(message)}</div>
      <button class="button primary" type="submit">Apply prices and fees</button>
    </div>
  </form>`;
}

export function useGoodsPriceQuote(button) {
  const input = button.closest('tr')?.querySelector('[data-goods-price-route], [data-service-fee]');
  if (!input) return;
  input.value = button.dataset.goodsPriceQuote;
  input.focus();
}

export function readGoodsPriceOverrides(form) {
  const overrides = Object.create(null);
  for (const input of form.querySelectorAll('[data-goods-price-route][data-goods-price-product]')) {
    if (input.value === '') continue;
    const price = input.valueAsNumber;
    if (!Number.isFinite(price) || price < 0 || input.validity.stepMismatch || !Number.isSafeInteger(Math.round(price * 100))) {
      throw new RangeError('Enter a nonnegative price in USD with up to two decimal places.');
    }
    const { goodsPriceRoute: route, goodsPriceProduct: product } = input.dataset;
    overrides[route] ??= Object.create(null);
    overrides[route][product] = price;
  }
  return overrides;
}

export function readServiceFees(form) {
  const fees = Object.create(null);
  for (const input of form.querySelectorAll('[data-service-fee]')) {
    if (input.value === '') continue;
    const fee = input.valueAsNumber;
    if (!Number.isFinite(fee) || fee < 0 || input.validity.stepMismatch || !Number.isSafeInteger(Math.round(fee * 100))) {
      throw new RangeError('Enter a nonnegative monthly fee in USD with up to two decimal places.');
    }
    fees[input.dataset.serviceFee] = fee;
  }
  return fees;
}
