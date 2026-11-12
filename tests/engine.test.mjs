// Run with: node --test tests/engine.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyGoodsPrices, applyServiceFees, applyYearEndAdjustments, createConfig, explainYear, productLineResults, PRODUCTS, profitAllocation,
  reviewGoodsPricing, royaltyCheck, runYear, summarizeTaxAndCustoms, TESTED_PARTIES, upgradeConfig,
} from '../src/engine.mjs'
import { DEFAULT_SIMULATION, simulateShocks, simulateStatAdjustments } from '../src/simulation.mjs'

const cents = value => Math.round(value * 100) / 100
const total = (months, key) => months.reduce((sum, month) => sum + month.consolidated[key], 0)
const distributors = ['DE', 'FR', 'UK', 'APAC', 'CA']
const policyRows = review => Object.fromEntries(review.entityResults.filter(row => TESTED_PARTIES.includes(row.id)).map(row => [row.id, row.policy]))
const bp = value => Math.round(value * 10_000)
const serviceMarkup = (months, id) => months.reduce((sum, month) => sum + month.services[id].fee, 0) /
  months.reduce((sum, month) => sum + month.services[id].cost, 0) - 1

// A scenario as saved before R&D, market variation and the tax layers were added,
// when the game was called SimulaTP and that name was its default seed.
function legacyConfig() {
  const config = createConfig()
  config.simulation.seed = 'SimulaTP-2027'
  config.rd.salesRate = 0
  config.annualOperatingMargin = 4_017_544.4704 / 10_487_570
  config.simulation.marketVariation = { demand: 0, salesPrice: 0 }
  return config
}

const withFloor = (markup = 0.05) => ({ ...createConfig(), priceFloor: { enabled: true, markup } })
const goodsInvoices = months => months.flatMap(month => month.transactions)
  .filter(invoice => !invoice.external && invoice.category === 'goods' && invoice.quantity)

test('the default budget meets its margin target without rescaling unit costs', () => {
  const config = createConfig()
  const { budget, variance } = runYear(config)
  assert.equal(budget[0].costScale, 1)
  assert.equal(cents(total(budget, 'revenue')), 10_487_570)
  assert.ok(Math.abs(total(budget, 'operatingProfit') / total(budget, 'revenue') - config.annualOperatingMargin) < 1e-9)
  // The default group earns an operating margin in the high teens, and both entrepreneurs stay profitable.
  assert.ok(config.annualOperatingMargin > 0.17 && config.annualOperatingMargin < 0.195)
  for (const id of ['US', 'CH']) assert.ok(budget.reduce((sum, month) => sum + month.entities[id].operatingProfit, 0) > 0, id)
  assert.ok(variance.every(month => Math.abs(month.check) < 0.005))
})

test('a saved scenario that has not started takes the current default margin, and one in progress keeps its own', () => {
  const previous = 3_965_513.159268929 / 10_487_570 - 0.04
  const saved = { ...createConfig(), annualOperatingMargin: previous }
  assert.equal(upgradeConfig(structuredClone(saved), false).annualOperatingMargin, createConfig().annualOperatingMargin)
  assert.equal(upgradeConfig(structuredClone(saved), true).annualOperatingMargin, previous)
  // A target the player chose is left alone.
  assert.equal(upgradeConfig({ ...structuredClone(saved), annualOperatingMargin: 0.25 }, false).annualOperatingMargin, 0.25)
})

test('a price change reaches a distributor\'s cost of sales only after its two months of stock are sold', () => {
  const config = createConfig()
  const base = runYear(config)
  for (const [id, route] of [['DE', 'CH-DE'], ['FR', 'CH-FR'], ['UK', 'CH-UK'], ['APAC', 'CH-APAC'], ['CA', 'US-CA']]) {
    // A distributor starts every month holding about two months of normal demand, bought at earlier prices.
    for (const family of Object.keys(PRODUCTS)) {
      const bin = base.actual[3].inventory.find(entry => entry.owner === id && entry.product === family)
      const opening = bin.opening.reduce((sum, lot) => sum + lot.quantity, 0)
      assert.ok(Math.abs(opening / PRODUCTS[family].demand[id] - 2) < 0.35, `${id} ${family}`)
    }
    const current = reviewGoodsPricing(config, 3).routes.find(entry => entry.key === route).prices
    const raised = Object.fromEntries(current.map(price => [price.product, cents(price.applied * 1.1)]))
    const changed = runYear(applyGoodsPrices(config, 3, { [route]: raised }))
    // A 10% rise in cost of sales means every unit sold carried the new price.
    const atNewPrice = month => (changed.actual[month].entities[id].cogs / base.actual[month].entities[id].cogs - 1) / 0.1
    // The new price starts in April. April's sales all come out of older stock.
    assert.ok(Math.abs(atNewPrice(3)) < 1e-9, id)
    // In May most units sold are still older stock.
    assert.ok(atNewPrice(4) < 0.35, id)
    // By June the older stock is gone, or nearly.
    assert.ok(atNewPrice(5) > 0.9, id)
    assert.ok(Math.abs(atNewPrice(6) - 1) < 0.001, id)
    // Purchases carry the new price from April, so the higher cost sits in inventory first.
    const bought = (year, month) => year.actual[month].transactions
      .filter(invoice => invoice.to === id && invoice.category === 'goods' && !invoice.external)
      .reduce((sum, invoice) => sum + invoice.amount, 0)
    assert.ok(Math.abs(bought(changed, 3) / bought(base, 3) - 1.1) < 0.001, id)
  }
})

test('group-wide shocks for a seed do not depend on the market list', () => {
  const plain = simulateShocks(DEFAULT_SIMULATION, 12)
  const withMarkets = simulateShocks(DEFAULT_SIMULATION, 12, ['US', 'DE'])
  assert.deepEqual(Object.keys(plain[0]), ['demand', 'salesPrice', 'materialCost'])
  // The same seed always gives the same year.
  assert.deepEqual(simulateShocks(DEFAULT_SIMULATION, 12), plain)
  const earlier = simulateShocks({ ...DEFAULT_SIMULATION, seed: 'SimulaTP-2027' }, 1)
  assert.ok(Math.abs(earlier[0].demand - -0.053929718847250896) < 1e-15)
  for (const [index, month] of plain.entries()) {
    for (const key of ['demand', 'salesPrice', 'materialCost']) assert.equal(withMarkets[index][key], month[key])
  }
  assert.ok(Math.abs(withMarkets[0].markets.DE.salesPrice) <= DEFAULT_SIMULATION.marketVariation.salesPrice)
})

test('without market variation every limited-risk distributor posts the same margin', () => {
  const { actual, variance } = runYear(legacyConfig())
  assert.equal(cents(actual[0].consolidated.revenue), 805_677.32)
  const margins = ['DE', 'FR', 'UK'].map(id => actual[0].entities[id].operatingMargin.toFixed(4))
  assert.equal(new Set(margins).size, 1)
  assert.ok(variance.every(month => Math.abs(month.check) < 0.005))
})

test('the product lines keep the same profitability order in every market', () => {
  const { budget, actual } = runYear(createConfig())
  for (const month of [...budget, ...actual]) {
    const byMarket = new Map()
    for (const sale of month.sales) {
      if (!sale.quantity) continue
      byMarket.set(sale.seller, { ...byMarket.get(sale.seller), [sale.product]: 1 - sale.groupCogs / sale.revenue })
    }
    for (const [market, margins] of byMarket) {
      // Control Systems is the high-margin line, Precision Components the middle, Industrial Modules the thin one.
      assert.ok(margins.B > margins.A && margins.A > margins.C, `${market} in month ${month.month}`)
    }
  }
  const lines = Object.fromEntries(productLineResults(budget[0]).map(line => [line.product, line.grossMargin]))
  assert.ok(lines.B > 0.6 && lines.A > 0.4 && lines.A < 0.6 && lines.C > 0.15 && lines.C < 0.35)
})

test('with no floor a thin-margin product can be priced below standard cost', () => {
  const review = reviewGoodsPricing(createConfig(), 0)
  const asia = review.routes.find(route => route.key === 'CH-APAC').prices.find(price => price.product === 'C')
  assert.ok(asia.applied < asia.standardCost)
  assert.equal(asia.floor, null)
  assert.equal(review.priceFloor, null)
})

test('the price floor holds every goods price at or above standard cost plus the markup', () => {
  const config = withFloor(0.05)
  const year = runYear(config)
  const review = reviewGoodsPricing(config, 3)
  const floors = Object.fromEntries(review.routes.map(route => [route.key, Object.fromEntries(route.prices.map(price => [price.product, price]))]))
  for (const prices of Object.values(floors)) {
    for (const price of Object.values(prices)) {
      assert.ok(price.floor >= price.standardCost * 1.05 - 1e-9 && price.floor < price.standardCost * 1.05 + 0.01)
      assert.ok(price.applied >= price.floor)
      if (price.recommended !== null) assert.ok(price.recommended >= price.floor)
    }
  }
  for (const invoice of goodsInvoices([...year.budget, ...year.actual])) {
    const floor = floors[invoice.from + '-' + invoice.to][invoice.product].floor
    assert.ok(invoice.amount / invoice.quantity >= floor - 1e-6, `${invoice.from}-${invoice.to} ${invoice.product}`)
  }
  // The thin-margin product is held at its floor for Asia, and the other products carry the difference.
  assert.equal(floors['CH-APAC'].C.applied, floors['CH-APAC'].C.floor)
  const open = reviewGoodsPricing(createConfig(), 0).routes.find(route => route.key === 'CH-APAC').prices
  assert.ok(floors['CH-APAC'].A.applied <= open.find(price => price.product === 'A').applied)
  const budgetMargin = id => {
    const row = reviewGoodsPricing(config, 0).entityResults.find(entry => entry.id === id)
    return Math.round(row.policy.forecast * 10_000)
  }
  assert.equal(budgetMargin('APAC'), 750)
  assert.ok(year.variance.every(month => Math.abs(month.check) < 0.005))
})

test('a price entered below the floor is refused', () => {
  const config = withFloor(0.05)
  const floor = reviewGoodsPricing(config, 3).routes.find(route => route.key === 'CH-DE').prices.find(price => price.product === 'C').floor
  const oneCentBelow = cents(floor - 0.01)
  assert.throws(() => applyGoodsPrices(config, 3, { 'CH-DE': { C: oneCentBelow } }), /cannot go below the floor/)
  const applied = applyGoodsPrices(config, 3, { 'CH-DE': { C: floor } })
  assert.equal(applied.goodsPriceSchedule.at(-1).prices['CH-DE'].C, floor)
  // Without the rule the same price is accepted.
  applyGoodsPrices(createConfig(), 3, { 'CH-DE': { C: oneCentBelow } })
  assert.throws(() => runYear({ ...createConfig(), priceFloor: { enabled: true, markup: 1.5 } }), /price floor markup/)
})

test('a year-end credit cannot take the year\'s purchases below their floor value', () => {
  // A high floor leaves little room between the invoices and their floor value.
  const config = withFloor(0.6)
  const choices = Object.fromEntries(distributors.map(id => [id, 'target']))
  const adjusted = applyYearEndAdjustments(config, 12, choices)
  const year = runYear(adjusted)
  const review = reviewGoodsPricing(adjusted, 12)
  const floors = Object.fromEntries(review.routes.map(route => [route.key, Object.fromEntries(route.prices.map(price => [price.product, price.floor]))]))
  let limited = 0
  for (const entry of review.yearEnd) {
    const invoices = goodsInvoices(year.actual).filter(invoice => invoice.to === entry.id)
    const headroom = invoices.reduce((total, invoice) => total + invoice.amount - invoice.quantity * floors[invoice.from + '-' + invoice.to][invoice.product], 0)
    assert.ok(entry.amount >= -headroom - 0.01, entry.id)
    if (entry.floorLimited.target) limited += 1
  }
  assert.ok(limited > 0)
  assert.ok(Math.abs(year.actual[11].reconciliation.profitDifference) < 0.005)
})

test('market variation makes distributors diverge', () => {
  const { actual } = runYear(createConfig())
  const margins = new Set(['DE', 'FR', 'UK'].map(id => actual[0].entities[id].operatingMargin.toFixed(4)))
  assert.equal(margins.size, 3)
})

test('a distributor is flagged only when its forecast leaves the range', () => {
  const config = createConfig()
  const policies = policyRows(reviewGoodsPricing(config, 12))
  for (const [id, policy] of Object.entries(policies)) {
    const inside = Math.round(policy.forecast * 10_000) >= Math.round(policy.low * 10_000) &&
      Math.round(policy.forecast * 10_000) <= Math.round(policy.high * 10_000)
    assert.equal(policy.outOfPolicy, !inside, id)
    assert.equal(policy.exposure > 0, !inside, id)
  }
  // In the default year France finishes below its range.
  assert.equal(policies.FR.status, 'below')
  assert.ok(Object.values(policies).some(policy => policy.status === 'within'))
})

test('a range must contain its target', () => {
  const config = createConfig()
  config.ranges.lrd = { low: 0.04, high: 0.05 }
  assert.throws(() => runYear(config), /range/)
})

test('year-end adjustments to target move each distributor onto its target and leave the group unchanged', () => {
  const config = createConfig()
  const before = runYear(config)
  const adjusted = applyYearEndAdjustments(config, 12, Object.fromEntries(distributors.map(id => [id, 'target'])))
  const after = runYear(adjusted)
  assert.equal(cents(after.actual[11].consolidated.operatingProfit), cents(before.actual[11].consolidated.operatingProfit))
  const policies = policyRows(reviewGoodsPricing(adjusted, 12))
  for (const id of distributors) {
    assert.equal(Math.round(policies[id].forecast * 10_000), Math.round(policies[id].target * 10_000), id)
    assert.equal(policies[id].status, 'within', id)
  }
  const entries = after.actual[11].transactions.filter(transaction => transaction.policy === 'YEAR_END_ADJUSTMENT')
  assert.equal(entries.length, 5)
  assert.ok(entries.every(entry => entry.quantity === 0))
  // An upward adjustment on a dutiable route adds duty. A credit earns no refund.
  const duty = months => summarizeTaxAndCustoms(adjusted, months).customs.routes
  for (const entry of entries) {
    const key = entry.from + '-' + entry.to
    if (!(key in adjusted.customs.rates)) continue // Shipments to Germany and France stay inside the EU.
    const added = duty(after.actual)[key].duty - duty(before.actual)[key].duty
    assert.ok(Math.abs(added - adjusted.customs.rates[key] * Math.max(0, entry.amount)) < 0.005, key)
  }
  assert.ok(entries.some(entry => entry.amount < 0))
})

test('year-end adjustments to the range touch only distributors outside it', () => {
  const config = createConfig()
  const adjusted = applyYearEndAdjustments(config, 12, Object.fromEntries(distributors.map(id => [id, 'range'])))
  const review = reviewGoodsPricing(adjusted, 12)
  const outside = review.yearEnd.filter(entry => distributors.includes(entry.id) && entry.statusBefore !== 'within')
  assert.ok(outside.length > 0 && outside.length < distributors.length)
  assert.deepEqual(review.yearEnd.filter(entry => entry.amount !== 0).map(entry => entry.id), outside.map(entry => entry.id))
  for (const entry of outside) {
    const policy = policyRows(review)[entry.id]
    const edge = entry.statusBefore === 'below' ? policy.low : policy.high
    assert.equal(policy.status, 'within', entry.id)
    assert.equal(Math.round(policy.forecast * 10_000), Math.round(edge * 10_000), entry.id)
  }
})

test('year-end adjustments stay closed until December is revealed', () => {
  assert.throws(() => applyYearEndAdjustments(createConfig(), 11, { DE: 'target' }), /December/)
  const config = createConfig()
  assert.equal(applyYearEndAdjustments(config, 12, { DE: 'none' }), config)
})

test('income tax follows US GAAP profit during the year and local statutory profit once the year is closed', () => {
  const config = createConfig()
  const { actual } = runYear(config)
  const gaapProfit = (id, months) => months.reduce((profit, month) => profit + month.entities[id].operatingProfit, 0)
  const nineMonths = actual.slice(0, 9)
  const interim = summarizeTaxAndCustoms(config, nineMonths).tax
  const expectedInterim = Object.keys(config.tax.rates).reduce((sum, id) => sum + config.tax.rates[id] * gaapProfit(id, nineMonths), 0)
  assert.ok(Math.abs(interim.total - expectedInterim) < 0.005)
  const { tax } = summarizeTaxAndCustoms(config, actual)
  const stat = actual[11].stat
  const expected = Object.keys(config.tax.rates).reduce((sum, id) =>
    sum + config.tax.rates[id] * (stat[id]?.operatingProfit ?? gaapProfit(id, actual)), 0)
  assert.ok(Math.abs(tax.total - expected) < 0.005)
  assert.equal(stat.US, undefined)
  assert.ok(tax.effectiveRate > 0.15 && tax.effectiveRate < 0.30)
})

test('a scenario saved before these settings existed still runs', () => {
  const { ranges, tax, customs, yearEnd, priceFloor, ...saved } = legacyConfig()
  delete saved.simulation.marketVariation
  const inProgress = upgradeConfig(structuredClone(saved), true)
  const year = runYear(inProgress)
  // Its margin target and its group-wide shocks are kept. Product costs are the current ones.
  const budgetMargin = total(year.budget, 'operatingProfit') / total(year.budget, 'revenue')
  assert.ok(Math.abs(budgetMargin - saved.annualOperatingMargin) < 1e-9)
  assert.equal(cents(year.actual[0].consolidated.revenue), 805_677.32)
  assert.equal(inProgress.simulation.marketVariation, undefined)
  assert.deepEqual(inProgress.priceFloor, priceFloor)
  const unstarted = upgradeConfig(structuredClone(saved), false)
  assert.deepEqual(unstarted.simulation.marketVariation, { ...DEFAULT_SIMULATION.marketVariation })
  assert.deepEqual(unstarted.ranges, ranges)
  // A customized target outside the default range widens the range to contain it.
  const wide = upgradeConfig({ ...structuredClone(saved), policies: { ...saved.policies, lrdMargin: 0.06 } }, true)
  assert.equal(wide.ranges.lrd.high, 0.06)
  runYear(wide)
})

test('the royalty can be set from 0% to 50% and is flagged when it is below the R&D share of sales', () => {
  const config = createConfig()
  for (const royaltyRate of [0, 0.5]) {
    const year = runYear({ ...config, policies: { ...config.policies, royaltyRate } })
    assert.ok(year.variance.every(month => Math.abs(month.check) < 0.005))
  }
  assert.throws(() => runYear({ ...config, policies: { ...config.policies, royaltyRate: 0.51 } }), /0% and 50%/)
  // The default 5% royalty covers the default 4% R&D share. Equal rates are not flagged.
  assert.equal(royaltyCheck(config).belowResearch, false)
  assert.equal(royaltyCheck({ ...config, policies: { ...config.policies, royaltyRate: 0.04 } }).belowResearch, false)
  const low = { ...config, policies: { ...config.policies, royaltyRate: 0.03 } }
  assert.deepEqual(royaltyCheck(low), { royaltyRate: 0.03, researchRate: 0.04, belowResearch: true })
  assert.equal(reviewGoodsPricing(low, 0).royalty.belowResearch, true)
})

test('a royalty above the break-even rate projects a loss for the Swiss licensee', () => {
  const config = createConfig()
  const withRoyalty = royaltyRate => profitAllocation(runYear({ ...config, policies: { ...config.policies, royaltyRate } }).budget)
  const base = withRoyalty(0.05)
  assert.equal(base.licenseeLoss, false)
  assert.ok(base.breakEvenRate > 0.05 && base.breakEvenRate < 0.5)
  // The royalty moves nothing else, so profit is linear in the rate and the break-even rate does not move.
  const high = withRoyalty(0.45)
  assert.equal(high.licenseeLoss, true)
  assert.ok(Math.abs(high.breakEvenRate - base.breakEvenRate) < 1e-9)
  assert.ok(Math.abs(high.swiss - (base.swissBeforeRoyalty - 0.45 * base.royaltyBase)) < 0.01)
  const justBelow = withRoyalty(Math.floor(base.breakEvenRate * 1000) / 1000)
  assert.equal(justBelow.licenseeLoss, false)
  assert.equal(reviewGoodsPricing({ ...config, policies: { ...config.policies, royaltyRate: 0.45 } }, 0).allocation.licenseeLoss, true)
})

test('Poland and India charge a fixed monthly fee set from budgeted cost plus the policy markup', () => {
  const config = createConfig()
  const { budget, actual, variance } = runYear(config)
  for (const id of ['PL', 'IN']) {
    const fees = new Set([...budget, ...actual].map(month => month.services[id].fee))
    assert.equal(fees.size, 1, id)
    // The budget year lands on the policy markup to within the rounding of the fee to cents.
    const target = id === 'PL' ? config.policies.polandMarkup : config.policies.indiaServicesMarkup
    assert.ok(Math.abs(serviceMarkup(budget, id) - target) < 1e-6, id)
    // Actual costs move, the fee does not, so the actual markup drifts.
    assert.ok(Math.abs(serviceMarkup(actual, id) - target) > 0.001, id)
  }
  // Poland's cost per unit falls as output rises, because part of its cost is fixed.
  const unitCost = month => month.services.PL.cost / month.services.PL.units
  const byVolume = [...budget].sort((left, right) => left.services.PL.units - right.services.PL.units)
  assert.ok(unitCost(byVolume[0]) > unitCost(byVolume.at(-1)))
  assert.ok(variance.every(month => Math.abs(month.check) < 0.005))
})

test('with no fixed overhead Poland\'s budget cost per unit is its standard conversion cost', () => {
  const config = { ...createConfig(), services: { polandFixedShare: 0 } }
  delete config.annualOperatingMargin
  const { budget } = runYear(config)
  for (const month of budget) {
    const standard = Object.entries(month.capacity.PL.byProduct).reduce((sum, [family, units]) => sum + units * PRODUCTS[family].plConversion, 0)
    assert.ok(Math.abs(month.services.PL.cost - standard) < 1e-6)
  }
})

test('the year reconciles when Poland converts nothing', () => {
  const config = { ...createConfig(), capacity: { US: 2550, PL: 0 } }
  delete config.annualOperatingMargin
  const { actual } = runYear(config)
  assert.ok(actual.every(month => month.services.PL.units === 0 && month.services.PL.cost > 0))
  assert.ok(actual.every(month => Math.abs(month.reconciliation.profitDifference) < 0.005))
})

test('a service fee set at a quarterly review applies from the next month and its policy quote reaches the target', () => {
  const config = createConfig()
  const review = reviewGoodsPricing(config, 6)
  const quotes = Object.fromEntries(review.services.map(quote => [quote.id, quote]))
  assert.throws(() => applyServiceFees(config, 5, { PL: 50_000 }), /March, June, or September/)
  assert.throws(() => applyServiceFees(config, 6, { US: 50_000 }), /Unknown service provider/)
  assert.equal(applyServiceFees(config, 6, { PL: quotes.PL.fee }), config)
  const revised = applyServiceFees(config, 6, { PL: quotes.PL.recommended, IN: quotes.IN.recommended })
  const { actual } = runYear(revised)
  assert.equal(actual[5].services.PL.fee, quotes.PL.fee)
  assert.equal(actual[6].services.PL.fee, quotes.PL.recommended)
  assert.equal(actual[11].services.IN.fee, quotes.IN.recommended)
  const forecast = policyRows(reviewGoodsPricing(revised, 6))
  assert.equal(bp(forecast.PL.forecast), bp(config.policies.polandMarkup))
  assert.equal(bp(forecast.IN.forecast), bp(config.policies.indiaServicesMarkup))
  assert.equal(reviewGoodsPricing(revised, 9).priceRevisions, 1)
})

test('the GAAP-to-stat adjustment is a signed share of operating expenses within its limits', () => {
  const ids = Array.from({ length: 4000 }, (_, index) => 'entity' + index)
  const always = { ...DEFAULT_SIMULATION, statAdjustment: { ...DEFAULT_SIMULATION.statAdjustment, probability: 1 } }
  const rates = Object.values(simulateStatAdjustments(always, ids))
  const sizes = rates.map(Math.abs)
  assert.ok(Math.max(...sizes) <= 0.10 && Math.min(...sizes) > 0)
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length
  assert.ok(Math.abs(average - 0.03) < 0.002)
  const raising = rates.filter(rate => rate > 0).length / rates.length
  assert.ok(raising > 0.45 && raising < 0.55)
  assert.deepEqual(simulateStatAdjustments(DEFAULT_SIMULATION, ['DE', 'FR']), simulateStatAdjustments(DEFAULT_SIMULATION, ['DE', 'FR']))
  const off = simulateStatAdjustments({ ...DEFAULT_SIMULATION, statAdjustment: { max: 0, mean: 0 } }, ['DE'])
  assert.equal(off.DE, 0)
  assert.throws(() => simulateStatAdjustments({ ...DEFAULT_SIMULATION, statAdjustment: { max: 0.05, mean: 0.06 } }, ['DE']), /GAAP-to-stat adjustment/)
})

test('an entity has a GAAP-to-stat adjustment only with the set probability', () => {
  const ids = Array.from({ length: 4000 }, (_, index) => 'entity' + index)
  const withChance = probability => ({ ...DEFAULT_SIMULATION, statAdjustment: { ...DEFAULT_SIMULATION.statAdjustment, probability } })
  assert.equal(DEFAULT_SIMULATION.statAdjustment.probability, 0.5)
  const half = simulateStatAdjustments(DEFAULT_SIMULATION, ids)
  const always = simulateStatAdjustments(withChance(1), ids)
  const adjusted = ids.filter(id => half[id] !== 0)
  assert.ok(adjusted.length / ids.length > 0.47 && adjusted.length / ids.length < 0.53)
  // The chance decides whether an entity is adjusted. It does not change the size it would have had.
  for (const id of adjusted) assert.equal(half[id], always[id])
  const average = adjusted.reduce((sum, id) => sum + Math.abs(half[id]), 0) / adjusted.length
  assert.ok(Math.abs(average - 0.03) < 0.003)
  assert.ok(Object.values(simulateStatAdjustments(withChance(0), ids)).every(rate => rate === 0))
  assert.ok(Object.values(always).every(rate => rate !== 0))
  // A scenario saved before the chance existed adjusted every entity.
  const { probability, ...legacy } = DEFAULT_SIMULATION.statAdjustment
  assert.deepEqual(simulateStatAdjustments({ ...DEFAULT_SIMULATION, statAdjustment: legacy }, ids), always)
  assert.throws(() => simulateStatAdjustments(withChance(1.2), ['DE']), /chance of a GAAP-to-stat adjustment/)
})

test('the range is tested on US GAAP during the year and on local statutory results after December', () => {
  const config = createConfig()
  const interim = reviewGoodsPricing(config, 9)
  assert.equal(interim.stat, null)
  assert.ok(Object.values(policyRows(interim)).every(policy => policy.basis === 'gaap'))
  const review = reviewGoodsPricing(config, 12)
  const { actual } = runYear(config)
  for (const [id, policy] of Object.entries(policyRows(review))) {
    const stat = review.stat[id]
    const result = review.entityResults.find(row => row.id === id).fullYear
    assert.equal(policy.basis, 'stat', id)
    // The adjustment is the entity's rate applied to its operating expenses outside R&D and goods.
    assert.ok(Math.abs(stat.adjustment - stat.rate * result.otherOperatingExpenses) < 1e-6, id)
    const profit = result.revenue - result.rdServiceRevenue - result.cogs - result.otherOperatingExpenses - stat.adjustment
    const base = ['PL', 'IN'].includes(id) ? result.otherOperatingExpenses + stat.adjustment : result.revenue - result.rdServiceRevenue
    assert.ok(Math.abs(policy.forecast - profit / base) < 1e-9, id)
    // Only an entity that drew an adjustment differs from its US GAAP result.
    if (stat.rate) assert.notEqual(bp(policy.forecast), bp(policy.gaap), id)
    else assert.equal(policy.forecast, policy.gaap, id)
  }
  // The adjustment sits outside the US GAAP ledger, so the consolidated result is untouched.
  assert.ok(Math.abs(actual[11].reconciliation.profitDifference) < 0.005)
  const off = createConfig()
  off.simulation.statAdjustment = { max: 0, mean: 0 }
  for (const policy of Object.values(policyRows(reviewGoodsPricing(off, 12)))) assert.equal(bp(policy.forecast), bp(policy.gaap))
})

test('year-end adjustments to target bring every tested party onto its target in local statutory terms', () => {
  const config = createConfig()
  const before = runYear(config)
  const adjusted = applyYearEndAdjustments(config, 12, Object.fromEntries(TESTED_PARTIES.map(id => [id, 'target'])))
  const after = runYear(adjusted)
  assert.equal(cents(after.actual[11].consolidated.operatingProfit), cents(before.actual[11].consolidated.operatingProfit))
  assert.ok(Math.abs(after.actual[11].reconciliation.profitDifference) < 0.005)
  for (const [id, policy] of Object.entries(policyRows(reviewGoodsPricing(adjusted, 12)))) {
    assert.equal(bp(policy.forecast), bp(policy.target), id)
    assert.equal(policy.status, 'within', id)
    assert.equal(policy.exposure, 0, id)
  }
  const trueUps = after.actual[11].transactions.filter(transaction => transaction.policy === 'SERVICE_TRUE_UP')
  assert.deepEqual([...new Set(trueUps.map(entry => entry.from))].sort(), ['IN', 'PL'])
})

test('the explanation of the year adds up from the budget to the final statutory result', () => {
  const config = createConfig()
  assert.throws(() => explainYear(config, { budget: [], actual: [] }), /December/)
  for (const scenario of [config, applyYearEndAdjustments(config, 12, { DE: 'target', PL: 'range' })]) {
    const year = runYear(scenario)
    const explanations = explainYear(scenario, year)
    assert.deepEqual(explanations.map(entry => entry.id), TESTED_PARTIES)
    const rows = policyRows(reviewGoodsPricing(scenario, 12))
    for (const entry of explanations) {
      const moved = entry.drivers.reduce((sum, driver) => sum + driver.points, 0)
      assert.ok(Math.abs(entry.budget + moved - entry.result) < 0.0005, entry.id)
      assert.equal(bp(entry.result), bp(rows[entry.id].forecast), entry.id)
      assert.equal(entry.status, rows[entry.id].status, entry.id)
      // The US GAAP result reported beside the statutory one is the one after any true-up.
      assert.equal(bp(entry.gaap), bp(rows[entry.id].gaap), entry.id)
      assert.equal(bp(year.actual[11].yearEnd.find(row => row.id === entry.id).gaapAfter), bp(entry.gaap), entry.id)
    }
    const germany = explanations.find(entry => entry.id === 'DE')
    assert.ok(germany.drivers.some(driver => driver.key === 'salesPrice'))
    assert.equal(germany.drivers.some(driver => driver.key === 'yearEnd'), scenario !== config)
  }
})
