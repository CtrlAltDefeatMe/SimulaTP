import { ENTITIES, POLICY_LABELS, PRODUCTS } from './engine.mjs';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactPercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 4 });
const monthNames = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const reviewMonths = [3, 6, 9];
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
    <input type="number" inputmode="decimal" min="0" step="0.01" aria-label="${html(label)}"
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

function pricingTable(routes, editing) {
  return `<section class="panel" aria-labelledby="goods-pricing-table-heading">
    <div class="panel-header"><div><h2 id="goods-pricing-table-heading">Goods prices by channel</h2><p class="subtitle">USD per unit</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="goods-pricing-table-heading">
      <table class="pricing-table" aria-labelledby="goods-pricing-table-heading">
        <thead><tr>
          <th scope="col">Channel</th><th scope="col">TP policy</th><th scope="col">Product family</th>
          <th scope="col">Current price</th><th scope="col">Policy price</th><th scope="col">New price</th>
        </tr></thead>
        ${routes.map(route => `<tbody data-pricing-channel="${html(route.key)}">
          ${route.prices.map((price, index) => `<tr>
            ${index === 0 ? `<th scope="rowgroup" class="pricing-channel" rowspan="${route.prices.length}">
              ${html(entityName(route.from))} <span aria-hidden="true">→</span><span class="visually-hidden"> to </span> ${html(entityName(route.to))}
            </th><td class="pricing-policy" rowspan="${route.prices.length}">${html(shortPolicy(route))}</td>` : ''}
            <th scope="row" class="pricing-family">${html(productName(price.product))}</th>
            <td>${format(price.applied)}</td>
            <td>${editing ? policyPriceButton(route, price) : format(price.recommended)}</td>
            <td class="pricing-edit">${editing ? priceInput(route, price) : '—'}</td>
          </tr>`).join('')}
          ${editing && route.note ? `<tr class="pricing-route-note"><td colspan="6">${html(route.note)}</td></tr>` : ''}
        </tbody>`).join('')}
      </table>
    </div>
  </section>`;
}

function entityResultsPanel(revealed, rows, routes) {
  const showForecast = revealed < 12;
  const actualHeading = revealed ? `YTD actuals through ${monthName(revealed)}` : 'YTD actuals';
  const title = showForecast ? 'YTD actuals and full-year forecast' : 'Full-year actuals';
  const detail = showForecast
    ? 'The forecast combines YTD actuals with budget assumptions for the remaining months at current goods transfer prices.'
    : 'January through December 2027';
  const columnHeadings = (isForecast = false) => resultColumns.map(([, label], index) =>
    `<th scope="col"${isForecast && index === 0 ? ' class="pricing-forecast-first"' : ''}>${html(label)}</th>`).join('');
  const targets = new Map(routes.map(({ to, targetMargin }) => [to, targetMargin]));
  const resultCells = (result, policy, isForecast = false) => resultColumns.map(([key, , formatter], index) => {
    let policyDetails = '';
    if (key === 'operatingMargin' && Number.isFinite(policy?.target)) {
      const comparable = Number.isFinite(policy.forecast) && format(policy.forecast, percent) !== format(result?.[key], percent)
        ? `${html(policy.label || 'Policy margin')} ${percent.format(policy.forecast)} · `
        : '';
      policyDetails = `<small class="pricing-margin-target">${comparable}Target ${percent.format(policy.target)}</small>`;
      if (isForecast && policy.outOfPolicy) policyDetails += '<small class="pricing-policy-status">Out of policy</small>';
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
        const statusClass = showForecast && comparison.outOfPolicy ? 'pricing-out-of-policy' : '';
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
      <p>The historical reference price equals the distributor’s base net resale price less operating expenses and the historical operating margin. The assumptions are 13% for expenses and 3% for margin at LRDs, and 19% for expenses and 7.5% for margin at FFDs. Both percentages are applied to the base net resale price.</p>
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

export function renderGoodsPricing({ revealed, effectiveMonth, routes, message, entityResults, openingPriceMethod }) {
  const editing = reviewMonths.includes(revealed) && effectiveMonth === revealed + 1;
  const nextReview = reviewMonths.find(month => month > revealed);
  const results = entityResultsPanel(revealed, entityResults, routes);
  const assumptions = openingInventoryPanel(routes, openingPriceMethod);
  const prices = pricingTable(routes, editing);
  if (!editing) return `${results}${assumptions}
    ${nextReview ? `<section class="panel pricing-period" aria-labelledby="pricing-review-heading">
      <div>
        <p class="pricing-period-label">Next quarterly review</p>
        <h2 id="pricing-review-heading">${monthName(nextReview)} close</h2>
      </div>
      <div class="pricing-period-copy"><p>Reveal ${monthName(nextReview)} actuals to review ${periodLabel(nextReview + 1)} prices.</p></div>
    </section>` : ''}
    ${prices}`;

  return `${results}${assumptions}<form id="goods-pricing-form" class="pricing-form">
    <section class="panel pricing-period" aria-labelledby="pricing-period-heading">
      <div>
        <p class="pricing-period-label">${monthName(revealed)} close · price review</p>
        <h2 id="pricing-period-heading">${periodLabel(effectiveMonth)}</h2>
      </div>
      <div class="pricing-period-copy">
        <p id="pricing-override-help">Select a policy price or enter your own USD per unit. Blank fields keep their current prices.</p>
      </div>
    </section>
    ${prices}
    <div class="panel form-footer pricing-footer">
      <div id="goods-pricing-message">${pricingStatus(message)}</div>
      <button class="button primary" type="submit">Apply transfer prices</button>
    </div>
  </form>`;
}

export function useGoodsPriceQuote(button) {
  const input = button.closest('tr')?.querySelector('[data-goods-price-route]');
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
