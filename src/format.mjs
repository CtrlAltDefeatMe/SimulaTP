// How the app shows numbers. The model's money is in thousands of US dollars and its
// units are in thousands, so a price per unit is in dollars. Amounts are shown as whole
// thousands; prose and headline figures are shown at their real size, such as $2.38B.

/** The label that goes with an amount in thousands. */
export const IN_THOUSANDS = 'USD thousands';

const wholeThousands = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const realScale = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const perUnit = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeCount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// A value that rounds to zero is shown as zero, never as −0.
const settle = (value, step) => Math.abs(value) < step / 2 ? 0 : value;

/** An amount in thousands of dollars, to the nearest thousand: $526,433. */
export const thousands = { format: value => wholeThousands.format(settle(value, 1)) };

/** An amount in thousands of dollars, written at its real size: $526.43M. */
export const realSize = { format: value => realScale.format(settle(value, 0.001) * 1000) };

/** A price or cost per unit, in dollars and cents. */
export const unitPrice = { format: value => perUnit.format(settle(value, 0.01)) };

/** A count of units, in thousands, to the nearest thousand. */
export const unitCount = { format: value => wholeCount.format(settle(value, 1)) };
