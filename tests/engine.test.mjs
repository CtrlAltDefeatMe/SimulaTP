// Run with: node --test tests/engine.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyGoodsPrices, applyServiceFees, applyYearEndAdjustments, createConfig, CUSTOMS_LANES, ENTITIES, entityDetail, explainYear, goodsPriceAlerts, productLineResults, PRODUCTS, profitAllocation, quarterly, unfilledDemand,
  reviewGoodsPricing, royaltyCheck, runYear, summarizeTaxAndCustoms, TESTED_PARTIES, upgradeConfig, US_TAX_RULES, usIncomeTax,
} from '../src/engine.mjs'
import { renderEntityDetail } from '../src/entity-view.mjs'
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

test('customs duty follows the importing block, where the goods were made and the product line', () => {
  const config = createConfig()
  // Give every lane and product its own rate so that a mix-up would show.
  CUSTOMS_LANES.forEach(({ key }, lane) => Object.keys(PRODUCTS).forEach((family, index) => {
    config.customs.rates[key][family] = 0.01 * (lane + 1) + 0.001 * (index + 1)
  }))
  const { actual } = runYear(config)
  const block = id => ['US', 'CA', 'APAC'].includes(id) ? id : 'EU'
  const expected = {}
  for (const month of actual) {
    for (const invoice of month.transactions) {
      if (invoice.external || invoice.category !== 'goods' || !invoice.quantity) continue
      // Every goods invoice says where its units were made, and the parts add up to the invoice.
      const parts = Object.entries(invoice.origins)
      assert.ok(parts.every(([origin]) => origin === 'US' || origin === 'EU'))
      assert.ok(Math.abs(parts.reduce((sum, [, value]) => sum + value, 0) - invoice.amount) < 1e-6)
      for (const [origin, value] of parts) {
        const importer = block(invoice.to)
        // No duty inside a block, and none on goods returning to the block that made them.
        if (importer === block(invoice.from) || importer === origin) continue
        const key = importer + '.' + origin
        expected[key] ??= { A: 0, B: 0, C: 0 }
        expected[key][invoice.product] += config.customs.rates[key][invoice.product] * value
      }
    }
  }
  const { lanes, total } = summarizeTaxAndCustoms(config, actual).customs
  for (const { key } of CUSTOMS_LANES) {
    for (const family of Object.keys(PRODUCTS)) {
      assert.ok(Math.abs(lanes[key].products[family].duty - (expected[key]?.[family] ?? 0)) < 0.005, key + ' ' + family)
      assert.equal(lanes[key].products[family].rate, config.customs.rates[key][family])
    }
  }
  assert.ok(Math.abs(total - Object.values(lanes).reduce((sum, lane) => sum + lane.duty, 0)) < 0.005)
  // Cross-supply carries US-made goods through the Swiss warehouse to Asia. Canada is supplied
  // from the US plant, so its lane for Europe-made goods is used only if cross-supplied goods are passed on.
  for (const key of ['EU.US', 'US.EU', 'CA.US', 'APAC.US', 'APAC.EU']) assert.ok(lanes[key].value > 0, key)
  // Shipments to Germany, France and the United Kingdom stay inside the European block.
  assert.ok(Object.values(lanes).every(lane => lane.importer !== 'EU' || lane.origin === 'US'))
  assert.ok(actual.every(month => month.inventory.every(bin => bin.closing.every(lot => lot.origin === 'US' || lot.origin === 'EU'))))
})

test('duty is part of what imported goods cost and reaches cost of sales when they are sold', () => {
  // Leave the margin target out so that unit costs are not rescaled between the two runs.
  const config = createConfig()
  delete config.annualOperatingMargin
  const raised = structuredClone(config)
  for (const family of Object.keys(PRODUCTS)) raised.customs.rates['EU.US'][family] += 0.04
  const [low, high] = [config, raised].map(scenario => runYear(scenario).actual)
  const year = (months, pick) => months.reduce((sum, month) => sum + pick(month), 0)
  // The change in the value of stock over the year, in total or for one owner.
  const stockAt = (months, key, owner) => {
    const value = (bins, end) => bins.filter(bin => !owner || bin.owner === owner)
      .reduce((sum, bin) => sum + bin[end].reduce((held, lot) => held + lot.quantity * lot[key], 0), 0)
    return value(months[11].inventory, 'closing') - value(months[0].inventory, 'opening')
  }
  const moreDuty = year(high, month => month.customs.total) - year(low, month => month.customs.total)
  assert.ok(moreDuty > 1000)
  // Switzerland imports the US-made goods. Its opening stock of them already carries duty at
  // the scenario's rate, and the duty paid in the year sits in stock until the goods are
  // sold. Its profit falls by the duty less the change in what is on the shelf.
  const stillInStock = stockAt(high, 'unitValue', 'CH') - stockAt(low, 'unitValue', 'CH')
  assert.ok(Math.abs(stillInStock) < moreDuty)
  const profit = (months, id) => year(months, month => month.entities[id].operatingProfit)
  // Goods sold on to Asia carry the duty in the distributor's declared price base only through
  // Switzerland's cost, so the whole effect lands on the importer.
  assert.ok(Math.abs(profit(high, 'CH') - profit(low, 'CH') + moreDuty - stillInStock) < 0.01)
  for (const id of ['US', 'PL', 'BE', 'DE', 'FR', 'UK', 'APAC', 'CA', 'IN']) assert.ok(Math.abs(profit(high, id) - profit(low, id)) < 1e-6, id)
  // The group bears it too: duty is paid to customs, not to another group company.
  const groupStock = stockAt(high, 'unitGroupCost') - stockAt(low, 'unitGroupCost')
  assert.ok(Math.abs(total(high, 'operatingProfit') - total(low, 'operatingProfit') + moreDuty - groupStock) < 0.01)
  assert.ok(high.every(month => Object.values(month.reconciliation).every(value => Math.abs(value) < 0.005)))
  const invalid = structuredClone(config)
  invalid.customs.rates['CA.EU'].C = 1.2
  assert.throws(() => runYear(invalid), /customs duty rate/)
})

test('an upward year-end adjustment into another customs block carries duty and still lands on target', () => {
  // Find a year in which Asia finishes above its target, so that it owes its supplier more.
  let found = null
  for (let index = 0; index < 60 && !found; index++) {
    const config = createConfig()
    config.simulation.seed = 'duty-' + index
    const entry = runYear(config).actual[11].yearEnd.find(row => row.id === 'APAC')
    if (entry.toTarget > 1000) found = config
  }
  assert.ok(found)
  const before = runYear(found)
  const after = runYear(applyYearEndAdjustments(found, 12, { APAC: 'target' }))
  const entry = after.actual[11].yearEnd.find(row => row.id === 'APAC')
  assert.ok(entry.amount > 0 && entry.dutyRate > 0)
  assert.ok(Math.abs(entry.duty - entry.dutyRate * entry.amount) < 1e-9)
  assert.equal(bp(entry.marginAfter), bp(entry.target))
  assert.ok(Math.abs(after.actual[11].customs.adjustments.APAC.duty - entry.duty) < 1e-9)
  // Asia pays the adjustment and the duty. Switzerland receives the adjustment. The group loses the duty.
  const profit = (year, id) => year.actual[11].entities[id].operatingProfit
  assert.ok(Math.abs(profit(after, 'APAC') - profit(before, 'APAC') + entry.amount + entry.duty) < 0.005)
  assert.ok(Math.abs(profit(after, 'CH') - profit(before, 'CH') - entry.amount) < 0.005)
  assert.ok(Math.abs(after.actual[11].consolidated.operatingProfit - before.actual[11].consolidated.operatingProfit + entry.duty) < 0.005)
  assert.ok(Object.values(after.actual[11].reconciliation).every(value => Math.abs(value) < 0.005))
  // The explanation of the year still adds up.
  const explained = explainYear(applyYearEndAdjustments(found, 12, { APAC: 'target' }), after).find(row => row.id === 'APAC')
  assert.ok(Math.abs(explained.budget + explained.drivers.reduce((sum, driver) => sum + driver.points, 0) - explained.result) < 1e-4)
})

test('a distributor\'s policy price leaves room for the duty it pays on top', () => {
  const margins = [0, 0.05, 0.15].map((rate) => {
    const config = createConfig()
    for (const origin of ['US', 'EU']) for (const family of Object.keys(PRODUCTS)) config.customs.rates['APAC.' + origin][family] = rate
    const { budget } = runYear(config)
    const asia = budget.reduce((sum, month) => ({ revenue: sum.revenue + month.entities.APAC.revenue, profit: sum.profit + month.entities.APAC.operatingProfit }), { revenue: 0, profit: 0 })
    // The whole budget still meets the consolidated target, with unit costs rescaled around the duty.
    assert.ok(Math.abs(total(budget, 'operatingProfit') / total(budget, 'revenue') - config.annualOperatingMargin) < 1e-9)
    const prices = reviewGoodsPricing(config, 0).routes.find(route => route.key === 'CH-APAC').prices
    return { margin: asia.profit / asia.revenue, price: prices.find(price => price.product === 'B').applied, rate }
  })
  // Asia earns its target margin in the budget at any duty rate.
  for (const { margin, rate } of margins) assert.ok(Math.abs(margin - 0.075) < 0.0005, String(rate))
  // Its price falls as duty rises, so that the landed cost stays about the same.
  assert.ok(margins[0].price > margins[1].price && margins[1].price > margins[2].price)
  assert.ok(Math.abs(margins[1].price * 1.05 / margins[0].price - 1) < 0.01)
})

test('duty rates saved by goods route become rates by block, origin and product line', () => {
  const byRoute = { 'US-CH': 0.02, 'CH-US': 0.08, 'CH-UK': 0.01, 'CH-APAC': 0.06, 'US-CA': 0.015 }
  const inProgress = upgradeConfig({ ...createConfig(), customs: { rates: { ...byRoute } } }, true)
  const expected = { 'EU.US': 0.02, 'US.EU': 0.08, 'CA.US': 0.015, 'CA.EU': 0.015, 'APAC.US': 0.06, 'APAC.EU': 0.06 }
  for (const { key } of CUSTOMS_LANES) assert.deepEqual(inProgress.customs.rates[key], { A: expected[key], B: expected[key], C: expected[key] })
  runYear(inProgress)
  // A scenario that has not started and never changed the old defaults takes the new ones.
  const untouched = { 'US-CH': 0.03, 'CH-US': 0.10, 'CH-UK': 0, 'CH-APAC': 0.05, 'US-CA': 0 }
  assert.deepEqual(upgradeConfig({ ...createConfig(), customs: { rates: untouched } }, false).customs, createConfig().customs)
  assert.equal(upgradeConfig({ ...createConfig(), customs: { rates: untouched } }, true).customs.rates['CA.EU'].A, 0)
})

test('the default plants run at their limit for each product line in busy months without leaving demand unfilled', () => {
  const config = createConfig()
  assert.deepEqual(config.capacity, { US: { A: 915, B: 1645 }, PL: { A: 1565, C: 1035 } })
  const { budget, actual } = runYear(config)
  for (const months of [budget, actual]) {
    for (const [id, limits] of Object.entries(config.capacity)) {
      for (const [family, limit] of Object.entries(limits)) {
        const made = months.map(month => month.capacity[id].byProduct[family])
        assert.ok(made.every(units => units <= limit), id + family)
        assert.ok(made.some(units => units === limit), id + family)
        assert.ok(made.some(units => units < limit), id + family)
      }
      assert.ok(months.every(month => month.capacity[id].limit === Object.values(limits).reduce((sum, limit) => sum + limit, 0)), id)
      assert.deepEqual(months[0].capacity[id].limits, limits)
    }
    // Stock covers what the plants cannot make in a busy month.
    assert.ok(months.every(month => month.sales.every(sale => sale.unfilled === 0)))
  }
  // Capacity used to be one figure for each plant. A scenario saved that way takes the limits by product line.
  for (const started of [false, true]) {
    assert.deepEqual(upgradeConfig({ ...createConfig(), capacity: { US: 2150, PL: 2900 } }, started).capacity, config.capacity)
  }
  const own = { US: { A: 1000, B: 1700 }, PL: { A: 1500, C: 1100 } }
  assert.deepEqual(upgradeConfig({ ...createConfig(), capacity: structuredClone(own) }, false).capacity, own)
  for (const capacity of [{ US: { A: 915 }, PL: { A: 1565, C: 1035 } }, { US: { A: 915, B: 1645 }, PL: { A: 1565, C: -1 } }, { US: { A: 915.5, B: 1645 }, PL: { A: 1565, C: 1035 } }]) {
    assert.throws(() => runYear({ ...createConfig(), capacity }), /capacity for .* must be a nonnegative whole number/)
  }
})

test('the high-margin line is made only in the United States and the low-margin line only in Poland', () => {
  const config = createConfig()
  const { budget, actual } = runYear(config)
  const add = (months, pick) => months.reduce((sum, month) => sum + pick(month), 0)
  const shipped = (months, policy, family) => add(months, month => month.transactions
    .filter(line => line.policy === policy && line.product === family).reduce((sum, line) => sum + line.quantity, 0))
  const sold = (months, family, sellers) => add(months, month => month.sales
    .filter(sale => sale.product === family && sellers.includes(sale.seller)).reduce((sum, sale) => sum + sale.quantity, 0))
  for (const months of [budget, actual]) {
    assert.ok(months.every(month => month.capacity.PL.byProduct.B === 0 && month.capacity.US.byProduct.C === 0))
    assert.ok(months.every(month => month.capacity.US.byProduct.A > 0 && month.capacity.US.byProduct.B > 0))
    assert.ok(months.every(month => month.capacity.PL.byProduct.A > 0 && month.capacity.PL.byProduct.C > 0))
    // Poland holds no materials for the line it does not convert.
    assert.ok(months.every(month => !month.inventory.some(bin => bin.custodian === 'PL' && bin.product === 'B')))
    // Each hub buys the line it does not make from the other, and never ships that line back.
    assert.equal(shipped(months, 'US_TO_CH', 'C'), 0)
    assert.equal(shipped(months, 'CH_TO_US', 'B'), 0)
    // Everything Europe and Asia sell of the US-made line crossed from the United States, give or take the change in stock.
    const acrossB = shipped(months, 'US_TO_CH', 'B')
    const acrossC = shipped(months, 'CH_TO_US', 'C')
    assert.ok(Math.abs(acrossB - sold(months, 'B', ['CH', 'DE', 'FR', 'UK', 'APAC'])) < 600, String(acrossB))
    assert.ok(Math.abs(acrossC - sold(months, 'C', ['US', 'CA'])) < 300, String(acrossC))
    // The shared line crosses only to cover a plant at its limit, so it is a small part of the flow.
    const acrossA = shipped(months, 'US_TO_CH', 'A') + shipped(months, 'CH_TO_US', 'A')
    assert.ok(acrossA < 0.02 * sold(months, 'A', ['US', 'CH', 'DE', 'FR', 'UK', 'APAC', 'CA']), String(acrossA))
    // Where the goods were made travels with them: Canada's low-margin line is European, Asia's high-margin line American.
    const origins = (owner, family) => new Set(months.flatMap(month => month.inventory
      .filter(bin => bin.owner === owner && bin.product === family).flatMap(bin => bin.receipts.map(lot => lot.origin))))
    assert.deepEqual([...origins('CA', 'C')], ['EU'])
    assert.deepEqual([...origins('APAC', 'B')], ['US'])
    assert.deepEqual([...origins('DE', 'B')], ['US'])
    assert.deepEqual([...origins('US', 'C')], ['EU'])
  }
  // Duty is paid at each border the goods cross: into the United States, and again into Canada.
  const lanes = summarizeTaxAndCustoms(config, actual).customs.lanes
  assert.ok(lanes['US.EU'].products.C.duty > 0 && lanes['CA.EU'].products.C.duty > 0)
  assert.ok(lanes['EU.US'].products.B.duty > 0 && lanes['APAC.US'].products.B.duty > 0)
  assert.equal(lanes['US.EU'].products.B.value + lanes['EU.US'].products.C.value, 0)

  // The Transfer prices page lists only the lines a hub can cross-supply, and a bought-in
  // line's standard cost is what the hub paid for it: the other hub's price plus the duty.
  const review = reviewGoodsPricing(config, 0)
  const route = key => review.routes.find(entry => entry.key === key)
  assert.deepEqual(route('US-CH').prices.map(price => price.product), ['A', 'B'])
  assert.deepEqual(route('CH-US').prices.map(price => price.product), ['A', 'C'])
  assert.deepEqual(route('CH-DE').prices.map(price => price.product), ['A', 'B', 'C'])
  const price = (key, family) => route(key).prices.find(entry => entry.product === family)
  assert.equal(price('CH-DE', 'B').made, false)
  assert.equal(price('CH-DE', 'A').made, true)
  assert.equal(bp(price('CH-DE', 'B').standardCost / (price('US-CH', 'B').standardCost * (1 + config.policies.usToSwissMarkup) * (1 + config.customs.rates['EU.US'].B))), 10_000)
  assert.equal(bp(price('US-CA', 'C').standardCost / (price('CH-US', 'C').standardCost * (1 + config.policies.swissToUsMarkup) * (1 + config.customs.rates['US.EU'].C))), 10_000)
  // The duty shown on a route is for the plant that normally supplies the line.
  assert.equal(price('US-CA', 'C').duty, config.customs.rates['CA.EU'].C)
  assert.equal(price('US-CA', 'A').duty, config.customs.rates['CA.US'].A)
  assert.equal(price('CH-APAC', 'B').duty, config.customs.rates['APAC.US'].B)
  assert.equal(price('CH-APAC', 'C').duty, config.customs.rates['APAC.EU'].C)
})

test('the other plant covers a shortfall of the line both plants make', () => {
  const config = { ...createConfig(), capacity: { US: { A: 1300, B: 1645 }, PL: { A: 1200, C: 1035 } } }
  const { budget, actual } = runYear(config)
  for (const months of [budget, actual]) {
    // Poland runs at its limit all year. The US plant makes the rest and ships it to Switzerland.
    assert.ok(months.every(month => month.capacity.PL.byProduct.A === 1200))
    assert.ok(months.every(month => month.capacity.US.byProduct.A <= 1300))
    const across = months.reduce((sum, month) => sum + month.transactions
      .filter(line => line.policy === 'US_TO_CH' && line.product === 'A').reduce((units, line) => units + line.quantity, 0), 0)
    assert.ok(across > 3000, String(across))
    assert.ok(months.every(month => month.sales.every(sale => sale.unfilled === 0)))
    assert.ok(months.every(month => Object.values(month.reconciliation).every(value => Math.abs(value) < 0.005)))
  }
  // With no spare capacity at either plant, the hubs share their stock before a sale is lost.
  const tight = { ...createConfig(), capacity: { US: { A: 700, B: 1645 }, PL: { A: 1200, C: 1035 } } }
  const short = runYear(tight).budget
  assert.ok(short.every(month => month.sales.every(sale => sale.unfilled === 0)))
  assert.ok(short.some(month => month.transactions.some(line => line.policy === 'CH_TO_US' && line.product === 'A' && line.quantity > 0)))
  // Cut further, the stock runs out at both hubs and demand for the line goes unmet. The other two lines are untouched.
  const starved = runYear({ ...createConfig(), capacity: { US: { A: 500, B: 1645 }, PL: { A: 900, C: 1035 } } }).budget
  const unfilled = family => starved.reduce((sum, month) => sum + month.sales.filter(sale => sale.product === family).reduce((units, sale) => units + sale.unfilled, 0), 0)
  assert.ok(unfilled('A') > 1000)
  assert.equal(unfilled('B') + unfilled('C'), 0)
})

test('demand for a line made in one plant goes unmet once that plant is at its limit and the stock is gone', () => {
  const base = createConfig()
  const baseline = runYear(base).budget
  const units = lots => lots.reduce((sum, lot) => sum + lot.quantity, 0)
  for (const [plant, family, limit, hub, other] of [['US', 'B', 1300, 'US', 'BE'], ['PL', 'C', 700, 'BE', 'US']]) {
    const config = { ...base, capacity: structuredClone(base.capacity) }
    config.capacity[plant][family] = limit
    const { budget, actual } = runYear(config)
    for (const months of [budget, actual]) {
      assert.ok(months.every(month => month.capacity[plant].byProduct[family] === limit), family)
      const unfilled = line => months.reduce((sum, month) => sum + month.sales.filter(sale => sale.product === line).reduce((count, sale) => count + sale.unfilled, 0), 0)
      assert.ok(unfilled(family) > 200, family)
      // The other plant cannot help, and the other lines are not affected.
      assert.equal(Object.keys(PRODUCTS).filter(line => line !== family).reduce((sum, line) => sum + unfilled(line), 0), 0)
      assert.ok(months.every(month => Object.values(month.reconciliation).every(value => Math.abs(value) < 0.005)))
      // No sale is lost while either hub still holds the line.
      const first = months.findIndex(month => month.sales.some(sale => sale.product === family && sale.unfilled > 0))
      const stock = custodian => units(months[first].inventory.find(bin => bin.custodian === custodian && bin.product === family && bin.stage === 'finished').closing)
      assert.ok(first > 0, family)
      assert.equal(stock(hub) + stock(other), 0, family)
    }
    // Lost sales are reported by product line and by seller.
    const lines = budget.map(month => productLineResults(month).find(line => line.product === family))
    assert.ok(lines.some(line => line.unfilled > 0 && line.lostSales > 0))
    const lost = budget.flatMap(month => unfilledDemand(month))
    assert.ok(lost.length && lost.every(entry => entry.product === family && entry.units > 0 && entry.lostSales > 0))
    assert.equal(lost.reduce((sum, entry) => sum + entry.units, 0), lines.reduce((sum, line) => sum + line.unfilled, 0))
    const revenue = months => months.reduce((sum, month) => sum + month.consolidated.revenue, 0)
    assert.ok(Math.abs(revenue(baseline) - revenue(budget) - lost.reduce((sum, entry) => sum + entry.lostSales, 0)) < 0.01, family)
  }
  assert.deepEqual(baseline.flatMap(month => unfilledDemand(month)), [])
})

test('a saved scenario that has not started takes the current default margin, and one in progress keeps its own', () => {
  const previous = 2_287_230.2960874448 / 10_487_570 - 0.04
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

test('prices below the supplier\'s standard cost are reported, and a floor removes them', () => {
  const open = createConfig()
  const alerts = goodsPriceAlerts(open, 1)
  // With no floor the thin line is sold to the full-fledged distributors below cost.
  assert.deepEqual(alerts.belowCost.map(row => row.key + ' ' + row.product).sort(), ['CH-APAC C', 'US-CA C'])
  assert.ok(alerts.belowCost.every(row => row.price < row.standardCost))
  assert.equal(alerts.atFloor.length, 0)
  assert.equal(alerts.floorMarkup, null)
  const route = reviewGoodsPricing(open, 0).routes.find(entry => entry.key === 'CH-APAC')
  assert.deepEqual(route.floorHeld, [])
  const floored = goodsPriceAlerts(withFloor(), 1)
  assert.equal(floored.belowCost.length, 0)
  assert.ok(floored.atFloor.some(row => row.key === 'CH-APAC' && row.product === 'C'))
  assert.equal(floored.floorMarkup, 0.05)
})

test('the floor is kept even when it leaves a distributor below its range, and the reason is reported', () => {
  // A modest floor holds the thin line up and the other lines absorb it, so Asia still meets its target.
  const modest = reviewGoodsPricing(withFloor(), 0)
  const asia = modest.routes.find(route => route.key === 'CH-APAC')
  assert.ok(asia.floorHeld.includes('C') && !asia.floorShort)
  const price = family => asia.prices.find(entry => entry.product === family)
  // The floor lifts the thin line above its policy price. The high-margin line is priced under its own to make up for it.
  assert.ok(asia.policyWithoutFloor.C < price('C').floor && price('C').applied === price('C').floor)
  assert.ok(price('B').applied < asia.policyWithoutFloor.B && price('B').applied > price('B').floor)
  assert.equal(policyRows(modest).APAC.status, 'within')
  // A floor above every policy price leaves nothing to absorb it. The floor still holds.
  const steep = withFloor(0.6)
  const review = reviewGoodsPricing(steep, 0)
  const held = review.routes.find(route => route.key === 'CH-APAC')
  assert.deepEqual(held.floorHeld, ['A', 'B', 'C'])
  assert.ok(held.floorShort)
  assert.ok(held.prices.every(price => price.applied === price.floor))
  assert.equal(policyRows(review).APAC.status, 'below')
  const year = runYear(steep)
  for (const invoice of goodsInvoices(year.actual)) {
    const floor = review.routes.find(route => route.key === invoice.from + '-' + invoice.to).prices.find(price => price.product === invoice.product).floor
    assert.ok(invoice.amount / invoice.quantity >= floor - 1e-9, invoice.id)
  }
  // Not even a year-end credit can bring Asia into its range, and the explanation says why.
  const entry = year.actual[11].yearEnd.find(row => row.id === 'APAC')
  assert.equal(entry.statusBefore, 'below')
  assert.ok(entry.floorLimited.range && entry.floorLimited.target)
  const closed = runYear(applyYearEndAdjustments(steep, 12, { APAC: 'target' }))
  assert.equal(closed.actual[11].yearEnd.find(row => row.id === 'APAC').statusAfter, 'below')
  const explained = explainYear(steep, year).find(row => row.id === 'APAC')
  assert.deepEqual(explained.facts.floor, { held: ['A', 'B', 'C'], creditLimited: true })
  assert.equal(explainYear(createConfig(), runYear(createConfig())).find(row => row.id === 'APAC').facts.floor, undefined)
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

test('year-end adjustments to target move each distributor onto its target and cost the group only the duty they attract', () => {
  const config = createConfig()
  const before = runYear(config)
  const adjusted = applyYearEndAdjustments(config, 12, Object.fromEntries(distributors.map(id => [id, 'target'])))
  const after = runYear(adjusted)
  assert.equal(cents(after.actual[11].consolidated.operatingProfit),
    cents(before.actual[11].consolidated.operatingProfit - after.actual[11].customs.adjustmentDuty))
  const policies = policyRows(reviewGoodsPricing(adjusted, 12))
  for (const id of distributors) {
    assert.equal(Math.round(policies[id].forecast * 10_000), Math.round(policies[id].target * 10_000), id)
    assert.equal(policies[id].status, 'within', id)
  }
  const entries = after.actual[11].transactions.filter(transaction => transaction.policy === 'YEAR_END_ADJUSTMENT')
  assert.equal(entries.length, 5)
  assert.ok(entries.every(entry => entry.quantity === 0))
  // An upward adjustment for a distributor outside Europe adds duty at the average rate
  // of its year's imports. A credit earns no refund. Germany, France and the United Kingdom
  // sit inside the same customs block as their supplier.
  const customs = months => summarizeTaxAndCustoms(adjusted, months).customs
  assert.deepEqual(Object.keys(customs(after.actual).adjustments).sort(), ['APAC', 'CA'])
  assert.equal(customs(before.actual).adjustmentDuty, 0)
  for (const [importer, entry] of Object.entries(customs(after.actual).adjustments)) {
    const invoice = entries.find(candidate => candidate.to === importer)
    assert.equal(entry.amount, invoice.amount, importer)
    const imports = Object.values(customs(after.actual).lanes).filter(lane => lane.importer === importer)
    const value = imports.reduce((sum, lane) => sum + lane.value, 0)
    const average = imports.reduce((sum, lane) => sum + lane.duty, 0) / value
    assert.ok(Math.abs(entry.duty - average * Math.max(0, invoice.amount)) < 0.005, importer)
  }
  assert.ok(Math.abs(customs(after.actual).total - customs(before.actual).total - customs(after.actual).adjustmentDuty) < 0.005)
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
  assert.throws(() => applyYearEndAdjustments(createConfig(), 11, { DE: 'target' }), /fourth-quarter/)
  const config = createConfig()
  assert.equal(applyYearEndAdjustments(config, 12, { DE: 'none' }), config)
})

test('income tax follows US GAAP profit during the year and local statutory profit once the year is closed', () => {
  const config = createConfig()
  const { actual } = runYear(config)
  const gaapProfit = (id, months) => months.reduce((profit, month) => profit + month.entities[id].operatingProfit, 0)
  // Every entity but the US parent pays its own rate. The US is taxed under its federal rules.
  const foreign = Object.keys(config.tax.rates).filter(id => id !== 'US')
  const nineMonths = actual.slice(0, 9)
  const interim = summarizeTaxAndCustoms(config, nineMonths).tax
  const expectedInterim = foreign.reduce((sum, id) => sum + config.tax.rates[id] * gaapProfit(id, nineMonths), 0) + usIncomeTax(config, nineMonths).total
  assert.ok(Math.abs(interim.total - expectedInterim) < 0.005)
  const { tax } = summarizeTaxAndCustoms(config, actual)
  const stat = actual[11].stat
  const expected = foreign.reduce((sum, id) => sum + config.tax.rates[id] * stat[id].operatingProfit, 0) + usIncomeTax(config, actual, stat).total
  assert.ok(Math.abs(tax.total - expected) < 0.005)
  assert.equal(tax.entities.US.tax, tax.entities.US.detail.total)
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
  const config = { ...createConfig(), capacity: { US: { A: 2600, B: 1645 }, PL: { A: 0, C: 0 } } }
  delete config.annualOperatingMargin
  const { actual } = runYear(config)
  assert.ok(actual.every(month => month.services.PL.units === 0 && month.services.PL.cost > 0))
  assert.ok(actual.every(month => Math.abs(month.reconciliation.profitDifference) < 0.005))
  // The US plant supplies the shared line everywhere. Nobody can make the line that only Poland makes.
  const unfilled = family => actual.reduce((sum, month) => sum + month.sales.filter(sale => sale.product === family).reduce((units, sale) => units + sale.unfilled, 0), 0)
  assert.equal(unfilled('A') + unfilled('B'), 0)
  assert.ok(unfilled('C') > 0)
})

test('a service fee set at a quarterly review applies from the next month and its policy quote reaches the target', () => {
  const config = createConfig()
  const review = reviewGoodsPricing(config, 6)
  const quotes = Object.fromEntries(review.services.map(quote => [quote.id, quote]))
  assert.throws(() => applyServiceFees(config, 5, { PL: 50_000 }), /first, second or third quarter/)
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
  assert.throws(() => explainYear(config, { budget: [], actual: [] }), /fourth-quarter/)
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

test('the entity detail report adds up to each entity’s results, budget and actual', () => {
  const config = applyYearEndAdjustments(createConfig(), 12, Object.fromEntries(TESTED_PARTIES.map(id => [id, 'target'])))
  const year = runYear(config)
  const companies = Object.keys(ENTITIES).filter(id => !ENTITIES[id].external)
  const add = (list, pick) => list.reduce((sum, item) => sum + pick(item), 0)
  const near = (left, right, label) => assert.ok(Math.abs(left - right) < 0.005, `${label}: ${left} against ${right}`)
  for (const id of companies) {
    for (const [basis, period, revealed] of [['month', 0, 0], ['month', 5, 12], ['month', 11, 12], ['year', 0, 0], ['year', 0, 7], ['year', 0, 12]]) {
      const detail = entityDetail(config, year, id, { basis, period, revealed })
      const sides = [
        ['budget', detail.budget, basis === 'year' ? year.budget : [year.budget[period]]],
        ['actual', detail.actual, basis === 'year' ? year.actual.slice(0, revealed) : period < revealed ? [year.actual[period]] : []],
      ]
      for (const [side, lines, months] of sides) {
        const label = [id, basis, period, revealed, side].join(' ')
        const results = months.map(month => month.entities[id])
        // Units times net sales price, product by product, is goods net sales. Fees, royalty and adjustments make up the rest of revenue.
        const goods = add(lines.sales, group => add(Object.values(group.products), line => line.amount))
        near(goods + add(lines.otherRevenue, line => line.amount) + lines.adjustmentRevenue, add(results, result => result.revenue), `${label} revenue`)
        // Units times the value they were carried at is cost of sales.
        const { products, adjustments, fees, other, total: costOfSales } = lines.costOfSales
        near(add(Object.values(products), line => line.amount) + adjustments + fees + other, add(results, result => result.cogs), `${label} cost of sales`)
        near(costOfSales, add(results, result => result.cogs), `${label} cost of sales total`)
        near(add(lines.charges, line => line.amount) + lines.ownCosts + lines.ownResearch, add(results, result => result.operatingExpenses), `${label} operating expenses`)
        near(lines.revenue - costOfSales - lines.operatingExpenses, add(results, result => result.operatingProfit), `${label} operating profit`)
        assert.ok(lines.ownCosts > -0.005 && lines.ownResearch > -0.005, label)
        // Nothing is reported as an actual before a month is revealed.
        if (!months.length) assert.deepEqual([lines.revenue, costOfSales, lines.operatingExpenses, lines.operatingProfit, lines.sales.length], [0, 0, 0, 0, 0], label)
        // Finished stock rolls forward: beginning plus received less sold is ending, in units and in value.
        if (months.length && lines.inventory.opening.length) {
          for (const family of Object.keys(PRODUCTS)) {
            const stock = rows => rows.find(row => row.stage === 'finished' && row.product === family)
            const [opening, closing] = [stock(lines.inventory.opening), stock(lines.inventory.closing)]
            assert.equal(opening.units + lines.received[family].units - products[family].units, closing.units, `${label} ${family} units`)
            near(opening.amount + lines.received[family].amount - products[family].amount, closing.amount, `${label} ${family} stock value`)
          }
        }
      }
    }
  }
})

test('the entity detail report shows service fees, the royalty and stock the way each is set', () => {
  const config = createConfig()
  const year = runYear(config)
  const report = (id, options) => entityDetail(config, year, id, options)
  // A service entity shows its budgeted cost and the markup on it separately. Together they are the fee.
  for (const [id, markup] of [['PL', config.policies.polandMarkup], ['IN', config.policies.indiaServicesMarkup]]) {
    const { budget, actual } = report(id, { basis: 'month', period: 4, revealed: 12 })
    for (const { service } of [budget, actual]) {
      assert.equal(service.kind, 'fixed')
      assert.equal(cents(service.budgetCost + service.markup), cents(service.fee), id)
      assert.equal(bp(service.markup / service.budgetCost), bp(markup), id)
    }
    // The fee is fixed for the month. The cost behind it is not.
    assert.equal(cents(actual.service.fee), cents(budget.service.fee), id)
    assert.notEqual(cents(actual.service.cost), cents(budget.service.cost), id)
    assert.equal(cents(report(id, { basis: 'year', revealed: 12 }).budget.service.budgetCost), cents(budget.service.budgetCost * 12), id)
  }
  const warehouse = report('BE', { basis: 'year', revealed: 12 }).actual.service
  assert.equal(bp(warehouse.markup / warehouse.fee), bp(config.policies.belgiumMargin))

  // Switzerland pays the royalty on its base, and the United States earns the same amount.
  const swiss = report('CH', { basis: 'year', revealed: 9 })
  const owner = report('US', { basis: 'year', revealed: 9 })
  for (const side of ['budget', 'actual']) {
    assert.equal(swiss[side].royalty.direction, 'paid')
    assert.equal(owner[side].royalty.direction, 'earned')
    assert.equal(cents(swiss[side].royalty.amount), cents(swiss[side].royalty.base * config.policies.royaltyRate))
    assert.equal(cents(swiss[side].royalty.amount), cents(owner[side].royalty.amount))
  }
  assert.equal(cents(swiss.actual.royalty.base), cents(year.actual.slice(0, 9).reduce((sum, month) => sum + month.royaltyBase, 0)))
  assert.equal(report('DE', { basis: 'year', revealed: 9 }).actual.royalty, null)

  // The annual view sets the full-year budget beside actuals to date.
  const units = lines => lines.sales.reduce((sum, group) => sum + Object.values(group.products).reduce((count, line) => count + line.units, 0), 0)
  const germany = report('DE', { basis: 'year', revealed: 3 })
  assert.equal(germany.budget.months, 12)
  assert.equal(germany.actual.months, 3)
  assert.equal(units(germany.actual), [0, 1, 2].reduce((sum, period) => sum + units(report('DE', { basis: 'month', period, revealed: 3 }).actual), 0))
  assert.deepEqual(germany.actual.inventory.closing, report('DE', { basis: 'month', period: 2, revealed: 3 }).actual.inventory.closing)
  assert.deepEqual(germany.actual.inventory.opening, germany.budget.inventory.opening)

  // Stock is a balance. Before the year starts both ends are the opening stock. An unrevealed month has no ending stock yet.
  const start = report('DE', { basis: 'year', revealed: 0 }).actual
  assert.equal(start.revenue, 0)
  assert.deepEqual(start.inventory.closing, start.inventory.opening)
  assert.ok(start.inventory.opening.every(row => row.units > 0))
  const next = report('DE', { basis: 'month', period: 3, revealed: 3 }).actual.inventory
  assert.deepEqual(next.opening, germany.actual.inventory.closing)
  assert.equal(next.closing, null)
  assert.deepEqual(report('DE', { basis: 'month', period: 5, revealed: 3 }).actual.inventory, { opening: null, closing: null })
  // The service entities and the toll manufacturer hold no stock.
  for (const id of ['PL', 'BE', 'IN']) assert.deepEqual(report(id, { basis: 'year', revealed: 12 }).budget.inventory, { opening: [], closing: [] })
  assert.deepEqual(Object.keys(report('PL', { basis: 'month', period: 0, revealed: 1 }).actual.made), Object.keys(PRODUCTS))

  assert.throws(() => report('UNRELATED'), /legal entities/)
  assert.throws(() => report('DE', { basis: 'week' }), /by month, by quarter or by year/)
  assert.throws(() => report('DE', { basis: 'quarter', period: 4 }), /first and the fourth/)
  assert.throws(() => report('DE', { layers: 'week' }), /by month or by quarter/)
  assert.throws(() => report('DE', { period: 12 }), /January and December/)
  assert.throws(() => report('DE', { revealed: 13 }), /between 0 and 12/)
})

test('the entity detail report lists cost of sales and stock by first-in, first-out layer', () => {
  const config = createConfig()
  const year = runYear(config)
  const companies = Object.keys(ENTITIES).filter(id => !ENTITIES[id].external)
  const each = layers => layers.map(layer => cents(layer.amount / layer.units))
  // Every line is the sum of its layers, in units and in value, and no layer is listed twice.
  for (const id of companies) {
    for (const [basis, period, revealed] of [['month', 0, 12], ['month', 8, 12], ['month', 3, 3], ['year', 0, 5], ['year', 0, 12]]) {
      const detail = entityDetail(config, year, id, { basis, period, revealed })
      for (const side of [detail.budget, detail.actual]) {
        const lines = [
          ...Object.values(side.costOfSales.products), ...Object.values(side.received),
          ...(side.inventory.opening ?? []), ...(side.inventory.closing ?? []),
        ]
        for (const line of lines) {
          assert.equal(line.layers.reduce((sum, layer) => sum + layer.units, 0), line.units, id)
          assert.ok(Math.abs(line.layers.reduce((sum, layer) => sum + layer.amount, 0) - line.amount) < 0.005, id)
          assert.equal(new Set(line.layers.map(layer => layer.key)).size, line.layers.length, id)
          assert.deepEqual(line.layers.map(layer => layer.key), line.layers.map(layer => layer.key).sort(), id)
          assert.ok(line.layers.every(layer => layer.units > 0 && layer.duty >= 0 && layer.duty < layer.amount), id)
        }
      }
    }
  }

  // Germany opens with two layers of Precision Components. January sells out of the older, cheaper one,
  // so its cost per unit is below the average value of the stock it started with.
  const january = entityDetail(config, year, 'DE', { basis: 'month', period: 0, revealed: 0 }).budget
  const opening = january.inventory.opening.find(row => row.product === 'A')
  assert.deepEqual(opening.layers.map(layer => [layer.vintage, layer.source, layer.units]), [['2026-11', 'bought', 360], ['2026-12', 'bought', 360]])
  const [older, newer] = each(opening.layers)
  assert.ok(older < newer)
  const sold = january.costOfSales.products.A
  assert.deepEqual(sold.layers.map(layer => layer.vintage), ['2026-11'])
  assert.deepEqual(each(sold.layers), [older])
  assert.ok(cents(sold.amount / sold.units) < cents(opening.amount / opening.units))
  // What it buys in January comes in at January's transfer price and is still in stock at the end of the month.
  assert.deepEqual(january.received.A.layers.map(layer => layer.vintage), ['2027-01'])
  const price = reviewGoodsPricing(config, 0).routes.find(route => route.key === 'CH-DE').prices.find(entry => entry.product === 'A').applied
  assert.deepEqual(each(january.received.A.layers), [cents(price)])
  assert.deepEqual(january.inventory.closing.find(row => row.product === 'A').layers.map(layer => layer.vintage), ['2026-11', '2026-12', '2027-01'])

  // A price raised at the March review shows in April's purchases at once, and in cost of sales only when that layer is reached.
  const current = reviewGoodsPricing(config, 3).routes.find(route => route.key === 'CH-DE').prices
  const raised = Object.fromEntries(current.map(entry => [entry.product, cents(entry.applied * 1.1)]))
  const changedConfig = applyGoodsPrices(config, 3, { 'CH-DE': raised })
  const changed = runYear(changedConfig)
  const month = period => entityDetail(changedConfig, changed, 'DE', { basis: 'month', period, revealed: 12 }).actual
  assert.deepEqual(each(month(3).received.A.layers), [raised.A])
  assert.ok(month(3).costOfSales.products.A.layers.every(layer => layer.vintage < '2027-04'))
  assert.ok(month(5).costOfSales.products.A.layers.some(layer => layer.vintage === '2027-04' && cents(layer.amount / layer.units) === raised.A))
  // The budget keeps the opening price, so the same layer shows both prices side by side.
  const april = entityDetail(changedConfig, changed, 'DE', { basis: 'month', period: 3, revealed: 12 })
  assert.deepEqual(april.budget.received.A.layers.map(layer => layer.key), april.actual.received.A.layers.map(layer => layer.key))
  assert.ok(each(april.budget.received.A.layers)[0] < raised.A)

  // An importer in another customs block carries the duty inside the layer's value.
  const asia = entityDetail(config, year, 'APAC', { basis: 'month', period: 2, revealed: 12 }).actual.received.A.layers
  assert.equal(asia.length, 1)
  assert.equal(cents(asia[0].duty / (asia[0].amount - asia[0].duty)), config.customs.rates['APAC.EU'].A)
  assert.ok(entityDetail(config, year, 'DE', { basis: 'year', revealed: 12 }).actual.received.A.layers.every(layer => layer.duty === 0))
  // Goods of two origins are listed apart only where the duty on them differs.
  // Asia receives the shared line from both plants when the US covers a Polish shortfall.
  const split = { ...createConfig(), capacity: { US: { A: 1300, B: 1645 }, PL: { A: 1200, C: 1035 } } }
  split.customs.rates['APAC.US'].A = 0.12
  const splitYear = runYear(split)
  const origins = lines => new Set(lines.received.A.layers.map(layer => layer.declared))
  assert.deepEqual([...origins(entityDetail(split, splitYear, 'APAC', { basis: 'year', revealed: 12 }).actual)].sort(), ['EU', 'US'])
  assert.deepEqual([...origins(entityDetail(config, year, 'APAC', { basis: 'year', revealed: 12 }).actual)], [null])

  // The United States makes two lines and buys the third from Switzerland, with duty in its value.
  const us = entityDetail(config, year, 'US', { basis: 'month', period: 1, revealed: 12 }).actual.received
  assert.deepEqual(us.B.layers.map(layer => layer.source), ['made'])
  assert.deepEqual(us.C.layers.map(layer => layer.source), ['bought'])
  assert.ok(us.C.layers[0].duty > 0 && us.B.layers[0].duty === 0)
  // Switzerland's converted goods are layered by the month their materials were bought. It buys the US-made line.
  const swiss = entityDetail(config, year, 'CH', { basis: 'month', period: 1, revealed: 12 }).actual.received
  assert.deepEqual(swiss.C.layers.map(layer => [layer.source, layer.materials]), [['converted', '2027-01'], ['converted', '2027-02']])
  assert.deepEqual(swiss.B.layers.map(layer => [layer.source, layer.materials]), [['bought', null]])
  assert.ok(swiss.B.layers[0].duty > 0)
})

test('the year rolls up into four quarters that add up to its twelve months', () => {
  const config = applyYearEndAdjustments(createConfig(), 12, Object.fromEntries(TESTED_PARTIES.map(id => [id, 'target'])))
  const year = runYear(config)
  const quarters = quarterly(config, year)
  const near = (left, right, label) => assert.ok(Math.abs(left - right) < 0.005, `${label}: ${left} against ${right}`)
  const units = lots => lots.reduce((sum, lot) => sum + lot.quantity, 0)
  for (const side of ['budget', 'actual']) {
    assert.equal(quarters[side].length, 4)
    quarters[side].forEach((quarter, index) => {
      const months = year[side].slice(index * 3, index * 3 + 3)
      const add = pick => months.reduce((sum, month) => sum + pick(month), 0)
      const label = `${side} Q${index + 1}`
      assert.equal(quarter.quarter, index + 1)
      assert.deepEqual(quarter.months, months.map(month => month.month))
      // Flows are the sum of the three months.
      for (const key of ['revenue', 'cogs', 'operatingExpenses', 'operatingProfit']) {
        near(quarter.consolidated[key], add(month => month.consolidated[key]), `${label} consolidated ${key}`)
        for (const id of Object.keys(quarter.entities)) near(quarter.entities[id][key], add(month => month.entities[id][key]), `${label} ${id} ${key}`)
      }
      near(quarter.consolidated.operatingMargin, quarter.consolidated.operatingProfit / quarter.consolidated.revenue, `${label} margin`)
      near(quarter.royaltyBase, add(month => month.royaltyBase), `${label} royalty base`)
      near(quarter.customs.total, add(month => month.customs.total), `${label} duty`)
      // Tax at a flat rate adds up. The US parent's is worked out on the quarter as a whole.
      for (const id of Object.keys(quarter.tax.entities).filter(id => id !== 'US')) {
        near(quarter.tax.entities[id].tax, add(month => month.tax.entities[id].tax), `${label} ${id} tax`)
      }
      near(quarter.tax.entities.US.tax, usIncomeTax(config, months).total, `${label} US tax`)
      for (const id of ['PL', 'IN']) {
        near(quarter.services[id].fee, add(month => month.services[id].fee), `${label} ${id} fee`)
        near(quarter.services[id].cost, add(month => month.services[id].cost), `${label} ${id} cost`)
      }
      for (const id of ['US', 'PL']) {
        assert.equal(quarter.capacity[id].used, add(month => month.capacity[id].used), label)
        assert.equal(quarter.capacity[id].limit, Object.values(config.capacity[id]).reduce((sum, limit) => sum + limit, 0) * 3, label)
        assert.deepEqual(quarter.capacity[id].limits, Object.fromEntries(Object.entries(config.capacity[id]).map(([family, limit]) => [family, limit * 3])), label)
      }
      // The same invoices, merged by kind, counterparties and product line.
      near(quarter.transactions.reduce((sum, line) => sum + line.amount, 0), add(month => month.transactions.reduce((sum, line) => sum + line.amount, 0)), `${label} transactions`)
      assert.equal(quarter.transactions.reduce((sum, line) => sum + line.quantity, 0), add(month => month.transactions.reduce((sum, line) => sum + line.quantity, 0)), label)
      assert.ok(quarter.transactions.length < add(month => month.transactions.length), label)
      assert.equal(productLineResults(quarter).reduce((sum, line) => sum + line.units, 0), add(month => productLineResults(month).reduce((sum, line) => sum + line.units, 0)), label)
      // Stock runs from the first month's opening to the last month's closing, and rolls forward.
      quarter.inventory.forEach((bin, position) => {
        assert.equal(units(bin.opening), units(months[0].inventory[position].opening), label)
        assert.equal(units(bin.closing), units(months[2].inventory[position].closing), label)
        assert.equal(units(bin.opening) + units(bin.receipts) - units(bin.issues), units(bin.closing), label)
      })
      for (const value of Object.values(quarter.reconciliation)) assert.ok(Math.abs(value) < 0.005, label)
    })
    // Each quarter opens on the stock the one before closed on.
    for (let index = 1; index < 4; index++) {
      assert.deepEqual(quarters[side][index].inventory.map(bin => units(bin.opening)), quarters[side][index - 1].inventory.map(bin => units(bin.closing)))
    }
  }
  // Year-end adjustments and local statutory results belong to the fourth quarter only.
  assert.deepEqual(quarters.actual.map(quarter => Boolean(quarter.yearEnd)), [false, false, false, true])
  assert.equal(quarters.actual[3].stat, year.actual[11].stat)
  assert.ok(quarters.budget.every(quarter => !quarter.yearEnd))
  // The quarter's bridge is the sum of its months' bridges and still explains the whole gap.
  quarters.variance.forEach((bridge, index) => {
    const months = year.variance.slice(index * 3, index * 3 + 3)
    for (const key of ['volume', 'salesPrice', 'materials', 'otherCogs', 'operatingExpenses', 'operatingProfit']) {
      near(bridge[key], months.reduce((sum, month) => sum + month[key], 0), `Q${index + 1} ${key}`)
    }
    near(bridge.operatingProfit, quarters.actual[index].consolidated.operatingProfit - quarters.budget[index].consolidated.operatingProfit, `Q${index + 1} profit gap`)
    near(bridge.volume + bridge.salesPrice + bridge.materials + bridge.otherCogs + bridge.operatingExpenses, bridge.operatingProfit, `Q${index + 1} bridge`)
    near(bridge.operatingMargin, quarters.actual[index].consolidated.operatingMargin - quarters.budget[index].consolidated.operatingMargin, `Q${index + 1} margin gap`)
  })
})

test('the entity detail report works by quarter and lists a quarter bought at one price as one layer', () => {
  const config = createConfig()
  const year = runYear(config)
  const quarters = quarterly(config, year)
  const report = (id, options) => entityDetail(config, year, id, { basis: 'quarter', layers: 'quarter', ...options })
  const each = layers => layers.map(layer => cents(layer.amount / layer.units))
  const near = (left, right, label) => assert.ok(Math.abs(left - right) < 0.005, `${label}: ${left} against ${right}`)
  for (const id of Object.keys(ENTITIES).filter(id => !ENTITIES[id].external)) {
    for (let period = 0; period < 4; period++) {
      const detail = report(id, { period, revealed: 12 })
      for (const side of ['budget', 'actual']) {
        const lines = detail[side]
        const results = quarters[side][period].entities[id]
        near(lines.revenue, results.revenue, `${id} Q${period + 1} ${side} revenue`)
        near(lines.costOfSales.total, results.cogs, `${id} Q${period + 1} ${side} cost of sales`)
        near(lines.operatingProfit, results.operatingProfit, `${id} Q${period + 1} ${side} profit`)
        assert.equal(lines.months, 3)
        // Every line is still the sum of its layers.
        for (const line of [...Object.values(lines.costOfSales.products), ...Object.values(lines.received), ...lines.inventory.opening, ...lines.inventory.closing]) {
          assert.equal(line.layers.reduce((sum, layer) => sum + layer.units, 0), line.units, id)
          near(line.layers.reduce((sum, layer) => sum + layer.amount, 0), line.amount, `${id} layers`)
          assert.deepEqual(line.layers.map(layer => layer.key), line.layers.map(layer => layer.key).sort(), id)
        }
      }
    }
  }

  // Germany pays one price all quarter, so each quarter's purchases are one layer. Its opening stock was bought at two prices.
  const first = report('DE', { period: 0, revealed: 3 })
  for (const side of [first.budget, first.actual]) {
    assert.deepEqual(side.inventory.opening.find(row => row.product === 'A').layers.map(layer => layer.vintage), ['2026-11', '2026-12'])
    assert.deepEqual(side.received.A.layers.map(layer => [layer.vintage, layer.quarter]), [['2027-Q1', true]])
    assert.deepEqual(side.costOfSales.products.A.layers.map(layer => layer.vintage), ['2026-11', '2026-12', '2027-Q1'])
    assert.deepEqual(side.inventory.closing.find(row => row.product === 'A').layers.map(layer => layer.vintage), ['2027-Q1'])
  }
  // The budget and the actuals list the same layers, so they share a row.
  assert.deepEqual(first.budget.costOfSales.products.A.layers.map(layer => layer.key), first.actual.costOfSales.products.A.layers.map(layer => layer.key))

  // A quarter is zero until all three of its months are revealed. The next one to be revealed shows its opening stock.
  const waiting = report('DE', { period: 1, revealed: 3 }).actual
  assert.equal(waiting.revenue, 0)
  assert.deepEqual(waiting.inventory.opening, first.actual.inventory.closing)
  assert.equal(waiting.inventory.closing, null)
  assert.equal(report('DE', { period: 1, revealed: 5 }).actual.revenue, 0)
  assert.deepEqual(report('DE', { period: 2, revealed: 3 }).actual.inventory, { opening: null, closing: null })
  assert.ok(report('DE', { period: 1, revealed: 6 }).actual.revenue > 0)

  // A price raised at the first-quarter review is the second quarter's layer, beside the budgeted price.
  // About two-thirds of that quarter's units still come from the older layer.
  const current = reviewGoodsPricing(config, 3).routes.find(route => route.key === 'CH-DE').prices
  const raised = Object.fromEntries(current.map(entry => [entry.product, cents(entry.applied * 1.1)]))
  const changedConfig = applyGoodsPrices(config, 3, { 'CH-DE': raised })
  const changed = runYear(changedConfig)
  const second = entityDetail(changedConfig, changed, 'DE', { basis: 'quarter', period: 1, revealed: 6, layers: 'quarter' })
  assert.deepEqual(each(second.actual.received.A.layers), [raised.A])
  assert.ok(each(second.budget.received.A.layers)[0] < raised.A)
  assert.deepEqual(second.actual.received.A.layers.map(layer => layer.key), second.budget.received.A.layers.map(layer => layer.key))
  const sold = second.actual.costOfSales.products.A
  const atNewPrice = sold.layers.find(layer => layer.vintage === '2027-Q2').units / sold.units
  assert.ok(atNewPrice > 0.25 && atNewPrice < 0.45, String(atNewPrice))
  const third = entityDetail(changedConfig, changed, 'DE', { basis: 'quarter', period: 2, revealed: 9, layers: 'quarter' })
  assert.ok(third.actual.costOfSales.products.A.layers.every(layer => cents(layer.amount / layer.units) === raised.A))

  // The plants' cost moves every month, so their layers stay by month.
  const us = report('US', { period: 1, revealed: 12 }).actual.received
  assert.deepEqual(us.B.layers.map(layer => [layer.source, layer.vintage]), [['made', '2027-04'], ['made', '2027-05'], ['made', '2027-06']])
  // What it buys from Switzerland comes at one price all quarter, so that is one layer.
  assert.deepEqual(us.C.layers.map(layer => [layer.source, layer.vintage]), [['bought', '2027-Q2']])
  // By month, the same report keeps a layer for every month.
  assert.deepEqual(entityDetail(config, year, 'DE', { basis: 'quarter', period: 0, revealed: 3 }).actual.received.A.layers.map(layer => layer.vintage), ['2027-01', '2027-02', '2027-03'])
})

test('a service fee quoted by the quarter is charged a third each month', () => {
  const config = createConfig()
  const before = reviewGoodsPricing(config, 3).services.find(service => service.id === 'IN')
  const revised = applyServiceFees(config, 3, { IN: 46_000.01 / 3 })
  const year = runYear(revised)
  const quarters = quarterly(revised, year)
  assert.equal(cents(quarters.actual[1].services.IN.fee), 46_000.01)
  assert.equal(cents(quarters.actual[0].services.IN.fee), cents(before.fee * 3))
  assert.throws(() => applyServiceFees(config, 3, { IN: -1 }), /nonnegative/)
  assert.throws(() => applyServiceFees(config, 3, { IN: Number.NaN }), /nonnegative/)
})

test('the US parent is taxed at 21% with the FDDEI and NCTI deductions, the NCTI credit and BEAT, plus state tax', () => {
  const config = createConfig()
  const { budget, actual } = runYear(config)
  const rules = US_TAX_RULES
  assert.deepEqual({ ...rules }, { federalRate: 0.21, fddeiDeduction: 0.3334, nctiDeduction: 0.40, nctiCreditShare: 0.90, beatRate: 0.105, beatThreshold: 0.03, beatGrossReceipts: 500_000 })
  const near = (left, right, label) => assert.ok(Math.abs(left - right) < 0.005, `${label}: ${left} against ${right}`)
  const add = (months, pick) => months.reduce((sum, month) => sum + pick(month), 0)
  for (const [months, stat] of [[budget, null], [actual, actual[11].stat], [actual.slice(0, 6), null]]) {
    const tax = usIncomeTax(config, months, stat)
    const us = add(months, month => month.entities.US.operatingProfit)
    // State tax at the rest of the US rate, deductible for federal purposes.
    near(tax.stateRate, config.tax.rates.US - 0.21, 'state rate')
    near(tax.state, tax.stateRate * us, 'state')
    // FDDEI: R&E is not allocated, so deduction eligible income is profit before R&D, less state tax.
    near(tax.fddei.dei, us + add(months, month => month.entities.US.rdExpense) - tax.state, 'DEI')
    near(tax.fddei.receipts, add(months, month => month.entities.US.revenue), 'gross receipts')
    near(tax.fddei.income, tax.fddei.goods - tax.fddei.goodsCogs + tax.fddei.royalty + tax.fddei.services - tax.fddei.servicesCost - tax.fddei.apportionedToForeign, 'FDDEI')
    assert.ok(tax.fddei.income > 0 && tax.fddei.income < tax.fddei.dei)
    near(tax.fddei.deduction, 0.3334 * tax.fddei.allowed, 'FDDEI deduction')
    // NCTI: every CFC's profit less its foreign tax, with no QBAI return; a 100% gross-up and a 90% credit.
    near(tax.ncti.amount, tax.ncti.cfcs.reduce((sum, cfc) => sum + cfc.tested, 0), 'NCTI')
    near(tax.ncti.grossUp, tax.ncti.testedTaxes, 'gross-up')
    near(tax.ncti.deemedPaid, 0.9 * tax.ncti.testedTaxes, 'deemed paid')
    near(tax.ncti.deduction, 0.4 * (tax.ncti.amount + tax.ncti.grossUp), 'NCTI deduction')
    // The CFCs pay more than 14% on average, so the credit covers the US tax on NCTI and the rest is lost.
    assert.ok(tax.ncti.testedTaxes / (tax.ncti.amount + tax.ncti.grossUp) > 0.14)
    near(tax.ncti.credit, 0.21 * 0.6 * (tax.ncti.amount + tax.ncti.grossUp), 'credit')
    assert.ok(tax.ncti.excessCredit > 0)
    near(tax.ncti.residual, 0, 'residual')
    // Taxable income and regular tax.
    near(tax.taxableIncome, us - tax.state + tax.ncti.amount + tax.ncti.grossUp - tax.fddei.deduction - tax.ncti.deduction, 'taxable income')
    near(tax.regularTax, 0.21 * tax.taxableIncome - tax.ncti.credit, 'regular tax')
    // BEAT: the R&D services in full and India's markup are base erosion payments. India's cost is excepted.
    near(tax.beat.research, add(months, month => month.transactions.filter(line => line.policy === 'RD_SERVICES').reduce((sum, line) => sum + line.amount, 0)), 'R&D services')
    near(tax.beat.indiaMarkup, tax.beat.indiaFee - tax.beat.indiaCost, 'India markup')
    near(tax.beat.percentage, tax.beat.benefits / tax.beat.deductions, 'base erosion percentage')
    // Gross receipts are in USD thousands and annualized for a part year. The parent is well above $500 million.
    near(tax.beat.grossReceipts, add(months, month => month.entities.US.revenue) * 12 / add(months, month => month.months?.length ?? 1), 'gross receipts test')
    assert.ok(tax.beat.grossReceiptsMet)
    assert.ok(tax.beat.percentage > 0.03 && tax.beat.applies)
    near(tax.beat.modifiedTaxableIncome, tax.taxableIncome + tax.beat.benefits, 'MTI')
    near(tax.beat.amount, Math.max(0, 0.105 * tax.beat.modifiedTaxableIncome - tax.regularTax), 'BEAT')
    near(tax.total, tax.regularTax + tax.beat.amount + tax.state, 'total')
  }
  // In the default year BEAT binds: the NCTI credit lowers regular tax, but NCTI still counts in modified taxable income.
  const year = usIncomeTax(config, budget)
  assert.ok(year.beat.amount > 0)
  // Below the gross receipts test, or with no base erosion payments to speak of, there is no BEAT.
  const small = structuredClone(budget)
  for (const month of small) month.entities.US.revenue = 40_000 / small.length
  const noBeat = usIncomeTax(config, small)
  near(noBeat.beat.grossReceipts, 40_000, 'small gross receipts')
  assert.ok(!noBeat.beat.grossReceiptsMet && !noBeat.beat.applies)
  assert.equal(noBeat.beat.amount, 0)
  near(noBeat.total, noBeat.regularTax + noBeat.state, 'without BEAT')
  const domesticResearch = { ...createConfig(), rd: { salesRate: 0.04, usShare: 1 } }
  const homeGrown = usIncomeTax(domesticResearch, runYear(domesticResearch).budget)
  assert.equal(homeGrown.beat.research, 0)
  assert.ok(homeGrown.beat.percentage < 0.03 && !homeGrown.beat.applies && homeGrown.beat.amount === 0)
  // A low-taxed CFC leaves residual US tax on NCTI: here every foreign rate is 5%.
  const lowTax = createConfig()
  for (const id of Object.keys(lowTax.tax.rates)) if (id !== 'US') lowTax.tax.rates[id] = 0.05
  const residual = usIncomeTax(lowTax, runYear(lowTax).budget)
  assert.ok(residual.ncti.residual > 0 && residual.ncti.excessCredit === 0)
  near(residual.ncti.residual, 0.21 * 0.6 * (residual.ncti.amount + residual.ncti.grossUp) - 0.9 * residual.ncti.testedTaxes, 'residual')
  // The group's tax and the Transfer prices page use the same figure.
  near(summarizeTaxAndCustoms(config, budget).tax.entities.US.tax, year.total, 'group tax')
  const review = reviewGoodsPricing(config, 12)
  near(review.entityResults.find(row => row.id === 'US').tax.fullYear, usIncomeTax(config, actual, actual[11].stat).total, 'pricing page')
  // A scenario saved with the old on/off setting drops it: the test now runs on the parent's receipts.
  assert.equal('beatGrossReceipts' in upgradeConfig({ ...createConfig(), tax: { ...createConfig().tax, beatGrossReceipts: false } }, true).tax, false)
})

test('the section 250 deduction is limited to taxable income', () => {
  // With R&D at 10% of sales, all of it in the US, US profit is small and the deductions are cut back.
  const config = { ...createConfig(), rd: { salesRate: 0.10, usShare: 1 } }
  delete config.annualOperatingMargin
  const tax = usIncomeTax(config, runYear(config).budget)
  const claimed = tax.fddei.base + tax.ncti.amount + tax.ncti.grossUp
  if (tax.beforeDeduction < claimed) {
    assert.ok(tax.limitShare < 1)
    assert.ok(Math.abs(tax.fddei.allowed + tax.ncti.allowed - Math.max(0, tax.beforeDeduction)) < 0.005)
  } else {
    assert.equal(tax.limitShare, 1)
  }
  assert.ok(tax.taxableIncome >= -0.005)
})

test('the entity detail report carries the US tax computation for the United States only', () => {
  const config = createConfig()
  const year = runYear(config)
  const us = entityDetail(config, year, 'US', { basis: 'year', revealed: 12 })
  assert.equal(us.budget.usTax.total, usIncomeTax(config, year.budget).total)
  assert.equal(us.actual.usTax.total, usIncomeTax(config, year.actual, year.actual[11].stat).total)
  const quarter = entityDetail(config, year, 'US', { basis: 'quarter', period: 1, revealed: 3 })
  assert.equal(quarter.budget.usTax.total, usIncomeTax(config, year.budget.slice(3, 6)).total)
  assert.equal(quarter.actual.usTax.total, 0)
  for (const id of ['CH', 'DE', 'PL', 'IN']) assert.equal(entityDetail(config, year, id, { basis: 'year', revealed: 12 }).actual.usTax, null)
  // The computation has its own table with one amount column a side, so it reads on a phone.
  const page = renderEntityDetail({ detail: us, entities: ['US', 'DE'] })
  const taxTable = page.slice(page.indexOf('entity-tax-table'))
  assert.ok(taxTable.includes('Total US income tax') && !taxTable.includes('Per unit, USD'))
  assert.equal((taxTable.match(/<tr class="entity-total"><th[^>]*>Total US income tax<\/th>(<td>[^<]*<\/td>)+<\/tr>/)?.[1] ?? '').length > 0, true)
  assert.equal(renderEntityDetail({ detail: entityDetail(config, year, 'DE', { basis: 'year', revealed: 12 }), entities: ['US', 'DE'] }).includes('entity-tax-table'), false)
})
