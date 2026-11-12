// Run with: node --test tests/engine.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyGoodsPrices, applyYearEndAdjustments, createConfig, productLineResults, profitAllocation, reviewGoodsPricing, royaltyCheck,
  runYear, summarizeTaxAndCustoms, upgradeConfig,
} from '../src/engine.mjs'
import { DEFAULT_SIMULATION, simulateShocks } from '../src/simulation.mjs'

const cents = value => Math.round(value * 100) / 100
const total = (months, key) => months.reduce((sum, month) => sum + month.consolidated[key], 0)
const distributors = ['DE', 'FR', 'UK', 'APAC', 'CA']
const policyRows = review => Object.fromEntries(review.entityResults.filter(row => distributors.includes(row.id)).map(row => [row.id, row.policy]))

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
  assert.ok(variance.every(month => Math.abs(month.check) < 0.005))
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
  assert.deepEqual(margins, ['0.1146', '0.1146', '0.1146'])
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
  assert.ok(lines.B > 0.7 && lines.A > 0.5 && lines.A < 0.7 && lines.C < 0.35)
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
  // In the default year France finishes below its range and Germany stays inside.
  assert.equal(policies.FR.status, 'below')
  assert.equal(policies.DE.status, 'within')
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
  for (const [id, policy] of Object.entries(policies)) {
    assert.equal(Math.round(policy.forecast * 10_000), Math.round(policy.target * 10_000), id)
    assert.equal(policy.status, 'within', id)
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
  const outside = review.yearEnd.filter(entry => entry.statusBefore !== 'within')
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

test('income tax is each entity\'s rate applied to its operating profit', () => {
  const config = createConfig()
  const { actual } = runYear(config)
  const { tax } = summarizeTaxAndCustoms(config, actual)
  const expected = Object.keys(config.tax.rates).reduce((sum, id) =>
    sum + config.tax.rates[id] * actual.reduce((profit, month) => profit + month.entities[id].operatingProfit, 0), 0)
  assert.ok(Math.abs(tax.total - expected) < 0.005)
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
