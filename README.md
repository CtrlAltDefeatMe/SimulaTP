# PlayTP

PlayTP is a browser-based transfer pricing simulator for 2027. Read the case brief, review the budget, reveal actuals one quarter at a time, and use the quarterly pricing reviews and the year-end adjustment to keep each tested entity inside its arm's-length range. Or run the full year without touching a price and read why entities finished outside their range.

The simulator uses a synthetic scenario. Tax and duty rates are illustrative. Scenario settings, reveal progress, and price changes are stored in your browser.

## What the model covers

- One plant for each end of the range: Control Systems (high margin) is made only in the United States and Industrial Modules (low margin) only in Poland, so the United States and Switzerland sell those lines to each other. Both plants make Precision Components
- Plant capacity by product line. When a plant is at its limit for Precision Components, the other plant makes the shortfall as far as its own limit allows. Demand for a line goes unmet, and the sale is lost, once its plants are at their limit and neither hub has stock left
- Results reported by quarter. The model closes every month underneath, so stock, costs and shocks still move month by month
- Demand, sales price and material cost shocks, group-wide and by market
- FIFO inventory, toll manufacturing, a principal structure, services and a royalty
- Three product lines with different profitability in every market: Control Systems high, Precision Components in the middle, Industrial Modules thin
- Fixed quarterly service fees for the Polish toll manufacturer and the Indian service center, set from budgeted cost plus the policy markup, against costs that vary. Part of Poland's cost is fixed overhead, so its unit cost rises when output falls
- Arm's-length ranges for seven tested entities: the limited-risk and full-fledged distributors on operating margin, Poland and India on markup on cost
- An unexpected GAAP-to-stat adjustment, revealed at the fourth-quarter close. Each entity outside the United States has a 50% chance of one for the year. The ranges and local income tax are tested on the statutory results
- An opening sequence on the first load of each browser session: the bars of the TH monogram tumble into place, the PlayTP name appears, and both shrink into the brand corner. It can be skipped, does not play when reduced motion is requested, and replays with `?intro` in the address
- An automatic full-year run at unchanged prices and fees, with a pop-up that explains each out-of-range result, and a replay of the same year
- An optional price floor: no goods price below standard cost plus a markup
- An entity detail report for each legal entity, by quarter or for the year, budget beside actual: units and net sales price by product line and buyer, cost of sales as units times inventory value, service cost and markup shown separately for the service entities, the Swiss royalty and its base, and beginning and ending inventory. The annual view sets the full-year budget beside actuals to date. Cost of sales and stock can be broken out into first-in, first-out layers by when the units came in, with the transfer price and customs duty behind each layer, so a price change can be followed from the quarter it is bought into cost of sales. A quarter bought at one price is one layer
- An Excel export of the entity detail report for every legal entity, for the quarter or year shown: a contents sheet and one sheet per entity, with stock layers, the customs duty in each imported layer, and the US income tax working on the United States sheet. Amounts are numbers, unrounded, in USD thousands. The workbook is built in the browser by `src/xlsx.mjs`, with no library
- Quarterly reviews of goods prices and service fees, and year-end adjustments. Each distributor holds about two months of stock on a FIFO basis, so about two-thirds of the units sold in the quarter a price changes still carry the old price
- A default group that earns a consolidated operating margin in the high teens (17.8%), with a high-margin, a mid-margin and a thin-margin product line in every market
- US federal tax under the rules for tax years beginning after 2025: the FDDEI deduction (33.34%, with no interest or R&E allocated), tax on net CFC tested income (NCTI: 40% deduction, 90% deemed-paid credit, no QBAI return) and BEAT (10.5%, 3% base erosion percentage), plus state tax. The working is on Entity detail for the United States
- Income tax by entity, and customs duty on declared transfer prices. The importer adds duty to the cost of the goods, so it reaches cost of sales when they are sold. Duty rates are set by importing block (Europe including Switzerland and the United Kingdom, the United States, Canada, Asia), by where the goods were made (United States or Poland) and by product line

All amounts are in thousands of US dollars and all unit counts are in thousands, so a price per unit is in dollars. Amounts show as whole numbers; headline figures show the real size, such as $2.38B. There is no currency layer.

## Tests

```
node --test tests/engine.test.mjs
```
