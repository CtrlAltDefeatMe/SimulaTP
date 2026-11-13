import { ENTITIES, PRODUCTS } from './engine.mjs';
import { realSize } from './format.mjs';

const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Prose shows amounts at their real size, such as $11.95M. The model's amounts are in thousands.
const dollars = realSize;
const pointsFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusLabels = { within: 'Within range', below: 'Below range', above: 'Above range' };
const driverLabels = {
  volume: 'Volume, mix and cost of goods', salesPrice: 'Sales prices', costs: 'Costs against the fixed fee',
  fees: 'Fee changes during the year', yearEnd: 'Year-end adjustment', stat: 'GAAP-to-stat adjustment',
};
// A driver smaller than this is left out of the written explanation.
const WORTH_SAYING = 0.001;

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const nameOf = id => ENTITIES[id]?.name ?? id;
const points = value => `${pointsFormat.format(Math.abs(value) * 100)} points`;
const signedPoints = value => `${value < 0 ? '−' : '+'}${pointsFormat.format(Math.abs(value) * 100)} pts`;
const moved = (value, measure) => `${value < 0 ? 'took' : 'added'} ${points(value)} ${value < 0 ? 'off' : 'to'} its ${measure}`;

/** The sentences that say why an entity finished where it did, largest effect first. */
function reasons(entry, pricesChanged) {
  const { facts, measure, service } = entry;
  const sentences = {
    salesPrice: driver => `Its sales prices averaged ${rate.format(Math.abs(facts.priceDeviation))} ${facts.priceDeviation < 0 ? 'below' : 'above'} budget${pricesChanged ? '' : ' while the prices it paid for goods stayed where they started'}, which ${moved(driver.points, measure)}.`,
    volume: driver => `Volume, mix and its cost of goods ${moved(driver.points, measure)}.`,
    costs: driver => {
      const output = entry.id === 'PL' && Math.abs(facts.unitsDeviation) >= 0.005
        ? ` It converted ${rate.format(Math.abs(facts.unitsDeviation))} ${facts.unitsDeviation < 0 ? 'fewer' : 'more'} units than budgeted. Its variable cost moved with output and its fixed overhead did not.` : '';
      return `Its costs ran ${rate.format(Math.abs(facts.costDeviation))} ${facts.costDeviation < 0 ? 'below' : 'above'} budget while its quarterly fee stayed fixed, which ${moved(driver.points, measure)}.${output}`;
    },
    fees: driver => `Fee changes at the quarterly reviews ${moved(driver.points, measure)}.`,
    yearEnd: driver => `The year-end adjustment ${moved(driver.points, measure)}.`,
    stat: driver => `An unexpected GAAP-to-stat adjustment of ${dollars.format(Math.abs(facts.statAdjustment))} brought the statutory ${service ? 'cost-plus markup' : 'operating margin'} ${driver.points < 0 ? 'down' : 'up'} ${percent.format(Math.abs(driver.points))} from the US GAAP result.`,
  };
  const said = entry.drivers.filter(driver => Math.abs(driver.points) >= WORTH_SAYING)
    .sort((left, right) => Math.abs(right.points) - Math.abs(left.points));
  // A price floor that held this distributor's prices up is part of why it finished low.
  const floor = [];
  if (entry.status === 'below' && facts.floor?.held.length) {
    const names = facts.floor.held.map(family => PRODUCTS[family].name);
    floor.push(`The price floor set what it paid for ${names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}, and the floor takes priority over its range.${facts.floor.creditLimited ? ' A year-end credit cannot go below the floor either, so it cannot be brought into its range.' : ''}`);
  }
  if (!said.length) return floor.length ? floor : [`It finished close to its budgeted ${measure}${service ? '' : ', with no single effect of note'}.`];
  return [...said.map(driver => sentences[driver.key](driver)), ...floor];
}

function bridge(entry) {
  const steps = entry.drivers.filter(driver => Math.abs(driver.points) >= 0.00005);
  return `<ol class="summary-bridge" aria-label="From budget to result">
    <li><span>Budget</span><strong>${percent.format(entry.budget)}</strong></li>
    ${steps.map(driver => `<li><span>${html(driverLabels[driver.key])}</span><strong class="${driver.points < 0 ? 'negative' : 'positive'}">${signedPoints(driver.points)}</strong></li>`).join('')}
    <li class="summary-bridge-result"><span>Local stat result</span><strong>${percent.format(entry.result)}</strong></li>
  </ol>`;
}

// The case the local accounts exist to teach: the two bases land on different sides of the range.
function crossing(entry) {
  const basisPoints = value => Math.round(value * 10_000);
  const gaapInside = basisPoints(entry.gaap) >= basisPoints(entry.low) && basisPoints(entry.gaap) <= basisPoints(entry.high);
  if (gaapInside === (entry.status === 'within')) return '';
  return gaapInside
    ? '<p class="summary-flag">Inside the range on US GAAP. The GAAP-to-stat adjustment moved it out.</p>'
    : '<p class="summary-result">Outside the range on US GAAP. The GAAP-to-stat adjustment brought it in.</p>';
}

function card(entry, pricesChanged) {
  const outside = entry.status !== 'within';
  const measure = entry.measure === 'markup' ? 'Markup on cost' : 'Operating margin';
  return `<article class="summary-card ${outside ? 'outside' : ''}">
    <header>
      <h3>${html(nameOf(entry.id))}</h3>
      <span class="status-chip ${outside ? 'miss' : 'ok'}">${statusLabels[entry.status]}</span>
    </header>
    <p class="summary-result">${measure} <strong>${percent.format(entry.result)}</strong> on local stat results · US GAAP ${percent.format(entry.gaap)} · range ${percent.format(entry.low)}–${percent.format(entry.high)}</p>
    ${crossing(entry)}
    ${outside ? `<p class="summary-why"><strong>Why.</strong> ${reasons(entry, pricesChanged).map(html).join(' ')}</p>` : ''}
    ${bridge(entry)}
  </article>`;
}

// How many of the tested entities drew a GAAP-to-stat adjustment this year.
function adjustedEntities(explanations) {
  const count = explanations.filter(entry => entry.facts.statAdjustment).length;
  if (!count) return 'No tested entity had a GAAP-to-stat adjustment this year, so they match the US GAAP figures you saw during the year.';
  const all = count === explanations.length;
  return `${all ? `All ${count}` : `${count} of the ${explanations.length}`} tested entities had an unexpected GAAP-to-stat adjustment, which only became visible at the fourth-quarter close.${all ? '' : ' For the others the statutory result matches US GAAP.'}`;
}

/**
 * The pop-up that closes the year: which tested entities finished outside their range
 * and what put them there. `untouched` is true when no price or fee was changed all year.
 */
export function renderYearSummary({ explanations, untouched, adjusted }) {
  const outside = explanations.filter(entry => entry.status !== 'within');
  const within = explanations.filter(entry => entry.status === 'within');
  const pricesChanged = !untouched;
  const lead = outside.length
    ? `${outside.length} of ${explanations.length} tested entities finished the year outside their arm’s-length range.`
    : `All ${explanations.length} tested entities finished the year inside their arm’s-length range.`;
  const context = untouched
    ? 'No transfer price or service fee was changed during the year, so every result below shows what the market and costs did against prices set at the start of the year.'
    : 'Prices or fees were changed during the year. The results below include those changes.';
  return `
    <header class="summary-head">
      <div><p class="pricing-period-label">2027 · Fourth-quarter close</p><h2 id="year-summary-title" tabindex="-1">How the year ended</h2></div>
      <button class="button" type="button" data-action="close-summary">Close</button>
    </header>
    <div class="summary-body">
      <p class="summary-lead">${lead}</p>
      <p>${context}${adjusted ? ' Year-end adjustments have been posted and are included.' : ' No year-end adjustment has been posted yet.'}</p>
      <p>The range is tested on <strong>local statutory results</strong>. ${adjustedEntities(explanations)}</p>
      ${outside.length ? `<h3 class="summary-section">Outside the range</h3>${outside.map(entry => card(entry, pricesChanged)).join('')}` : ''}
      ${within.length ? `<h3 class="summary-section">Inside the range</h3>${within.map(entry => card(entry, pricesChanged)).join('')}` : ''}
    </div>
    <footer class="summary-foot">
      <p>${outside.length ? 'A year-end adjustment can still bring these entities into range. Or replay the same year and use the quarterly reviews.' : 'No year-end adjustment is needed.'}</p>
      <div class="view-controls">
        <button class="button" type="button" data-action="replay-year">Replay the year from Q1</button>
        <button class="button primary" type="button" data-action="review-prices">Open the year-end review</button>
      </div>
    </footer>`;
}
