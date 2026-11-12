const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const glossary = [
  ['Arm’s-length range', 'The span of results that independent companies earn in comparable circumstances. A tested party inside the range is treated as priced at arm’s length.'],
  ['Cost plus', 'A price set at the supplier’s cost plus a markup.'],
  ['FIFO', 'First in, first out. The oldest stock is treated as sold first, at the cost it was bought for.'],
  ['Full-fledged distributor (FFD)', 'A distributor that carries its own market, inventory and credit risk, and so targets a higher margin.'],
  ['Limited-risk distributor (LRD)', 'A distributor whose supplier carries most of the market and inventory risk, so it targets a low and steady margin.'],
  ['Operating margin (OM)', 'Operating profit divided by net sales.'],
  ['Principal', 'The entity that takes the main decisions and risks for a region and keeps the profit left after the other entities are paid.'],
  ['Residual profit', 'What is left after every routine function has earned its target return.'],
  ['Royalty', 'A payment for the use of intangible property. Here it is a share of sales paid to the IP owner.'],
  ['Tested party', 'The entity whose result is compared with the range, normally the one with the simpler functions.'],
  ['Toll manufacturer', 'A manufacturer that converts materials owned by its customer and is paid for the conversion.'],
  ['Year-end adjustment', 'A payment or credit after the year closes that moves a tested party’s result for the whole year. Also called a true-up.'],
];

function groupRows({ policies, ranges }) {
  const range = kind => `${percent.format(ranges[kind].low)} to ${percent.format(ranges[kind].high)}`;
  return [
    ['United States', 'Manufacturer, IP owner and headquarters',
      `Keeps the residual on North American sales. Receives the royalty from Switzerland and a fee for headquarters services at cost plus ${percent.format(policies.usServicesMarkup)}. Funds all R&D.`],
    ['Switzerland', 'European principal',
      `Buys conversion from Poland, owns the stock in the Belgian warehouse, and sells to the European and Asian distributors and to independent distributors. Keeps the residual after routine returns and a ${percent.format(policies.royaltyRate)} royalty on European third-party sales.`],
    ['Poland', 'Toll manufacturer', `Actual conversion cost plus ${percent.format(policies.polandMarkup)}.`],
    ['Belgium', 'Warehouse operator', `A fee that leaves a ${percent.format(policies.belgiumMargin)} operating margin.`],
    ['Germany, France, United Kingdom', 'Limited-risk distributors',
      `Goods prices set for a ${percent.format(policies.lrdMargin)} operating margin. Range ${range('lrd')}.`],
    ['Asia, Canada', 'Full-fledged distributors',
      `Goods prices set for a ${percent.format(policies.ffdMargin)} operating margin. Range ${range('ffd')}. Switzerland supplies Asia and the United States supplies Canada.`],
    ['India', 'Shared services', `Cost plus ${percent.format(policies.indiaServicesMarkup)}.`],
  ];
}

export function renderBrief({ config, revealed }) {
  const { policies } = config;
  const start = revealed ? 'Return to the dashboard' : 'Open the dashboard';
  return `
    <div class="brief-grid">
      <section class="panel" aria-labelledby="brief-case-heading">
        <div class="panel-header"><h2 id="brief-case-heading">The case</h2></div>
        <div class="brief-copy">
          <p>You lead transfer pricing for a US-headquartered industrial group. It makes three product families in the United States and Poland and sells them to third-party customers in North America, Europe and Asia.</p>
          <p>The 2027 budget is set and the year is about to start. All figures are synthetic and in US dollars.</p>
        </div>
      </section>
      <section class="panel" aria-labelledby="brief-job-heading">
        <div class="panel-header"><h2 id="brief-job-heading">Your job</h2></div>
        <div class="brief-copy">
          <p>Keep each of the five distributors inside its arm’s-length range for the full year.</p>
          <p>Demand, sales prices and material costs move away from budget every month, and each market moves differently. Your lever is the price the distributors pay for goods. You can reset it after the March, June and September closes and post a year-end adjustment after December.</p>
        </div>
      </section>
    </div>
    <section class="panel" aria-labelledby="brief-group-heading">
      <div class="panel-header"><div><h2 id="brief-group-heading">The group</h2><p class="subtitle">Current policies. Change them in <a href="#settings">Scenario settings</a>.</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-labelledby="brief-group-heading"><table class="brief-table">
        <thead><tr><th scope="col">Entity</th><th scope="col">Role</th><th scope="col">How it is paid</th></tr></thead>
        <tbody>${groupRows(config).map(([entity, role, paid]) => `<tr>
          <th scope="row" class="table-name">${html(entity)}</th><td>${html(role)}</td><td>${html(paid)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>
    <div class="brief-grid">
      <section class="panel" aria-labelledby="brief-year-heading">
        <div class="panel-header"><h2 id="brief-year-heading">How the year runs</h2></div>
        <ol class="brief-steps">
          <li>Read the budget on the <a href="#dashboard">Dashboard</a> and trace the flows on the <a href="#map">Transaction map</a>.</li>
          <li>Reveal actuals one month at a time. The variance bridge explains each month’s gap to budget.</li>
          <li>After the March, June and September closes, open <a href="#pricing">Goods transfer prices</a>. The forecast shows where each distributor will finish the year at current prices. Take the policy price, enter your own, or leave prices alone.</li>
          <li>New prices apply to new shipments only. Stock a distributor already holds keeps its old cost and is sold first, so a price change takes time to reach its margin.</li>
          <li>After December, choose a year-end adjustment for each distributor and read the year-end review.</li>
        </ol>
      </section>
      <section class="panel" aria-labelledby="brief-cost-heading">
        <div class="panel-header"><h2 id="brief-cost-heading">What a miss costs</h2></div>
        <div class="brief-copy">
          <p><strong>Tax at risk.</strong> A distributor that finishes below its range is assumed to be adjusted up to its target by its own tax authority. One that finishes above is assumed to be adjusted by its supplier’s tax authority. With no relief on the other side, the group pays tax on the same profit twice.</p>
          <p><strong>Customs duty.</strong> A year-end adjustment that raises what a distributor paid also raises the declared customs value, and duty is due on the increase. A credit earns no duty refund.</p>
          <p><strong>Group tax.</strong> Moving profit between entities changes the group’s tax bill, because their tax rates differ.</p>
        </div>
      </section>
    </div>
    <section class="panel" aria-labelledby="brief-questions-heading">
      <div class="panel-header"><h2 id="brief-questions-heading">Questions to work through</h2></div>
      <ul class="brief-steps">
        <li>Which distributors needed a price change at each review, and which stayed inside their range without one?</li>
        <li>How much of a March price change reaches the full-year margin? What would the same change achieve in September?</li>
        <li>Switzerland keeps the residual on European and Asian sales after routine returns and the royalty. The United States owns the IP and funds the R&amp;D. Does a ${percent.format(policies.royaltyRate)} royalty leave the profit where the functions, assets and risks sit? Change the rate in Scenario settings and watch the split.</li>
        <li>When is a year-end adjustment to the edge of the range enough, and when is the target the better aim?</li>
        <li>Which year-end adjustments cost customs duty, and which leave duty overpaid?</li>
      </ul>
    </section>
    <section class="panel" aria-labelledby="brief-glossary-heading">
      <div class="panel-header"><h2 id="brief-glossary-heading">Glossary</h2></div>
      <dl class="glossary">${glossary.map(([term, meaning]) => `<div><dt>${html(term)}</dt><dd>${html(meaning)}</dd></div>`).join('')}</dl>
    </section>
    <div class="panel brief-start">
      <p>${revealed ? `${revealed} of 12 months are revealed.` : 'The budget is ready. No actuals are revealed yet.'}</p>
      <button class="button primary" type="button" data-action="start">${start}</button>
    </div>`;
}
