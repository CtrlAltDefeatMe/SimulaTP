import { DEFAULT_SIMULATION, simulateShocks, validateSimulationConfig } from './simulation.mjs'

export const ENTITIES = {
  US: { name: 'United States', region: 'North America', role: 'Manufacturer, IP owner and HQ' },
  CH: { name: 'Switzerland', region: 'Europe', role: 'European principal' },
  PL: { name: 'Poland', region: 'Europe', role: 'Toll manufacturer' },
  BE: { name: 'Belgium', region: 'Europe', role: 'Warehouse operator' },
  DE: { name: 'Germany', region: 'Europe', role: 'Limited-risk distributor' },
  FR: { name: 'France', region: 'Europe', role: 'Limited-risk distributor' },
  UK: { name: 'United Kingdom', region: 'Europe', role: 'Limited-risk distributor' },
  APAC: { name: 'Asia', region: 'Asia Pacific', role: 'Full-fledged distributor' },
  CA: { name: 'Canada', region: 'North America', role: 'Full-fledged distributor' },
  IN: { name: 'India', region: 'Asia', role: 'Shared services' },
  UNRELATED: { name: 'Independent distributors', region: 'Europe', role: 'Third-party customer', external: true },
}

export const PRODUCTS = {
  A: {
    name: 'Precision Components', price: 112, material: 31, usConversion: 17, plConversion: 13,
    demand: { US: 640, CH: 170, DE: 360, FR: 285, UK: 310, APAC: 430, CA: 245 },
  },
  B: {
    name: 'Control Systems', price: 186, material: 63, usConversion: 25, plConversion: 20,
    demand: { US: 430, CH: 110, DE: 240, FR: 200, UK: 185, APAC: 285, CA: 140 },
  },
  C: {
    name: 'Industrial Modules', price: 268, material: 94, usConversion: 33, plConversion: 27,
    demand: { US: 280, CH: 80, DE: 145, FR: 130, UK: 120, APAC: 180, CA: 90 },
  },
}

export const POLICY_LABELS = {
  US_TO_CH: 'US → Swiss cross-supply',
  CH_TO_US: 'Swiss → US cross-supply',
  LRD_GOODS: 'LRD product transfer',
  FFD_GOODS: 'FFD product transfer',
  PL_TOLL_BUDGET: 'Poland budget toll fee',
  PL_TOLL_TRUE_UP: 'Poland actual cost true-up',
  BE_WAREHOUSE: 'Belgian warehouse fee',
  US_SERVICES: 'US headquarters services',
  IN_SERVICES: 'India shared services',
  RD_SERVICES: 'R&D services · cost plus 10%',
  CH_ROYALTY: 'Swiss royalty to US',
  UNRELATED_SALE: 'Sale to unrelated distributors',
  US_DOMESTIC_SALE: 'US domestic third-party sale',
  LRD_EXTERNAL_SALE: 'LRD third-party sale',
  FFD_EXTERNAL_SALE: 'FFD third-party sale',
}

const DISTRIBUTORS = ['DE', 'FR', 'UK', 'APAC', 'CA']
const MARKETS = ['US', 'CH', ...DISTRIBUTORS]
const FAMILIES = Object.keys(PRODUCTS)
const LRD = new Set(['DE', 'FR', 'UK'])
const ALL_COMPANIES = Object.keys(ENTITIES).filter(id => !ENTITIES[id].external)
const CHANNEL_FACTOR = { US: 1.08, CH: 0.88, DE: 1.04, FR: 1.01, UK: 1.05, APAC: 0.94, CA: 1.02 }
const SEASONAL = [0.93, 0.95, 0.99, 1.01, 1.04, 1.03, 0.96, 0.98, 1.08, 1.10, 1.13, 1.02]
const ZERO_SHOCK = { demand: 0, salesPrice: 0, materialCost: 0 }
const DEFAULT_ANNUAL_MARGIN = 4_017_544.4704 / 10_487_570
const RD_MARKUP = 0.10
const HISTORICAL_OPENING_POLICIES = { lrdMargin: 0.03, ffdMargin: 0.075, polandMarkup: 0.08 }
const sourceOf = id => id === 'CA' ? 'US' : 'CH'
const goodsRouteKey = (from, to) => from + '-' + to
const GOODS_ROUTES = [
  { from: 'US', to: 'CH', policy: 'US_TO_CH', markup: 'usToSwissMarkup' },
  { from: 'CH', to: 'US', policy: 'CH_TO_US', markup: 'swissToUsMarkup' },
  ...DISTRIBUTORS.map(to => ({ from: sourceOf(to), to, policy: LRD.has(to) ? 'LRD_GOODS' : 'FFD_GOODS' })),
].map(route => ({ ...route, key: goodsRouteKey(route.from, route.to) }))
const GOODS_ROUTE_KEYS = new Set(GOODS_ROUTES.map(route => route.key))
const sum = values => values.reduce((total, value) => total + value, 0)
const valueOf = (lots, field) => sum(lots.map(lot => lot.quantity * lot[field]))
const unitsOf = lots => sum(lots.map(lot => lot.quantity))
const margin = (profit, revenue) => revenue ? profit / revenue : 0
const roundCurrency = amount => Math.round(amount * 100) / 100

export function createConfig() {
  return {
    capacity: { US: 2550, PL: 4850 },
    policies: {
      lrdMargin: 0.03, ffdMargin: 0.075, polandMarkup: 0.08, belgiumMargin: 0.06,
      usServicesMarkup: 0.07, indiaServicesMarkup: 0.12, royaltyRate: 0.05,
      usToSwissMarkup: 0.15, swissToUsMarkup: 0.20,
    },
    annualOperatingMargin: DEFAULT_ANNUAL_MARGIN,
    rd: { salesRate: 0, usShare: 0.5 },
    startingPriceMethod: 'fifo-policy',
    simulation: structuredClone(DEFAULT_SIMULATION),
    goodsPriceSchedule: [],
  }
}

function validatePricingMonth(month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('The effective month must be between January and December 2027.')
  }
}

function validatePriceTable(prices) {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new RangeError('Enter prices by goods route and product family.')
  for (const [route, products] of Object.entries(prices)) {
    if (!GOODS_ROUTE_KEYS.has(route) || !products || typeof products !== 'object' || Array.isArray(products)) {
      throw new RangeError('Unknown goods route: ' + route)
    }
    for (const [family, price] of Object.entries(products)) {
      if (!FAMILIES.includes(family)) throw new RangeError('Unknown product family: ' + family)
      const cents = Math.round(price * 100)
      if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(cents) || price !== cents / 100) {
        throw new RangeError('Each goods price must be a nonnegative dollar amount with at most two decimal places.')
      }
    }
  }
}

export function quarterPricingMonth(revealed) {
  return [3, 6, 9].includes(revealed) ? revealed + 1 : null
}

function goodsPricesForMonth(config, month, initial) {
  const revision = config.goodsPriceSchedule?.findLast(entry => entry.startMonth <= month)
  if (!revision) return initial
  return Object.fromEntries(GOODS_ROUTES.map(({ key }) => [key, { ...initial[key], ...revision.prices[key] }]))
}

function validateConfig(config) {
  const { annualOperatingMargin, rd, startingPriceMethod } = config
  if (startingPriceMethod !== undefined && startingPriceMethod !== 'fifo-policy') {
    throw new RangeError('Unknown starting transfer pricing method.')
  }
  if (annualOperatingMargin !== undefined && (!Number.isFinite(annualOperatingMargin) || annualOperatingMargin >= 1)) {
    throw new RangeError('The consolidated operating margin target must be a percentage below 100%.')
  }
  if (rd !== undefined) {
    if (!Number.isFinite(rd?.salesRate) || rd.salesRate < 0 || rd.salesRate > 0.1) {
      throw new RangeError('R&D must be between 0% and 10% of consolidated sales.')
    }
    if (!Number.isFinite(rd.usShare) || rd.usShare < 0 || rd.usShare > 1) {
      throw new RangeError('The US share of R&D must be between 0% and 100%.')
    }
  }
  for (const entity of ['US', 'PL']) {
    const capacity = config.capacity?.[entity]
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError(`${entity} capacity must be a nonnegative whole number.`)
  }
  for (const key of Object.keys(createConfig().policies)) {
    const value = config.policies?.[key]
    const isMargin = key.endsWith('Margin')
    if (!Number.isFinite(value) || value < 0 || (isMargin && value >= 1) || (!isMargin && value > 1)) {
      throw new RangeError(`${key} must be between 0% and ${isMargin ? 'less than 100%' : '100%'}.`)
    }
  }
  let previousMonth = 0
  for (const { startMonth, prices, overrides } of config.goodsPriceSchedule ?? []) {
    validatePricingMonth(startMonth)
    if (startMonth <= previousMonth) throw new RangeError('Goods price revisions must be ordered by effective month.')
    validatePriceTable(prices)
    validatePriceTable(overrides)
    previousMonth = startMonth
  }
}

function makeLot(quantity, unitValue, unitGroupCost, unitMaterialCost, vintage) {
  return { quantity, unitValue, unitGroupCost, unitMaterialCost, vintage }
}

class Stock {
  constructor() {
    this.bins = new Map()
  }

  bin(owner, custodian, product, stage = 'finished') {
    const key = [owner, custodian, product, stage].join('/')
    if (!this.bins.has(key)) {
      this.bins.set(key, { owner, custodian, product, stage, lots: [], opening: [], receipts: [], issues: [] })
    }
    return this.bins.get(key)
  }

  startMonth() {
    for (const bin of this.bins.values()) {
      bin.opening = bin.lots.map(lot => ({ ...lot }))
      bin.receipts = []
      bin.issues = []
    }
  }

  receive(bin, lots) {
    bin.lots.push(...lots.map(lot => ({ ...lot })))
    bin.receipts.push(...lots.map(lot => ({ ...lot })))
  }

  issue(bin, quantity) {
    const issues = []
    let remaining = quantity
    while (remaining > 0 && bin.lots.length) {
      const oldest = bin.lots[0]
      const issued = Math.min(remaining, oldest.quantity)
      issues.push({ ...oldest, quantity: issued })
      oldest.quantity -= issued
      remaining -= issued
      if (!oldest.quantity) bin.lots.shift()
    }
    bin.issues.push(...issues)
    return issues
  }

  snapshot() {
    return [...this.bins.values()].map(({ lots, ...bin }) => ({
      ...bin, closing: lots.map(lot => ({ ...lot })),
    }))
  }
}

function baseGroupCost(product, plant) {
  return product.material + (plant === 'US' ? product.usConversion : product.plConversion)
}

function basePrice(product, market) {
  return product.price * CHANNEL_FACTOR[market]
}

function distributorCostRate(market) {
  return LRD.has(market) ? 0.13 : 0.19
}

function distributorUnitTp(product, market, policies) {
  const rate = LRD.has(market) ? policies.lrdMargin : policies.ffdMargin
  return Math.max(0, basePrice(product, market) * (1 - rate - distributorCostRate(market)))
}

function standardGoodsPrices(policies, costScale) {
  return Object.fromEntries(GOODS_ROUTES.map(({ key, from, to, markup }) => [
    key, Object.fromEntries(FAMILIES.map(family => {
      const product = PRODUCTS[family]
      const standardCost = from === 'US' ? baseGroupCost(product, 'US')
        : baseGroupCost(product, 'PL') + product.plConversion * policies.polandMarkup
      const price = markup ? standardCost * costScale * (1 + policies[markup]) : distributorUnitTp(product, to, policies)
      return [family, roundCurrency(price)]
    })),
  ]))
}

function seedOpeningStock(costScale) {
  // Opening distributor invoice values use the 2026 policy assumptions. Group
  // cost follows the scenario's consolidated budget calibration.
  const historical = HISTORICAL_OPENING_POLICIES
  const stock = new Stock()
  for (const family of FAMILIES) {
    const product = PRODUCTS[family]
    for (const market of DISTRIBUTORS) {
      const cost = baseGroupCost(product, sourceOf(market)) * costScale
      const tp = distributorUnitTp(product, market, historical)
      const bin = stock.bin(market, market, family)
      bin.lots = [
        makeLot(product.demand[market], tp * 0.97, cost * 0.98, product.material * costScale * 0.98, '2026-11'),
        makeLot(product.demand[market], tp, cost, product.material * costScale, '2026-12'),
      ]
    }
    const swissDemand = sum(MARKETS.filter(id => id !== 'US' && id !== 'CA').map(id => product.demand[id]))
    const cost = baseGroupCost(product, 'PL') * costScale
    const local = cost + product.plConversion * costScale * historical.polandMarkup
    const warehouse = stock.bin('CH', 'BE', family)
    warehouse.lots = [0.96, 0.98, 0.99, 1].map((factor, index) =>
      makeLot(swissDemand, local * factor, cost * factor, product.material * costScale * factor, '2026-' + String(9 + index).padStart(2, '0')))
    const us = stock.bin('US', 'US', family)
    const usCost = baseGroupCost(product, 'US') * costScale
    us.lots = [makeLot(product.demand.US + product.demand.CA, usCost, usCost, product.material * costScale, '2026-12')]
    for (const [stage, months] of [['raw', 0.35], ['wip', 0.15]]) {
      const bin = stock.bin('CH', 'PL', family, stage)
      const material = product.material * costScale
      bin.lots = [makeLot(Math.round(swissDemand * months), material, material, material, '2026-12')]
    }
  }
  return stock
}

class Ledger {
  constructor(month) {
    this.month = month
    this.journal = []
    this.transactions = []
    this.sequence = 0
  }

  post(entity, debit, credit, amount, transactionId = `J${this.month}-${++this.sequence}`) {
    if (!Number.isFinite(amount)) throw new RangeError('Scenario amounts exceed the supported range. Reduce the shock bounds.')
    if (!amount) return
    const [debitAccount, creditAccount] = amount > 0 ? [debit, credit] : [credit, debit]
    this.journal.push(
      { entity, account: debitAccount, debit: Math.abs(amount), credit: 0, transactionId },
      { entity, account: creditAccount, debit: 0, credit: Math.abs(amount), transactionId },
    )
  }

  transfer({ from, to, category, policy, product = null, quantity = 0, amount, buyerAccount, basis = null, external = false }) {
    const id = `T${this.month}-${++this.sequence}`
    this.transactions.push({ id, from, to, category, policy, product, quantity, amount, basis, external })
    const revenueAccount = policy === 'RD_SERVICES' ? 'intercompanyRDRevenue' : {
      goods: 'intercompanyGoodsRevenue', services: 'intercompanyServicesRevenue', royalty: 'intercompanyRoyaltyRevenue',
    }[category]
    if (external) {
      this.post(from, 'externalClearing', 'externalRevenue', amount, id)
    } else {
      // Royalty arrows follow the payment. Goods and service arrows follow delivery.
      const [seller, buyer] = category === 'royalty' ? [to, from] : [from, to]
      this.post(seller, 'intercompanyReceivable', revenueAccount, amount, id)
      this.post(buyer, buyerAccount, 'intercompanyPayable', amount, id)
    }
  }

  financials() {
    const accounts = Object.fromEntries(ALL_COMPANIES.map(id => [id, {}]))
    for (const { entity, account, debit, credit } of this.journal) {
      accounts[entity][account] = (accounts[entity][account] ?? 0) + debit - credit
    }
    const entities = Object.fromEntries(Object.entries(accounts).map(([id, account]) => {
      const externalRevenue = -(account.externalRevenue ?? 0)
      const rdServiceRevenue = -(account.intercompanyRDRevenue ?? 0)
      const intercompanyRevenue = rdServiceRevenue - sum([
        account.intercompanyGoodsRevenue ?? 0, account.intercompanyServicesRevenue ?? 0, account.intercompanyRoyaltyRevenue ?? 0,
      ])
      return [id, {
        ...pnl(externalRevenue + intercompanyRevenue, account.cogs ?? 0, account.operatingExpenses ?? 0, account.rdExpense ?? 0, rdServiceRevenue),
        externalRevenue, intercompanyRevenue,
      }]
    }))
    return { entities, accounts }
  }
}

function pnl(revenue, cogs, otherOperatingExpenses, rdExpense = 0, rdServiceRevenue = 0) {
  const operatingExpenses = otherOperatingExpenses + rdExpense
  const operatingProfit = revenue - cogs - operatingExpenses
  return { revenue, cogs, otherOperatingExpenses, rdExpense, rdServiceRevenue, operatingExpenses, operatingProfit, operatingMargin: margin(operatingProfit, revenue) }
}

// Largest-remainder allocation keeps whole units and makes capacity a hard limit.
function allocate(requests, available) {
  const total = sum(requests)
  if (!Number.isSafeInteger(total)) throw new RangeError('Demand exceeds the supported whole-unit range. Reduce the demand shock bounds.')
  if (total <= available) return [...requests]
  const quotas = requests.map(value => (value / total) * available)
  const allocated = quotas.map(Math.floor)
  const remainder = available - sum(allocated)
  const ranked = quotas.map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
  for (const { index } of ranked.slice(0, remainder)) allocated[index]++
  return allocated
}

function monthPlan(stock, month, shocks) {
  const seasonal = SEASONAL[month - 1]
  return Object.fromEntries(FAMILIES.map(family => {
    const product = PRODUCTS[family]
    const demand = Object.fromEntries(MARKETS.map(id => [id, Math.round(product.demand[id] * seasonal * (1 + shocks.demand))]))
    const us = stock.bin('US', 'US', family)
    const warehouse = stock.bin('CH', 'BE', family)
    const orders = Object.fromEntries(DISTRIBUTORS.map(id => [
      id, Math.max(0, demand[id] + 2 * product.demand[id] - unitsOf(stock.bin(id, id, family).lots)),
    ]))
    const usDemand = demand.US + orders.CA
    const swissDemand = demand.CH + orders.DE + orders.FR + orders.UK + orders.APAC
    const usToSwiss = Math.round(swissDemand * 0.15)
    const swissToUs = Math.round(usDemand * 0.12)
    const usBuffer = product.demand.US + product.demand.CA
    const warehouseBuffer = 4 * sum(MARKETS.filter(id => id !== 'US' && id !== 'CA').map(id => product.demand[id]))
    return [family, {
      demand, us, warehouse, orders, usToSwiss, swissToUs,
      usBuild: Math.max(0, usDemand + usToSwiss + usBuffer - swissToUs - unitsOf(us.lots)),
      plBuild: Math.max(0, swissDemand + swissToUs + warehouseBuffer - usToSwiss - unitsOf(warehouse.lots)),
    }]
  }))
}

function produce(stock, book, family, plan, usUnits, plUnits, shocks, config, vintage, costScale) {
  const product = PRODUCTS[family]
  const material = product.material * costScale * (1 + shocks.materialCost)
  if (usUnits) {
    const cost = material + product.usConversion * costScale
    stock.receive(plan.us, [makeLot(usUnits, cost, cost, material, vintage)])
    book.post('US', 'inventory', 'externalClearing', usUnits * cost)
  }
  if (!plUnits) return

  const raw = stock.bin('CH', 'PL', family, 'raw')
  const wip = stock.bin('CH', 'PL', family, 'wip')
  // Replenish the raw and material-only WIP buffers as conversion completes.
  stock.receive(raw, [makeLot(plUnits, material, material, material, vintage)])
  book.post('CH', 'inventory', 'externalClearing', plUnits * material)
  stock.receive(wip, stock.issue(raw, plUnits))
  const completed = stock.issue(wip, plUnits)
  const budgetConversion = plUnits * product.plConversion * costScale
  // Demand is the proxy for conversion efficiency in this training model.
  const actualConversion = budgetConversion * (1 - 0.12 * Math.min(shocks.demand, 1))
  const markup = 1 + config.policies.polandMarkup
  const provisional = budgetConversion * markup
  const trueUp = (actualConversion - budgetConversion) * markup
  book.post('PL', 'operatingExpenses', 'externalClearing', actualConversion)
  book.transfer({
    from: 'PL', to: 'CH', category: 'services', policy: 'PL_TOLL_BUDGET', product: family,
    quantity: plUnits, amount: provisional, basis: budgetConversion, buyerAccount: 'inventory',
  })
  book.transfer({
    from: 'PL', to: 'CH', category: 'services', policy: 'PL_TOLL_TRUE_UP', product: family,
    amount: trueUp, basis: actualConversion - budgetConversion, buyerAccount: 'inventory',
  })
  const unitFee = (provisional + trueUp) / plUnits
  const unitConversion = actualConversion / plUnits
  stock.receive(plan.warehouse, completed.map(lot => makeLot(
    lot.quantity, lot.unitValue + unitFee, lot.unitGroupCost + unitConversion, lot.unitMaterialCost, vintage,
  )))
}

function deliver(stock, book, { lots, from, to, target, family, policy, priceLot, vintage }) {
  const quantity = unitsOf(lots)
  if (!quantity) return
  const received = lots.map(lot => makeLot(lot.quantity, priceLot(lot), lot.unitGroupCost, lot.unitMaterialCost, vintage))
  stock.receive(target, received)
  book.transfer({
    from, to, category: 'goods', policy, product: family, quantity,
    amount: valueOf(received, 'unitValue'), basis: valueOf(lots, 'unitValue'), buyerAccount: 'inventory',
  })
  book.post(from, 'cogs', 'inventory', valueOf(lots, 'unitValue'))
}

function moveGoods(stock, book, plans, vintage, priceTable) {
  for (const family of FAMILIES) {
    const plan = plans[family]
    const fixedPrice = (from, to) => priceTable[goodsRouteKey(from, to)][family]
    const usLots = stock.issue(plan.us, plan.usToSwiss)
    const swissLots = stock.issue(plan.warehouse, plan.swissToUs)
    deliver(stock, book, {
      lots: usLots, from: 'US', to: 'CH', target: plan.warehouse, family, policy: 'US_TO_CH',
      priceLot: () => fixedPrice('US', 'CH'), vintage,
    })
    deliver(stock, book, {
      lots: swissLots, from: 'CH', to: 'US', target: plan.us, family, policy: 'CH_TO_US',
      priceLot: () => fixedPrice('CH', 'US'), vintage,
    })
    for (const [supplier, source] of [['US', plan.us], ['CH', plan.warehouse]]) {
      const markets = DISTRIBUTORS.filter(id => sourceOf(id) === supplier)
      const requested = markets.map(id => plan.orders[id])
      const direct = plan.demand[supplier]
      const allocations = allocate([direct, ...requested], unitsOf(source.lots))
      plan.demandAllocation ??= {}
      plan.demandAllocation[supplier] = allocations[0]
      markets.forEach((market, index) => deliver(stock, book, {
        lots: stock.issue(source, allocations[index + 1]), from: supplier, to: market,
        target: stock.bin(market, market, family), family, policy: LRD.has(market) ? 'LRD_GOODS' : 'FFD_GOODS',
        priceLot: () => fixedPrice(supplier, market), vintage,
      }))
    }
  }
}

function sellGoods(stock, book, plans, shocks) {
  const sales = []
  for (const family of FAMILIES) {
    const product = PRODUCTS[family]
    const plan = plans[family]
    for (const seller of MARKETS) {
      const isDistributor = DISTRIBUTORS.includes(seller)
      const bin = seller === 'US' ? plan.us : seller === 'CH' ? plan.warehouse : stock.bin(seller, seller, family)
      const demand = plan.demand[seller]
      const lots = stock.issue(bin, isDistributor ? demand : plan.demandAllocation[seller])
      const quantity = unitsOf(lots)
      const price = basePrice(product, seller) * (1 + shocks.salesPrice)
      const revenue = quantity * price
      const localCogs = valueOf(lots, 'unitValue')
      const groupCogs = valueOf(lots, 'unitGroupCost')
      const materialCogs = valueOf(lots, 'unitMaterialCost')
      const channel = LRD.has(seller) ? 'LRD' : isDistributor ? 'FFD' : seller === 'CH' ? 'direct' : 'domestic'
      const customer = seller === 'CH' ? 'UNRELATED' : 'THIRD_PARTY'
      const policy = { LRD: 'LRD_EXTERNAL_SALE', FFD: 'FFD_EXTERNAL_SALE', direct: 'UNRELATED_SALE', domestic: 'US_DOMESTIC_SALE' }[channel]
      sales.push({ seller, customer, channel, product: family, demand, quantity, price, revenue, groupCogs, materialCogs, unfilled: demand - quantity })
      if (quantity) book.transfer({
        from: seller, to: customer, category: 'goods', policy, product: family, quantity, amount: revenue, external: true,
      })
      book.post(seller, 'cogs', 'inventory', localCogs)
      if (!isDistributor || !quantity) continue

      const expense = quantity * basePrice(product, seller) * distributorCostRate(seller)
      book.post(seller, 'operatingExpenses', 'externalClearing', expense)
    }
  }
  return sales
}

function bookOtherCosts(book, stock, sales, config, shocks) {
  const { policies } = config
  const warehouseUnits = sum(stock.snapshot().filter(bin => bin.owner === 'CH' && bin.custodian === 'BE').map(bin => unitsOf(bin.issues)))
  const belgianCost = 6800 + 1.25 * warehouseUnits
  const usServices = 14800 * (1 + 0.2 * shocks.demand)
  const indiaServices = 9800 * (1 + 0.2 * shocks.demand)
  for (const [id, amount] of [['US', usServices + 22500], ['CH', 16100], ['IN', indiaServices], ['BE', belgianCost]]) {
    book.post(id, 'operatingExpenses', 'externalClearing', amount)
  }
  const royaltyBase = sum(sales.filter(sale => sale.channel === 'LRD' || sale.channel === 'direct').map(sale => sale.revenue))
  for (const [from, to, policy, basis, amount] of [
    ['BE', 'CH', 'BE_WAREHOUSE', belgianCost, belgianCost / (1 - policies.belgiumMargin)],
    ['US', 'CH', 'US_SERVICES', usServices, usServices * (1 + policies.usServicesMarkup)],
    ['IN', 'US', 'IN_SERVICES', indiaServices * 0.45, indiaServices * 0.45 * (1 + policies.indiaServicesMarkup)],
    ['IN', 'CH', 'IN_SERVICES', indiaServices * 0.55, indiaServices * 0.55 * (1 + policies.indiaServicesMarkup)],
    ['CH', 'US', 'CH_ROYALTY', royaltyBase, royaltyBase * policies.royaltyRate],
  ]) {
    book.transfer({
      from, to, category: policy === 'CH_ROYALTY' ? 'royalty' : 'services', policy, amount, basis, buyerAccount: 'operatingExpenses',
    })
  }
  return royaltyBase
}

function bookResearch(book, revenue, rd) {
  const totalCost = revenue * (rd?.salesRate ?? 0)
  if (!totalCost) return
  const usCost = totalCost * rd.usShare
  const foreignCost = totalCost - usCost
  const germanCost = foreignCost * 0.60
  book.post('US', 'rdExpense', 'externalClearing', usCost)
  for (const [from, cost] of [['DE', germanCost], ['PL', foreignCost - germanCost]]) {
    if (!cost) continue
    book.post(from, 'rdExpense', 'externalClearing', cost)
    book.transfer({
      from, to: 'US', category: 'services', policy: 'RD_SERVICES', amount: cost * (1 + RD_MARKUP),
      basis: cost, buyerAccount: 'rdExpense',
    })
  }
}

function balances(book, stock, sales, entities, accounts) {
  const inventory = stock.snapshot()
  const closingProfit = sum(inventory.map(bin => valueOf(bin.closing, 'unitValue') - valueOf(bin.closing, 'unitGroupCost')))
  const openingProfit = sum(inventory.map(bin => valueOf(bin.opening, 'unitValue') - valueOf(bin.opening, 'unitGroupCost')))
  const inventoryProfitChange = closingProfit - openingProfit
  const internal = book.transactions.filter(transaction => !transaction.external)
  const intercompanyRevenue = sum(internal.map(transaction => transaction.amount))
  const externalCostIds = new Set(book.journal.filter(entry => entry.account === 'externalClearing').map(entry => entry.transactionId))
  const externalExpenses = account => sum(book.journal.filter(entry =>
    entry.account === account && externalCostIds.has(entry.transactionId) &&
    (account !== 'operatingExpenses' || entry.entity !== 'PL')).map(entry => entry.debit - entry.credit))
  // Poland expenses the cost of providing the toll service. The group capitalizes
  // that conversion into the goods, so it enters consolidated COGS through FIFO.
  const capitalizedPolandConversion = accounts.PL.operatingExpenses ?? 0
  const consolidated = pnl(sum(sales.map(sale => sale.revenue)), sum(sales.map(sale => sale.groupCogs)),
    externalExpenses('operatingExpenses'), externalExpenses('rdExpense'))
  const entityProfit = sum(Object.values(entities).map(entity => entity.operatingProfit))
  const eliminations = {
    intercompanyRevenue, openingInventoryProfit: openingProfit, closingInventoryProfit: closingProfit,
    inventoryProfitChange, entityProfit, capitalizedPolandConversion,
  }
  const postingBalances = new Map()
  for (const entry of book.journal) {
    const key = entry.entity + '/' + entry.transactionId
    postingBalances.set(key, (postingBalances.get(key) ?? 0) + entry.debit - entry.credit)
  }
  const entityInventoryDifferences = ALL_COMPANIES.map(owner => {
    const owned = inventory.filter(bin => bin.owner === owner)
    const movement = sum(owned.map(bin => valueOf(bin.closing, 'unitValue') - valueOf(bin.opening, 'unitValue')))
    return Math.abs(movement - (accounts[owner].inventory ?? 0))
  })
  const receivables = sum(Object.values(accounts).map(account => account.intercompanyReceivable ?? 0))
  const payables = -sum(Object.values(accounts).map(account => account.intercompanyPayable ?? 0))
  const postedRevenue = sum(Object.values(entities).map(entity => entity.intercompanyRevenue))
  const inventoryQuantityDifference = Math.max(0, ...inventory.map(bin => Math.abs(
    unitsOf(bin.opening) + unitsOf(bin.receipts) - unitsOf(bin.issues) - unitsOf(bin.closing),
  )))
  const reconciliation = {
    ledgerDifference: Math.max(0, ...Array.from(postingBalances.values(), Math.abs)),
    intercompanyDifference: Math.max(
      Math.abs(receivables - intercompanyRevenue), Math.abs(payables - intercompanyRevenue), Math.abs(postedRevenue - intercompanyRevenue),
    ),
    profitDifference: consolidated.operatingProfit - (entityProfit - inventoryProfitChange),
    inventoryDifference: Math.max(...entityInventoryDifferences),
    inventoryQuantityDifference,
  }
  return { inventory, consolidated, eliminations, reconciliation }
}

function closeMonth(stock, config, month, shocks, priceTable, costScale) {
  stock.startMonth()
  const vintage = '2027-' + String(month).padStart(2, '0')
  const book = new Ledger(month)
  const plans = monthPlan(stock, month, shocks)
  const usUnits = allocate(FAMILIES.map(family => plans[family].usBuild), config.capacity.US)
  const plUnits = allocate(FAMILIES.map(family => plans[family].plBuild), config.capacity.PL)
  const capacity = Object.fromEntries([['US', usUnits], ['PL', plUnits]].map(([id, units]) => [id, {
    limit: config.capacity[id], used: sum(units),
    byProduct: Object.fromEntries(FAMILIES.map((family, index) => [family, units[index]])),
  }]))
  FAMILIES.forEach((family, index) => produce(stock, book, family, plans[family], usUnits[index], plUnits[index], shocks, config, vintage, costScale))
  moveGoods(stock, book, plans, vintage, priceTable)
  const sales = sellGoods(stock, book, plans, shocks)
  const royaltyBase = bookOtherCosts(book, stock, sales, config, shocks)
  bookResearch(book, sum(sales.map(sale => sale.revenue)), config.rd)
  const { entities, accounts } = book.financials()
  const financials = balances(book, stock, sales, entities, accounts)
  if (Object.values(financials.reconciliation).some(value => !Number.isFinite(value) || Math.abs(value) >= 0.005)) {
    throw new RangeError('This scenario does not reconcile to the cent. Reduce the size of the transfer price overrides or shocks.')
  }
  return {
    month, shocks, entities, sales, capacity, royaltyBase, costScale, ...financials,
    transactions: book.transactions, journal: book.journal,
  }
}

export function explainVariance(budget, actual) {
  const budgetSales = new Map(budget.sales.map(sale => [sale.seller + '/' + sale.product, sale]))
  let volume = 0
  let revenueVolume = 0
  let salesPrice = 0
  let materials = 0
  let otherCogs = 0
  const costScale = budget.costScale ?? 1
  for (const sale of actual.sales) {
    const reference = budgetSales.get(sale.seller + '/' + sale.product)
    const product = PRODUCTS[sale.product]
    const primaryPlant = sale.seller === 'US' || sale.seller === 'CA' ? 'US' : 'PL'
    const budgetUnitCogs = reference.quantity ? reference.groupCogs / reference.quantity : baseGroupCost(product, primaryPlant) * costScale
    const budgetUnitMaterials = reference.quantity ? reference.materialCogs / reference.quantity : product.material * costScale
    const changeInUnits = sale.quantity - reference.quantity
    revenueVolume += changeInUnits * reference.price
    volume += changeInUnits * (reference.price - budgetUnitCogs)
    salesPrice += sale.quantity * (sale.price - reference.price)
    materials += sale.quantity * budgetUnitMaterials - sale.materialCogs
    otherCogs += sale.quantity * (budgetUnitCogs - budgetUnitMaterials) - (sale.groupCogs - sale.materialCogs)
  }
  const operatingExpenses = budget.consolidated.operatingExpenses - actual.consolidated.operatingExpenses
  const operatingProfit = actual.consolidated.operatingProfit - budget.consolidated.operatingProfit
  return {
    month: actual.month, revenue: actual.consolidated.revenue - budget.consolidated.revenue, revenueVolume,
    volume, salesPrice, materials, otherCogs, operatingExpenses, operatingProfit,
    operatingMargin: actual.consolidated.operatingMargin - budget.consolidated.operatingMargin,
    check: operatingProfit - (volume + salesPrice + materials + otherCogs + operatingExpenses),
  }
}

function rollupPnl(months) {
  return pnl(
    sum(months.map(month => month.revenue)),
    sum(months.map(month => month.cogs)),
    sum(months.map(month => month.otherOperatingExpenses)),
    sum(months.map(month => month.rdExpense)),
    sum(months.map(month => month.rdServiceRevenue)),
  )
}

function budgetAtCost(config, months, costScale, prices) {
  if (!months) return []
  const stock = seedOpeningStock(costScale)
  return Array.from({ length: months }, (_, index) => closeMonth(stock, config, index + 1, ZERO_SHOCK, prices, costScale))
}

function calibratedCostScale(target, reference) {
  if (target === undefined) return 1
  const { revenue, cogs, operatingExpenses } = rollupPnl(reference.map(month => month.consolidated))
  const allowableCogs = revenue * (1 - target) - operatingExpenses
  if (allowableCogs < -1e-8) {
    const ceiling = (Math.floor(10_000 * (1 - operatingExpenses / revenue)) / 100).toFixed(2)
    throw new RangeError(`The target would require negative COGS. With these settings the maximum consolidated margin is ${ceiling}%.`)
  }
  const ratio = Math.max(0, allowableCogs) / cogs
  return Math.abs(ratio - 1) < 1e-12 ? 1 : ratio
}

function scenarioBudget(config, months = 0) {
  const { policies, annualOperatingMargin, startingPriceMethod } = config
  const provisional = standardGoodsPrices(policies, 1)
  const openingPriceMethod = startingPriceMethod ?? 'legacy'
  const calibrateDistributorPrices = openingPriceMethod === 'fifo-policy'
  const needsReference = annualOperatingMargin !== undefined || calibrateDistributorPrices
  const reference = needsReference ? budgetAtCost(config, 12, 1, provisional) : []
  const costScale = calibratedCostScale(annualOperatingMargin, reference)
  const initial = costScale === 1 ? { ...provisional } : standardGoodsPrices(policies, costScale)
  const openingNotes = {}
  let priceChanged = false

  if (calibrateDistributorPrices) {
    for (const route of GOODS_ROUTES.filter(route => !route.markup)) {
      const { key, to } = route
      const target = policies[LRD.has(to) ? 'lrdMargin' : 'ffdMargin']
      const planned = distributorPnl(rollupPnl(reference.map(month => month.entities[to])))
      const { recommended, note } = distributorQuote(route, reference, planned, 1, provisional[key], provisional[key], target)
      const prices = Object.fromEntries(FAMILIES.map(family => [
        family, recommended?.[family] ?? provisional[key][family],
      ]))
      initial[key] = prices
      priceChanged ||= FAMILIES.some(family => prices[family] !== provisional[key][family])
      if (note) openingNotes[key] = note
    }
  }

  const budget = needsReference && costScale === 1 && !priceChanged ? reference.slice(0, months)
    : budgetAtCost(config, months, costScale, initial)
  return { costScale, initial, openingNotes, openingPriceMethod, budget }
}

function distributorPnl(result) {
  return pnl(result.revenue - result.rdServiceRevenue, result.cogs, result.otherOperatingExpenses)
}

function summarizeEntityResults(actual, forecast, policies) {
  const fullYear = [...actual, ...forecast]
  return ['consolidated', ...ALL_COMPANIES].map(id => {
    const results = month => id === 'consolidated' ? month.consolidated : month.entities[id]
    const ytd = rollupPnl(actual.map(results))
    const annual = rollupPnl(fullYear.map(results))
    const row = { id, ytd, fullYear: annual }
    const distributor = DISTRIBUTORS.includes(id)
    if (distributor || id === 'BE') {
      const target = distributor ? policies[LRD.has(id) ? 'lrdMargin' : 'ffdMargin'] : policies.belgiumMargin
      const comparable = distributor ? distributorPnl(annual) : annual
      const label = distributor ? (LRD.has(id) ? 'LRD OM' : 'FFD OM') : 'Warehouse OM'
      const forecast = comparable.revenue ? comparable.operatingMargin : null
      row.policy = { label, target, forecast, outOfPolicy: forecast !== null &&
        Math.round(forecast * 10_000) !== Math.round(target * 10_000) }
    }
    return row
  })
}

function crossSupplyQuote(route, forecast, policies) {
  const invoices = forecast.flatMap(month => month.transactions.filter(transaction => transaction.policy === route.policy))
  const recommended = Object.fromEntries(FAMILIES.map(family => {
    const shipments = invoices.filter(invoice => invoice.product === family)
    const units = sum(shipments.map(invoice => invoice.quantity))
    const sellerCost = sum(shipments.map(invoice => invoice.basis))
    return [family, units ? roundCurrency(sellerCost / units * (1 + policies[route.markup])) : null]
  }))
  return { recommended, note: invoices.length ? '' : 'No shipments are forecast for this route through December.' }
}

function distributorQuote(route, forecast, fullYear, startMonth, current, standard, target) {
  const vintage = '2027-' + String(startMonth).padStart(2, '0')
  const positions = forecast.flatMap(month => month.inventory.filter(bin => bin.owner === route.to))
  // Only issues from future receipts can change this year's cost of goods sold.
  const adjustableUnits = Object.fromEntries(positions.reduce((units, bin) => {
    const newIssues = bin.issues.filter(lot => lot.vintage >= vintage)
    units.set(bin.product, (units.get(bin.product) ?? 0) + unitsOf(newIssues))
    return units
  }, new Map()))
  const units = sum(Object.values(adjustableUnits))
  if (!units) return { note: 'No sales are forecast from inventory received at new prices this year.' }

  const adjustableCogs = sum(FAMILIES.map(family => adjustableUnits[family] * current[family]))
  const fixedCogs = fullYear.cogs - adjustableCogs
  const costAllowance = fullYear.revenue * (1 - target) - fullYear.operatingExpenses - fixedCogs
  const standardCogs = sum(FAMILIES.map(family => adjustableUnits[family] * standard[family]))
  const allowance = Math.max(0, costAllowance)
  const recommended = Object.fromEntries(FAMILIES.map(family => {
    const price = standardCogs ? standard[family] * allowance / standardCogs : allowance / units
    return [family, adjustableUnits[family] ? roundCurrency(price) : null]
  }))
  const note = costAllowance < 0
    ? 'The full-year target is out of reach at any nonnegative price because of costs already incurred or carried in.'
    : ''
  return { recommended, note }
}

export function reviewGoodsPricing(config, revealed) {
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > 12) throw new RangeError('Reveal progress must be between zero and twelve months.')
  validateConfig(config)
  const { costScale, initial, openingNotes, openingPriceMethod } = scenarioBudget(config)
  const current = goodsPricesForMonth(config, Math.min(revealed + 1, 12), initial)
  const effectiveMonth = quarterPricingMonth(revealed)
  const stock = seedOpeningStock(costScale)
  validateSimulationConfig(config.simulation)
  const pastShocks = revealed ? simulateShocks(config.simulation, revealed) : []
  const actual = pastShocks.map((shock, index) => {
    const month = index + 1
    return closeMonth(stock, config, month, shock, goodsPricesForMonth(config, month, initial), costScale)
  })
  const forecast = []
  for (let month = revealed + 1; month <= 12; month++) {
    forecast.push(closeMonth(stock, config, month, ZERO_SHOCK, current, costScale))
  }

  const entityResults = summarizeEntityResults(actual, forecast, config.policies)
  const routes = GOODS_ROUTES.map(route => {
    const { key, from, to, policy, markup } = route
    const targetMargin = markup ? null : config.policies[LRD.has(to) ? 'lrdMargin' : 'ffdMargin']
    let quote = {}
    if (effectiveMonth) {
      const fullYear = entityResults.find(row => row.id === to).fullYear
      quote = markup ? crossSupplyQuote(route, forecast, config.policies)
        : distributorQuote(route, forecast, distributorPnl(fullYear), effectiveMonth, current[key], initial[key], targetMargin)
    }
    const startingQuote = revealed === 0 && openingPriceMethod === 'fifo-policy' && !openingNotes[key] ? initial[key] : null
    return {
      key, from, to, policy, targetMargin, markup: markup ? config.policies[markup] : null, note: quote.note,
      openingNote: openingNotes[key],
      prices: FAMILIES.map(product => ({
        product, applied: current[key][product], recommended: quote.recommended?.[product] ?? startingQuote?.[product] ?? null,
      })),
    }
  })
  return { effectiveMonth, routes, entityResults, actual, forecast, openingPriceMethod }
}

export function applyGoodsPrices(config, revealed, overrides = {}) {
  const startMonth = quarterPricingMonth(revealed)
  if (!startMonth) throw new RangeError('Review and change goods prices after closing March, June, or September.')
  validateConfig(config)
  validatePriceTable(overrides)
  const { initial } = scenarioBudget(config)
  const current = goodsPricesForMonth(config, startMonth, initial)
  const changed = Object.entries(overrides).some(([key, products]) =>
    Object.entries(products).some(([family, price]) => price !== current[key][family]))
  if (!changed) return config
  const prices = Object.fromEntries(GOODS_ROUTES.map(({ key }) => [key, { ...current[key], ...overrides[key] }]))
  return {
    ...config,
    goodsPriceSchedule: [
      ...(config.goodsPriceSchedule ?? []).filter(revision => revision.startMonth < startMonth),
      { startMonth, prices, overrides: structuredClone(overrides) },
    ],
  }
}

function runPeriod(config, months) {
  validateConfig(config)
  const { budget, costScale, initial } = scenarioBudget(config, months)
  const actualStock = seedOpeningStock(costScale)
  const shocks = simulateShocks(config.simulation, months)
  const actual = []
  const variance = []
  for (let month = 1; month <= months; month++) {
    const budgetMonth = budget[month - 1]
    const priceTable = goodsPricesForMonth(config, month, initial)
    const actualMonth = closeMonth(actualStock, config, month, shocks[month - 1], priceTable, costScale)
    actual.push(actualMonth)
    variance.push(explainVariance(budgetMonth, actualMonth))
  }
  return { budget, actual, variance }
}

export function runJanuary(config = createConfig()) {
  return runPeriod(config, 1)
}

export function runYear(config = createConfig()) {
  return runPeriod(config, 12)
}
