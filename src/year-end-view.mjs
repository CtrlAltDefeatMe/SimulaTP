import { ENTITIES } from './engine.mjs';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const share = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const statusLabels = { within: 'Within range', below: 'Below range', above: 'Above range' };
const modeLabels = { none: 'No adjustment', range: 'To the edge of the range', target: 'To the target' };

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const rate = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });

/** The message shown wherever the royalty rate is below R&D as a share of consolidated sales. */
export function royaltyWarning({ royaltyRate, researchRate }) {
  return `The royalty rate of ${rate.format(royaltyRate)} is less than R&D spend of ${rate.format(researchRate)} of consolidated sales. This can be a sign that the royalty is too low.`;
}

const rateToTenth = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * The message shown when the licensee finishes the year with an operating loss.
 * `closed` is true once all twelve months are actuals and nothing is left to project.
 */
export function licenseeLossWarning({ royaltyRate, swiss, swissBeforeRoyalty, breakEvenRate, closed = false }) {
  const loss = wholeDollars.format(Math.abs(swiss));
  const result = closed ? 'made' : 'is projected to make';
  if (swissBeforeRoyalty <= 0 || !Number.isFinite(breakEvenRate)) {
    return `Switzerland, the licensee, ${result} a full-year operating loss of ${loss}. It ${closed ? 'was' : 'is'} in a loss before any royalty.`;
  }
  return `At a royalty of ${rate.format(royaltyRate)}, Switzerland, the licensee, ${result} a full-year operating loss of ${loss}. ${closed ? 'It would have broken even' : 'It breaks even'} at a royalty of about ${rateToTenth.format(breakEvenRate)}.`;
}

function entityName(id) {
  return ENTITIES[id]?.name ?? id;
}

function signedDollars(value) {
  if (!value) return dollars.format(0);
  return `${value > 0 ? '+' : '−'}${dollars.format(Math.abs(value))}`;
}

function rangeLabel({ low, high }) {
  return `${percent.format(low)}–${percent.format(high)}`;
}

function statusChip(status) {
  return `<span class="status-chip ${status === 'within' ? 'ok' : 'miss'}">${statusLabels[status] ?? 'Out of policy'}</span>`;
}

function stat(label, value, detail) {
  return `<div class="panel kpi"><p class="kpi-label">${html(label)}</p><strong class="kpi-number">${html(value)}</strong><p class="kpi-footer">${html(detail)}</p></div>`;
}

function signedPercent(value) {
  if (!value) return percent.format(0);
  return `${value > 0 ? '+' : '−'}${percent.format(Math.abs(value))}`;
}

function scorecard({ yearEnd, entityResults, fullYear, budget, priceRevisions }) {
  const policies = new Map(entityResults.filter(row => row.policy).map(row => [row.id, row.policy]));
  const within = yearEnd.filter(entry => entry.statusAfter === 'within').length;
  const exposure = yearEnd.reduce((total, entry) => total + (policies.get(entry.id)?.exposure ?? 0), 0);
  const adjusted = yearEnd.filter(entry => entry.amount);
  const moved = adjusted.reduce((total, entry) => total + Math.abs(entry.amount), 0);
  const { adjustmentDuty } = fullYear.customs;
  const consolidated = entityResults.find(row => row.id === 'consolidated').fullYear;
  const profitGap = consolidated.operatingProfit - budget.operatingProfit;
  return `<section aria-labelledby="year-end-review-heading" class="year-end-review">
    <div class="panel pricing-period">
      <div><p class="pricing-period-label">December close</p><h2 id="year-end-review-heading">Year-end review</h2></div>
      <div class="pricing-period-copy"><p>${within === yearEnd.length
        ? 'Every tested entity finished the year inside its arm’s-length range on local statutory results.'
        : `${yearEnd.length - within} of ${yearEnd.length} tested entities finished outside their arm’s-length range on local statutory results. A year-end adjustment can still move them.`}</p>
        <p><button class="button" type="button" data-action="year-summary">Explain the year</button></p></div>
    </div>
    <div class="kpi-grid year-end-stats">
      ${stat('Tested entities within range', `${within} of ${yearEnd.length}`, 'Local statutory results, after year-end adjustments')}
      ${stat('Tax at risk', wholeDollars.format(exposure), 'Assumed adjustment to target with no relief')}
      ${stat('Price reviews used', `${priceRevisions} of 3`, 'Quarterly reviews where prices or fees changed')}
      ${stat('Year-end adjustments', wholeDollars.format(moved), `${adjusted.length} of ${yearEnd.length} tested entities`)}
      ${stat('Group income tax', wholeDollars.format(fullYear.tax.total), `${percent.format(fullYear.tax.effectiveRate)} effective rate on local results · budget ${percent.format(budget.tax.effectiveRate)}`)}
      ${stat('Customs duty', wholeDollars.format(fullYear.customs.total), `${wholeDollars.format(adjustmentDuty)} on year-end adjustments`)}
      ${stat('Consolidated operating profit', wholeDollars.format(consolidated.operatingProfit), `${profitGap < 0 ? '−' : '+'}${wholeDollars.format(Math.abs(profitGap))} vs budget`)}
      ${stat('Consolidated operating margin', percent.format(consolidated.operatingMargin), `Budget ${percent.format(budget.operatingMargin)}`)}
    </div>
  </section>`;
}

function adjustmentForm({ yearEnd, message }) {
  const option = (entry, mode) => {
    const amount = mode === 'target' ? entry.toTarget : mode === 'range' ? entry.toRange : 0;
    const unavailable = mode === 'range' && entry.statusBefore === 'within';
    const limited = entry.floorLimited?.[mode] ? ', limited by the price floor' : '';
    const label = mode === 'none' ? modeLabels.none : `${modeLabels[mode]} (${signedDollars(amount)}${limited})`;
    return `<option value="${mode}" ${entry.mode === mode ? 'selected' : ''} ${unavailable ? 'disabled' : ''}>${html(label)}</option>`;
  };
  return `<form id="year-end-form" class="pricing-form">
    <section class="panel" aria-labelledby="year-end-adjust-heading">
      <div class="panel-header"><div><h2 id="year-end-adjust-heading">Year-end adjustments</h2>
        <p class="subtitle" id="year-end-help">The range is tested on the local statutory (stat) result: US GAAP with the stat adjustment revealed at the December close. A positive stat adjustment is extra local cost. For a distributor, a positive amount is paid to its supplier and a negative amount is a credit from it. For Poland and India, a positive amount is an extra fee from their customers and a negative amount is a refund. Adjustments are booked in December and do not change consolidated profit.</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-labelledby="year-end-adjust-heading"><table class="year-end-table">
        <thead><tr>
          <th scope="col">Entity</th><th scope="col">Counterparty</th><th scope="col">US GAAP result</th><th scope="col">Stat adjustment</th>
          <th scope="col">Stat result</th><th scope="col">Range</th>
          <th scope="col">Year-end adjustment</th><th scope="col">Stat result after</th>
        </tr></thead>
        <tbody>${yearEnd.map(entry => `<tr>
          <th scope="row" class="table-name">${html(entityName(entry.id))}<small class="pricing-margin-target">${entry.service ? 'Markup on cost' : 'Operating margin'}</small></th>
          <td>${html(entry.counterparty.map(entityName).join(', '))}</td>
          <td>${percent.format(entry.gaapBefore)}</td>
          <td>${signedPercent(entry.statRate)}<small class="pricing-margin-target">${signedDollars(entry.statAdjustment)}</small></td>
          <td>${percent.format(entry.marginBefore)}${statusChip(entry.statusBefore)}</td>
          <td>${rangeLabel(entry)}<small class="pricing-margin-target">Target ${percent.format(entry.target)}</small></td>
          <td><select name="yearEnd.${html(entry.id)}" aria-label="Year-end adjustment for ${html(entityName(entry.id))}" aria-describedby="year-end-help">
            ${['none', 'range', 'target'].map(mode => option(entry, mode)).join('')}
          </select></td>
          <td>${percent.format(entry.marginAfter)}${statusChip(entry.statusAfter)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>
    <div class="panel form-footer pricing-footer">
      <div id="year-end-message">${message ? `<p class="form-message" role="status">${html(message)}</p>` : ''}</div>
      <button class="button primary" type="submit">Post year-end adjustments</button>
    </div>
  </form>`;
}

/** Where operating profit lands, with the tax and duty that follow from it. */
export function allocationPanel({ allocation, fullYear, revealed, royalty }) {
  const flagged = royalty?.belowResearch;
  const basis = revealed >= 12 ? 'Full-year actuals' : revealed ? 'Full-year forecast at current prices' : 'Full-year budget';
  const part = (label, value, note, alert = false) => `<li${alert ? ' class="flagged"' : ''}><span>${html(label)}${note ? `<small>${html(note)}</small>` : ''}</span><strong>${wholeDollars.format(value)} · ${share.format(allocation.total ? value / allocation.total : 0)}</strong></li>`;
  return `<section class="panel breakdown" aria-labelledby="allocation-heading">
    <div class="panel-header"><div><h2 id="allocation-heading">Where the profit lands</h2><p class="subtitle">${basis} · sum of entity operating profit</p></div></div>
    <div class="allocation-grid">
      <ul class="detail-list">
        ${part('United States', allocation.us, 'IP owner, manufacturer and headquarters')}
        ${part('Switzerland', allocation.swiss, 'European principal and licensee, after the royalty', allocation.licenseeLoss)}
        ${part('All other entities', allocation.routine, 'Routine returns')}
      </ul>
      <ul class="detail-list">
        <li${flagged ? ' class="flagged"' : ''}><span>Royalty paid to the United States${royalty ? `<small>${rate.format(royalty.royaltyRate)} royalty · R&amp;D ${rate.format(royalty.researchRate)} of consolidated sales</small>` : ''}</span><strong>${wholeDollars.format(allocation.royalty)}</strong></li>
        <li><span>Royalty as a share of Swiss profit before royalty</span><strong>${share.format(allocation.royaltyShare)}</strong></li>
        <li><span>Group income tax<small>${percent.format(fullYear.tax.effectiveRate)} effective rate on entity profit</small></span><strong>${wholeDollars.format(fullYear.tax.total)}</strong></li>
        <li><span>Customs duty on declared transfer prices<small>Memo. Not deducted from operating profit</small></span><strong>${wholeDollars.format(fullYear.customs.total)}</strong></li>
      </ul>
    </div>
    ${flagged ? `<p class="field-warning panel-note">${html(royaltyWarning(royalty))}</p>` : ''}
    ${allocation.licenseeLoss && royalty ? `<p class="field-warning panel-note">${html(licenseeLossWarning({ ...allocation, royaltyRate: royalty.royaltyRate, closed: revealed >= 12 }))}</p>` : ''}
  </section>`;
}

export function renderYearEnd(review) {
  return `${scorecard(review)}${adjustmentForm(review)}`;
}

export function readYearEndChoices(form) {
  const choices = Object.create(null);
  for (const select of form.querySelectorAll('select[name^="yearEnd."]')) {
    choices[select.name.slice('yearEnd.'.length)] = select.value;
  }
  return choices;
}
