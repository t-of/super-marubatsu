'use strict';
// スーパーマルバツゲームの AI の学習（依存なしの node、worker_threads で並列）。
//   node tools/train.js --work <作業フォルダ> [--minutes 480] [--games 2000] [--workers 9]
//     [--imitateGames 2000] [--imitateIterations 10000] [--arenaGames 400] [--arenaIterations 200]
// 同じコマンドをもう一度打てば、作業フォルダの続きから進む。--minutes を過ぎたら区切りのよい所で止まる。
// docs/private/specs/super-marubatsu.md「6. AI／学習」のとおり:
//   0. 手本（M10k どうし） → 1. 自己対戦 → 2. 学び直す → 3. 測って採用 → 4. くり返す
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const SMNet = require('../js/net.js');
const { fit } = require('./fit');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return typeof def === 'number' ? +v : v;
};
const WORK = arg('work');
if (!WORK) { console.log('--work <作業フォルダ> を付けてください'); process.exit(1); }
const MINUTES = arg('minutes', 480);
const GAMES = arg('games', 2000);
const WORKERS = arg('workers', 0) || undefined; // 0/未指定なら pool.js の既定（コア数-1）
const IMITATE_GAMES = arg('imitateGames', 2000);
const IMITATE_ITER = arg('imitateIterations', 10000);
const ARENA_GAMES = arg('arenaGames', 400);
const ARENA_ITER = arg('arenaIterations', 200);
const KEEP = 5; // 直近何世代ぶんの自己対戦を学習に使うか

const f = (p) => path.join(WORK, p);
fs.mkdirSync(WORK, { recursive: true });
const OUT = path.join(__dirname, '..', 'ai', 'net.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const t0 = Date.now();
const elapsedMin = () => (Date.now() - t0) / 60000;

const state = fs.existsSync(f('state.json'))
  ? JSON.parse(fs.readFileSync(f('state.json'), 'utf8'))
  : { round: 0, seconds: 0, best: null, failStreak: 0, lrScale: 1, history: [] };
const baseSeconds = state.seconds;
const save = () => { state.seconds = baseSeconds + (Date.now() - t0) / 1000; fs.writeFileSync(f('state.json'), JSON.stringify(state, null, 1)); };

// ---- 200 通りの決まった出だし（最初の 2 手）。仕様「強くなったときだけ採用」用 ----
function makeOpenings(n, seed) {
  const rand = require('../js/mcts.js').makeRng(seed);
  const openings = [];
  for (let i = 0; i < n; i++) {
    const a = (rand() * 81) | 0;
    let b = (rand() * 81) | 0;
    while (b === a) b = (rand() * 81) | 0; // 同じマスの重複だけ避ける
    openings.push([a, b]);
  }
  return openings;
}

async function selfPlayBatch(net, games, seed0, opts = {}) {
  const jobs = Array.from({ length: games }, (_, i) => pool.run({ kind: 'selfplay', net, seed: seed0 + i, ...opts }));
  return Promise.all(jobs);
}

// 200 通りの出だし × 先手後手の両方 = 400 局。勝率（a から見た）を返す
async function arenaMatch(a, b, games, openings, seed0) {
  const jobs = [];
  openings.slice(0, games / 2).forEach((op, i) => {
    jobs.push(pool.run({ kind: 'match', seed: seed0 + i * 2, opening: op, a, b, iterations: ARENA_ITER }).then((r) => (r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5)));
    jobs.push(pool.run({ kind: 'match', seed: seed0 + i * 2 + 1, opening: op, a: b, b: a, iterations: ARENA_ITER }).then((r) => (r.winner === 1 ? 1 : r.winner === 0 ? 0 : 0.5)));
  });
  const results = await Promise.all(jobs);
  return results.reduce((s, x) => s + x, 0) / results.length;
}

function writeGen(name, data) {
  fs.writeFileSync(f(`${name}.x`), Buffer.from(data.inputs.buffer, data.inputs.byteOffset, data.inputs.byteLength));
  fs.writeFileSync(f(`${name}.pi`), Buffer.from(data.policies.buffer, data.policies.byteOffset, data.policies.byteLength));
  fs.writeFileSync(f(`${name}.y`), Buffer.from(data.values.buffer, data.values.byteOffset, data.values.byteLength));
}
function readGen(name) {
  const buf = (ext, T, w) => { const b = fs.readFileSync(f(`${name}.${ext}`)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
  return { inputs: buf('x', Float32Array), policies: buf('pi', Float32Array), values: buf('y', Float32Array) };
}

(async () => {
  pool.start(WORKERS);
  console.log(`作業フォルダ ${WORK}  これまで ${Math.round(state.seconds / 60)} 分, ${state.round} 回`);

  // ---- 0. 手本（M10k どうし）: 最初の 1 回だけ ----
  if (!state.best) {
    if (!fs.existsSync(f('imitate.x'))) {
      console.log(`手本を集める（M10k どうし ${IMITATE_GAMES} 局）`);
      const results = await selfPlayImitate(IMITATE_GAMES, IMITATE_ITER);
      writeGen('imitate', results);
      save();
    }
    const data = readGen('imitate');
    const net = SMNet.createNet();
    console.log(`ネットを合わせる（${data.values.length} 局面ぶん）`);
    fit(net, data.inputs, data.policies, data.values, { epochs: 6, lr: 1e-3, log: console.log });
    const json = SMNet.toJSON(net);
    fs.writeFileSync(f('gen-0.json'), json);
    fs.writeFileSync(f('net-best.json'), json);
    fs.writeFileSync(OUT, json);
    state.best = { round: 0 };
    state.history.push({ round: 0, note: '手本（M10k）から学んだ最初のネット' });
    save();
    console.log('世代 0: 手本から学んだネットを採用（比べる相手がまだないため）');
  }

  const openings = makeOpenings(200, 777);

  while (elapsedMin() < MINUTES) {
    const round = state.round + 1;
    const r0 = Date.now();
    const best = JSON.parse(fs.readFileSync(f('net-best.json'), 'utf8'));

    // ---- 1. 自己対戦 ----
    const sp0 = Date.now();
    const games = await selfPlayBatch(best, GAMES, 20000 + round * GAMES, { iterFast: 80, iterSlow: 400, everyN: 4, temperatureMoves: 8, dirichlet: true });
    const spSeconds = (Date.now() - sp0) / 1000;
    const totalPositions = games.reduce((s, g) => s + g.count, 0);
    const totalMoves = games.reduce((s, g) => s + g.count * 4, 0); // 4 手に 1 手だけ記録するので、打った手はおよそ 4 倍
    const readsPerSec = Math.round((totalMoves * 200) / spSeconds); // 1 手あたり平均 200 回ほど読む見積もり
    {
      const D = SMNet.INPUT;
      const inputs = new Float32Array(totalPositions * D), policies = new Float32Array(totalPositions * 81), values = new Float32Array(totalPositions);
      let off = 0;
      for (const g of games) { inputs.set(g.inputs, off * D); policies.set(g.policies, off * 81); values.set(g.values, off); off += g.count; }
      writeGen(`self-${round}`, { inputs, policies, values });
    }

    // ---- 2. 学び直す（直近 KEEP 世代ぶん） ----
    const parts = [];
    for (let r = round; r > Math.max(0, round - KEEP); r--) if (fs.existsSync(f(`self-${r}.x`))) parts.push(readGen(`self-${r}`));
    const D = SMNet.INPUT;
    const total = parts.reduce((s, p) => s + p.values.length, 0);
    const X = new Float32Array(total * D), PI = new Float32Array(total * 81), Y = new Float32Array(total);
    let off = 0;
    for (const p of parts) { X.set(p.inputs, off * D); PI.set(p.policies, off * 81); Y.set(p.values, off); off += p.values.length; }
    const candidateNet = SMNet.load(best).net;
    const lr = 1e-3 * state.lrScale;
    const fitResult = fit(candidateNet, X, PI, Y, { epochs: 3, lr, log: () => {} });
    const candidateJson = SMNet.toJSON(candidateNet);

    // ---- 3. 測って採用 ----
    const winRate = await arenaMatch({ net: JSON.parse(candidateJson) }, { net: best }, ARENA_GAMES, openings, 40000 + round * 1000);
    const accepted = winRate >= 0.55;
    if (accepted) {
      fs.writeFileSync(f('net-best.json'), candidateJson);
      fs.writeFileSync(f(`gen-${round}.json`), candidateJson);
      fs.writeFileSync(OUT, candidateJson);
      state.failStreak = 0;
    } else {
      state.failStreak++;
      if (state.failStreak === 5) { state.lrScale *= 0.5; console.log('5 世代 採用なし。学習率を半分にする'); }
    }

    // 軽い M10k との勝率（参考値。厳密な測定は tools/arena.js）
    const m10kGames = Math.min(20, ARENA_GAMES);
    const m10kNet = accepted ? JSON.parse(candidateJson) : best;
    const m10kWin = await arenaMatch({ net: m10kNet }, {}, m10kGames, openings.slice(0, m10kGames), 90000 + round * 100);

    // 古い自己対戦の記録を消す
    if (fs.existsSync(f(`self-${round - KEEP}.x`))) for (const e of ['x', 'pi', 'y']) fs.rmSync(f(`self-${round - KEEP}.${e}`));

    state.round = round;
    const genMinutes = (Date.now() - r0) / 60000;
    state.history.push({ round, positions: totalPositions, readsPerSec, policyLoss: fitResult.policyLoss, valueLoss: fitResult.valueLoss, winRate, accepted, m10kWin, minutes: genMinutes });
    save();
    console.log(`世代 ${round}: 局 ${totalPositions * 4}  読み ${readsPerSec}/秒  誤差(方策/価値) ${fitResult.policyLoss.toFixed(3)}/${fitResult.valueLoss.toFixed(3)}  ${accepted ? '採用' : '見送り'}（対最良 ${(winRate * 100).toFixed(0)}%）  対M10k ${(m10kWin * 100).toFixed(0)}%  ${genMinutes.toFixed(1)} 分  計 ${Math.round(state.seconds / 60)} 分`);

    if (state.failStreak >= 10) {
      console.log('10 世代 採用なしのため止める');
      break;
    }
  }
  pool.stop();
})();

// 手本づくり: M10k どうしで対局し、局面（NN の入力）・読んだ回数の割合・結果を集める
async function selfPlayImitate(games, iterations) {
  const jobs = Array.from({ length: games }, (_, i) => pool.run({ kind: 'imitate', seed: 10000 + i, iterations }));
  const results = await Promise.all(jobs);
  const D = SMNet.INPUT;
  const total = results.reduce((s, r) => s + r.count, 0);
  const inputs = new Float32Array(total * D), policies = new Float32Array(total * 81), values = new Float32Array(total);
  let off = 0;
  for (const r of results) { inputs.set(r.inputs, off * D); policies.set(r.policies, off * 81); values.set(r.values, off); off += r.count; }
  return { inputs, policies, values };
}
