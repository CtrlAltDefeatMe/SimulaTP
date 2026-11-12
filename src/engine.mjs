import { DEFAULT_SIMULATION, simulateShocks, simulateStatAdjustments, validateSimulationConfig } from './simulation.mjs'

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

// The three lines differ in profitability, in the same order in every market: Control
// Systems earns a high gross margin, Precision Components a middling one and Industrial
// Modules a thin one. Price levels still differ by market through CHANNEL_FACTOR.
export const PRODUCTS = {
  A: {
    name: 'Precision Components', price: 112, material: 40, usConversion: 23, plConversion: 18,
    demand: { US: 640, CH: 170, DE: 360, FR: 285, UK: 310, APAC: 430, CA: 245 },
  },
  B: {
    name: 'Control Systems', price: 186, material: 44, usConversion: 25, plConversion: 20,
    demand: { US: 430, CH: 110, DE: 240, FR: 200, UK: 185, APAC: 285, CA: 140 },
  },
  C: {
    name: 'Industrial Modules', price: 268, material: 154, usConversion: 52, plConversion: 45,
    demand: { US: 280, CH: 80, DE: 145, FR: 130, UK: 120, APAC: 180, CA: 90 },
  },
}

export const POLICY_LABELS = {
  US_TO_CH: 'US → Swiss cross-supply',
  CH_TO_US: 'Swiss → US cross-supply',
  LRD_GOODS: 'LRD product transfer',
  FFD_GOODS: 'FFD product transfer',
  PL_TOLL_FEE: 'Poland monthly toll fee',
  BE_WAREHOUSE: 'Belgian warehouse fee',
  US_SERVICES: 'US headquarters services',
  IN_SERVICES: 'India monthly service fee',
  RD_SERVICES: 'R&D services · cost plus 10%',
  CH_ROYALTY: 'Swiss royalty to US',
  YEAR_END_ADJUSTMENT: 'Year-end transfer price adjustment',
  SERVICE_TRUE_UP: 'Year-end service fee true-up',
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
// Poland and India charge a fixed monthly fee and are tested on their markup on cost.
const SERVICE_PROVIDERS = ['PL', 'IN']
export const TESTED_PARTIES = [...DISTRIBUTORS, ...SERVICE_PROVIDERS]
// Every entity but the US parent files local accounts that can differ from US GAAP.
const LOCAL_ENTITIES = ALL_COMPANIES.filter(id => id !== 'US')
// Monthly operating costs outside the distributors, in USD. Belgium also pays for each unit it ships.
const INDIA_BUDGET_COST = 13_500
const US_SERVICES_COST = 19_000
const US_HEADQUARTERS_COST = 34_000
const SWISS_OPERATING_COST = 27_000
const BELGIAN_COST = { fixed: 9_500, perUnit: 1.75 }
// A distributor's own selling and administrative cost, as a share of its sales at list price.
export const DISTRIBUTOR_COST_RATE = { lrd: 0.15, ffd: 0.22 }
const INDIA_CUSTOMERS = { US: 0.45, CH: 0.55 }
const CHANNEL_FACTOR = { US: 1.08, CH: 0.88, DE: 1.04, FR: 1.01, UK: 1.05, APAC: 0.94, CA: 1.02 }
const SEASONAL = [0.93, 0.95, 0.99, 1.01, 1.04, 1.03, 0.96, 0.98, 1.08, 1.10, 1.13, 1.02]
const ZERO_SHOCK = { demand: 0, salesPrice: 0, materialCost: 0 }
const DEFAULT_RD_RATE = 0.04
// The default budget before R&D, less R&D at its default share of sales. Keeping the
// target equal to the uncalibrated budget leaves the base unit costs unscaled.
const DEFAULT_ANNUAL_MARGIN = 2_381_070.1859345874 / 10_487_570 - DEFAULT_RD_RATE
// Defaults of earlier versions, when unit costs and operating expenses were lower.
const PREVIOUS_DEFAULT_MARGINS = [3_965_513.159268929, 3_980_550.8704, 4_017_544.4704].map(profit => profit / 10_487_570 - DEFAULT_RD_RATE)
const RD_MARKUP = 0.10
// Arm's-length ranges for the tested distributors. Each range must contain its target.
const DEFAULT_RANGES = {
  lrd: { low: 0.015, high: 0.045 }, ffd: { low: 0.055, high: 0.095 },
  toll: { low: 0.05, high: 0.11 }, services: { low: 0.08, high: 0.16 },
}
// Each tested party's range and the policy setting that holds its target.
const POLICY_KINDS = {
  lrd: { target: 'lrdMargin', label: 'LRD' }, ffd: { target: 'ffdMargin', label: 'FFD' },
  toll: { target: 'polandMarkup', label: 'Poland toll' }, services: { target: 'indiaServicesMarkup', label: 'India services' },
}
const policyKind = id => id === 'PL' ? 'toll' : id === 'IN' ? 'services' : LRD.has(id) ? 'lrd' : 'ffd'
// Illustrative statutory income tax rates. They are scenario assumptions, not tax advice.
const DEFAULT_TAX_RATES = { US: 0.25, CH: 0.15, PL: 0.19, BE: 0.25, DE: 0.30, FR: 0.25, UK: 0.25, APAC: 0.17, CA: 0.265, IN: 0.25 }
// Customs territories. The EU, Switzerland and the United Kingdom are treated as one block.
export const CUSTOMS_BLOCKS = {
  EU: { name: 'Europe', members: 'EU, Switzerland and United Kingdom' },
  US: { name: 'United States' },
  CA: { name: 'Canada' },
  APAC: { name: 'Asia' },
}
const customsBlock = id => id !== 'EU' && id in CUSTOMS_BLOCKS ? id : 'EU'
// Goods are made in the United States or, for the Swiss principal, in Poland.
export const GOODS_ORIGINS = { US: 'United States', EU: 'Europe (Poland)' }
// A lane is one importing block and one place the goods were made. Goods that move inside
// a block, or return to the block that made them, pay no duty and have no lane.
export const CUSTOMS_LANES = [['EU', 'US'], ['US', 'EU'], ['CA', 'US'], ['CA', 'EU'], ['APAC', 'US'], ['APAC', 'EU']]
  .map(([importer, origin]) => ({ key: importer + '.' + origin, importer, origin }))
// Illustrative import duty on the declared transfer price. Each lane starts with one rate for all product lines.
const DEFAULT_DUTY_RATES = { 'EU.US': 0.03, 'US.EU': 0.10, 'CA.US': 0, 'CA.EU': 0.04, 'APAC.US': 0.05, 'APAC.EU': 0.05 }
// Rates used to be set by goods route, for every product and origin entering the destination.
const LEGACY_DUTY_ROUTES = { 'EU.US': 'US-CH', 'US.EU': 'CH-US', 'CA.US': 'US-CA', 'CA.EU': 'US-CA', 'APAC.US': 'CH-APAC', 'APAC.EU': 'CH-APAC' }
const LEGACY_DUTY_DEFAULTS = { 'US-CH': 0.03, 'CH-US': 0.10, 'CH-UK': 0, 'CH-APAC': 0.05, 'US-CA': 0 }
export const YEAR_END_MODES = ['none', 'range', 'target']
export const MAX_ROYALTY_RATE = 0.5
const HISTORICAL_OPENING_POLICIES = { lrdMargin: 0.03, ffdMargin: 0.075, polandMarkup: 0.08 }
const sourceOf = id => id === 'CA' ? 'US' : 'CH'
const goodsRouteKey = (from, to) => from + '-' + to
const GOODS_ROUTES = [
  { from: 'US', to: 'CH', policy: 'US_TO_CH', markup: 'usToSwissMarkup' },
  { from: 'CH', to: 'US', policy: 'CH_TO_US', markup: 'swissToUsMarkup' },
  ...DISTRIBUTORS.map(to => ({ from: sourceOf(to), to, policy: LRD.has(to) ? 'LRD_GOODS' : 'FFD_GOODS' })),
].map(route => ({ ...route, key: goodsRouteKey(route.from, route.to) }))
const GOODS_ROUTE_KEYS = new Set(GOODS_ROUTES.map(route => route.key))
export const TAXED_ENTITIES = ALL_COMPANIES
const sum = values => values.reduce((total, value) => total + value, 0)
const valueOf = (lots, field) => sum(lots.map(lot => lot.quantity * lot[field]))
const unitsOf = lots => sum(lots.map(lot => lot.quantity))
const margin = (profit, revenue) => revenue ? profit / revenue : 0
const roundCurrency = amount => Math.round(amount * 100) / 100
// Round to the cent without crossing the limit: a floor rounds up, headroom rounds down.
const ceilCurrency = amount => Math.ceil(amount * 100 - 1e-6) / 100
const floorCurrency = amount => Math.floor(amount * 100 + 1e-6) / 100
const basisPoints = value => Math.round(value * 10_000)
// A market's shock is the group-wide shock plus that market's own deviation.
const marketShock = (shocks, id, key) => shocks[key] + (shocks.markets?.[id]?.[key] ?? 0)
const taxRate = (config, id) => config.tax?.rates?.[id] ?? DEFAULT_TAX_RATES[id] ?? 0
const dutyRate = (config, lane, family) => config.customs?.rates?.[lane]?.[family] ?? DEFAULT_DUTY_RATES[lane] ?? 0
const dutyRates = pick => Object.fromEntries(CUSTOMS_LANES.map(({ key }) => [
  key, Object.fromEntries(FAMILIES.map(family => [family, pick(key, family)])),
]))

export function createConfig() {
  return {
    capacity: { US: 2550, PL: 4850 },
    policies: {
      lrdMargin: 0.03, ffdMargin: 0.075, polandMarkup: 0.08, belgiumMargin: 0.06,
      usServicesMarkup: 0.07, indiaServicesMarkup: 0.12, royaltyRate: 0.05,
      usToSwissMarkup: 0.15, swissToUsMarkup: 0.20,
    },
    ranges: structuredClone(DEFAULT_RANGES),
    // Share of Poland's conversion cost, at normal volume, that does not move with output.
    services: { polandFixedShare: 0.4 },
    annualOperatingMargin: DEFAULT_ANNUAL_MARGIN,
    rd: { salesRate: DEFAULT_RD_RATE, usShare: 0.5 },
    tax: { rates: { ...DEFAULT_TAX_RATES } },
    customs: { rates: dutyRates(key => DEFAULT_DUTY_RATES[key]) },
    // Optional rule: no goods transfer price may fall below standard cost plus this markup.
    priceFloor: { enabled: false, markup: 0.05 },
    startingPriceMethod: 'fifo-policy',
    simulation: structuredClone(DEFAULT_SIMULATION),
    goodsPriceSchedule: [],
    serviceFeeSchedule: [],
    yearEnd: Object.fromEntries(TESTED_PARTIES.map(id => [id, 'none'])),
  }
}

/**
 * Fill in settings added after a scenario was saved. A scenario that has not
 * started picks up the current defaults. One in progress keeps the behavior it
 * started with, so its revealed months do not change.
 */
export function upgradeConfig(config, started) {
  const defaults = createConfig()
  const upgraded = { ...config }
  for (const key of ['tax', 'customs', 'priceFloor', 'services', 'serviceFeeSchedule']) upgraded[key] ??= defaults[key]
  upgraded.ranges = { ...defaults.ranges, ...upgraded.ranges }
  upgraded.yearEnd = { ...defaults.yearEnd, ...upgraded.yearEnd }
  // A scenario saved before R&D existed ran without it.
  upgraded.rd ??= { salesRate: 0, usShare: defaults.rd.usShare }
  for (const [kind, { target: key }] of Object.entries(POLICY_KINDS)) {
    const target = upgraded.policies?.[key]
    const { low, high } = upgraded.ranges[kind]
    if (Number.isFinite(target) && (target < low || target > high)) {
      upgraded.ranges = { ...upgraded.ranges, [kind]: { low: Math.min(low, target), high: Math.max(high, target) } }
    }
  }
  // Duty rates saved by goods route become rates by importing block, origin and product line.
  const savedDuty = upgraded.customs?.rates
  if (savedDuty && !CUSTOMS_LANES.some(({ key }) => key in savedDuty)) {
    const untouched = Object.entries(LEGACY_DUTY_DEFAULTS).every(([route, rate]) => savedDuty[route] === rate)
    upgraded.customs = !started && untouched ? defaults.customs
      : { rates: dutyRates(key => savedDuty[LEGACY_DUTY_ROUTES[key]] ?? DEFAULT_DUTY_RATES[key]) }
  }
  // A scenario that has not started and still holds an earlier default takes the current one.
  if (!started && upgraded.rd.salesRate === DEFAULT_RD_RATE
    && PREVIOUS_DEFAULT_MARGINS.some(previous => Math.abs(upgraded.annualOperatingMargin - previous) < 1e-9)) {
    upgraded.annualOperatingMargin = DEFAULT_ANNUAL_MARGIN
  }
  if (!started && upgraded.simulation) {
    const { marketVariation, serviceCostVariation, statAdjustment } = DEFAULT_SIMULATION
    upgraded.simulation = { marketVariation: { ...marketVariation }, serviceCostVariation, ...upgraded.simulation }
    upgraded.simulation.statAdjustment = { ...statAdjustment, ...upgraded.simulation.statAdjustment }
  }
  return upgraded
}

function policyRange(config, id) {
  const kind = policyKind(id)
  const target = config.policies[POLICY_KINDS[kind].target]
  const { low, high } = config.ranges?.[kind] ?? DEFAULT_RANGES[kind]
  return { target, low: Math.min(low, target), high: Math.max(high, target) }
}

function rangeStatus(margin, { low, high }) {
  if (basisPoints(margin) < basisPoints(low)) return 'below'
  return basisPoints(margin) > basisPoints(high) ? 'above' : 'within'
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
  if (config.policies.royaltyRate > MAX_ROYALTY_RATE) throw new RangeError('The royalty rate must be between 0% and 50%.')
  if (config.priceFloor !== undefined) {
    const { enabled, markup } = config.priceFloor ?? {}
    if (typeof enabled !== 'boolean' || !Number.isFinite(markup) || markup < 0 || markup > 1) {
      throw new RangeError('The price floor markup on standard cost must be between 0% and 100%.')
    }
  }
  for (const [kind, { target: key, label }] of Object.entries(POLICY_KINDS)) {
    if (config.ranges?.[kind] === undefined) continue
    const { low, high } = config.ranges[kind] ?? {}
    const target = config.policies[key]
    if (![low, high].every(Number.isFinite) || low < 0 || high >= 1 || low > target || high < target) {
      throw new RangeError(`The ${label} arm's-length range must run from a low of at least 0% to a high below 100% and contain its target.`)
    }
  }
  const fixedShare = config.services?.polandFixedShare
  if (fixedShare !== undefined && (!Number.isFinite(fixedShare) || fixedShare < 0 || fixedShare > 1)) {
    throw new RangeError('The fixed share of Poland\'s conversion cost must be between 0% and 100%.')
  }
  const taxRates = config.tax?.rates
  if (taxRates !== undefined && TAXED_ENTITIES.some(id => !Number.isFinite(taxRates[id]) || taxRates[id] < 0 || taxRates[id] >= 1)) {
    throw new RangeError('Each income tax rate must be between 0% and less than 100%.')
  }
  const duties = config.customs?.rates
  if (duties !== undefined && CUSTOMS_LANES.some(({ key }) => FAMILIES.some((family) => {
    const rate = duties[key]?.[family]
    return !Number.isFinite(rate) || rate < 0 || rate >= 1
  }))) {
    throw new RangeError('Each customs duty rate must be between 0% and less than 100%.')
  }
  for (const [id, mode] of Object.entries(config.yearEnd ?? {})) {
    if (!TESTED_PARTIES.includes(id) || !YEAR_END_MODES.includes(mode)) throw new RangeError('Unknown year-end adjustment choice.')
  }
  let previousMonth = 0
  for (const { startMonth, prices, overrides } of config.goodsPriceSchedule ?? []) {
    validatePricingMonth(startMonth)
    if (startMonth <= previousMonth) throw new RangeError('Goods price revisions must be ordered by effective month.')
    validatePriceTable(prices)
    validatePriceTable(overrides)
    previousMonth = startMonth
  }
  previousMonth = 0
  for (const { startMonth, fees } of config.serviceFeeSchedule ?? []) {
    validatePricingMonth(startMonth)
    if (startMonth <= previousMonth) throw new RangeError('Service fee revisions must be ordered by effective month.')
    validateServiceFees(fees)
    previousMonth = startMonth
  }
}

function validateServiceFees(fees) {
  if (!fees || typeof fees !== 'object' || Array.isArray(fees)) throw new RangeError('Enter monthly fees by service provider.')
  for (const [id, fee] of Object.entries(fees)) {
    if (!SERVICE_PROVIDERS.includes(id)) throw new RangeError('Unknown service provider: ' + id)
    const cents = Math.round(fee * 100)
    if (!Number.isFinite(fee) || fee < 0 || !Number.isSafeInteger(cents) || fee !== cents / 100) {
      throw new RangeError('Each monthly fee must be a nonnegative dollar amount with at most two decimal places.')
    }
  }
}

function serviceFeesForMonth(config, month, initial) {
  const revision = config.serviceFeeSchedule?.findLast(entry => entry.startMonth <= month)
  return revision ? { ...initial, ...revision.fees } : initial
}

// `origin` is the customs block where the goods were made. It travels with the lot.
function makeLot(quantity, unitValue, unitGroupCost, unitMaterialCost, vintage, origin) {
  return { quantity, unitValue, unitGroupCost, unitMaterialCost, vintage, origin }
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
  return LRD.has(market) ? DISTRIBUTOR_COST_RATE.lrd : DISTRIBUTOR_COST_RATE.ffd
}

function distributorUnitTp(product, market, policies) {
  const rate = LRD.has(market) ? policies.lrdMargin : policies.ffdMargin
  return Math.max(0, basePrice(product, market) * (1 - rate - distributorCostRate(market)))
}

// The supplier's standard cost of a unit: budget materials and conversion, plus the
// toll fee for goods the Swiss principal has made in Poland. Shocks do not move it.
function standardUnitCost(from, product, policies) {
  return from === 'US' ? baseGroupCost(product, 'US')
    : baseGroupCost(product, 'PL') + product.plConversion * policies.polandMarkup
}

function standardCosts(policies, costScale) {
  return Object.fromEntries(GOODS_ROUTES.map(({ key, from }) => [
    key, Object.fromEntries(FAMILIES.map(family => [family, standardUnitCost(from, PRODUCTS[family], policies) * costScale])),
  ]))
}

// The lowest price allowed on each route and product when the floor rule is on, else null.
function priceFloors(config, costs) {
  if (!config.priceFloor?.enabled) return null
  return Object.fromEntries(Object.entries(costs).map(([key, products]) => [
    key, Object.fromEntries(Object.entries(products).map(([family, cost]) => [
      family, ceilCurrency(cost * (1 + config.priceFloor.markup)),
    ])),
  ]))
}

function atLeastFloor(prices, floors) {
  if (!floors) return prices
  return Object.fromEntries(Object.entries(prices).map(([key, products]) => [
    key, Object.fromEntries(Object.entries(products).map(([family, price]) => [family, Math.max(price, floors[key][family])])),
  ]))
}

function standardGoodsPrices(policies, costScale) {
  return Object.fromEntries(GOODS_ROUTES.map(({ key, from, to, markup }) => [
    key, Object.fromEntries(FAMILIES.map(family => {
      const product = PRODUCTS[family]
      const price = markup ? standardUnitCost(from, product, policies) * costScale * (1 + policies[markup])
        : distributorUnitTp(product, to, policies)
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
      const origin = customsBlock(sourceOf(market))
      bin.lots = [
        makeLot(product.demand[market], tp * 0.97, cost * 0.98, product.material * costScale * 0.98, '2026-11', origin),
        makeLot(product.demand[market], tp, cost, product.material * costScale, '2026-12', origin),
      ]
    }
    const swissDemand = sum(MARKETS.filter(id => id !== 'US' && id !== 'CA').map(id => product.demand[id]))
    const cost = baseGroupCost(product, 'PL') * costScale
    const local = cost + product.plConversion * costScale * historical.polandMarkup
    const warehouse = stock.bin('CH', 'BE', family)
    warehouse.lots = [0.96, 0.98, 0.99, 1].map((factor, index) =>
      makeLot(swissDemand, local * factor, cost * factor, product.material * costScale * factor, '2026-' + String(9 + index).padStart(2, '0'), 'EU'))
    const us = stock.bin('US', 'US', family)
    const usCost = baseGroupCost(product, 'US') * costScale
    us.lots = [makeLot(product.demand.US + product.demand.CA, usCost, usCost, product.material * costScale, '2026-12', 'US')]
    for (const [stage, months] of [['raw', 0.35], ['wip', 0.15]]) {
      const bin = stock.bin('CH', 'PL', family, stage)
      const material = product.material * costScale
      bin.lots = [makeLot(Math.round(swissDemand * months), material, material, material, '2026-12', 'EU')]
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

  transfer({ from, to, category, policy, product = null, quantity = 0, amount, buyerAccount, basis = null, external = false, origins = null }) {
    const id = `T${this.month}-${++this.sequence}`
    this.transactions.push({ id, from, to, category, policy, product, quantity, amount, basis, external, ...(origins ? { origins } : {}) })
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
    const demand = Object.fromEntries(MARKETS.map(id => [
      id, Math.round(product.demand[id] * seasonal * (1 + marketShock(shocks, id, 'demand'))),
    ]))
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

function produceInUs(stock, book, family, plan, usUnits, shocks, vintage, costScale) {
  if (!usUnits) return
  const product = PRODUCTS[family]
  const material = product.material * costScale * (1 + shocks.materialCost)
  const cost = material + product.usConversion * costScale
  stock.receive(plan.us, [makeLot(usUnits, cost, cost, material, vintage, 'US')])
  book.post('US', 'inventory', 'externalClearing', usUnits * cost)
}

// Poland's conversion cost at normal volume: the base monthly demand it serves, at
// standard conversion cost. A fixed share of it is overhead that does not move with output.
function polandOverhead(config, costScale) {
  const normal = sum(FAMILIES.map(family => {
    const product = PRODUCTS[family]
    return sum(MARKETS.filter(id => id !== 'US' && id !== 'CA').map(id => product.demand[id])) * product.plConversion
  }))
  return (config.services?.polandFixedShare ?? 0) * normal * costScale
}

// Poland converts the Swiss principal's materials for a fixed monthly fee. Its own cost is
// fixed overhead plus a variable cost per unit, so cost per unit rises when output falls.
// `fee` is the month's charge. Without one, the charge is cost plus the policy markup.
function tollInPoland(stock, book, plans, plUnits, shocks, config, vintage, costScale, fee) {
  const standard = FAMILIES.map((family, index) => plUnits[index] * PRODUCTS[family].plConversion * costScale)
  const absorbed = sum(standard)
  const variableShare = 1 - (config.services?.polandFixedShare ?? 0)
  const cost = (polandOverhead(config, costScale) + variableShare * absorbed) * (1 + (shocks.services?.PL ?? 0))
  const charge = fee ?? cost * (1 + config.policies.polandMarkup)
  const result = { cost, fee: charge, units: sum(plUnits) }
  book.post('PL', 'operatingExpenses', 'externalClearing', cost)
  if (!absorbed) {
    // Nothing was converted, so no goods can carry the fee or the cost. Both are expensed.
    book.transfer({ from: 'PL', to: 'CH', category: 'services', policy: 'PL_TOLL_FEE', amount: charge, basis: cost, buyerAccount: 'cogs' })
    book.uncapitalizedConversion = cost
    return result
  }
  FAMILIES.forEach((family, index) => {
    const units = plUnits[index]
    if (!units) return
    const product = PRODUCTS[family]
    const plan = plans[family]
    const material = product.material * costScale * (1 + shocks.materialCost)
    const raw = stock.bin('CH', 'PL', family, 'raw')
    const wip = stock.bin('CH', 'PL', family, 'wip')
    // Replenish the raw and material-only WIP buffers as conversion completes.
    stock.receive(raw, [makeLot(units, material, material, material, vintage, 'EU')])
    book.post('CH', 'inventory', 'externalClearing', units * material)
    stock.receive(wip, stock.issue(raw, units))
    const completed = stock.issue(wip, units)
    // The month's fee and cost are spread over the goods by their standard conversion content.
    const share = standard[index] / absorbed
    book.transfer({
      from: 'PL', to: 'CH', category: 'services', policy: 'PL_TOLL_FEE', product: family,
      quantity: units, amount: charge * share, basis: cost * share, buyerAccount: 'inventory',
    })
    stock.receive(plan.warehouse, completed.map(lot => makeLot(
      lot.quantity, lot.unitValue + charge * share / units, lot.unitGroupCost + cost * share / units, lot.unitMaterialCost, vintage, lot.origin,
    )))
  })
  return result
}

function deliver(stock, book, { lots, from, to, target, family, policy, priceLot, vintage }) {
  const quantity = unitsOf(lots)
  if (!quantity) return
  const received = lots.map(lot => makeLot(lot.quantity, priceLot(lot), lot.unitGroupCost, lot.unitMaterialCost, vintage, lot.origin))
  stock.receive(target, received)
  // The invoice value by where the goods were made. Customs duty depends on it.
  const origins = {}
  for (const lot of received) origins[lot.origin] = (origins[lot.origin] ?? 0) + lot.quantity * lot.unitValue
  book.transfer({
    from, to, category: 'goods', policy, product: family, quantity,
    amount: valueOf(received, 'unitValue'), basis: valueOf(lots, 'unitValue'), buyerAccount: 'inventory', origins,
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
      const price = basePrice(product, seller) * (1 + marketShock(shocks, seller, 'salesPrice'))
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

function bookOtherCosts(book, stock, sales, config, shocks, indiaFee) {
  const { policies } = config
  const warehouseUnits = sum(stock.snapshot().filter(bin => bin.owner === 'CH' && bin.custodian === 'BE').map(bin => unitsOf(bin.issues)))
  const belgianCost = BELGIAN_COST.fixed + BELGIAN_COST.perUnit * warehouseUnits
  const usServices = US_SERVICES_COST * (1 + 0.2 * shocks.demand)
  // India's cost follows activity and has a deviation of its own. Its fee is fixed for the month.
  const indiaServices = INDIA_BUDGET_COST * (1 + 0.2 * shocks.demand) * (1 + (shocks.services?.IN ?? 0))
  const indiaCharge = indiaFee ?? indiaServices * (1 + policies.indiaServicesMarkup)
  for (const [id, amount] of [['US', usServices + US_HEADQUARTERS_COST], ['CH', SWISS_OPERATING_COST], ['IN', indiaServices], ['BE', belgianCost]]) {
    book.post(id, 'operatingExpenses', 'externalClearing', amount)
  }
  const royaltyBase = sum(sales.filter(sale => sale.channel === 'LRD' || sale.channel === 'direct').map(sale => sale.revenue))
  for (const [from, to, policy, basis, amount] of [
    ['BE', 'CH', 'BE_WAREHOUSE', belgianCost, belgianCost / (1 - policies.belgiumMargin)],
    ['US', 'CH', 'US_SERVICES', usServices, usServices * (1 + policies.usServicesMarkup)],
    ...Object.entries(INDIA_CUSTOMERS).map(([customer, share]) =>
      ['IN', customer, 'IN_SERVICES', indiaServices * share, indiaCharge * share]),
    ['CH', 'US', 'CH_ROYALTY', royaltyBase, royaltyBase * policies.royaltyRate],
  ]) {
    book.transfer({
      from, to, category: policy === 'CH_ROYALTY' ? 'royalty' : 'services', policy, amount, basis, buyerAccount: 'operatingExpenses',
    })
  }
  return { royaltyBase, india: { cost: indiaServices, fee: indiaCharge } }
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

const isServiceProvider = id => SERVICE_PROVIDERS.includes(id)

// The activity each tested party is judged on. R&D services are priced separately.
function testedPnl(result) {
  return pnl(result.revenue - result.rdServiceRevenue, result.cogs, result.otherOperatingExpenses)
}

/**
 * A tested party's result on the basis it is judged on. Distributors are measured by
 * operating margin on sales, service providers by markup on cost. `statAdjustment` is
 * the US GAAP to local statutory difference: a positive amount adds local cost.
 */
function testedResult(id, result, statAdjustment = 0) {
  const tested = testedPnl(result)
  const profit = tested.operatingProfit - statAdjustment
  const costs = tested.cogs + tested.otherOperatingExpenses + statAdjustment
  const base = isServiceProvider(id) ? costs : tested.revenue
  return { revenue: tested.revenue, costs, profit, base, indicator: margin(profit, base) }
}

// Who pays a service provider, and how its charge is split between them.
const serviceCustomers = id => id === 'PL' ? { CH: 1 } : INDIA_CUSTOMERS

// After the December close the year's prices can still be corrected: a distributor's
// supplier can raise or credit its goods purchases, and a service provider's customers
// can top up or claw back its fees. Adjustments are expensed in December, never enter
// inventory, and aim at the local statutory result, which is what the range is tested on.
function yearEndAdjustments(book, config, { months: priorMonths, floors, statRates }) {
  const provisional = book.financials().entities
  const invoices = [...priorMonths.flatMap(month => month.transactions), ...book.transactions]
    .filter(invoice => !invoice.external && invoice.category === 'goods' && invoice.quantity)
  return TESTED_PARTIES.map(id => {
    const service = isServiceProvider(id)
    const fullYear = rollupPnl([...priorMonths.map(month => month.entities[id]), provisional[id]])
    const statAdjustment = (statRates?.[id] ?? 0) * fullYear.otherOperatingExpenses
    const gaap = testedResult(id, fullYear)
    const before = testedResult(id, fullYear, statAdjustment)
    const range = policyRange(config, id)
    const statusBefore = rangeStatus(before.indicator, range)
    // A credit lowers what a distributor paid for the year's goods. With a price floor,
    // it can go no further than the gap between the year's invoices and their floor value.
    const headroom = floors && !service ? floorCurrency(sum(invoices.filter(invoice => invoice.to === id).map(invoice =>
      invoice.amount - invoice.quantity * floors[goodsRouteKey(invoice.from, id)][invoice.product]))) : Infinity
    // For a distributor: profit above what the level allows, paid to its supplier.
    // For a service provider: the fee still owed to reach the level, paid by its customers.
    const needed = level => roundCurrency((before.profit - level * before.base) * (service ? -1 : 1))
    const wanted = {
      target: needed(range.target),
      range: statusBefore === 'within' ? 0 : needed(statusBefore === 'below' ? range.low : range.high),
    }
    const toTarget = Math.max(wanted.target, -headroom)
    const toRange = Math.max(wanted.range, -headroom)
    const mode = config.yearEnd?.[id] ?? 'none'
    const amount = mode === 'target' ? toTarget : mode === 'range' ? toRange : 0
    if (amount && service) {
      for (const [customer, share] of Object.entries(serviceCustomers(id))) {
        book.transfer({
          from: id, to: customer, category: 'services', policy: 'SERVICE_TRUE_UP', amount: amount * share,
          buyerAccount: id === 'PL' ? 'cogs' : 'operatingExpenses',
        })
      }
    } else if (amount) {
      book.transfer({
        from: sourceOf(id), to: id, category: 'goods', policy: 'YEAR_END_ADJUSTMENT', amount, buyerAccount: 'cogs',
      })
    }
    const after = margin(before.profit + (service ? amount : -amount), before.base)
    return {
      id, service, counterparty: service ? Object.keys(serviceCustomers(id)) : [sourceOf(id)], mode, amount, toTarget, toRange, ...range,
      floorLimited: { target: toTarget !== wanted.target, range: toRange !== wanted.range },
      revenue: before.revenue, statRate: statRates?.[id] ?? 0, statAdjustment,
      gaapBefore: gaap.indicator, marginBefore: before.indicator, statusBefore,
      gaapAfter: margin(gaap.profit + (service ? amount : -amount), gaap.base),
      marginAfter: after, statusAfter: rangeStatus(after, range),
    }
  })
}

// The year in local accounts: each entity's US GAAP operating profit less its statutory
// adjustment, which is a share of its operating expenses outside R&D and goods purchased.
function statutoryResults({ months: priorMonths, statRates }, entities) {
  return Object.fromEntries(LOCAL_ENTITIES.map(id => {
    const fullYear = rollupPnl([...priorMonths.map(month => month.entities[id]), entities[id]])
    const rate = statRates?.[id] ?? 0
    const adjustment = rate * fullYear.otherOperatingExpenses
    return [id, {
      rate, base: fullYear.otherOperatingExpenses, adjustment,
      gaapProfit: fullYear.operatingProfit, operatingProfit: fullYear.operatingProfit - adjustment,
    }]
  }))
}

// Local tax is charged on local accounts. `stat` holds them once the year is closed.
function taxFor(config, entities, stat = null) {
  const byEntity = Object.fromEntries(TAXED_ENTITIES.map(id => {
    const rate = taxRate(config, id)
    const profit = stat?.[id]?.operatingProfit ?? entities[id].operatingProfit
    return [id, { rate, profit, tax: rate * profit }]
  }))
  const total = sum(Object.values(byEntity).map(entity => entity.tax))
  const profit = sum(Object.values(byEntity).map(entity => entity.profit))
  return { entities: byEntity, total, profit, effectiveRate: profit ? total / profit : 0 }
}

const emptyLanes = config => Object.fromEntries(CUSTOMS_LANES.map(({ key, importer, origin }) => [key, {
  importer, origin, value: 0, duty: 0,
  products: Object.fromEntries(FAMILIES.map(family => [family, { rate: dutyRate(config, key, family), value: 0, duty: 0 }])),
}]))

// Duty is charged on the declared transfer price each time goods enter a customs block
// from another one. The rate depends on the importing block, the product line and where
// the goods were made. It is reported beside the results and is not charged to operating profit.
function customsFor(config, transactions, priorMonths = []) {
  const lanes = emptyLanes(config)
  const credits = {}
  for (const invoice of transactions) {
    if (invoice.external || invoice.category !== 'goods') continue
    const importer = customsBlock(invoice.to)
    if (importer === customsBlock(invoice.from)) continue
    if (invoice.policy === 'YEAR_END_ADJUSTMENT') {
      credits[importer] = (credits[importer] ?? 0) + invoice.amount
      continue
    }
    for (const [origin, value] of Object.entries(invoice.origins ?? {})) {
      const lane = lanes[importer + '.' + origin]
      if (!lane) continue
      const entry = lane.products[invoice.product]
      entry.value += value
      entry.duty += entry.rate * value
      lane.value += value
      lane.duty += entry.rate * value
    }
  }
  // A year-end adjustment changes what was paid for the whole year's imports, so it takes
  // their average duty rate. An upward one adds duty. No refund is assumed for a credit.
  const adjustments = Object.fromEntries(Object.entries(credits).map(([importer, amount]) => {
    const imports = [...priorMonths.map(month => month.customs.lanes), lanes]
      .flatMap(set => Object.values(set).filter(lane => lane.importer === importer))
    const value = sum(imports.map(lane => lane.value))
    const rate = value ? sum(imports.map(lane => lane.duty)) / value : 0
    return [importer, { amount, rate, duty: rate * Math.max(0, amount) }]
  }))
  const adjustmentDuty = sum(Object.values(adjustments).map(entry => entry.duty))
  return { lanes, adjustments, adjustmentDuty, total: sum(Object.values(lanes).map(lane => lane.duty)) + adjustmentDuty }
}

/** Third-party sales and group cost of sales by product line for a closed month. */
export function productLineResults(month) {
  return FAMILIES.map(family => {
    const sales = month.sales.filter(sale => sale.product === family)
    const revenue = sum(sales.map(sale => sale.revenue))
    const cogs = sum(sales.map(sale => sale.groupCogs))
    return { product: family, units: sum(sales.map(sale => sale.quantity)), revenue, cogs, grossProfit: revenue - cogs, grossMargin: margin(revenue - cogs, revenue) }
  })
}

/** Total income tax and customs duty for a set of closed months. */
export function summarizeTaxAndCustoms(config, months) {
  const entities = Object.fromEntries(TAXED_ENTITIES.map(id => [id, rollupPnl(months.map(month => month.entities[id]))]))
  const lanes = emptyLanes(config)
  for (const month of months) {
    for (const [key, lane] of Object.entries(month.customs.lanes)) {
      lanes[key].value += lane.value
      lanes[key].duty += lane.duty
      for (const family of FAMILIES) {
        lanes[key].products[family].value += lane.products[family].value
        lanes[key].products[family].duty += lane.products[family].duty
      }
    }
  }
  // Year-end adjustments exist only in the December close.
  const adjustments = Object.assign({}, ...months.map(month => month.customs.adjustments))
  const adjustmentDuty = sum(months.map(month => month.customs.adjustmentDuty))
  // A full year of actuals carries the statutory results. Tax then follows them.
  const stat = months.length === 12 ? months[11].stat ?? null : null
  return {
    tax: taxFor(config, entities, stat),
    customs: { lanes, adjustments, adjustmentDuty, total: sum(months.map(month => month.customs.total)) },
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
  // In a month with no output there are no goods to carry it, and it is expensed.
  const uncapitalizedConversion = book.uncapitalizedConversion ?? 0
  const capitalizedPolandConversion = (accounts.PL.operatingExpenses ?? 0) - uncapitalizedConversion
  const consolidated = pnl(sum(sales.map(sale => sale.revenue)), sum(sales.map(sale => sale.groupCogs)),
    externalExpenses('operatingExpenses') + uncapitalizedConversion, externalExpenses('rdExpense'))
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

// `fees` holds the month's fixed service fees. `yearToDate` is passed for the December
// close of actuals only, when year-end adjustments and local statutory results are booked.
function closeMonth(stock, config, month, shocks, priceTable, costScale, fees = null, yearToDate = null) {
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
  FAMILIES.forEach((family, index) => produceInUs(stock, book, family, plans[family], usUnits[index], shocks, vintage, costScale))
  const poland = tollInPoland(stock, book, plans, plUnits, shocks, config, vintage, costScale, fees?.PL)
  moveGoods(stock, book, plans, vintage, priceTable)
  const sales = sellGoods(stock, book, plans, shocks)
  const { royaltyBase, india } = bookOtherCosts(book, stock, sales, config, shocks, fees?.IN)
  bookResearch(book, sum(sales.map(sale => sale.revenue)), config.rd)
  const yearEnd = yearToDate ? yearEndAdjustments(book, config, yearToDate) : null
  const { entities, accounts } = book.financials()
  const stat = yearToDate ? statutoryResults(yearToDate, entities) : null
  const financials = balances(book, stock, sales, entities, accounts)
  if (Object.values(financials.reconciliation).some(value => !Number.isFinite(value) || Math.abs(value) >= 0.005)) {
    throw new RangeError('This scenario does not reconcile to the cent. Reduce the size of the transfer price overrides or shocks.')
  }
  return {
    month, shocks, entities, sales, capacity, royaltyBase, costScale, ...financials, services: { PL: poland, IN: india },
    tax: taxFor(config, entities), customs: customsFor(config, book.transactions, yearToDate?.months ?? []), ...(yearEnd ? { yearEnd, stat } : {}),
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

function budgetAtCost(config, months, costScale, prices, fees = null) {
  if (!months) return []
  const stock = seedOpeningStock(costScale)
  return Array.from({ length: months }, (_, index) => closeMonth(stock, config, index + 1, ZERO_SHOCK, prices, costScale, fees))
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
  // The reference year runs at unscaled cost with services at cost plus. It gives the
  // budgeted service costs that the fixed monthly fees are set from.
  const reference = budgetAtCost(config, 12, 1, provisional)
  const costScale = calibratedCostScale(annualOperatingMargin, reference)
  const budgetServiceCost = {
    PL: sum(reference.map(month => month.services.PL.cost)) * costScale / 12,
    IN: sum(reference.map(month => month.services.IN.cost)) / 12,
  }
  const initialFees = {
    PL: roundCurrency(budgetServiceCost.PL * (1 + policies.polandMarkup)),
    IN: roundCurrency(budgetServiceCost.IN * (1 + policies.indiaServicesMarkup)),
  }
  const costs = standardCosts(policies, costScale)
  const floors = priceFloors(config, costs)
  let initial = costScale === 1 ? { ...provisional } : standardGoodsPrices(policies, costScale)
  const openingNotes = {}

  if (calibrateDistributorPrices) {
    for (const route of GOODS_ROUTES.filter(route => !route.markup)) {
      const { key, to } = route
      const target = policies[LRD.has(to) ? 'lrdMargin' : 'ffdMargin']
      const planned = testedPnl(rollupPnl(reference.map(month => month.entities[to])))
      const { recommended, note } = distributorQuote(route, reference, planned, 1, provisional[key], provisional[key], target, floors?.[key])
      const prices = Object.fromEntries(FAMILIES.map(family => [
        family, recommended?.[family] ?? provisional[key][family],
      ]))
      initial[key] = prices
      if (note) openingNotes[key] = note
    }
  }
  initial = atLeastFloor(initial, floors)

  const budget = budgetAtCost(config, months, costScale, initial, initialFees)
  return { costScale, initial, openingNotes, openingPriceMethod, budget, costs, floors, initialFees, budgetServiceCost }
}

function summarizeEntityResults(actual, forecast, config) {
  const { policies } = config
  const fullYear = [...actual, ...forecast]
  // Local accounts exist only once all twelve months are actuals. Until then the
  // forecast is on US GAAP, and the range test on it is provisional.
  const stat = forecast.length ? null : actual[11]?.stat ?? null
  const rows = ALL_COMPANIES.map(id => {
    const results = month => month.entities[id]
    const ytd = rollupPnl(actual.map(results))
    const annual = rollupPnl(fullYear.map(results))
    const rate = taxRate(config, id)
    const taxable = stat?.[id]?.operatingProfit ?? annual.operatingProfit
    const row = {
      id, ytd, fullYear: annual, stat: stat?.[id] ?? null,
      tax: { rate, ytd: rate * ytd.operatingProfit, fullYear: rate * taxable },
    }
    if (TESTED_PARTIES.includes(id)) {
      const service = isServiceProvider(id)
      const range = policyRange(config, id)
      const gaap = testedResult(id, annual)
      const tested = testedResult(id, annual, stat?.[id]?.adjustment ?? 0)
      const forecast = tested.base ? tested.indicator : null
      const status = forecast === null ? 'within' : rangeStatus(forecast, range)
      // A tax authority on the short side is assumed to adjust to the target with no relief elsewhere.
      const gap = range.target * tested.base - tested.profit
      const payerRate = service
        ? sum(Object.entries(serviceCustomers(id)).map(([customer, share]) => share * taxRate(config, customer)))
        : taxRate(config, sourceOf(id))
      const exposure = status === 'below' ? rate * gap : status === 'above' ? payerRate * -gap : 0
      row.policy = {
        label: service ? 'Markup on cost' : LRD.has(id) ? 'LRD OM' : 'FFD OM', measure: service ? 'markup' : 'margin',
        ...range, forecast, status, outOfPolicy: status !== 'within', exposure,
        basis: stat ? 'stat' : 'gaap', gaap: gaap.base ? gaap.indicator : null,
      }
    } else if (id === 'BE') {
      const target = policies.belgiumMargin
      const forecast = annual.revenue ? annual.operatingMargin : null
      const outOfPolicy = forecast !== null && basisPoints(forecast) !== basisPoints(target)
      row.policy = { label: 'Warehouse OM', measure: 'margin', target, forecast, status: outOfPolicy ? 'off' : 'within', outOfPolicy, exposure: 0, basis: 'gaap' }
    }
    return row
  })
  const consolidated = month => month.consolidated
  const total = key => sum(rows.map(row => row.tax[key]))
  return [{
    id: 'consolidated', ytd: rollupPnl(actual.map(consolidated)), fullYear: rollupPnl(fullYear.map(consolidated)), stat: null,
    tax: { rate: null, ytd: total('ytd'), fullYear: total('fullYear') },
  }, ...rows]
}

// The monthly fee that would bring a service provider's full-year markup to its target,
// given what it has already been paid and the cost forecast for the rest of the year.
function serviceFeeQuotes(config, actual, forecast, currentFees, budgetServiceCost) {
  const remaining = forecast.length
  return SERVICE_PROVIDERS.map(id => {
    const { target, low, high } = policyRange(config, id)
    const months = [...actual, ...forecast]
    const cost = sum(months.map(month => month.services[id].cost))
    const billed = sum(actual.map(month => month.services[id].fee))
    return {
      id, customers: Object.keys(serviceCustomers(id)), target, low, high,
      budgetCost: budgetServiceCost[id], fee: currentFees[id],
      recommended: remaining ? roundCurrency(Math.max(0, (cost * (1 + target) - billed) / remaining)) : null,
    }
  })
}

/**
 * Compare the royalty rate with R&D as a share of consolidated sales. A royalty
 * below the R&D share can be a sign that it is too low. It is a prompt, not a limit.
 */
export function royaltyCheck(config) {
  const royaltyRate = config.policies.royaltyRate
  const researchRate = config.rd?.salesRate ?? 0
  return { royaltyRate, researchRate, belowResearch: royaltyRate < researchRate }
}

/**
 * Where the group's operating profit lands, and how much of the Swiss residual the
 * royalty moves. Switzerland is the licensee. The royalty changes nothing else in the
 * model, so its profit falls in a straight line as the rate rises and reaches zero
 * at `breakEvenRate`.
 */
export function profitAllocation(months) {
  const profit = id => sum(months.map(month => month.entities[id].operatingProfit))
  const royalty = sum(months.flatMap(month =>
    month.transactions.filter(transaction => transaction.policy === 'CH_ROYALTY').map(transaction => transaction.amount)))
  const us = profit('US')
  const swiss = profit('CH')
  const routine = sum(ALL_COMPANIES.filter(id => id !== 'US' && id !== 'CH').map(profit))
  const swissBeforeRoyalty = swiss + royalty
  const royaltyBase = sum(months.map(month => month.royaltyBase))
  return {
    us, swiss, routine, total: us + swiss + routine, royalty, swissBeforeRoyalty, royaltyBase,
    royaltyShare: swissBeforeRoyalty ? royalty / swissBeforeRoyalty : 0,
    breakEvenRate: royaltyBase ? swissBeforeRoyalty / royaltyBase : null,
    licenseeLoss: swiss <= -0.005,
  }
}

function crossSupplyQuote(route, forecast, policies, floor = null) {
  const invoices = forecast.flatMap(month => month.transactions.filter(transaction => transaction.policy === route.policy))
  const held = []
  const recommended = Object.fromEntries(FAMILIES.map(family => {
    const shipments = invoices.filter(invoice => invoice.product === family)
    const units = sum(shipments.map(invoice => invoice.quantity))
    const sellerCost = sum(shipments.map(invoice => invoice.basis))
    if (!units) return [family, null]
    const price = roundCurrency(sellerCost / units * (1 + policies[route.markup]))
    if (floor && price < floor[family]) held.push(family)
    return [family, floor ? Math.max(price, floor[family]) : price]
  }))
  const note = !invoices.length ? 'No shipments are forecast for this route through December.' : floorNote(held)
  return { recommended, note, held }
}

function floorNote(held, short = false) {
  if (!held.length) return ''
  const names = held.map(family => PRODUCTS[family].name).join(', ')
  return short
    ? `Every product is at the price floor, so the full-year target is out of reach. Held at the floor: ${names}.`
    : `Held at the price floor: ${names}.`
}

function distributorQuote(route, forecast, fullYear, startMonth, current, standard, target, floor = null) {
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
  const allowance = Math.max(0, costAllowance)
  const sold = FAMILIES.filter(family => adjustableUnits[family])
  // Spread the cost the target allows over the products in proportion to their standard
  // prices. A product that would fall below its floor is held there, and the rest absorb it.
  const held = new Set()
  let prices
  let short = false
  for (;;) {
    const free = sold.filter(family => !held.has(family))
    const remaining = allowance - sum([...held].map(family => adjustableUnits[family] * floor[family]))
    short = held.size > 0 && !free.length && remaining < -0.005
    const freeStandard = sum(free.map(family => adjustableUnits[family] * standard[family]))
    const freeUnits = sum(free.map(family => adjustableUnits[family]))
    prices = Object.fromEntries(free.map(family => [
      family, freeStandard ? standard[family] * Math.max(0, remaining) / freeStandard : Math.max(0, remaining) / freeUnits,
    ]))
    const below = floor ? free.filter(family => prices[family] < floor[family]) : []
    if (!below.length) break
    for (const family of below) held.add(family)
  }
  const recommended = Object.fromEntries(FAMILIES.map(family => [
    family, !adjustableUnits[family] ? null : held.has(family) ? floor[family] : roundCurrency(prices[family]),
  ]))
  const note = costAllowance < 0
    ? 'The full-year target is out of reach at any nonnegative price because of costs already incurred or carried in.'
    : floorNote([...held], short)
  return { recommended, note, held: [...held] }
}

export function reviewGoodsPricing(config, revealed) {
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > 12) throw new RangeError('Reveal progress must be between zero and twelve months.')
  validateConfig(config)
  const { costScale, initial, openingNotes, openingPriceMethod, costs, floors, initialFees, budgetServiceCost } = scenarioBudget(config)
  const current = goodsPricesForMonth(config, Math.min(revealed + 1, 12), initial)
  const currentFees = serviceFeesForMonth(config, Math.min(revealed + 1, 12), initialFees)
  const effectiveMonth = quarterPricingMonth(revealed)
  const stock = seedOpeningStock(costScale)
  validateSimulationConfig(config.simulation)
  const pastShocks = revealed ? simulateShocks(config.simulation, revealed, MARKETS, SERVICE_PROVIDERS) : []
  const actual = []
  for (const [index, shock] of pastShocks.entries()) {
    const month = index + 1
    actual.push(closeMonth(stock, config, month, shock, goodsPricesForMonth(config, month, initial), costScale,
      serviceFeesForMonth(config, month, initialFees), month === 12 ? yearToDate(config, actual, floors) : null))
  }
  const forecast = []
  for (let month = revealed + 1; month <= 12; month++) {
    forecast.push(closeMonth(stock, config, month, ZERO_SHOCK, current, costScale, currentFees))
  }

  const entityResults = summarizeEntityResults(actual, forecast, config)
  const routes = GOODS_ROUTES.map(route => {
    const { key, from, to, policy, markup } = route
    const targetMargin = markup ? null : config.policies[LRD.has(to) ? 'lrdMargin' : 'ffdMargin']
    let quote = {}
    if (effectiveMonth) {
      const fullYear = entityResults.find(row => row.id === to).fullYear
      quote = markup ? crossSupplyQuote(route, forecast, config.policies, floors?.[key])
        : distributorQuote(route, forecast, testedPnl(fullYear), effectiveMonth, current[key], initial[key], targetMargin, floors?.[key])
    }
    const startingQuote = revealed === 0 && openingPriceMethod === 'fifo-policy' && !openingNotes[key] ? initial[key] : null
    return {
      key, from, to, policy, targetMargin, markup: markup ? config.policies[markup] : null, note: quote.note,
      openingNote: openingNotes[key],
      prices: FAMILIES.map(product => ({
        product, applied: current[key][product], recommended: quote.recommended?.[product] ?? startingQuote?.[product] ?? null,
        standardCost: costs[key][product], floor: floors?.[key][product] ?? null,
      })),
    }
  })
  const fullYear = [...actual, ...forecast]
  const reviewsUsed = new Set([...(config.goodsPriceSchedule ?? []), ...(config.serviceFeeSchedule ?? [])].map(entry => entry.startMonth))
  return {
    effectiveMonth, routes, entityResults, actual, forecast, openingPriceMethod,
    services: serviceFeeQuotes(config, actual, forecast, currentFees, budgetServiceCost),
    allocation: profitAllocation(fullYear), royalty: royaltyCheck(config), fullYear: summarizeTaxAndCustoms(config, fullYear),
    yearEnd: actual[11]?.yearEnd ?? null, stat: actual[11]?.stat ?? null, priceRevisions: reviewsUsed.size,
    priceFloor: floors ? { ...config.priceFloor } : null,
  }
}

// What the December close of actuals needs: the year so far, the price floors, and the
// year's local statutory adjustment rates.
function yearToDate(config, months, floors) {
  return { months: [...months], floors, statRates: simulateStatAdjustments(config.simulation, LOCAL_ENTITIES) }
}

/** Record new fixed monthly fees for Poland and India from the month after a quarterly review. */
export function applyServiceFees(config, revealed, fees = {}) {
  const startMonth = quarterPricingMonth(revealed)
  if (!startMonth) throw new RangeError('Review and change service fees after closing March, June, or September.')
  validateConfig(config)
  validateServiceFees(fees)
  const { initialFees } = scenarioBudget(config)
  const current = serviceFeesForMonth(config, startMonth, initialFees)
  if (!Object.entries(fees).some(([id, fee]) => fee !== current[id])) return config
  return {
    ...config,
    serviceFeeSchedule: [
      ...(config.serviceFeeSchedule ?? []).filter(revision => revision.startMonth < startMonth),
      { startMonth, fees: { ...current, ...fees } },
    ],
  }
}

export function applyGoodsPrices(config, revealed, overrides = {}) {
  const startMonth = quarterPricingMonth(revealed)
  if (!startMonth) throw new RangeError('Review and change goods prices after closing March, June, or September.')
  validateConfig(config)
  validatePriceTable(overrides)
  const { initial, floors } = scenarioBudget(config)
  if (floors) {
    for (const [key, products] of Object.entries(overrides)) {
      for (const [family, price] of Object.entries(products)) {
        if (price >= floors[key][family]) continue
        const { from, to } = GOODS_ROUTES.find(route => route.key === key)
        throw new RangeError(`${PRODUCTS[family].name}, ${ENTITIES[from].name} to ${ENTITIES[to].name}: the price cannot go below the floor of $${floors[key][family].toFixed(2)}, which is standard cost plus ${+(config.priceFloor.markup * 100).toFixed(2)}%.`)
      }
    }
  }
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

/** Record the year-end adjustment chosen for each tested party once December is closed. */
export function applyYearEndAdjustments(config, revealed, choices = {}) {
  if (revealed !== 12) throw new RangeError('Year-end adjustments open once December actuals are revealed.')
  validateConfig(config)
  for (const [id, mode] of Object.entries(choices)) {
    if (!TESTED_PARTIES.includes(id) || !YEAR_END_MODES.includes(mode)) throw new RangeError('Unknown year-end adjustment choice.')
  }
  const current = Object.fromEntries(TESTED_PARTIES.map(id => [id, config.yearEnd?.[id] ?? 'none']))
  const yearEnd = { ...current, ...choices }
  return TESTED_PARTIES.some(id => yearEnd[id] !== current[id]) ? { ...config, yearEnd } : config
}

function runPeriod(config, months) {
  validateConfig(config)
  const { budget, costScale, initial, floors, initialFees } = scenarioBudget(config, months)
  const actualStock = seedOpeningStock(costScale)
  const shocks = simulateShocks(config.simulation, months, MARKETS, SERVICE_PROVIDERS)
  const actual = []
  const variance = []
  for (let month = 1; month <= months; month++) {
    const budgetMonth = budget[month - 1]
    const priceTable = goodsPricesForMonth(config, month, initial)
    const actualMonth = closeMonth(actualStock, config, month, shocks[month - 1], priceTable, costScale,
      serviceFeesForMonth(config, month, initialFees), month === 12 ? yearToDate(config, actual, floors) : null)
    actual.push(actualMonth)
    variance.push(explainVariance(budgetMonth, actualMonth))
  }
  return { budget, actual, variance }
}

/**
 * Explain where each tested party finished the year and what moved it there. Each
 * driver is a change in the party's indicator, in the order the effects are applied,
 * so the drivers add up to the gap between the budget and the final statutory result.
 */
export function explainYear(config, { budget, actual }) {
  if (actual.length !== 12 || !actual[11].yearEnd) throw new RangeError('The year can be explained once December actuals are revealed.')
  const total = (months, pick) => sum(months.map(pick))
  return actual[11].yearEnd.map(entry => {
    const { id, service } = entry
    const range = policyRange(config, id)
    const planned = testedResult(id, rollupPnl(budget.map(month => month.entities[id])))
    const result = rollupPnl(actual.map(month => month.entities[id]))
    const gaap = testedResult(id, result)
    // The true-up changes revenue for a service provider and cost of sales for a distributor.
    const beforeTrueUp = (gaap.profit + (service ? -entry.amount : entry.amount)) / (service ? gaap.costs : gaap.revenue)
    const drivers = []
    const facts = { statRate: entry.statRate, statAdjustment: entry.statAdjustment }
    if (service) {
      const budgetFees = total(budget, month => month.services[id].fee)
      const budgetCost = total(budget, month => month.services[id].cost)
      const cost = total(actual, month => month.services[id].cost)
      const atBudgetFee = budgetFees / cost - 1
      drivers.push({ key: 'costs', points: atBudgetFee - planned.indicator })
      drivers.push({ key: 'fees', points: beforeTrueUp - atBudgetFee })
      facts.costDeviation = cost / budgetCost - 1
      if (id === 'PL') {
        facts.unitsDeviation = total(actual, month => month.capacity.PL.used) / total(budget, month => month.capacity.PL.used) - 1
      }
    } else {
      const sales = actual.flatMap(month => month.sales.filter(sale => sale.seller === id))
      const atBudgetPrices = sum(sales.map(sale => sale.quantity * basePrice(PRODUCTS[sale.product], id)))
      const costs = gaap.costs - entry.amount
      const atBudgetPriceMargin = (atBudgetPrices - costs) / atBudgetPrices
      drivers.push({ key: 'volume', points: atBudgetPriceMargin - planned.indicator })
      drivers.push({ key: 'salesPrice', points: beforeTrueUp - atBudgetPriceMargin })
      facts.priceDeviation = gaap.revenue / atBudgetPrices - 1
      const units = months => sum(months.flatMap(month => month.sales.filter(sale => sale.seller === id).map(sale => sale.quantity)))
      facts.unitsDeviation = units(actual) / units(budget) - 1
    }
    drivers.push({ key: 'yearEnd', points: gaap.indicator - beforeTrueUp })
    drivers.push({ key: 'stat', points: entry.marginAfter - gaap.indicator })
    return {
      id, service, measure: service ? 'markup' : 'margin', ...range, budget: planned.indicator, gaap: gaap.indicator,
      result: entry.marginAfter, status: entry.statusAfter, adjustment: entry.amount, facts,
      drivers: drivers.filter(driver => Math.abs(driver.points) >= 0.00005),
    }
  })
}

export function runJanuary(config = createConfig()) {
  return runPeriod(config, 1)
}

export function runYear(config = createConfig()) {
  return runPeriod(config, 12)
}
