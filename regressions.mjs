import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecast, logit } from './main.ts';

const practice = ['p00', 'p01'].map(id => JSON.parse(readFileSync(new URL(`../gta6-trophy-rarity-forecast-01-kit/input/${id}.in`, import.meta.url), 'utf8')));
for (const data of practice) {
  const expected = forecast(data);
  assert.deepEqual(expected, forecast(data), 'Forecasts must be deterministic');
  const instant = Date.parse(data.target);
  for (const target of [new Date(instant).toISOString(), new Date(instant).toISOString().replace('Z', '+00:00'), data.target.replace('Z', '+00:00')]) {
    assert.equal(Date.parse(target), instant);
    assert.deepEqual(forecast({ ...data, target }), expected, 'Equivalent target representations must forecast identically');
  }
}

const epoch = Date.parse('2026-11-19T00:00:00Z');
const iso = h => new Date(epoch + h * 3600000).toISOString();
const data = {
  ...practice[0], id: 'missing-audit', at: iso(48), target: iso(156), horizon_minutes: 6480,
  trophies: [
    { id: 1, description: 'Start the game.', tier: 'bronze', points: 15, secret: false },
    { id: 2, description: 'Complete an activity.', tier: 'bronze', points: 15, secret: false },
    { id: 3, description: 'Complete another activity.', tier: 'bronze', points: 15, secret: false }
  ],
  history: [0, 12, 24, 36, 48].map((h, j) => {
    const n = 1000 + j * 250;
    return { at: iso(h), players_tracked: n, trophies_earned: n + 100,
      rates: [100, Number((1000 / n).toFixed(2)), Number((9000 / n).toFixed(2))] };
  })
};
const masked = structuredClone(data);
masked.history.slice(0, 2).forEach(row => { row.rates[1] = null; row.rates[2] = null; });
const control = forecast(data);
const corrected = forecast(masked);
const distance = result => result.trophies.slice(1).reduce((sum, row, i) => sum + row.q.reduce((a, q, j) => a + Math.abs(logit(q) - logit(control.trophies[i + 1].q[j])), 0), 0);
assert(distance(corrected) < 1e-12, 'Missing early observations must not manufacture count progression');

const laterAdded = structuredClone(data);
for (const row of laterAdded.history.slice(0, -1)) row.rates[2] = null;
const output = forecast(laterAdded);
for (const row of output.trophies) {
  row.q.forEach((q, j) => { assert(Number.isFinite(q) && q >= 0 && q <= 100); if (j) assert(q >= row.q[j - 1]); });
}
console.log(JSON.stringify({deterministic_practice_outputs: true, timestamp_equivalence: 'pass', missing_observation_logit_distance: distance(corrected), later_added_trophy: 'valid'}, null, 2));
