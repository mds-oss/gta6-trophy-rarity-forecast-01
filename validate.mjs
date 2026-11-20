import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { forecast, countBounds, logit } from './main.ts';

const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const clip = value => Math.max(0.01, Math.min(99.99, value));
const inverse = value => 100 / (1 + Math.exp(-value));
const kit = resolve(process.argv[2] || '../gta6-trophy-rarity-forecast-01-kit');
const fixture = JSON.parse(readFileSync(join(kit, 'input/p00.in'), 'utf8'));
const loss = (result, rates) => result.trophies.reduce((sum, row, i) => sum + row.q.reduce((a, q, k) => {
  const error = logit(rates[i]) - logit(q);
  return a + 2 * Math.max(levels[k] * error, (levels[k] - 1) * error);
}, 0), 0) / (rates.length * 5);
function baseline(data, trend = false) {
  const last = data.history.at(-1);
  const epoch = Date.parse(data.game.release_date + 'T00:00:00Z');
  const axis = at => Math.log1p(Math.max(0, (Date.parse(at) - epoch) / 3600000));
  const rows = data.history.filter(row => Date.parse(row.at) >= Date.parse(data.at) - 86400000);
  return { trophies: data.trophies.map((trophy, i) => {
    let center = logit(last.rates[i]);
    let residual = 0;
    if (trend && rows.length >= 3) {
      const xs = rows.map(row => axis(row.at));
      const ys = rows.map(row => logit(row.rates[i]));
      const mx = xs.reduce((a,b) => a+b, 0) / xs.length;
      const my = ys.reduce((a,b) => a+b, 0) / ys.length;
      const variance = xs.reduce((a,b) => a+(b-mx)**2, 0);
      const slope = variance > 0 ? xs.reduce((a,b,j) => a+(b-mx)*(ys[j]-my), 0) / variance : 0;
      center = my + slope * (axis(data.target) - mx);
      residual = Math.sqrt(ys.reduce((a,b,j) => a+(b-my-slope*(xs[j]-mx))**2, 0) / ys.length);
    }
    const spread = Math.hypot(0.5 * Math.sqrt(data.horizon_minutes / 1440), residual);
    return { id: trophy.id, q: z.map(value => inverse(center + value * spread)) };
  }) };
}
function validate(data, result) {
  assert.deepEqual(Object.keys(result), ['trophies']);
  assert.equal(result.trophies.length, data.trophies.length);
  assert.deepEqual(result.trophies.map(t => t.id).sort((a,b)=>a-b), data.trophies.map(t=>t.id).sort((a,b)=>a-b));
  for (const row of result.trophies) {
    assert.deepEqual(Object.keys(row).sort(), ['id','q']);
    assert.equal(row.q.length, 5);
    row.q.forEach((q,i) => { assert(Number.isFinite(q) && q>=0 && q<=100); if (i) assert(q>=row.q[i-1]); });
  }
  assert(Buffer.byteLength(JSON.stringify(result)) <= 65536);
}

// Genuine chronological cuts: all available observations are the same cache.
// They test stale-page handling, not performance across an unseen refresh.
let plateauLoss = 0;
let cuts = 0;
for (let i = 2; i < fixture.history.length; i++) {
  const data = structuredClone(fixture);
  data.history = fixture.history.slice(0,i);
  data.at = data.history.at(-1).at;
  data.target = fixture.history[i].at;
  data.horizon_minutes = (Date.parse(data.target)-Date.parse(data.at))/60000;
  const output = forecast(data);
  validate(data, output);
  plateauLoss += loss(output, fixture.history[i].rates);
  cuts++;
}
assert(plateauLoss < 1e-10);
for (const [rate, count] of [[0.63,4],[0.78,5],[0.94,6],[1.1,7],[100,638]]) assert.deepEqual(countBounds(rate,638),[count,count]);

// Independent deterministic stress families: counts use clock time, a capped
// exponential, or a delayed sigmoid, rather than the model's log-age formula.
// These measure robustness to assumptions; they are not forecast validation.
const synthetic = [];
const initialCounts = fixture.history[0].rates.map(r => Math.round(r*638/100));
const iso = h => new Date(Date.parse('2026-11-19T00:00:00Z') + h*3600000).toISOString();
for (const family of ['dilution','linear','saturation','delayed']) {
  for (const poolPower of [0.5,0.8,1.1]) {
    const snapshots = [];
    for (let h = 0; h <= 168; h += 3) {
      const refreshed = Math.floor(h/6)*6;
      const players = Math.round(638 + 850 * Math.pow(refreshed, poolPower));
      const awards = initialCounts.map((base,i) => {
        if (i===1) return players;
        const speed = i%7===0 ? 3 : i%5===0 ? 0.3 : 0;
        const growth = family==='dilution' ? 0 : family==='linear' ? speed*refreshed : family==='saturation'
          ? speed*30*(1-Math.exp(-refreshed/30)) : speed*60/(1+Math.exp(-(refreshed-50)/12))-speed*60/(1+Math.exp(50/12));
        return Math.min(players, Math.round(base+Math.max(0,growth)));
      });
      snapshots.push({slot:iso(h),at:iso(h),players_tracked:players,trophies_earned:awards.reduce((a,b)=>a+b,0),rates:awards.map(c=>Number((100*c/players).toFixed(2)))});
    }
    for (const origin of [24,36,48]) {
      for (const horizon of [12,36,108]) {
        const data = {...fixture, at:iso(origin), target:iso(origin+horizon), horizon_minutes:horizon*60,history:snapshots.filter(s=>s.at<=iso(origin))};
        const truth = snapshots.find(s=>s.at===data.target).rates;
        const prediction = forecast(data);
        validate(data,prediction);
        synthetic.push({family,origin,horizon,model:loss(prediction,truth),persistence:loss(baseline(data),truth),curve:loss(baseline(data,true),truth)});
        const duplicated = {...data,history:data.history.flatMap(row=>[row,{...row,at:new Date(Date.parse(row.at)+1000).toISOString()}])};
        assert.deepEqual(forecast(duplicated),prediction,'Repeated cache reads must not change predictions');
      }
    }
  }
}
const average = rows => Object.fromEntries(['model','persistence','curve'].map(key=>[key,rows.reduce((a,r)=>a+r[key],0)/rows.length]));
const practice = [];
for (const id of ['p00','p01']) {
  const data = JSON.parse(readFileSync(join(kit,`input/${id}.in`),'utf8'));
  const result = forecast(data);
  validate(data,result);
  assert.deepEqual(result,forecast(data));
  practice.push({id,bytes:Buffer.byteLength(JSON.stringify(result)),official_loss:null});
}
const folder = resolve('../validation');
mkdirSync(folder,{recursive:true});
const runtimes = [];
const hashes = [];
for (let repeat=0;repeat<2;repeat++) {
  const output = join(folder,`run-${repeat+1}`);
  mkdirSync(output,{recursive:true});
  const start=performance.now();
  const processResult=spawnSync(process.execPath,['main.ts'],{cwd:resolve('.'),env:{...process.env,MAKEFUN_INPUT_DIR:join(kit,'input'),MAKEFUN_OUTPUT_DIR:output},encoding:'utf8'});
  assert.equal(processResult.status,0,processResult.stderr);
  runtimes.push(performance.now()-start);
  hashes.push(['p00','p01'].map(id=>readFileSync(join(output,`${id}.out`),'utf8')));
}
assert.deepEqual(hashes[0],hashes[1]);
const report={runtime_ms:runtimes,practice,plateau_cuts:cuts,plateau_loss:plateauLoss/cuts,synthetic_cases:synthetic.length,synthetic_average:average(synthetic),by_family:Object.fromEntries(['dilution','linear','saturation','delayed'].map(f=>[f,average(synthetic.filter(r=>r.family===f))])),by_horizon:Object.fromEntries([12,36,108].map(h=>[h,average(synthetic.filter(r=>r.horizon===h))])),limitations:['Official practice target labels and scorer are not shipped; no local official practice loss is available.','Chronological input cuts contain no refresh. Synthetic results are sensitivity tests, not evidence of predictive skill.','The 108.5-hour final horizon cannot be backtested against the launch history available at its checkpoint.']};
writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
