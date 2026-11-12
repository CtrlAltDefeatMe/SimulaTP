# SimulaTP

SimulaTP is a browser-based transfer pricing simulator for 2027. Read the case brief, review the budget, reveal monthly actuals, and use the quarterly pricing reviews and the year-end adjustment to keep each distributor inside its arm's-length range.

The simulator uses a synthetic scenario. Tax and duty rates are illustrative. Scenario settings, reveal progress, and price changes are stored in your browser.

## What the model covers

- Monthly demand, sales price and material cost shocks, group-wide and by market
- FIFO inventory, toll manufacturing, a principal structure, services and a royalty
- Three product lines with different profitability in every market: Control Systems high, Precision Components in the middle, Industrial Modules thin
- Arm's-length ranges for the limited-risk and full-fledged distributors
- An optional price floor: no goods price below standard cost plus a markup
- Quarterly goods price reviews and year-end adjustments
- Income tax by entity, and customs duty on declared transfer prices as a memo

Customs duty is not deducted from operating profit, and all amounts are in US dollars. There is no currency layer.

## Tests

```
node --test tests/engine.test.mjs
```
