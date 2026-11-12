# PlayTP

PlayTP is a browser-based transfer pricing simulator for 2027. Read the case brief, review the budget, reveal monthly actuals, and use the quarterly pricing reviews and the year-end adjustment to keep each tested entity inside its arm's-length range. Or run the full year without touching a price and read why entities finished outside their range.

The simulator uses a synthetic scenario. Tax and duty rates are illustrative. Scenario settings, reveal progress, and price changes are stored in your browser.

## What the model covers

- Monthly demand, sales price and material cost shocks, group-wide and by market
- FIFO inventory, toll manufacturing, a principal structure, services and a royalty
- Three product lines with different profitability in every market: Control Systems high, Precision Components in the middle, Industrial Modules thin
- Fixed monthly service fees for the Polish toll manufacturer and the Indian service center, set from budgeted cost plus the policy markup, against costs that vary each month. Part of Poland's cost is fixed overhead, so its unit cost rises when output falls
- Arm's-length ranges for seven tested entities: the limited-risk and full-fledged distributors on operating margin, Poland and India on markup on cost
- An unexpected GAAP-to-stat adjustment, revealed at the December close. Each entity outside the United States has a 50% chance of one for the year. The ranges and local income tax are tested on the statutory results
- An opening sequence on the first load of each browser session: the bars of the TH monogram tumble into place, the PlayTP name appears, and both shrink into the brand corner. It can be skipped, does not play when reduced motion is requested, and replays with `?intro` in the address
- An automatic full-year run at unchanged prices and fees, with a pop-up that explains each out-of-range result, and a replay of the same year
- An optional price floor: no goods price below standard cost plus a markup
- Quarterly reviews of goods prices and service fees, and year-end adjustments
- Income tax by entity, and customs duty on declared transfer prices as a memo

Customs duty is not deducted from operating profit, and all amounts are in US dollars. There is no currency layer.

## Tests

```
node --test tests/engine.test.mjs
```
