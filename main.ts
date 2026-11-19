import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: 'platinum' | 'gold' | 'silver' | 'bronze';
  points: number;
  secret: boolean;
}

interface HistorySnapshot {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: (number | null)[];
}

interface CaseInput {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: HistorySnapshot[];
}

const LAUNCH_MS = Date.parse('2026-11-18T23:30:00Z');
// Student-t (df=8) quantiles at 0.05, 0.25, 0.50, 0.75, 0.95 for calibrated tails
const T8_Q = [-1.8595, -0.7064, 0.0, 0.7064, 1.8595];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function logit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(z: number): number {
  const p = 1 / (1 + Math.exp(-clamp(z, -12, 12)));
  return clamp(p * 100, 0.01, 99.99);
}

function logHoursSinceLaunch(iso: string): number {
  const hrs = Math.max(0.1, (Date.parse(iso) - LAUNCH_MS) / 3_600_000);
  return Math.log(1 + hrs);
}

function deduplicateRefreshes(history: HistorySnapshot[]): HistorySnapshot[] {
  const unique: HistorySnapshot[] = [];
  let prevKey = '';
  for (const snap of history) {
    const key = `${snap.players_tracked}|${snap.trophies_earned}|${snap.rates.join(',')}`;
    if (key !== prevKey) {
      unique.push(snap);
      prevKey = key;
    }
  }
  return unique;
}

function forecastCase(data: CaseInput): { trophies: { id: number; q: number[] }[] } {
  const refreshes = deduplicateRefreshes(data.history);
  const lastSnap = data.history[data.history.length - 1];
  const uTarget = logHoursSinceLaunch(data.target);
  const uLast = logHoursSinceLaunch(lastSnap.at);
  const du = Math.max(0.01, uTarget - uLast);
  const horizonDays = Math.max(0.01, data.horizon_minutes / 1440);

  // Compute per-trophy weighted linear regression on logit(rate) vs logHours
  const rawSlopes: number[] = [];
  const rawIntercepts: number[] = [];
  const rawResiduals: number[] = [];
  const uSpan = refreshes.length >= 2
    ? logHoursSinceLaunch(refreshes[refreshes.length - 1].at) - logHoursSinceLaunch(refreshes[0].at)
    : 0;

  for (let i = 0; i < data.trophies.length; i++) {
    const pts: { u: number; y: number; w: number }[] = [];
    for (let j = 0; j < refreshes.length; j++) {
      const r = refreshes[j].rates[i];
      if (r === null || r === undefined) continue;
      const u = logHoursSinceLaunch(refreshes[j].at);
      // Weight newer refreshes and larger player pools higher
      const recencyW = Math.exp(-0.5 * (refreshes.length - 1 - j) / Math.max(1, refreshes.length * 0.4));
      const poolW = Math.sqrt(Math.max(1, refreshes[j].players_tracked));
      pts.push({ u, y: logit(r), w: recencyW * poolW });
    }

    if (pts.length < 2 || uSpan < 0.05) {
      const lastR = lastSnap.rates[i] ?? 1.0;
      rawSlopes.push(0);
      rawIntercepts.push(logit(lastR));
      rawResiduals.push(0);
      continue;
    }

    let sw = 0, swu = 0, swy = 0;
    for (const p of pts) {
      sw += p.w;
      swu += p.w * p.u;
      swy += p.w * p.y;
    }
    const meanU = swu / sw;
    const meanY = swy / sw;

    let num = 0, den = 0;
    for (const p of pts) {
      num += p.w * (p.u - meanU) * (p.y - meanY);
      den += p.w * (p.u - meanU) * (p.u - meanU);
    }
    const slope = den > 1e-9 ? clamp(num / den, -1.5, 2.0) : 0;
    const intercept = meanY - slope * meanU;

    let rss = 0;
    for (const p of pts) {
      const err = p.y - (intercept + slope * p.u);
      rss += p.w * err * err;
    }
    const rmse = Math.sqrt(rss / sw);

    rawSlopes.push(slope);
    rawIntercepts.push(intercept);
    rawResiduals.push(rmse);
  }

  // Tier-pooled slope prior
  const tierGroups: Record<string, number[]> = { platinum: [], gold: [], silver: [], bronze: [] };
  for (let i = 0; i < data.trophies.length; i++) {
    if (refreshes.length >= 2 && uSpan >= 0.05) {
      tierGroups[data.trophies[i].tier].push(rawSlopes[i]);
    }
  }
  const tierMeanSlope: Record<string, number> = {};
  for (const tier of Object.keys(tierGroups)) {
    const arr = tierGroups[tier];
    tierMeanSlope[tier] = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  const outTrophies: { id: number; q: number[] }[] = [];
  const isEarlySingleRefresh = refreshes.length < 2 && lastSnap.players_tracked < 2000;

  for (let i = 0; i < data.trophies.length; i++) {
    const t = data.trophies[i];
    const lastR = lastSnap.rates[i] ?? 1.0;
    const lastZ = logit(lastR);

    let medZ: number;
    let spreadZ: number;

    if (refreshes.length < 2 || uSpan < 0.05) {
      // Launch-night single-refresh regime: expect dilution on non-trivial trophies
      const dilutionShift = isEarlySingleRefresh && lastR < 90 ? -0.85 : 0;
      medZ = lastZ + dilutionShift;
      const baseSpread = isEarlySingleRefresh ? 0.95 : 0.45 * Math.sqrt(horizonDays);
      spreadZ = lastR >= 99.5 ? 0.25 : baseSpread;
    } else {
      // Global progression signal from mean trophies earned per player
      const firstMean = refreshes[0].trophies_earned / Math.max(1, refreshes[0].players_tracked);
      const lastMean = lastSnap.trophies_earned / Math.max(1, lastSnap.players_tracked);
      const globalLogitDrift = Math.log(Math.max(0.2, lastMean) / Math.max(0.2, firstMean)) / Math.max(0.2, uSpan);

      // Shrink individual slope toward tier mean slope + damped global progression
      const shrinkW = clamp(uSpan / (uSpan + 0.6), 0.15, 0.85);
      const priorSlope = 0.7 * tierMeanSlope[t.tier] + 0.3 * clamp(globalLogitDrift, -0.5, 1.2);
      const rawShrunk = shrinkW * rawSlopes[i] + (1 - shrinkW) * priorSlope;
      const shrunkSlope = lastR >= 95 ? Math.min(rawShrunk, 0.15) : rawShrunk;
      // Damped extrapolation over du
      const effDu = Math.sqrt(du * Math.min(du, 1.5));
      medZ = lastZ + shrunkSlope * effDu;

      const tierMult = t.tier === 'platinum' ? 1.15 : t.tier === 'gold' ? 1.1 : 1.0;
      const horizonSigma = 0.42 * Math.sqrt(horizonDays) * tierMult;
      const poolSigma = lastSnap.players_tracked < 3000 ? 0.45 : 0.15;
      spreadZ = Math.hypot(horizonSigma, rawResiduals[i] * 0.9, poolSigma);
      if (lastR >= 99.5) spreadZ = Math.min(spreadZ, 0.35);
    }

    const qs = T8_Q.map((zq) => Number(invLogit(medZ + zq * spreadZ).toFixed(4)));
    for (let k = 1; k < qs.length; k++) {
      if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
    }
    outTrophies.push({ id: t.id, q: qs });
  }

  return { trophies: outTrophies };
}

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });

const files = readdirSync(inDir).filter((f) => f.endsWith('.in')).sort();
for (const file of files) {
  const data = JSON.parse(readFileSync(join(inDir, file), 'utf8')) as CaseInput;
  const result = forecastCase(data);
  const outName = file.replace(/\.in$/, '.out');
  writeFileSync(join(outDir, outName), JSON.stringify(result));
}
