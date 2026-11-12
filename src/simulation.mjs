export const SHOCK_KEYS = Object.freeze(['demand', 'salesPrice', 'materialCost']);
/** Shocks that also vary by market. Material costs move with the group. */
export const MARKET_SHOCK_KEYS = Object.freeze(['demand', 'salesPrice']);

export const DEFAULT_SIMULATION = Object.freeze({
  seed: 'PlayTP2027',
  distributions: Object.freeze({
    demand: Object.freeze({ min: -0.18, mode: 0, max: 0.18 }),
    salesPrice: Object.freeze({ min: -0.10, mode: 0, max: 0.10 }),
    materialCost: Object.freeze({ min: -0.15, mode: 0, max: 0.15 }),
  }),
  correlation: Object.freeze([
    Object.freeze([1, 0.25, 0.15]),
    Object.freeze([0.25, 1, 0.20]),
    Object.freeze([0.15, 0.20, 1]),
  ]),
  // Half-width of each market's own monthly deviation, added to the group-wide shock.
  marketVariation: Object.freeze({ demand: 0.10, salesPrice: 0.05 }),
});

const shockLabels = {
  demand: 'Demand',
  salesPrice: 'Sales price',
  materialCost: 'Material cost',
};

function factorCorrelation(correlation) {
  const size = SHOCK_KEYS.length;
  if (!Array.isArray(correlation) || correlation.length !== size ||
      Array.from(correlation).some((row) => !Array.isArray(row) || row.length !== size)) {
    throw new RangeError(`Correlation must be a ${size} × ${size} matrix.`);
  }
  correlation.forEach((row, i) => {
    if (row[i] !== 1) throw new RangeError('Correlation diagonal entries must equal 1.');
    for (let j = 0; j < i; j += 1) {
      const value = row[j];
      if (!Number.isFinite(value) || Math.abs(value) > 1 || value !== correlation[j][i]) {
        throw new RangeError('Correlation must be symmetric, with coefficients between -1 and 1.');
      }
    }
  });

  // A zero Cholesky pivot is valid for a positive semidefinite matrix.
  // Allow rounding error on the residuals so perfect correlations are usable.
  const tolerance = 1e-12;
  const factor = Array.from({ length: size }, () => Array(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let residual = correlation[i][j];
      for (let k = 0; k < j; k += 1) {
        residual -= factor[i][k] * factor[j][k];
      }
      if (i === j) {
        if (residual < -tolerance) {
          throw new RangeError('Correlation must be positive semidefinite.');
        }
        factor[i][j] = Math.sqrt(Math.max(0, residual));
      } else if (factor[j][j] > 0) {
        factor[i][j] = residual / factor[j][j];
      } else if (Math.abs(residual) > tolerance) {
        throw new RangeError('Correlation must be positive semidefinite.');
      }
    }
  }
  return factor;
}

function prepareConfig(config) {
  const seed = config?.seed;
  if (!(typeof seed === 'string' && seed.trim()) && !Number.isSafeInteger(seed)) {
    throw new RangeError('Seed must be nonempty text or a safe integer.');
  }
  const distributions = SHOCK_KEYS.map((key) => {
    const { min, mode, max } = config.distributions?.[key] ?? {};
    if (![min, mode, max].every(Number.isFinite) || min > mode || mode > max || min < -1) {
      throw new RangeError(`${shockLabels[key]} must have finite bounds in minimum, mode, maximum order, with a minimum of at least -100%.`);
    }
    return { min, mode, max };
  });
  // Scenarios saved before market variation existed keep their group-wide shocks.
  const marketVariation = MARKET_SHOCK_KEYS.map((key) => {
    const value = config.marketVariation?.[key] ?? 0;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${shockLabels[key]} variation by market must be between 0% and 100%.`);
    }
    if (distributions[SHOCK_KEYS.indexOf(key)].min - value < -1) {
      throw new RangeError(`${shockLabels[key]} minimum less its variation by market cannot fall below -100%.`);
    }
    return value;
  });
  return { seed: String(seed), distributions, marketVariation, factor: factorCorrelation(config.correlation) };
}

/** Throw a RangeError if the seed, triangular distributions, or correlation are invalid. */
export function validateSimulationConfig(config = DEFAULT_SIMULATION) {
  prepareConfig(config);
}

function createUniformSampler(seed) {
  // FNV-1a seed hashing followed by Mulberry32. Use the center of each
  // 32-bit probability interval to keep samples strictly inside (0, 1).
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (((value ^ (value >>> 14)) >>> 0) + 0.5) / 2 ** 32;
  };
}

function createNormalSampler(uniform) {
  let spare;
  return () => {
    if (spare !== undefined) {
      const sample = spare;
      spare = undefined;
      return sample;
    }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function normalCdf(value) {
  // Abramowitz and Stegun 26.2.17, with absolute error below 7.5e-8.
  if (value === 0) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const polynomial = t * (0.319381530 + t * (-0.356563782 + t * (
    1.781477937 + t * (-1.821255978 + t * 1.330274429)
  )));
  const tail = Math.exp(-value * value / 2) / Math.sqrt(2 * Math.PI) * polynomial;
  return value < 0 ? tail : 1 - tail;
}

function triangularQuantile(probability, { min, mode, max }) {
  if (min === max) return min;
  const width = max - min;
  const modeFraction = (mode - min) / width;
  if (probability <= modeFraction) {
    return min + width * Math.sqrt(probability * modeFraction);
  }
  return max - width * Math.sqrt((1 - probability) * (1 - modeFraction));
}

/**
 * Generate monthly fractional shocks. The correlation applies to the underlying normal draws.
 * When `markets` are given, each month also carries `markets[id]`: that market's own
 * deviation in demand and sales price, to be added to the group-wide shock.
 */
export function simulateShocks(config = DEFAULT_SIMULATION, months = 12, markets = []) {
  if (!Number.isSafeInteger(months) || months <= 0) {
    throw new RangeError('Months must be a positive integer.');
  }
  const { seed, distributions, marketVariation, factor } = prepareConfig(config);
  const normal = createNormalSampler(createUniformSampler(seed));
  // A separate stream keeps the group-wide draws identical for a given seed,
  // whatever the market list or variation settings.
  const marketUniform = createUniformSampler(seed + '/markets');
  const unit = { min: -1, mode: 0, max: 1 };
  return Array.from({ length: months }, () => {
    const independent = SHOCK_KEYS.map(() => normal());
    const shock = Object.fromEntries(SHOCK_KEYS.map((key, i) => {
      const correlated = factor[i].reduce((sum, weight, j) => sum + weight * independent[j], 0);
      return [key, triangularQuantile(normalCdf(correlated), distributions[i])];
    }));
    if (markets.length) {
      shock.markets = Object.fromEntries(markets.map((id) => [
        id, Object.fromEntries(MARKET_SHOCK_KEYS.map((key, i) => [
          key, marketVariation[i] * triangularQuantile(marketUniform(), unit),
        ])),
      ]));
    }
    return shock;
  });
}
