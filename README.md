# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mds-oss/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mds-oss/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An offline, deterministic forecast of trophy earn-rate quantiles. Authored with an AI coding agent for the make.fun bounty. Standard library only; no dependencies, installation, network access or model calls at runtime. MIT licensed.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Node 22 or later. Reads every `.in` in name order and writes its matching `.out`. The default directories are `/input` and `/output`.

## Model

The model reconstructs feasible integer earner intervals from two-decimal percentages and uses the aggregate trophy total when it is consistent. Identical cached observations count once. It forecasts players and trophy counts separately, combining robust log-age trends, an initial count offset, progression pooling by trophy metadata, and damped population-growth scenarios. Quantiles are taken from the predictive mixture rather than averaged across component quantiles.

The one-state launch fallback uses the **first-refresh denominator disclosed by the competition rules** only within its disclosed short practice window. Trophy growth assumptions in that fallback are subjective development priors, not fitted historical estimates. That denominator never anchors the final's week-ahead population. The model carries no hardcoded target-rate vector and never reads a case's answers.

A public Exophase observation during development showed substantial player growth alongside persistent small earner counts for many trophies. It informed the choice of count-offset models and trophy-specific growth. It is later than the practice checkpoints; practice performance must therefore be described as development performance, not an out-of-time backtest.

## Validation

```sh
node validate.mjs /path/to/gta6-trophy-rarity-forecast-01-kit
```

The validation harness checks output shape, bounds, monotonic quantiles, file size, exact determinism across two processes, duplicate-cache invariance, count intervals, and chronological cuts from supplied input history. It compares sensitivity on independent synthetic dilution, linear-growth, saturating-growth, and delayed-progression paths against the two published house baseline formulas using the exact clipped-logit pinball metric.

The practice kit contains **no target labels or local official scorer**. Its history cuts contain only an unchanged cache. Synthetic comparisons are assumption tests, not evidence of predictive accuracy. There is also too little pre-deadline history to backtest a 108.5-hour horizon. Exact top-20 scores were recovered from public archive score metadata; the top entry scored 0.000375 and the 20th scored 0.032516. No house-entry rows were present in the board inspected during development, so their exact scores remain unavailable. No competitor repositories or source were read.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
