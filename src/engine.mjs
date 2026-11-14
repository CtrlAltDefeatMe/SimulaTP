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
// The high-margin line is made only in the United States and the low-margin line only in
// Poland. Both plants make the middle line. See PRODUCT_PLANTS.
export const PRODUCTS = {
  A: {
    name: 'Precision Components', price: 112, material: 38, usConversion: 23, plConversion: 18,
    demand: { US: 640, CH: 170, DE: 360, FR: 285, UK: 310, APAC: 430, CA: 245 },
  },
  B: {
    name: 'Control Systems', price: 186, material: 42, usConversion: 25, plConversion: 20,
    demand: { US: 430, CH: 110, DE: 240, FR: 200, UK: 185, APAC: 285, CA: 140 },
  },
  C: {
    name: 'Industrial Modules', price: 268, material: 152, usConversion: 52, plConversion: 45,
    demand: { US: 280, CH: 80, DE: 145, FR: 130, UK: 120, APAC: 180, CA: 90 },
  },
}

export const POLICY_LABELS = {
  US_TO_CH: 'US → Swiss cross-supply',
  CH_TO_US: 'Swiss → US cross-supply',
  LRD_GOODS: 'LRD product transfer',
  FFD_GOODS: 'FFD product transfer',
  PL_TOLL_FEE: 'Poland quarterly toll fee',
  BE_WAREHOUSE: 'Belgian warehouse fee',
  US_SERVICES: 'US headquarters services',
  IN_SERVICES: 'India quarterly service fee',
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
/** The plants that make each product line. A line made in one plant reaches the other region by cross-supply. */
export const PRODUCT_PLANTS = { A: ['US', 'PL'], B: ['US'], C: ['PL'] }
const PLANTS = ['US', 'PL']
// Two hubs hold the group's finished stock and supply its markets: the United States, fed
// by the US plant, and Switzerland, fed by the Polish toll manufacturer.
const HUBS = ['US', 'CH']
const HUB_PLANT = { US: 'US', CH: 'PL' }
const otherHub = hub => hub === 'US' ? 'CH' : 'US'
const makes = (plant, family) => PRODUCT_PLANTS[family].includes(plant)
// The plant a hub's supply of a product line normally comes from: its own if it makes the line, else the other one.
const plantFor = (family, hub) => makes(HUB_PLANT[hub], family) ? HUB_PLANT[hub] : HUB_PLANT[otherHub(hub)]
// Whether a hub makes a line itself or buys it from the other hub.
const hubMakes = (hub, family) => makes(HUB_PLANT[hub], family)
const LRD = new Set(['DE', 'FR', 'UK'])
// Months of their own base demand the distributors hold in stock. The limited-risk
// distributors hold none: the Swiss principal keeps their stock in the Belgian warehouse
// and ships each order straight to the customer, selling to the distributor as it ships.
// It holds the two months the distributors would otherwise keep, on top of its own stock.
const DISTRIBUTOR_STOCK_MONTHS = { lrd: 0, ffd: 2 }
const PRINCIPAL_LRD_STOCK_MONTHS = 2
const stockMonths = id => DISTRIBUTOR_STOCK_MONTHS[LRD.has(id) ? 'lrd' : 'ffd']
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
const DEFAULT_ANNUAL_MARGIN = 2_279_906.539063561 / 10_487_570 - DEFAULT_RD_RATE
// Defaults of earlier versions: before the limited-risk distributors' stock moved to the
// Swiss principal, before each product line was given its own plant, before plant capacity
// was cut to about a normal month's output, before customs duty entered cost of sales, and
// before unit costs and operating expenses were raised.
const PREVIOUS_DEFAULT_MARGINS = [2_281_724.4253404764, 2_282_638.939772495, 2_287_230.2960874448, 2_381_070.1859345874, 3_965_513.159268929, 3_980_550.8704, 4_017_544.4704]
  .map(profit => profit / 10_487_570 - DEFAULT_RD_RATE)
// Units a month for each product line a plant makes. Each is a little above a normal
// month's output, so a plant runs at its limit in the busier months and draws on stock.
const DEFAULT_CAPACITY = { US: { A: 915, B: 1645 }, PL: { A: 1565, C: 1035 } }
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
// Fixed assets at 1 January 2027, USD thousands: cost and net book value by class, and the
// useful life in years over which cost is depreciated, straight line. They are sized on the
// default budget. The US parent's land and buildings are 20% of its net sales, net, and
// depreciate by 1% of sales a year (a 40-year life); its machinery and equipment are 25%
// of sales, net, and depreciate by 2% (20 years). Poland's sales are only its toll fee, so
// its plant is sized like the US plant instead, scaled by capacity at conversion cost: 20%
// larger. The others own no land or buildings: office equipment of about 3% of sales for
// the distributors, 1% for the Swiss principal and 10% for India, and warehouse equipment
// of 35% of its fee for Belgium, which leases its building. Half of their cost is depreciated.
// Depreciation is part of each entity's operating costs: it is shown as its own line, worked
// out from these assets, and the rest of the costs are shown without it.
export const FIXED_ASSET_CLASSES = { buildings: 'Land and buildings', equipment: 'Machinery and equipment' }
export const FIXED_ASSETS = {
  US: { buildings: { cost: 2_038_000, net: 1_019_000, life: 40 }, equipment: { cost: 2_038_000, net: 1_274_000, life: 20 } },
  CH: { equipment: { cost: 126_000, net: 63_000, life: 5 } },
  PL: { buildings: { cost: 2_450_000, net: 1_225_000, life: 40 }, equipment: { cost: 2_450_000, net: 1_531_000, life: 20 } },
  BE: { equipment: { cost: 142_000, net: 71_000, life: 10 } },
  DE: { equipment: { cost: 103_000, net: 51_000, life: 5 } },
  FR: { equipment: { cost: 77_000, net: 39_000, life: 5 } },
  UK: { equipment: { cost: 78_000, net: 39_000, life: 5 } },
  APAC: { equipment: { cost: 103_000, net: 51_000, life: 5 } },
  CA: { equipment: { cost: 58_000, net: 29_000, life: 5 } },
  IN: { equipment: { cost: 36_000, net: 18_000, life: 4 } },
}
// Customers pay in 60 days and group companies in 30, and so does everyone for what they buy:
// two months and one month of the engine's monthly flows.
export const PAYMENT_TERMS = { thirdParty: { days: 60, months: 2 }, related: { days: 30, months: 1 } }
// The US parent's bonds, held by outside investors: about 30% of its equity at the start of
// the year, at a fixed coupon. There are no loans between group companies.
export const US_BONDS = { amount: 690_000, rate: 0.05 }
// Each entity holds about a month of its budgeted revenue in cash at the start of the year.
const OPENING_CASH_MONTHS = 1
const monthlyDepreciation = (id, kind) => {
  const asset = FIXED_ASSETS[id]?.[kind]
  return asset ? asset.cost / asset.life / 12 : 0
}
const depreciationOf = id => monthlyDepreciation(id, 'buildings') + monthlyDepreciation(id, 'equipment')
// Interest on the bonds for a number of months.
const bondInterest = months => US_BONDS.amount * US_BONDS.rate * months / 12

// Illustrative statutory income tax rates. They are scenario assumptions, not tax advice.
// The US rate is the federal 21% plus state tax.
const DEFAULT_TAX_RATES = { US: 0.25, CH: 0.15, PL: 0.19, BE: 0.25, DE: 0.30, FR: 0.25, UK: 0.25, APAC: 0.17, CA: 0.265, IN: 0.25 }
// US federal rules for tax years beginning after 2025, as amended by Pub. L. 119-21.
export const US_TAX_RULES = Object.freeze({
  federalRate: 0.21,
  // Section 250 deductions: on foreign-derived deduction eligible income (FDDEI), and on
  // net CFC tested income (NCTI) with its section 78 gross-up.
  fddeiDeduction: 0.3334, nctiDeduction: 0.40,
  // Share of the foreign income taxes on tested income that is deemed paid and creditable.
  nctiCreditShare: 0.90,
  // Base erosion and anti-abuse tax: the rate on modified taxable income, the base erosion
  // percentage at or above which it applies, and the annual gross receipts it needs, in
  // thousands of dollars like every amount in the model.
  beatRate: 0.105, beatThreshold: 0.03, beatGrossReceipts: 500_000,
})
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
// The hub an entity's goods come through. A hub is its own.
const hubOf = id => id === 'US' || id === 'CA' ? 'US' : 'CH'
// The markets a hub supplies, itself included.
const hubMarkets = hub => MARKETS.filter(id => hubOf(id) === hub)
const goodsRouteKey = (from, to) => from + '-' + to
const GOODS_ROUTES = [
  { from: 'US', to: 'CH', policy: 'US_TO_CH', markup: 'usToSwissMarkup' },
  { from: 'CH', to: 'US', policy: 'CH_TO_US', markup: 'swissToUsMarkup' },
  ...DISTRIBUTORS.map(to => ({ from: sourceOf(to), to, policy: LRD.has(to) ? 'LRD_GOODS' : 'FFD_GOODS' })),
].map(route => ({ ...route, key: goodsRouteKey(route.from, route.to) }))
const GOODS_ROUTE_KEYS = new Set(GOODS_ROUTES.map(route => route.key))
// A hub can only cross-supply a line its own plant makes. Every line reaches the distributors.
const routeCarries = ({ from, markup }, family) => !markup || hubMakes(from, family)
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
// The duty rate on a unit made in `origin` when one entity ships it to another.
function importDutyRate(config, from, to, family, origin) {
  const importer = customsBlock(to)
  if (importer === customsBlock(from) || importer === origin) return 0
  return dutyRate(config, importer + '.' + origin, family)
}
const dutyRates = pick => Object.fromEntries(CUSTOMS_LANES.map(({ key }) => [
  key, Object.fromEntries(FAMILIES.map(family => [family, pick(key, family)])),
]))

export function createConfig() {
  return {
    capacity: structuredClone(DEFAULT_CAPACITY),
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
  upgraded.tax = { ...defaults.tax, ...upgraded.tax }
  // BEAT's gross receipts test used to be a setting. It is now worked out from the US parent's receipts.
  delete upgraded.tax.beatGrossReceipts
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
  // Capacity used to be one figure for each plant across all product lines. It is now set
  // for each line a plant makes, so a scenario saved the old way takes the current limits.
  if (typeof upgraded.capacity?.US !== 'object' || typeof upgraded.capacity?.PL !== 'object') {
    upgraded.capacity = structuredClone(DEFAULT_CAPACITY)
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
  for (const plant of PLANTS) {
    for (const family of FAMILIES.filter(family => makes(plant, family))) {
      const capacity = config.capacity?.[plant]?.[family]
      if (!Number.isSafeInteger(capacity) || capacity < 0) {
        throw new RangeError(`${ENTITIES[plant].name} capacity for ${PRODUCTS[family].name} must be a nonnegative whole number.`)
      }
    }
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
  if (!fees || typeof fees !== 'object' || Array.isArray(fees)) throw new RangeError('Enter fees by service provider.')
  for (const [id, fee] of Object.entries(fees)) {
    if (!SERVICE_PROVIDERS.includes(id)) throw new RangeError('Unknown service provider: ' + id)
    // A fee quoted by the quarter is a third of it each month, so a monthly fee need not be whole cents.
    if (!Number.isFinite(fee) || fee < 0 || !Number.isSafeInteger(Math.round(fee * 100))) {
      throw new RangeError('Each fee must be a nonnegative dollar amount.')
    }
  }
}

function serviceFeesForMonth(config, month, initial) {
  const revision = config.serviceFeeSchedule?.findLast(entry => entry.startMonth <= month)
  return revision ? { ...initial, ...revision.fees } : initial
}

// `origin` is the customs block where the goods were made. It travels with the lot.
// `source` is how the lot came into its bin: 'made', 'converted', 'bought' or 'materials'.
// `trace` can add: `unitDuty`, the customs duty inside `unitValue`; `declared`, the origin
// declared at customs when the lot crossed a customs border; and `materials`, the month the
// materials of a converted lot were bought.
function makeLot(quantity, unitValue, unitGroupCost, unitMaterialCost, vintage, origin, source = 'bought', trace = {}) {
  return { quantity, unitValue, unitGroupCost, unitMaterialCost, vintage, origin, source, unitDuty: 0, declared: null, materials: null, ...trace }
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

// What a unit may cost a distributor, landed, to leave its target margin after its own expenses.
function distributorLandedCost(product, market, policies) {
  const rate = LRD.has(market) ? policies.lrdMargin : policies.ffdMargin
  return Math.max(0, basePrice(product, market) * (1 - rate - distributorCostRate(market)))
}

// The customs origin of a product line as a hub normally holds it: where its plant is.
const plannedOrigin = (family, hub) => plantFor(family, hub) === 'US' ? 'US' : 'EU'

// The policy transfer price is the landed cost less the import duty the distributor pays
// on top of the price. The plan assumes goods from the plant that normally supplies the line.
function distributorUnitTp(family, market, config, policies = config.policies) {
  const supplier = sourceOf(market)
  const duty = importDutyRate(config, supplier, market, family, plannedOrigin(family, supplier))
  return distributorLandedCost(PRODUCTS[family], market, policies) / (1 + duty)
}

const CROSS_MARKUP = { US: 'usToSwissMarkup', CH: 'swissToUsMarkup' }

// What a hub's own plant charges it for a unit: budget materials and conversion, plus the
// toll fee for goods the Swiss principal has made in Poland.
function madeUnitCost(hub, product, policies) {
  return hub === 'US' ? baseGroupCost(product, 'US')
    : baseGroupCost(product, 'PL') + product.plConversion * policies.polandMarkup
}

// The price one hub charges the other for a line it makes: its standard cost plus the cross-supply markup.
function crossSupplyPrice(from, family, policies) {
  return madeUnitCost(from, PRODUCTS[family], policies) * (1 + policies[CROSS_MARKUP[from]])
}

// The supplier's standard cost of a unit. For a line its plant makes, that is the made
// cost. For a line it buys from the other hub, it is the cross-supply price plus the
// import duty paid on it. Shocks do not move it.
function standardUnitCost(from, family, config, policies = config.policies) {
  if (hubMakes(from, family)) return madeUnitCost(from, PRODUCTS[family], policies)
  const seller = otherHub(from)
  return crossSupplyPrice(seller, family, policies) * (1 + importDutyRate(config, seller, from, family, plannedOrigin(family, seller)))
}

// What a unit has cost the group by the time a hub holds it: the plant's materials and
// conversion, and the duty paid if it crossed from the other hub.
function hubGroupCost(hub, family, config, policies = config.policies) {
  const product = PRODUCTS[family]
  if (hubMakes(hub, family)) return baseGroupCost(product, HUB_PLANT[hub])
  const seller = otherHub(hub)
  return baseGroupCost(product, HUB_PLANT[seller])
    + crossSupplyPrice(seller, family, policies) * importDutyRate(config, seller, hub, family, plannedOrigin(family, seller))
}

function standardCosts(config, costScale) {
  return Object.fromEntries(GOODS_ROUTES.map(({ key, from }) => [
    key, Object.fromEntries(FAMILIES.map(family => [family, standardUnitCost(from, family, config) * costScale])),
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

function standardGoodsPrices(config, costScale) {
  const { policies } = config
  return Object.fromEntries(GOODS_ROUTES.map(({ key, from, to, markup }) => [
    key, Object.fromEntries(FAMILIES.map(family => {
      const price = markup ? standardUnitCost(from, family, config) * costScale * (1 + policies[markup])
        : distributorUnitTp(family, to, config)
      return [family, roundCurrency(price)]
    })),
  ]))
}

function seedOpeningStock(costScale, config) {
  // Opening distributor values are landed costs under the 2026 policy assumptions: the
  // invoice price plus any import duty paid on it. Group cost follows the scenario's
  // consolidated budget calibration and carries the same duty.
  const historical = HISTORICAL_OPENING_POLICIES
  // Last year's toll markup, with this year's cross-supply markups.
  const history = { ...config.policies, ...historical }
  const stock = new Stock()
  for (const family of FAMILIES) {
    const product = PRODUCTS[family]
    // The full-fledged distributors open with two months of stock. The limited-risk ones hold none.
    for (const market of DISTRIBUTORS.filter(id => stockMonths(id))) {
      const cost = hubGroupCost(sourceOf(market), family, config, history) * costScale
      const tp = distributorLandedCost(product, market, historical)
      const bin = stock.bin(market, market, family)
      const origin = plannedOrigin(family, sourceOf(market))
      const rate = importDutyRate(config, sourceOf(market), market, family, origin)
      // The duty inside a landed cost.
      const duty = landed => landed * rate / (1 + rate)
      const declared = customsBlock(market) !== origin ? origin : null
      bin.lots = [
        makeLot(product.demand[market], tp * 0.97, cost * 0.98 + duty(tp * 0.97), product.material * costScale * 0.98, '2026-11', origin, 'bought', { unitDuty: duty(tp * 0.97), declared }),
        makeLot(product.demand[market], tp, cost + duty(tp), product.material * costScale, '2026-12', origin, 'bought', { unitDuty: duty(tp), declared }),
      ]
    }
    // Each hub opens with its usual stock. Of a line its own plant makes, that is four
    // months of its markets' demand in the Swiss warehouse and one month in the United
    // States, carried at what the plant charged. Of a line it buys from the other hub, it
    // is one month, carried at the cross-supply price plus the duty paid on it. The Swiss
    // warehouse also holds two months of the limited-risk distributors' demand.
    const opening = (hub, factor, month, units) => {
      const material = product.material * costScale * factor
      const vintage = '2026-' + String(month).padStart(2, '0')
      const origin = plannedOrigin(family, hub)
      if (hubMakes(hub, family)) {
        const group = baseGroupCost(product, HUB_PLANT[hub]) * costScale * factor
        const local = madeUnitCost(hub, product, history) * costScale * factor
        return makeLot(units, local, group, material, vintage, origin, hub === 'US' ? 'made' : 'converted')
      }
      const seller = otherHub(hub)
      const price = crossSupplyPrice(seller, family, history) * costScale * factor
      const duty = price * importDutyRate(config, seller, hub, family, origin)
      const group = baseGroupCost(product, HUB_PLANT[seller]) * costScale * factor + duty
      return makeLot(units, price + duty, group, material, vintage, origin, 'bought', { unitDuty: duty, declared: origin })
    }
    for (const hub of HUBS) {
      // One lot for each month of stock, the older ones bought or made a little cheaper.
      const own = sum(hubMarkets(hub).map(id => product.demand[id]))
      const lrd = hub === 'CH' ? sum([...LRD].map(id => product.demand[id])) : 0
      const lrdMonths = hub === 'CH' ? PRINCIPAL_LRD_STOCK_MONTHS : 0
      const months = Math.max(bufferMonths(hub, family), lrdMonths)
      // `age` is 0 for December, 1 for November and so on.
      const units = age => (age < bufferMonths(hub, family) ? own : 0) + (age < lrdMonths ? lrd : 0)
      stock.bin(hub, hub === 'CH' ? 'BE' : 'US', family).lots = [0.96, 0.98, 0.99, 1].slice(-months).map((factor, index) =>
        opening(hub, factor, 12 - months + 1 + index, units(months - 1 - index)))
    }
    // Poland holds materials and work in process only for the lines it converts.
    if (!makes('PL', family)) continue
    for (const [stage, months] of [['raw', 0.35], ['wip', 0.15]]) {
      const bin = stock.bin('CH', 'PL', family, stage)
      const material = product.material * costScale
      bin.lots = [makeLot(Math.round(normalUnits('PL', family) * months), material, material, material, '2026-12', 'EU', 'materials')]
    }
  }
  return stock
}

// The units a plant makes of a product line in a normal month: the base demand of the markets it supplies.
function normalUnits(plant, family) {
  return sum(HUBS.filter(hub => plantFor(family, hub) === plant).flatMap(hub => hubMarkets(hub)).map(id => PRODUCTS[family].demand[id]))
}

class Ledger {
  constructor(month) {
    this.month = month
    this.journal = []
    this.transactions = []
    // Customs duty charged on this month's imports, and on a year-end adjustment.
    this.duties = []
    this.dutyAdjustments = {}
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
    this.transactions.push({
      id, from, to, category, policy, product, quantity, amount, basis, external,
      ...(buyerAccount ? { account: buyerAccount } : {}), ...(origins ? { origins } : {}),
    })
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

// Months of its markets' base demand that each hub aims to hold in finished stock of a
// line its own plant makes. A line bought from the other hub is held for one month.
const HUB_BUFFER_MONTHS = { US: 1, CH: 4 }
const bufferMonths = (hub, family) => hubMakes(hub, family) ? HUB_BUFFER_MONTHS[hub] : 1
// The Swiss warehouse also holds the limited-risk distributors' stock.
const hubBuffer = (hub, family) => bufferMonths(hub, family) * sum(hubMarkets(hub).map(id => PRODUCTS[family].demand[id]))
  + (hub === 'CH' ? PRINCIPAL_LRD_STOCK_MONTHS * sum([...LRD].map(id => PRODUCTS[family].demand[id])) : 0)

// What each plant makes in the month and what the hubs ship to each other, by product line.
// A plant cannot make more of a line than its capacity for that line. A line made in one
// plant is ordered from that plant's hub by the other hub. For a line both plants make,
// each plant supplies its own hub, and where one is at its limit the other makes the
// shortfall as far as its own capacity allows and its hub ships it across.
function monthPlan(stock, month, shocks, config) {
  const seasonal = SEASONAL[month - 1]
  return Object.fromEntries(FAMILIES.map(family => {
    const product = PRODUCTS[family]
    const demand = Object.fromEntries(MARKETS.map(id => [
      id, Math.round(product.demand[id] * seasonal * (1 + marketShock(shocks, id, 'demand'))),
    ]))
    const us = stock.bin('US', 'US', family)
    const warehouse = stock.bin('CH', 'BE', family)
    const bins = { US: us, CH: warehouse }
    const orders = Object.fromEntries(DISTRIBUTORS.map(id => [
      id, Math.max(0, demand[id] + stockMonths(id) * product.demand[id] - unitsOf(stock.bin(id, id, family).lots)),
    ]))
    // What each hub's markets want from it this month, and what it needs to receive to
    // serve them and end the month on its usual stock.
    const wanted = Object.fromEntries(HUBS.map(hub => [
      hub, demand[hub] + sum(DISTRIBUTORS.filter(id => sourceOf(id) === hub).map(id => orders[id])),
    ]))
    const need = Object.fromEntries(HUBS.map(hub => [hub, Math.max(0, wanted[hub] + hubBuffer(hub, family) - unitsOf(bins[hub].lots))]))
    const limit = plant => makes(plant, family) ? config.capacity[plant][family] : 0
    const build = { US: 0, PL: 0 }
    // Units one hub asks the other for, keyed by the hub that ships them.
    const cross = { US: 0, CH: 0 }
    if (PRODUCT_PLANTS[family].length === 1) {
      const maker = HUBS.find(hub => hubMakes(hub, family))
      cross[maker] = need[otherHub(maker)]
      build[HUB_PLANT[maker]] = Math.min(need.US + need.CH, limit(HUB_PLANT[maker]))
    } else {
      const own = Object.fromEntries(HUBS.map(hub => [hub, Math.min(need[hub], limit(HUB_PLANT[hub]))]))
      // What a hub's markets want this month beyond its stock and what its own plant can make.
      const short = Object.fromEntries(HUBS.map(hub => [hub, Math.max(0, wanted[hub] - unitsOf(bins[hub].lots) - own[hub])]))
      for (const hub of HUBS) build[HUB_PLANT[hub]] = own[hub]
      for (const hub of HUBS) {
        const helper = otherHub(hub)
        // The other plant makes the shortfall as far as its spare capacity goes.
        const extra = Math.max(0, Math.min(need[hub] - own[hub], limit(HUB_PLANT[helper]) - own[helper]))
        build[HUB_PLANT[helper]] += extra
        // Beyond that, the other hub covers from its stock what would otherwise be a lost sale, unless it is short itself.
        cross[helper] = Math.max(extra, short[helper] ? 0 : short[hub])
      }
    }
    return [family, { demand, us, warehouse, orders, wanted, usToSwiss: cross.US, swissToUs: cross.CH, usBuild: build.US, plBuild: build.PL }]
  }))
}

function produceInUs(stock, book, family, plan, usUnits, shocks, vintage, costScale) {
  if (!usUnits) return
  const product = PRODUCTS[family]
  const material = product.material * costScale * (1 + shocks.materialCost)
  const cost = material + product.usConversion * costScale
  stock.receive(plan.us, [makeLot(usUnits, cost, cost, material, vintage, 'US', 'made')])
  book.post('US', 'inventory', 'externalClearing', usUnits * cost)
}

// Poland's conversion cost at normal volume: the base monthly demand for the lines it
// makes, in the markets it supplies, at standard conversion cost. A fixed share of it is overhead that does not move with output.
function polandOverhead(config, costScale) {
  const normal = sum(FAMILIES.map(family => normalUnits('PL', family) * PRODUCTS[family].plConversion))
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
    stock.receive(raw, [makeLot(units, material, material, material, vintage, 'EU', 'materials')])
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
      // The lot in conversion still carries the month its materials were bought.
      'converted', { materials: lot.vintage },
    )))
  })
  return result
}

function deliver(stock, book, config, { lots, from, to, target, family, policy, priceLot, vintage }) {
  const quantity = unitsOf(lots)
  if (!quantity) return
  // The invoice value by where the goods were made. Customs duty depends on it.
  const origins = {}
  let invoiced = 0
  let dutyPaid = 0
  const received = lots.map((lot) => {
    const price = priceLot(lot)
    const value = lot.quantity * price
    const rate = importDutyRate(config, from, to, family, lot.origin)
    const importer = customsBlock(to)
    origins[lot.origin] = (origins[lot.origin] ?? 0) + value
    invoiced += value
    // Every import is declared, whether or not its rate is zero.
    if (importer !== customsBlock(from) && importer !== lot.origin) {
      book.duties.push({ importer, origin: lot.origin, product: family, value, rate, duty: rate * value })
      dutyPaid += rate * value
    }
    // The importer pays the duty on top of the price. It is part of what the goods cost,
    // for the importer and for the group, and reaches cost of sales when they are sold.
    return makeLot(
      lot.quantity, price * (1 + rate), lot.unitGroupCost + price * rate, lot.unitMaterialCost, vintage, lot.origin,
      'bought', { unitDuty: price * rate, declared: importer !== customsBlock(from) ? lot.origin : null },
    )
  })
  stock.receive(target, received)
  book.transfer({
    from, to, category: 'goods', policy, product: family, quantity,
    amount: invoiced, basis: valueOf(lots, 'unitValue'), buyerAccount: 'inventory', origins,
  })
  book.post(to, 'inventory', 'externalClearing', dutyPaid)
  book.post(from, 'cogs', 'inventory', valueOf(lots, 'unitValue'))
}

// Each hub shares the stock it holds between its own customers, its distributors and
// what the other hub cannot cover from its own stock, in proportion to what each wanted
// when there is not enough. Only then does it rebuild the other hub's stock, and it
// sends just enough to leave both hubs holding the same share of their usual stock. A
// shortage therefore runs the stock down at both hubs before a sale is lost. The hub
// that ships across goes first, so the other can pass the goods on in the same month.
function moveGoods(stock, book, plans, vintage, priceTable, config) {
  for (const family of FAMILIES) {
    const plan = plans[family]
    const fixedPrice = (from, to) => priceTable[goodsRouteKey(from, to)][family]
    const bins = { US: plan.us, CH: plan.warehouse }
    const asked = { US: plan.usToSwiss, CH: plan.swissToUs }
    plan.demandAllocation = {}
    for (const supplier of [...HUBS].sort((left, right) => asked[right] - asked[left])) {
      const source = bins[supplier]
      const receiver = otherHub(supplier)
      const markets = DISTRIBUTORS.filter(id => sourceOf(id) === supplier)
      const requested = markets.map(id => plan.orders[id])
      const urgent = Math.min(asked[supplier], Math.max(0, plan.wanted[receiver] - unitsOf(bins[receiver].lots)))
      const allocations = allocate([plan.demand[supplier], ...requested, urgent], unitsOf(source.lots))
      plan.demandAllocation[supplier] = allocations[0]
      const left = unitsOf(source.lots) - sum(allocations)
      // What the other hub will hold once it has served its markets, before any restocking.
      const held = Math.max(0, unitsOf(bins[receiver].lots) + allocations.at(-1) - plan.wanted[receiver])
      const [own, other] = [hubBuffer(supplier, family), hubBuffer(receiver, family)]
      const fair = Math.round((left + held) * other / (own + other)) - held
      const restock = Math.max(0, Math.min(asked[supplier] - urgent, left, fair))
      deliver(stock, book, config, {
        lots: stock.issue(source, allocations.at(-1) + restock), from: supplier, to: receiver, target: bins[receiver], family,
        policy: supplier === 'US' ? 'US_TO_CH' : 'CH_TO_US', priceLot: () => fixedPrice(supplier, receiver), vintage,
      })
      markets.forEach((market, index) => deliver(stock, book, config, {
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
      sales.push({ seller, customer, channel, product: family, demand, quantity, price, revenue, localCogs, groupCogs, materialCogs, unfilled: demand - quantity })
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
    // An upward adjustment into another customs block raises the declared value of the
    // year's imports. The distributor pays duty on the increase. A credit earns no refund.
    const dutyRate = service ? 0 : yearDutyRate(id, priorMonths, book)
    const dutyOn = amount => dutyRate * Math.max(0, amount)
    // For a distributor: profit above what the level allows, paid to its supplier, less
    // the duty the payment itself attracts. For a service provider: the fee still owed
    // to reach the level, paid by its customers.
    const needed = (level) => {
      const gap = before.profit - level * before.base
      return roundCurrency(service ? -gap : gap > 0 ? gap / (1 + dutyRate) : gap)
    }
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
      if (customsBlock(id) !== customsBlock(sourceOf(id))) {
        book.dutyAdjustments[customsBlock(id)] = { amount, rate: dutyRate, duty: dutyOn(amount) }
        book.post(id, 'cogs', 'externalClearing', dutyOn(amount))
      }
    }
    const duty = service ? 0 : dutyOn(amount)
    const after = margin(before.profit + (service ? amount : -amount - duty), before.base)
    return {
      id, service, counterparty: service ? Object.keys(serviceCustomers(id)) : [sourceOf(id)], mode, amount, toTarget, toRange, ...range,
      floorLimited: { target: toTarget !== wanted.target, range: toRange !== wanted.range },
      revenue: before.revenue, statRate: statRates?.[id] ?? 0, statAdjustment,
      gaapBefore: gaap.indicator, marginBefore: before.indicator, statusBefore,
      duty, dutyRate, dutyToTarget: dutyOn(toTarget), dutyToRange: dutyOn(toRange),
      gaapAfter: margin(gaap.profit + (service ? amount : -amount - duty), gaap.base),
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
// The United States is taxed under its federal rules, with FDDEI, NCTI and BEAT, plus
// state tax. Its `rate` is the effective rate on its operating profit.
function taxFor(config, months, stat = null) {
  const byEntity = Object.fromEntries(TAXED_ENTITIES.map(id => {
    const profit = stat?.[id]?.operatingProfit ?? sum(months.map(month => month.entities[id].operatingProfit))
    if (id === 'US') {
      const detail = usIncomeTax(config, months, stat)
      return [id, { rate: profit ? detail.total / profit : 0, profit, tax: detail.total, detail }]
    }
    const rate = taxRate(config, id)
    return [id, { rate, profit, tax: rate * profit }]
  }))
  const total = sum(Object.values(byEntity).map(entity => entity.tax))
  const profit = sum(Object.values(byEntity).map(entity => entity.profit))
  return { entities: byEntity, total, profit, effectiveRate: profit ? total / profit : 0 }
}

// The foreign subsidiaries, all treated as controlled foreign corporations wholly owned by the US parent.
const CFCS = ALL_COMPANIES.filter(id => id !== 'US')

/**
 * The US parent's income tax for a set of closed periods, computed as if they were its
 * tax year: federal tax at 21% with the section 250 deductions for FDDEI and NCTI, the
 * deemed-paid credit on NCTI and the BEAT, plus state tax at the rest of its rate.
 * `stat` holds the year's local statutory results once the year is closed: the CFCs'
 * foreign taxes follow them. Taxable income starts from US GAAP operating profit less the
 * interest on the US parent's bonds, with no NOLs and no credits other than the NCTI credit.
 * The interest is well inside the section 163(j) limit of 30% of adjusted taxable income.
 */
export function usIncomeTax(config, months, stat = null) {
  const rules = US_TAX_RULES
  const add = pick => sum(months.map(pick))
  const us = rollupPnl(months.map(month => month.entities.US))
  const lines = months.flatMap(month => month.transactions)
  const find = (policy, from, to) => lines.filter(line => line.policy === policy && line.from === from && line.to === to)
  const total = (list, key = 'amount') => sum(list.map(line => line[key] ?? 0))

  // Interest on the bonds for the months covered, deductible for state and federal tax.
  const monthsCovered = sum(months.map(month => month.months?.length ?? 1))
  const interest = bondInterest(monthsCovered)
  // State tax, on US operating profit less the interest. It is deductible for federal purposes.
  const stateRate = Math.max(0, taxRate(config, 'US') - rules.federalRate)
  const state = stateRate * Math.max(0, us.operatingProfit - interest)

  // Gross receipts by kind. Sales to Canada and Switzerland are resold to unrelated
  // customers abroad, the royalty is for foreign use of the IP, and the headquarters
  // services are for Switzerland: all are foreign-derived.
  const domesticSales = months.flatMap(month => month.sales.filter(sale => sale.seller === 'US'))
  const domestic = { receipts: sum(domesticSales.map(sale => sale.revenue)), cogs: sum(domesticSales.map(sale => sale.localCogs)) }
  const goodsAbroad = [...find('FFD_GOODS', 'US', 'CA'), ...find('US_TO_CH', 'US', 'CH')]
  const adjustment = total(find('YEAR_END_ADJUSTMENT', 'US', 'CA'))
  const goods = { receipts: total(goodsAbroad) + adjustment, cogs: total(goodsAbroad, 'basis') }
  const royalty = total(find('CH_ROYALTY', 'CH', 'US'))
  const headquarters = find('US_SERVICES', 'US', 'CH')
  const services = { receipts: total(headquarters), cost: total(headquarters, 'basis') }
  const foreignReceipts = goods.receipts + royalty + services.receipts
  const receipts = domestic.receipts + foreignReceipts
  // Anything not traced to a kind of receipt stays with domestic income.
  const otherReceipts = us.revenue - receipts
  const otherCogs = us.cogs - domestic.cogs - goods.cogs

  // FDDEI: foreign-derived gross income less the deductions properly allocable to it,
  // other than interest and R&E, which are not allocated to it. Headquarters services cost is allocated to the fee it
  // earns. Other operating expenses and state tax are apportioned on gross receipts.
  const apportioned = us.otherOperatingExpenses - services.cost + state
  const foreignShare = receipts + otherReceipts > 0 ? foreignReceipts / (receipts + otherReceipts) : 0
  const foreignIncome = goods.receipts - goods.cogs + royalty + services.receipts - services.cost
  const fddei = foreignIncome - foreignShare * apportioned
  // Deduction eligible income: all of the US parent's income, on the same rules.
  const dei = us.revenue - us.cogs - us.otherOperatingExpenses - state
  const fddeiBase = dei > 0 ? Math.max(0, Math.min(fddei, dei)) : 0

  // NCTI: each CFC's tested income is its profit less its foreign income tax, which
  // follows its local statutory profit once the year is closed. Tested losses offset
  // tested income. No QBAI return is deducted.
  const cfcs = CFCS.map(id => {
    const profit = add(month => month.entities[id].operatingProfit)
    const local = stat?.[id]?.operatingProfit ?? profit
    const foreignTax = Math.max(0, taxRate(config, id) * local)
    return { id, profit, foreignTax, tested: profit - foreignTax }
  })
  const testedIncome = sum(cfcs.filter(cfc => cfc.tested > 0).map(cfc => cfc.tested))
  const testedLoss = sum(cfcs.filter(cfc => cfc.tested < 0).map(cfc => cfc.tested))
  const ncti = Math.max(0, testedIncome + testedLoss)
  const inclusion = testedIncome > 0 ? ncti / testedIncome : 0
  const testedTaxes = sum(cfcs.filter(cfc => cfc.tested > 0).map(cfc => cfc.foreignTax))
  const grossUp = inclusion * testedTaxes
  const deemedPaid = rules.nctiCreditShare * inclusion * testedTaxes

  // Section 250, limited to taxable income: where FDDEI and NCTI with its gross-up exceed
  // taxable income before the deduction, both are cut back in proportion.
  const beforeDeduction = us.operatingProfit - interest - state + ncti + grossUp
  const claimed = fddeiBase + ncti + grossUp
  const limitShare = claimed > 0 ? Math.min(1, Math.max(0, beforeDeduction) / claimed) : 1
  const fddeiAllowed = fddeiBase * limitShare
  const nctiAllowed = (ncti + grossUp) * limitShare
  const fddeiDeduction = rules.fddeiDeduction * fddeiAllowed
  const nctiDeduction = rules.nctiDeduction * nctiAllowed
  const taxableIncome = beforeDeduction - fddeiDeduction - nctiDeduction
  const taxBeforeCredits = rules.federalRate * Math.max(0, taxableIncome)

  // The NCTI credit is limited to the US tax on the NCTI basket. Only the section 250
  // deduction is allocated to it, so the basket holds NCTI with its gross-up less that
  // deduction. Credits above the limit are lost.
  const basketIncome = ncti + grossUp - nctiDeduction
  const creditLimit = taxableIncome > 0 ? taxBeforeCredits * Math.min(1, Math.max(0, basketIncome) / taxableIncome) : 0
  const credit = Math.min(deemedPaid, creditLimit)
  const regularTax = taxBeforeCredits - credit

  // BEAT. Deductible payments to foreign related parties are base erosion payments: the
  // R&D services from Germany and Poland in full, since R&D cannot use the services cost
  // method, and the markup on India's fee, whose cost is excepted under that method.
  // Goods bought from Switzerland enter cost of goods sold and are not deductions.
  const research = total(lines.filter(line => line.policy === 'RD_SERVICES' && line.to === 'US'))
  const india = lines.filter(line => line.policy === 'IN_SERVICES' && line.to === 'US')
  const indiaCost = total(india, 'basis')
  const indiaMarkup = Math.max(0, total(india) - indiaCost + total(find('SERVICE_TRUE_UP', 'IN', 'US')))
  const baseErosionBenefits = research + indiaMarkup
  // The base erosion percentage compares them with all deductions, leaving out cost of
  // goods sold, the section 250 deduction and the excepted service cost. Interest paid to
  // the outside bondholders is a deduction but not a base erosion payment.
  const deductions = us.otherOperatingExpenses + us.rdExpense + interest + state - indiaCost
  const baseErosionPercentage = deductions > 0 ? baseErosionBenefits / deductions : 0
  // The test averages three prior years. The model has one, so it takes this one, scaled to a full year.
  const grossReceipts = monthsCovered ? us.revenue * 12 / monthsCovered : 0
  const grossReceiptsMet = grossReceipts >= rules.beatGrossReceipts
  const beatApplies = grossReceiptsMet && baseErosionPercentage >= rules.beatThreshold
  const modifiedTaxableIncome = taxableIncome + baseErosionBenefits
  const minimumTax = rules.beatRate * Math.max(0, modifiedTaxableIncome)
  const beat = beatApplies ? Math.max(0, minimumTax - regularTax) : 0

  return {
    operatingProfit: us.operatingProfit, interest, stateRate, state,
    fddei: {
      goods: goods.receipts, adjustment, royalty, services: services.receipts, foreignReceipts, receipts: receipts + otherReceipts,
      foreignShare, goodsCogs: goods.cogs, servicesCost: services.cost, apportioned, apportionedToForeign: foreignShare * apportioned,
      research: us.rdExpense, income: fddei, dei, base: fddeiBase, allowed: fddeiAllowed, deduction: fddeiDeduction,
      domestic: domestic.receipts + otherReceipts, domesticCogs: domestic.cogs + otherCogs,
    },
    ncti: {
      cfcs, testedIncome, testedLoss, amount: ncti, inclusion, testedTaxes, grossUp, allowed: nctiAllowed, deduction: nctiDeduction,
      basketIncome, taxBeforeCredit: taxableIncome > 0 ? taxBeforeCredits * Math.min(1, Math.max(0, basketIncome) / taxableIncome) : 0,
      deemedPaid, credit, excessCredit: deemedPaid - credit, residual: Math.max(0, creditLimit - credit),
    },
    limitShare, beforeDeduction, taxableIncome, taxBeforeCredits, credit, regularTax,
    beat: {
      research, indiaFee: total(india), indiaCost, indiaMarkup, benefits: baseErosionBenefits, deductions,
      percentage: baseErosionPercentage, grossReceipts, grossReceiptsMet, applies: beatApplies, modifiedTaxableIncome, minimumTax, amount: beat,
    },
    federal: regularTax + beat,
    total: regularTax + beat + state,
  }
}

// The rates behind the entity report, for the Parameters sheet of the Excel export.
export function reportParameters(config) {
  return {
    taxRates: Object.fromEntries(TAXED_ENTITIES.map(id => [id, taxRate(config, id)])),
    royaltyRate: config.policies.royaltyRate,
    rdMarkup: RD_MARKUP,
    usServicesMarkup: config.policies.usServicesMarkup,
    belgiumMargin: config.policies.belgiumMargin,
    indiaShares: { ...INDIA_CUSTOMERS },
    dutyRates: dutyRates((key, family) => dutyRate(config, key, family)),
    customsBlocks: Object.fromEntries(ALL_COMPANIES.map(id => [id, customsBlock(id)])),
  }
}

const emptyLanes = config => Object.fromEntries(CUSTOMS_LANES.map(({ key, importer, origin }) => [key, {
  importer, origin, value: 0, duty: 0,
  products: Object.fromEntries(FAMILIES.map(family => [family, { rate: dutyRate(config, key, family), value: 0, duty: 0 }])),
}]))

// Duty is charged on the declared transfer price each time goods enter a customs block
// from another one. The rate depends on the importing block, the product line and where
// the goods were made. The importer adds it to the cost of the goods, so it reaches cost
// of sales when they are sold. This is the duty charged in the month, by lane.
function customsFor(config, book) {
  const lanes = emptyLanes(config)
  for (const { importer, origin, product, value, duty } of book.duties) {
    const lane = lanes[importer + '.' + origin]
    lane.products[product].value += value
    lane.products[product].duty += duty
    lane.value += value
    lane.duty += duty
  }
  const adjustments = book.dutyAdjustments
  const adjustmentDuty = sum(Object.values(adjustments).map(entry => entry.duty))
  return { lanes, adjustments, adjustmentDuty, total: sum(Object.values(lanes).map(lane => lane.duty)) + adjustmentDuty }
}

// The average duty rate on everything a distributor imported this year. A year-end
// adjustment changes what was paid for all of it, so it takes this rate.
function yearDutyRate(id, priorMonths, book) {
  const importer = customsBlock(id)
  if (importer === customsBlock(sourceOf(id))) return 0
  const imports = [
    ...priorMonths.flatMap(month => Object.values(month.customs.lanes)).filter(lane => lane.importer === importer),
    ...book.duties.filter(entry => entry.importer === importer),
  ]
  const value = sum(imports.map(entry => entry.value))
  return value ? sum(imports.map(entry => entry.duty)) / value : 0
}

/**
 * Third-party sales and group cost of sales by product line for a closed month. `unfilled`
 * is the demand that could not be supplied, and `lostSales` is what it would have sold for.
 */
export function productLineResults(month) {
  return FAMILIES.map(family => {
    const sales = month.sales.filter(sale => sale.product === family)
    const revenue = sum(sales.map(sale => sale.revenue))
    const cogs = sum(sales.map(sale => sale.groupCogs))
    return {
      product: family, units: sum(sales.map(sale => sale.quantity)), revenue, cogs, grossProfit: revenue - cogs, grossMargin: margin(revenue - cogs, revenue),
      unfilled: sum(sales.map(sale => sale.unfilled)), lostSales: sum(sales.map(sale => sale.unfilled * sale.price)),
    }
  })
}

/** Demand that could not be supplied in a closed month, by seller and product line. */
export function unfilledDemand(month) {
  return month.sales.filter(sale => sale.unfilled > 0)
    .map(({ seller, product, unfilled, price }) => ({ seller, product, units: unfilled, lostSales: unfilled * price }))
}

/** Total income tax and customs duty for a set of closed months. */
export function summarizeTaxAndCustoms(config, months) {
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
    tax: taxFor(config, months, stat),
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
  // Duty on a year-end adjustment is paid to customs and expensed at once. Every other
  // cost of sales reaches the group through the goods sold.
  const consolidated = pnl(sum(sales.map(sale => sale.revenue)), sum(sales.map(sale => sale.groupCogs)) + externalExpenses('cogs'),
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
  const plans = monthPlan(stock, month, shocks, config)
  const usUnits = FAMILIES.map(family => plans[family].usBuild)
  const plUnits = FAMILIES.map(family => plans[family].plBuild)
  // `limits` holds the month's capacity for each line the plant makes. `limit` is their total.
  const capacity = Object.fromEntries([['US', usUnits], ['PL', plUnits]].map(([id, units]) => [id, {
    limit: sum(Object.values(config.capacity[id])), used: sum(units), limits: { ...config.capacity[id] },
    byProduct: Object.fromEntries(FAMILIES.map((family, index) => [family, units[index]])),
  }]))
  FAMILIES.forEach((family, index) => produceInUs(stock, book, family, plans[family], usUnits[index], shocks, vintage, costScale))
  const poland = tollInPoland(stock, book, plans, plUnits, shocks, config, vintage, costScale, fees?.PL)
  moveGoods(stock, book, plans, vintage, priceTable, config)
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
  const closed = {
    month, shocks, entities, sales, capacity, royaltyBase, costScale, ...financials, services: { PL: poland, IN: india },
    customs: customsFor(config, book), ...(yearEnd ? { yearEnd, stat } : {}),
    transactions: book.transactions, journal: book.journal,
  }
  closed.tax = taxFor(config, [closed])
  return closed
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
    const primaryPlant = plantFor(sale.product, hubOf(sale.seller))
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

/** The months in a quarter. Results are reported by quarter and closed by month underneath. */
export const QUARTER_MONTHS = 3

// One reporting period made from consecutive closed months, in the shape of a closed month.
// Flows are added up. Stock runs from the first month's opening to the last month's closing.
function combineMonths(config, months, quarter) {
  const [first, last] = [months[0], months.at(-1)]
  const add = pick => sum(months.map(pick))
  const transactions = new Map()
  for (const transaction of months.flatMap(month => month.transactions)) {
    const { policy, from, to, category, product, external, account } = transaction
    const key = [policy, from, to, category, product ?? '', external, account ?? ''].join('|')
    const line = transactions.get(key)
    if (!line) {
      transactions.set(key, { ...transaction, ...(transaction.origins ? { origins: { ...transaction.origins } } : {}) })
      continue
    }
    line.quantity += transaction.quantity
    line.amount += transaction.amount
    if (typeof transaction.basis === 'number') line.basis = (line.basis ?? 0) + transaction.basis
    for (const [origin, value] of Object.entries(transaction.origins ?? {})) {
      line.origins ??= {}
      line.origins[origin] = (line.origins[origin] ?? 0) + value
    }
  }
  const { tax, customs } = summarizeTaxAndCustoms(config, months)
  return {
    quarter, months: months.map(month => month.month), month: last.month, costScale: first.costScale,
    entities: Object.fromEntries(Object.keys(first.entities).map(id => {
      const results = months.map(month => month.entities[id])
      return [id, { ...rollupPnl(results), externalRevenue: sum(results.map(entity => entity.externalRevenue)), intercompanyRevenue: sum(results.map(entity => entity.intercompanyRevenue)) }]
    })),
    consolidated: rollupPnl(months.map(month => month.consolidated)),
    sales: months.flatMap(month => month.sales),
    capacity: Object.fromEntries(Object.keys(first.capacity).map(id => [id, {
      limit: add(month => month.capacity[id].limit), used: add(month => month.capacity[id].used),
      limits: Object.fromEntries(Object.keys(first.capacity[id].limits).map(family => [family, add(month => month.capacity[id].limits[family])])),
      byProduct: Object.fromEntries(FAMILIES.map(family => [family, add(month => month.capacity[id].byProduct[family])])),
    }])),
    royaltyBase: add(month => month.royaltyBase),
    services: Object.fromEntries(Object.keys(first.services).map(id => [id, Object.fromEntries(
      Object.keys(first.services[id]).map(key => [key, add(month => month.services[id][key])]),
    )])),
    inventory: first.inventory.map((bin, index) => ({
      ...bin, opening: bin.opening, closing: last.inventory[index].closing,
      receipts: months.flatMap(month => month.inventory[index].receipts), issues: months.flatMap(month => month.inventory[index].issues),
    })),
    // The largest control difference in any of the months. Each is zero to the cent.
    reconciliation: Object.fromEntries(Object.keys(first.reconciliation).map(key => [
      key, months.map(month => month.reconciliation[key]).reduce((worst, value) => Math.abs(value) > Math.abs(worst) ? value : worst, 0),
    ])),
    tax, customs, transactions: [...transactions.values()],
    // Year-end adjustments and local statutory results belong to the last close of the year.
    ...(last.yearEnd ? { yearEnd: last.yearEnd, stat: last.stat } : {}),
  }
}

/**
 * The year by quarter. Each quarter has the shape of a closed month, so anything that
 * reads a month reads a quarter the same way. `variance` adds up the monthly bridges.
 */
export function quarterly(config, { budget, actual, variance }) {
  validateConfig(config)
  const quarters = months => Array.from({ length: Math.floor(months.length / QUARTER_MONTHS) }, (_, quarter) =>
    combineMonths(config, months.slice(quarter * QUARTER_MONTHS, (quarter + 1) * QUARTER_MONTHS), quarter + 1))
  const result = { budget: quarters(budget), actual: quarters(actual) }
  return {
    ...result,
    variance: result.actual.map((quarter, index) => {
      const bridges = variance.slice(index * QUARTER_MONTHS, (index + 1) * QUARTER_MONTHS)
      const total = Object.fromEntries(Object.keys(bridges[0]).filter(key => key !== 'month' && key !== 'operatingMargin')
        .map(key => [key, sum(bridges.map(bridge => bridge[key]))]))
      return { quarter: index + 1, ...total, operatingMargin: quarter.consolidated.operatingMargin - result.budget[index].consolidated.operatingMargin }
    }),
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
  const stock = seedOpeningStock(costScale, config)
  return Array.from({ length: months }, (_, index) => closeMonth(stock, config, index + 1, ZERO_SHOCK, prices, costScale, fees))
}

const consolidatedMargin = (months) => {
  const { revenue, operatingProfit } = rollupPnl(months.map(month => month.consolidated))
  return operatingProfit / revenue
}

function scenarioBudget(config, months = 0) {
  const { policies, annualOperatingMargin: target, startingPriceMethod } = config
  const provisional = standardGoodsPrices(config, 1)
  const openingPriceMethod = startingPriceMethod ?? 'legacy'
  const calibrateDistributorPrices = openingPriceMethod === 'fifo-policy'
  // The reference year runs at unscaled cost with services at cost plus. It gives the
  // budgeted service costs that the fixed monthly fees are set from, and the forecast
  // the distributors' starting prices are set against.
  const reference = budgetAtCost(config, 12, 1, provisional)
  const referenceCost = id => sum(reference.map(month => month.services[id].cost)) / 12
  // Everything that follows from a level of unit cost: fees, floors, starting prices and the budget year.
  const plan = (costScale) => {
    const budgetServiceCost = { PL: referenceCost('PL') * costScale, IN: referenceCost('IN') }
    const initialFees = {
      PL: roundCurrency(budgetServiceCost.PL * (1 + policies.polandMarkup)),
      IN: roundCurrency(budgetServiceCost.IN * (1 + policies.indiaServicesMarkup)),
    }
    const costs = standardCosts(config, costScale)
    const floors = priceFloors(config, costs)
    let initial = costScale === 1 ? { ...provisional } : standardGoodsPrices(config, costScale)
    const openingNotes = {}
    // The policy prices a floor replaces, and whether it puts a distributor's target out of reach.
    const unfloored = {}
    const openingShort = {}
    if (calibrateDistributorPrices) {
      for (const route of GOODS_ROUTES.filter(route => !route.markup)) {
        const { key, to } = route
        const margin = policies[LRD.has(to) ? 'lrdMargin' : 'ffdMargin']
        const planned = testedPnl(rollupPnl(reference.map(month => month.entities[to])))
        const quote = (floor) => distributorQuote(config, route, reference, planned, 1, provisional[key], provisional[key], margin, floor)
        const { recommended, note, short } = quote(floors?.[key])
        initial[key] = Object.fromEntries(FAMILIES.map(family => [family, recommended?.[family] ?? provisional[key][family]]))
        if (note) openingNotes[key] = note
        if (floors) {
          unfloored[key] = quote(null).recommended ?? null
          openingShort[key] = Boolean(short)
        }
      }
    }
    initial = atLeastFloor(initial, floors)
    const year = budgetAtCost(config, 12, costScale, initial, initialFees)
    return {
      costScale, initial, openingNotes, unfloored, openingShort, costs, floors, initialFees, budgetServiceCost, year,
      gap: consolidatedMargin(year) - target,
    }
  }

  // Unit costs are scaled until the budget year earns the target margin. Customs duty
  // is charged on transfer prices and does not all move with unit cost, so the scale is
  // found by trial: the margin falls in a straight line as costs rise, unless a price floor bends it.
  let chosen = plan(1)
  if (target !== undefined && Math.abs(chosen.gap) >= 1e-12) {
    let previous = chosen
    const { revenue, cogs, operatingExpenses } = rollupPnl(chosen.year.map(month => month.consolidated))
    let scale = Math.max(0, revenue * (1 - target) - operatingExpenses) / cogs
    if (Math.abs(scale - 1) < 1e-6) scale = 0.9
    for (let attempt = 0; attempt < 20; attempt++) {
      chosen = plan(scale)
      if (Math.abs(chosen.gap) < 1e-12) break
      const slope = (chosen.gap - previous.gap) / (chosen.costScale - previous.costScale)
      const next = chosen.costScale - chosen.gap / slope
      if (!(next > 0)) {
        // Even free goods would not reach the target: other costs alone take the margin below it.
        const atZeroCost = chosen.gap - slope * chosen.costScale + target
        if (atZeroCost < target - 1e-10) {
          throw new RangeError(`The target would require negative COGS. With these settings the maximum consolidated margin is ${(Math.floor(10_000 * atZeroCost) / 100).toFixed(2)}%.`)
        }
        chosen = plan(0)
        break
      }
      previous = chosen
      scale = next
    }
  }
  const { year, gap, ...rest } = chosen
  return { ...rest, openingPriceMethod, budget: year.slice(0, months) }
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
    // The US parent's tax follows its federal rules, not a flat rate.
    const row = {
      id, ytd, fullYear: annual, stat: stat?.[id] ?? null,
      tax: id === 'US'
        ? { rate, ytd: actual.length ? usIncomeTax(config, actual).total : 0, fullYear: usIncomeTax(config, fullYear, stat).total }
        : { rate, ytd: rate * ytd.operatingProfit, fullYear: rate * taxable },
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
  const note = !invoices.length ? 'No shipments are forecast for this route through the end of the year.' : floorNote(held)
  return { recommended, note, held }
}

function floorNote(held, short = false) {
  if (!held.length) return ''
  const names = held.map(family => PRODUCTS[family].name).join(', ')
  return short
    ? `Every product is at the price floor, so the full-year target is out of reach. Held at the floor: ${names}.`
    : `Held at the price floor: ${names}.`
}

function distributorQuote(config, route, forecast, fullYear, startMonth, current, standard, target, floor = null) {
  const vintage = '2027-' + String(startMonth).padStart(2, '0')
  const positions = forecast.flatMap(month => month.inventory.filter(bin => bin.owner === route.to))
  // Only issues from future receipts can change this year's cost of goods sold.
  const adjustableUnits = Object.fromEntries(FAMILIES.map(family => [family, 0]))
  // Each of those units costs the distributor its price plus any import duty on it.
  // `landed` is that cost per dollar of price, averaged over where the units were made.
  const landedUnits = Object.fromEntries(FAMILIES.map(family => [family, 0]))
  for (const bin of positions) {
    for (const lot of bin.issues.filter(issue => issue.vintage >= vintage)) {
      adjustableUnits[bin.product] += lot.quantity
      landedUnits[bin.product] += lot.quantity * (1 + importDutyRate(config, route.from, route.to, bin.product, lot.origin))
    }
  }
  const landed = Object.fromEntries(FAMILIES.map(family => [family, adjustableUnits[family] ? landedUnits[family] / adjustableUnits[family] : 1]))
  const units = sum(Object.values(adjustableUnits))
  if (!units) return { note: 'No sales are forecast from inventory received at new prices this year.' }

  const adjustableCogs = sum(FAMILIES.map(family => adjustableUnits[family] * current[family] * landed[family]))
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
    const remaining = allowance - sum([...held].map(family => adjustableUnits[family] * floor[family] * landed[family]))
    short = held.size > 0 && !free.length && remaining < -0.005
    const freeStandard = sum(free.map(family => adjustableUnits[family] * standard[family] * landed[family]))
    const freeUnits = sum(free.map(family => adjustableUnits[family] * landed[family]))
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
  return { recommended, note, held: [...held], short: costAllowance < 0 || short }
}

// Units and carrying value of one entity's stock, by stage and product. `key` picks the
// opening or the closing lots of each bin.
// Whether where a product was made changes what it costs this entity to import it. Goods
// made in the United States and in Poland reach the same importer at different duty rates.
function originMatters(config, id, family) {
  const supplier = id === 'US' ? 'CH' : id === 'CH' ? 'US' : sourceOf(id)
  return importDutyRate(config, supplier, id, family, 'US') !== importDutyRate(config, supplier, id, family, 'EU')
}

const quarterOf = vintage => Math.ceil(Number(vintage.slice(5)) / QUARTER_MONTHS)

// Lots that came into one bin in the same month, the same way and at one value are a layer.
// Goods converted in one month from materials bought in different months are layers of
// their own. The declared origin tells layers apart only where it changes the duty. Where
// a month still brought in lots at more than one value, `n` numbers them in the order they
// arrived. It is read from the whole year, so a layer keeps its number in every month.
// With `grain` 'quarter', the months of a quarter that came in the same way at one value
// are a single layer, as long as that holds in the budget and in the actuals alike, so
// both list the same layers.
function layerIndexes(config, sides, id, grain = 'month') {
  const split = Object.fromEntries(FAMILIES.map(family => [family, originMatters(config, id, family)]))
  const declared = (product, lot) => split[product] ? lot.declared : null
  const quarterKey = (stage, product, lot) => [stage, product, lot.vintage.slice(0, 4), quarterOf(lot.vintage), lot.source, declared(product, lot) ?? ''].join('/')
  const scan = (months, visit) => months.forEach((month, index) => {
    for (const bin of month.inventory) {
      if (bin.owner !== id) continue
      for (const lot of index ? bin.receipts : [...bin.opening, ...bin.receipts]) visit(bin.stage, bin.product, lot)
    }
  })
  // A quarter is one layer when it spans more than one month and all its lots share one value, on both sides.
  const mixed = new Set()
  const spans = new Map()
  if (grain === 'quarter') {
    for (const months of Object.values(sides)) {
      const first = new Map()
      scan(months, (stage, product, lot) => {
        const key = quarterKey(stage, product, lot)
        spans.set(key, (spans.get(key) ?? new Set()).add(lot.vintage))
        if (!first.has(key)) first.set(key, lot.unitValue)
        else if (Math.abs(first.get(key) - lot.unitValue) >= 1e-9) mixed.add(key)
      })
    }
  }
  const whole = (stage, product, lot) => {
    const key = quarterKey(stage, product, lot)
    return grain === 'quarter' && !mixed.has(key) && spans.get(key)?.size > 1
  }
  return Object.fromEntries(Object.entries(sides).map(([side, months]) => {
    const values = new Map()
    const rank = (stage, product, lot) => {
      const key = [stage, product, lot.vintage, lot.source, declared(product, lot) ?? '', lot.materials ?? ''].join('/')
      const seen = values.get(key) ?? []
      values.set(key, seen)
      const found = seen.findIndex(value => Math.abs(value - lot.unitValue) < 1e-9)
      return found < 0 ? seen.push(lot.unitValue) - 1 : found
    }
    scan(months, rank)
    return [side, { rank, declared, whole }]
  }))
}

const SOURCE_ORDER = { made: 0, converted: 0, materials: 0, bought: 1 }

// The layers a list of lots belongs to, oldest first: units, value and the customs duty inside the value.
function layersOf(lots, stage, product, index) {
  const layers = new Map()
  for (const lot of lots) {
    const declared = index.declared(product, lot)
    if (index.whole(stage, product, lot)) {
      // A quarter bought at one price is one layer. It sorts after the months of its own quarter.
      const [year, quarter] = [lot.vintage.slice(0, 4), quarterOf(lot.vintage)]
      const key = [`${year}-${String(quarter * QUARTER_MONTHS).padStart(2, '0')}~`, SOURCE_ORDER[lot.source], lot.source, declared ?? ''].join('/')
      const layer = layers.get(key) ?? { key, vintage: `${year}-Q${quarter}`, quarter: true, source: lot.source, declared, materials: null, n: 0, units: 0, amount: 0, duty: 0 }
      layer.units += lot.quantity
      layer.amount += lot.quantity * lot.unitValue
      layer.duty += lot.quantity * lot.unitDuty
      layers.set(key, layer)
      continue
    }
    const n = index.rank(stage, product, lot)
    // The key sorts the layers of a bin into the order they are sold: by month, goods made or converted before goods bought.
    const key = [lot.vintage, SOURCE_ORDER[lot.source], lot.source, declared ?? '', lot.materials ?? '', String(n).padStart(3, '0')].join('/')
    const layer = layers.get(key) ?? { key, vintage: lot.vintage, source: lot.source, declared, materials: lot.materials, n, units: 0, amount: 0, duty: 0 }
    layer.units += lot.quantity
    layer.amount += lot.quantity * lot.unitValue
    layer.duty += lot.quantity * lot.unitDuty
    layers.set(key, layer)
  }
  return [...layers.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function stockOf(inventory, id, key, index) {
  const rows = new Map()
  for (const bin of inventory) {
    if (bin.owner !== id) continue
    const name = bin.stage + '/' + bin.product
    const row = rows.get(name) ?? { stage: bin.stage, product: bin.product, units: 0, amount: 0, lots: [] }
    for (const lot of bin[key]) {
      row.units += lot.quantity
      row.amount += lot.quantity * lot.unitValue
      row.lots.push(lot)
    }
    rows.set(name, row)
  }
  const order = { finished: 0, wip: 1, raw: 2 }
  return [...rows.values()].sort((left, right) => order[left.stage] - order[right.stage] || left.product.localeCompare(right.product))
    .map(({ lots, ...row }) => ({ ...row, layers: layersOf(lots, row.stage, row.product, index) }))
}

// The line detail behind one entity's results for a set of closed months.
function entityLines(config, id, months, budgetServiceCost, index) {
  const results = rollupPnl(months.map(month => month.entities[id]))
  const byProduct = () => Object.fromEntries(FAMILIES.map(family => [family, { units: 0, amount: 0 }]))
  const sales = new Map()
  const otherRevenue = new Map()
  const charges = new Map()
  const costOfSales = byProduct()
  const received = byProduct()
  const made = byProduct()
  const lots = { sold: Object.fromEntries(FAMILIES.map(family => [family, []])), received: Object.fromEntries(FAMILIES.map(family => [family, []])) }
  let adjustmentRevenue = 0
  let adjustmentCost = 0
  for (const month of months) {
    for (const invoice of month.transactions) {
      const adjustment = invoice.policy === 'YEAR_END_ADJUSTMENT'
      // A royalty is recorded from the payer to the owner. Everything else runs from seller to buyer.
      const [seller, buyer] = invoice.category === 'royalty' ? [invoice.to, invoice.from] : [invoice.from, invoice.to]
      if (seller === id) {
        if (adjustment) adjustmentRevenue += invoice.amount
        else if (invoice.category === 'goods') {
          // Every buyer of the goods is listed apart, because each pays its own price.
          const key = invoice.external ? 'customers' : buyer
          const group = sales.get(key) ?? { buyer: key, external: invoice.external, products: byProduct() }
          group.products[invoice.product].units += invoice.quantity
          group.products[invoice.product].amount += invoice.amount
          sales.set(key, group)
        } else {
          const line = otherRevenue.get(invoice.policy) ?? { policy: invoice.policy, to: new Set(), amount: 0, cost: 0 }
          line.to.add(buyer)
          line.amount += invoice.amount
          line.cost += invoice.basis ?? 0
          otherRevenue.set(invoice.policy, line)
        }
      }
      if (buyer === id && !invoice.external) {
        if (adjustment) adjustmentCost += invoice.amount
        else if (invoice.account === 'operatingExpenses' || invoice.account === 'rdExpense' || (invoice.account === 'cogs' && invoice.category !== 'goods')) {
          // A fee booked straight to cost of sales: a toll fee true-up, or a toll fee in a month with no output.
          const line = charges.get(invoice.policy + '/' + invoice.account) ?? { policy: invoice.policy, from: new Set(), account: invoice.account, amount: 0, base: 0 }
          line.from.add(seller)
          line.amount += invoice.amount
          line.base += invoice.basis ?? 0
          charges.set(invoice.policy + '/' + invoice.account, line)
        }
      }
    }
    // Cost of sales is what leaves the finished stock: units at the value they were carried at.
    for (const bin of month.inventory) {
      if (bin.owner !== id || bin.stage !== 'finished') continue
      for (const lot of bin.issues) {
        costOfSales[bin.product].units += lot.quantity
        costOfSales[bin.product].amount += lot.quantity * lot.unitValue
      }
      // What came into finished stock: units made, converted or bought, at the value they are carried at.
      for (const lot of bin.receipts) {
        received[bin.product].units += lot.quantity
        received[bin.product].amount += lot.quantity * lot.unitValue
      }
      lots.sold[bin.product].push(...bin.issues)
      lots.received[bin.product].push(...bin.receipts)
    }
    if (month.capacity[id]) for (const family of FAMILIES) made[family].units += month.capacity[id].byProduct[family]
  }
  // Each product line's cost of sales and receipts, layer by layer.
  for (const family of FAMILIES) {
    costOfSales[family].layers = layersOf(lots.sold[family], 'finished', family, index)
    received[family].layers = layersOf(lots.received[family], 'finished', family, index)
  }
  const list = (lines, parties) => [...lines.values()].map(line => ({ ...line, [parties]: [...line[parties]] }))
  const chargeLines = list(charges, 'from')
  const charged = account => sum(chargeLines.filter(line => line.account === account).map(line => line.amount))
  const costOfGoods = sum(FAMILIES.map(family => costOfSales[family].amount))
  let service = null
  if (isServiceProvider(id)) {
    // The fee is a fixed monthly amount: the budgeted cost plus the policy markup on it.
    const fee = sum(months.map(month => month.services[id].fee))
    const budgetCost = budgetServiceCost[id] * months.length
    service = {
      kind: 'fixed', rate: config.policies[POLICY_KINDS[policyKind(id)].target], budgetCost, markup: fee - budgetCost, fee,
      cost: sum(months.map(month => month.services[id].cost)),
      trueUp: otherRevenue.get('SERVICE_TRUE_UP')?.amount ?? 0,
    }
  } else if (id === 'BE') {
    // The warehouse charges what it spent in the month, grossed up to leave its margin on the fee.
    const { amount = 0, cost = 0 } = otherRevenue.get('BE_WAREHOUSE') ?? {}
    service = { kind: 'margin', rate: config.policies.belgiumMargin, budgetCost: cost, markup: amount - cost, fee: amount, cost, trueUp: 0 }
  }
  const paid = charges.get('CH_ROYALTY/operatingExpenses')
  const earned = otherRevenue.get('CH_ROYALTY')
  const depreciation = Object.fromEntries(Object.keys(FIXED_ASSET_CLASSES).map(kind => [kind, monthlyDepreciation(id, kind) * months.length]))
  const interest = id === 'US' ? bondInterest(months.length) : 0
  return {
    months: months.length,
    sales: [...sales.values()].sort((left, right) => Number(right.external) - Number(left.external)),
    otherRevenue: list(otherRevenue, 'to'), adjustmentRevenue, revenue: results.revenue,
    costOfSales: {
      products: costOfSales, adjustments: adjustmentCost, fees: charged('cogs'),
      // What is left is customs duty on a year-end adjustment.
      other: results.cogs - costOfGoods - adjustmentCost - charged('cogs'), total: results.cogs,
    },
    charges: chargeLines.filter(line => line.account !== 'cogs'),
    // Depreciation is part of the entity's own operating costs. It is shown apart, worked out from its fixed assets.
    ownCosts: results.otherOperatingExpenses - charged('operatingExpenses') - depreciation.buildings - depreciation.equipment,
    depreciation,
    ownResearch: results.rdExpense - charged('rdExpense'),
    operatingExpenses: results.operatingExpenses, operatingProfit: results.operatingProfit,
    interest, profitBeforeTax: results.operatingProfit - interest,
    // The royalty is a rate on the third-party sales of the Swiss principal and its limited-risk distributors.
    royalty: paid || earned ? {
      direction: paid ? 'paid' : 'earned', rate: config.policies.royaltyRate, base: paid ? paid.base : earned.cost, amount: (paid ?? earned).amount,
    } : null,
    service, made: id === 'US' || id === 'PL' ? made : null, received,
    // The US parent's income tax for the period. Local statutory results exist only for a full year.
    usTax: id === 'US' ? usIncomeTax(config, months, months.length === 12 ? months[11].stat ?? null : null) : null,
    inventory: months.length ? { opening: stockOf(months[0].inventory, id, 'opening', index), closing: stockOf(months.at(-1).inventory, id, 'closing', index) } : null,
  }
}

/**
 * The detail behind one legal entity's results, budget beside actual: goods sold by buyer
 * and product line, cost of sales, fees, royalty and stock. `basis` is 'quarter' for the
 * quarter in `period` (0 to 3), 'month' for the month in `period` (0 to 11), or 'year' for
 * the full-year budget beside actuals to date. `revealed` counts the months revealed.
 * Actuals cover revealed periods only and are zero before any is revealed. Stock is a
 * balance, not a flow: an end of the actual inventory that is not known yet is null.
 * Cost of sales, receipts and stock each list their `layers`: the lots that came in at one
 * value, first in, first out, with the customs duty inside the value. `layers` is 'month'
 * for a layer per month, or 'quarter' to list a quarter bought at one price as one layer.
 */
export function entityDetail(config, { budget, actual }, id, { basis = 'month', period = 0, revealed = 0, layers = 'month' } = {}) {
  validateConfig(config)
  if (!ALL_COMPANIES.includes(id)) throw new RangeError('Choose one of the group’s legal entities.')
  if (!['month', 'quarter', 'year'].includes(basis)) throw new RangeError('The view is by month, by quarter or by year.')
  if (layers !== 'month' && layers !== 'quarter') throw new RangeError('Stock layers are by month or by quarter.')
  // A period covers one month or the three months of a quarter.
  const span = basis === 'quarter' ? QUARTER_MONTHS : 1
  const start = period * span
  if (!Number.isInteger(period) || period < 0 || start + span > 12) {
    throw new RangeError(basis === 'quarter' ? 'The quarter must be between the first and the fourth.' : 'The month must be between January and December.')
  }
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > 12) throw new RangeError('Revealed months must be between 0 and 12.')
  const { budgetServiceCost } = scenarioBudget(config)
  const ranks = layerIndexes(config, { budget, actual }, id, layers)
  const actualMonths = basis === 'year' ? actual.slice(0, revealed) : start + span <= revealed ? actual.slice(start, start + span) : []
  const actualLines = entityLines(config, id, actualMonths, budgetServiceCost, ranks.actual)
  if (!actualMonths.length) {
    // The year opens on the same stock in the budget and in the actuals.
    const yearOpening = stockOf(actual[0].inventory, id, 'opening', ranks.actual)
    if (basis === 'year') actualLines.inventory = { opening: yearOpening, closing: yearOpening }
    // The next period to be revealed starts from the stock the last revealed month ended on.
    else if (start <= revealed) {
      actualLines.inventory = { opening: start ? stockOf(actual[start - 1].inventory, id, 'closing', ranks.actual) : yearOpening, closing: null }
    } else actualLines.inventory = { opening: null, closing: null }
  }
  const budgetLines = entityLines(config, id, basis === 'year' ? budget : budget.slice(start, start + span), budgetServiceCost, ranks.budget)
  // Balance sheets at the start and the end of the period. An end of the actuals not revealed yet is null.
  const sheets = balanceSheets(config, { budget, actual })
  const ends = {
    budget: [basis === 'year' ? 0 : start, basis === 'year' ? 12 : start + span],
    actual: basis === 'year' ? [0, revealed] : [start <= revealed ? start : null, start + span <= revealed ? start + span : null],
  }
  for (const [side, lines] of [['budget', budgetLines], ['actual', actualLines]]) {
    const [from, to] = ends[side]
    const at = index => index === null ? null : sheets[side][index][id]
    lines.balance = { start: at(from), end: at(to) }
    lines.tax = periodTax(config, id, lines, lines.balance)
    lines.profitAfterTax = lines.profitBeforeTax - (lines.tax?.total ?? 0)
    lines.ratios = ratiosOf(id, lines)
  }
  return { id, basis, period, revealed, budget: budgetLines, actual: actualLines }
}

// Income tax for a period on the year-to-date basis: the tax on the year to its end, less the
// tax on the year to its start. The balance sheet carries the year-to-date tax as a liability,
// so this is what makes it roll forward. `base` is the tax worked out on the period alone: the
// rate on operating profit, or for the United States its full computation. What is left is
// `adjustment`: the true-up to local statutory profit at the year end, and for the United
// States the effect of working out its limits and tests on the year to date.
function periodTax(config, id, lines, { start, end }) {
  if (!start || !end) return null
  const total = end.taxPayable - start.taxPayable
  const base = id === 'US' ? lines.usTax.total : taxRate(config, id) * lines.operatingProfit
  return { rate: id === 'US' ? null : taxRate(config, id), base, adjustment: total - base, total }
}

// Return on assets and the other balance sheet ratios for a period, annualized. Operating
// assets leave out cash. Averages are of the balances at the start and the end of the period.
function ratiosOf(id, lines) {
  const { start, end } = lines.balance
  if (!start || !end || !lines.months) return null
  const year = 12 / lines.months
  const average = pick => (pick(start) + pick(end)) / 2
  const operating = sheet => sheet.receivables.total + sheet.inventory + sheet.fixedAssets.net
  const days = (balance, flow) => flow > 0 ? balance / flow * lines.months * 365 / 12 : NaN
  return {
    returnOnAssets: lines.operatingProfit * year / average(sheet => sheet.assets),
    returnOnOperatingAssets: lines.operatingProfit * year / average(operating),
    assetTurnover: lines.revenue * year / average(sheet => sheet.assets),
    receivableDays: days(end.receivables.total, lines.revenue),
    inventoryDays: days(end.inventory, lines.costOfSales.total),
    bondsToEquity: id === 'US' ? end.bonds / end.equity : null,
  }
}

const sheetCache = new WeakMap()

/**
 * Each legal entity's balance sheet at the start of the year (index 0) and at the end of every
 * month (1 to 12), for the budget and the actuals, in USD thousands.
 * - Receivables and payables follow the payment terms: two months of third-party sales and
 *   purchases are open, and one month of those with group companies. Last November and
 *   December are taken to look like the budgeted January. A balance that turns negative,
 *   such as a credit note larger than a month's sales, is shown on the other side.
 * - Inventory is the stock the entity owns, at the value it is carried at.
 * - Fixed assets are cost less accumulated depreciation, with no additions in the year.
 * - Income tax is accrued on the year to date and paid after the year end. It starts at zero.
 * - The US parent's bonds are fixed. Interest is paid as it falls due.
 * - Cash starts at about a month of budgeted revenue. It then moves with profit before tax,
 *   depreciation, and the changes in receivables, inventory and payables.
 * - Equity is what is left at the start of the year, plus profit after tax.
 */
export function balanceSheets(config, year) {
  const cached = sheetCache.get(year)
  if (cached) return cached
  const { budget, actual } = year
  const flowsOf = month => {
    const flows = Object.fromEntries(ALL_COMPANIES.map(id => [id, { thirdPartySales: 0, clearing: 0, relatedSales: 0, relatedPurchases: 0 }]))
    for (const { entity, account, debit, credit } of month.journal) {
      const flow = flows[entity]
      if (account === 'externalRevenue') flow.thirdPartySales -= debit - credit
      else if (account === 'externalClearing') flow.clearing += debit - credit
      else if (account === 'intercompanyReceivable') flow.relatedSales += debit - credit
      else if (account === 'intercompanyPayable') flow.relatedPurchases -= debit - credit
    }
    for (const id of ALL_COMPANIES) {
      const flow = flows[id]
      // Outsiders are paid for what was bought from them. Depreciation is inside the costs but is not paid to anyone.
      flow.thirdPartyPurchases = flow.thirdPartySales - flow.clearing - depreciationOf(id)
    }
    return flows
  }
  // Last November and December, for the balances open at the start of the year.
  const before = flowsOf(budget[0])
  const openingCash = Object.fromEntries(ALL_COMPANIES.map(id => [id,
    Math.round(sum(budget.map(month => month.entities[id].revenue)) * OPENING_CASH_MONTHS / 12 / 1000) * 1000]))
  const sheetsFor = months => {
    const flows = months.map(flowsOf)
    const flowAt = index => index >= 1 ? flows[index - 1] : before
    // The flows of the `count` months up to and including month `index`.
    const open = (index, count, id, key) => sum(Array.from({ length: count }, (_, back) => flowAt(index - back)[id][key]))
    const inventoryAt = (index, id) => {
      const [bins, key] = index ? [months[index - 1].inventory, 'closing'] : [months[0].inventory, 'opening']
      return sum(bins.filter(bin => bin.owner === id).map(bin => valueOf(bin[key], 'unitValue')))
    }
    const taxes = Array.from({ length: 13 }, (_, index) => index
      ? taxFor(config, months.slice(0, index), index === 12 ? months[11].stat ?? null : null).entities
      : null)
    let opening = null
    return Array.from({ length: 13 }, (_, index) => {
      const sheets = Object.fromEntries(ALL_COMPANIES.map(id => {
        const thirdParty = open(index, PAYMENT_TERMS.thirdParty.months, id, 'thirdPartySales')
        const related = open(index, PAYMENT_TERMS.related.months, id, 'relatedSales')
        const owedThirdParty = open(index, PAYMENT_TERMS.thirdParty.months, id, 'thirdPartyPurchases')
        const owedRelated = open(index, PAYMENT_TERMS.related.months, id, 'relatedPurchases')
        const receivables = {
          thirdParty: Math.max(0, thirdParty) + Math.max(0, -owedThirdParty),
          related: Math.max(0, related) + Math.max(0, -owedRelated),
        }
        const payables = {
          thirdParty: Math.max(0, owedThirdParty) + Math.max(0, -thirdParty),
          related: Math.max(0, owedRelated) + Math.max(0, -related),
        }
        receivables.total = receivables.thirdParty + receivables.related
        payables.total = payables.thirdParty + payables.related
        const inventory = inventoryAt(index, id)
        const fixedAssets = Object.fromEntries(Object.keys(FIXED_ASSET_CLASSES).filter(kind => FIXED_ASSETS[id]?.[kind]).map(kind => {
          const { cost, net } = FIXED_ASSETS[id][kind]
          const depreciated = cost - net + monthlyDepreciation(id, kind) * index
          return [kind, { cost, depreciated, net: cost - depreciated }]
        }))
        fixedAssets.net = sum(Object.values(fixedAssets).map(asset => asset.net))
        const profitBeforeTax = sum(months.slice(0, index).map(month => month.entities[id].operatingProfit)) - (id === 'US' ? bondInterest(index) : 0)
        const taxPayable = index ? taxes[index][id]?.tax ?? 0 : 0
        const bonds = id === 'US' ? US_BONDS.amount : 0
        // Cash moves with profit before tax and depreciation, less what is tied up in working capital.
        const workingCapital = receivables.total + inventory - payables.total
        const cash = index
          ? opening[id].cash + profitBeforeTax + depreciationOf(id) * index - (workingCapital - opening[id].workingCapital)
          : openingCash[id]
        const assets = cash + receivables.total + inventory + fixedAssets.net
        const liabilities = payables.total + taxPayable + bonds
        const equity = index ? opening[id].equity + profitBeforeTax - taxPayable : assets - liabilities
        return [id, {
          cash, receivables, inventory, fixedAssets, assets, payables, taxPayable, bonds, liabilities, equity,
          liabilitiesAndEquity: liabilities + equity, workingCapital, profitBeforeTax, months: index,
        }]
      }))
      if (!index) opening = sheets
      return sheets
    })
  }
  const result = { budget: sheetsFor(budget), actual: sheetsFor(actual) }
  sheetCache.set(year, result)
  return result
}

/**
 * Goods prices in force in a month that need the player's attention: those below the
 * supplier's standard cost, and those held at the price floor.
 */
export function goodsPriceAlerts(config, month) {
  validateConfig(config)
  validatePricingMonth(month)
  const { initial, costs, floors } = scenarioBudget(config)
  const prices = goodsPricesForMonth(config, month, initial)
  const rows = GOODS_ROUTES.flatMap(route => FAMILIES.filter(family => routeCarries(route, family)).map(product => ({
    key: route.key, from: route.from, to: route.to, product,
    price: prices[route.key][product], standardCost: costs[route.key][product], floor: floors?.[route.key][product] ?? null,
  })))
  return {
    belowCost: rows.filter(row => row.price < row.standardCost),
    atFloor: rows.filter(row => row.floor !== null && row.price <= row.floor),
    floorMarkup: floors ? config.priceFloor.markup : null,
  }
}

export function reviewGoodsPricing(config, revealed) {
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > 12) throw new RangeError('Reveal progress must be between zero and twelve months.')
  validateConfig(config)
  const {
    costScale, initial, openingNotes, unfloored, openingShort, openingPriceMethod, costs, floors, initialFees, budgetServiceCost,
  } = scenarioBudget(config)
  const current = goodsPricesForMonth(config, Math.min(revealed + 1, 12), initial)
  const currentFees = serviceFeesForMonth(config, Math.min(revealed + 1, 12), initialFees)
  const effectiveMonth = quarterPricingMonth(revealed)
  const stock = seedOpeningStock(costScale, config)
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
    // What the policy would ask for with no floor, where a floor is in force.
    let withoutFloor = floors && revealed === 0 ? unfloored[key] ?? null : null
    let floorShort = floors && revealed === 0 ? openingShort[key] ?? false : false
    if (effectiveMonth) {
      const fullYear = entityResults.find(row => row.id === to).fullYear
      const priced = floor => markup ? crossSupplyQuote(route, forecast, config.policies, floor)
        : distributorQuote(config, route, forecast, testedPnl(fullYear), effectiveMonth, current[key], initial[key], targetMargin, floor)
      quote = priced(floors?.[key])
      if (floors) {
        withoutFloor = priced(null).recommended ?? null
        floorShort = Boolean(quote.short)
      }
    }
    const startingQuote = revealed === 0 && openingPriceMethod === 'fifo-policy' && !openingNotes[key] ? initial[key] : null
    return {
      key, from, to, policy, targetMargin, markup: markup ? config.policies[markup] : null, note: quote.note,
      openingNote: openingNotes[key],
      // Products whose price in force sits at the floor, the policy price the floor replaced,
      // and whether the floor puts the buyer's full-year target out of reach.
      floorHeld: floors ? FAMILIES.filter(family => routeCarries(route, family) && current[key][family] <= floors[key][family]) : [],
      policyWithoutFloor: withoutFloor, floorShort,
      // A hub cross-supplies only the lines its own plant makes.
      prices: FAMILIES.filter(family => routeCarries(route, family)).map(product => ({
        product, applied: current[key][product], recommended: quote.recommended?.[product] ?? startingQuote?.[product] ?? null,
        standardCost: costs[key][product], floor: floors?.[key][product] ?? null,
        // Whether the supplier makes the line itself or buys it from the other hub first.
        made: hubMakes(from, product),
        // The import duty the buyer pays on top of the price, for goods from the plant that normally supplies the line.
        duty: importDutyRate(config, from, to, product, plannedOrigin(product, from)),
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
  if (!startMonth) throw new RangeError('Review and change service fees after closing the first, second or third quarter.')
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
  if (!startMonth) throw new RangeError('Review and change goods prices after closing the first, second or third quarter.')
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
  if (revealed !== 12) throw new RangeError('Year-end adjustments open once fourth-quarter actuals are revealed.')
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
  const actualStock = seedOpeningStock(costScale, config)
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
  if (actual.length !== 12 || !actual[11].yearEnd) throw new RangeError('The year can be explained once fourth-quarter actuals are revealed.')
  const total = (months, pick) => sum(months.map(pick))
  const { initial, floors } = scenarioBudget(config)
  return actual[11].yearEnd.map(entry => {
    const { id, service } = entry
    const range = policyRange(config, id)
    const planned = testedResult(id, rollupPnl(budget.map(month => month.entities[id])))
    const result = rollupPnl(actual.map(month => month.entities[id]))
    const gaap = testedResult(id, result)
    // The true-up changes revenue for a service provider and cost of sales for a distributor,
    // where it also carries any customs duty it attracts.
    const beforeTrueUp = (gaap.profit + (service ? -entry.amount : entry.amount + entry.duty)) / (service ? gaap.costs : gaap.revenue)
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
      const costs = gaap.costs - entry.amount - entry.duty
      const atBudgetPriceMargin = (atBudgetPrices - costs) / atBudgetPrices
      drivers.push({ key: 'volume', points: atBudgetPriceMargin - planned.indicator })
      drivers.push({ key: 'salesPrice', points: beforeTrueUp - atBudgetPriceMargin })
      facts.priceDeviation = gaap.revenue / atBudgetPrices - 1
      const units = months => sum(months.flatMap(month => month.sales.filter(sale => sale.seller === id).map(sale => sale.quantity)))
      facts.unitsDeviation = units(actual) / units(budget) - 1
      if (floors) {
        // Products whose price sat at the floor at some point in the year, and whether the
        // floor stops a year-end credit from reaching the range.
        const key = goodsRouteKey(sourceOf(id), id)
        const prices = Array.from({ length: 12 }, (_, index) => goodsPricesForMonth(config, index + 1, initial)[key])
        facts.floor = {
          held: FAMILIES.filter(family => prices.some(table => table[family] <= floors[key][family])),
          creditLimited: entry.floorLimited.range,
        }
      }
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
