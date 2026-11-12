// Run with: node --test tests/engine.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyYearEndAdjustments, createConfig, reviewGoodsPricing, royaltyCheck, runYear, summarizeTaxAndCustoms, upgradeConfig,
} from '../src/engine.mjs'
import { DEFAULT_SIMULATION, simulateShocks } from '../src/simulation.mjs'

const cents = value => Math.round(value * 100) / 100
const total = (months, key) => months.reduce((sum, month) => sum + month.consolidated[key], 0)
const distributors = ['DE', 'FR', 'UK', 'APAC', 'CA']
const policyRows = review => Object.fromEntries(review.entityResults.filter(row => distributors.includes(row.id)).map(row => [row.id, row.policy]))

// The scenario as it stood before R&D, market variation and the tax layers were added.
function legacyConfig() {
  const config = createConfig()
  config.rd.salesRate = 0
  config.annualOperatingMargin = 4_017_544.4704 / 10_487_570
  config.simulation.marketVariation = { demand: 0, salesPrice: 0 }
  return config
}

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
  assert.ok(Math.abs(plain[0].demand - -0.053929718847250896) < 1e-15)
  for (const [index, month] of plain.entries()) {
    for (const key of ['demand', 'salesPrice', 'materialCost']) assert.equal(withMarkets[index][key], month[key])
  }
  assert.ok(Math.abs(withMarkets[0].markets.DE.salesPrice) <= DEFAULT_SIMULATION.marketVariation.salesPrice)
})

test('with the new layers switched off the engine reproduces the original January close', () => {
  const { actual } = runYear(legacyConfig())
  assert.equal(cents(actual[0].consolidated.revenue), 805_677.32)
  assert.equal(cents(actual[0].consolidated.operatingProfit), 335_489.81)
  const margins = ['DE', 'FR', 'UK'].map(id => actual[0].entities[id].operatingMargin.toFixed(4))
  assert.deepEqual(margins, ['0.1146', '0.1146', '0.1146'])
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
  assert.equal(policies.UK.status, 'above')
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
  const asia = entries.find(entry => entry.to === 'APAC').amount
  assert.ok(asia > 0)
  assert.ok(Math.abs(duty(after.actual)['CH-APAC'].duty - duty(before.actual)['CH-APAC'].duty - 0.05 * asia) < 0.005)
})

test('year-end adjustments to the range touch only distributors outside it', () => {
  const config = createConfig()
  const adjusted = applyYearEndAdjustments(config, 12, Object.fromEntries(distributors.map(id => [id, 'range'])))
  const review = reviewGoodsPricing(adjusted, 12)
  const moved = review.yearEnd.filter(entry => entry.amount !== 0).map(entry => entry.id)
  assert.deepEqual(moved, ['UK'])
  assert.equal(policyRows(review).UK.status, 'within')
  assert.equal(Math.round(policyRows(review).UK.forecast * 10_000), 450)
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

test('a scenario saved before these settings existed still runs and keeps its results', () => {
  const { ranges, tax, customs, yearEnd, ...saved } = legacyConfig()
  delete saved.simulation.marketVariation
  const inProgress = upgradeConfig(structuredClone(saved), true)
  assert.equal(cents(runYear(inProgress).actual[0].consolidated.operatingProfit), 335_489.81)
  assert.equal(inProgress.simulation.marketVariation, undefined)
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
