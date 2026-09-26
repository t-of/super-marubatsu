'use strict';
// スーパーマルバツゲームの AI の強さを測る（docs/private/specs/super-marubatsu.md「6. AI／強さの測り方」の 1〜3・5）。
//   node tools/arena.js [--net ai/net.json] [--work <学習の作業フォルダ>] [--games 200] [--matchGames 400] [--timeMs 1000] [--iterations 200] [--workers 9]
// 1. 世代の進み（--work があれば）: 採用した世代ごとに M1k・M10k・M100k・1 つ前の世代と 200 局ずつ
// 2. Elo の表（M1k = 0）
// 3. 「最強」の合格: 最良の NN + MCTS と、素の MCTS を同じ 1 手 1 秒で 400 局。90% 以上勝てば合格
// 5. 先手の勝率
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return typeof def === 'number' ? +v : v;
};
const NET_PATH = arg('net', path.join(__dirname, '..', 'ai', 'net.json'));
const WORK = arg('work', null);
const GAMES = arg('games', 200);
const MATCH_GAMES = arg('matchGames', 400);
const TIME_MS = arg('timeMs', 1000);
const ITERATIONS = arg('iterations', 200);
const WORKERS = arg('workers', 0) || undefined;

// 200 通り前後の決まった出だし。同じ出だしを先手後手 1 回ずつ打つので先手の有利が相殺される
function makeOpenings(n, seed) {
  const { makeRng } = require('../js/mcts.js');
  const rand = makeRng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (rand() * 81) | 0;
    let b = (rand() * 81) | 0;
    while (b === a) b = (rand() * 81) | 0;
    out.push([a, b]);
  }
  return out;
}

// side を { net } か {}（素の MCTS）で表し、iterations か timeMs で強さを決める
function side(net, opts) { return net ? { net, ...opts } : { ...opts }; }

// a と b を、決まった出だし × 先手後手の両方で games 局打つ。{ aWinRate, firstWinRate, results } を返す
async function playSet(a, b, games, openings, seedBase) {
  const jobs = [];
  const half = Math.ceil(games / 2);
  for (let i = 0; i < half; i++) {
    const op = openings[i % openings.length];
    jobs.push(pool.run({ kind: 'match', seed: seedBase + i * 2, opening: op, a, b }).then((r) => ({ side: 'a-first', winner: r.winner })));
    jobs.push(pool.run({ kind: 'match', seed: seedBase + i * 2 + 1, opening: op, a: b, b: a }).then((r) => ({ side: 'b-first', winner: r.winner })));
  }
  const results = await Promise.all(jobs);
  let aWins = 0, draws = 0, firstWins = 0, total = 0;
  for (const r of results) {
    total++;
    const aIsX = r.side === 'a-first';
    if (r.winner === -1) { draws++; aWins += 0.5; }
    else if ((r.winner === 0) === aIsX) aWins++;
    if (r.winner === 0) firstWins++;
    else if (r.winner === 1) { /* 後手勝ち */ } else firstWins += 0.5;
  }
  return { aWinRate: aWins / total, firstWinRate: firstWins / total, games: total };
}

// Bradley-Terry（勝率からの Elo）を、観測した勝率にいちばん合うように当てはめる。anchor の Elo は固定
function fitElo(names, matches, anchor) {
  const R = Object.fromEntries(names.map((n) => [n, 0]));
  const lr = 10;
  for (let step = 0; step < 2000; step++) {
    const grad = Object.fromEntries(names.map((n) => [n, 0]));
    for (const { a, b, rate, games } of matches) {
      const pred = 1 / (1 + 10 ** ((R[b] - R[a]) / 400));
      const err = (rate - pred) * games;
      grad[a] += err;
      grad[b] -= err;
    }
    for (const n of names) if (n !== anchor) R[n] += (lr * grad[n]) / 100;
  }
  return R;
}

(async () => {
  pool.start(WORKERS);
  const best = fs.existsSync(NET_PATH) ? JSON.parse(fs.readFileSync(NET_PATH, 'utf8')) : null;
  if (!best) { console.log(`${NET_PATH} が見つからないので、最強の合格テストはできません`); }
  const openings = makeOpenings(300, 555);

  const matches = []; // { a, b, rate(a から見た勝率), games }
  const names = new Set(['M1k', 'M10k', 'M100k']);

  // ---- 1. 世代の進み ----
  if (WORK) {
    const gens = fs.readdirSync(WORK).filter((f) => /^gen-\d+\.json$/.test(f))
      .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    console.log(`世代の進み: ${gens.length} 世代`);
    let prevName = null, prevNet = null;
    for (const g of gens) {
      const name = g.replace('.json', '');
      const net = JSON.parse(fs.readFileSync(path.join(WORK, g), 'utf8'));
      names.add(name);
      for (const [label, iters] of [['M1k', 1000], ['M10k', 10000], ['M100k', 100000]]) {
        const r = await playSet(side(net, { iterations: ITERATIONS }), side(null, { iterations: iters }), GAMES, openings, 1000);
        matches.push({ a: name, b: label, rate: r.aWinRate, games: r.games });
        console.log(`  ${name} vs ${label}: ${(r.aWinRate * 100).toFixed(1)}%`);
      }
      if (prevName) {
        const r = await playSet(side(net, { iterations: ITERATIONS }), side(prevNet, { iterations: ITERATIONS }), GAMES, openings, 2000);
        matches.push({ a: name, b: prevName, rate: r.aWinRate, games: r.games });
        console.log(`  ${name} vs ${prevName}: ${(r.aWinRate * 100).toFixed(1)}%`);
      }
      prevName = name; prevNet = net;
    }
  }

  // M1k・M10k・M100k どうしの Elo の基準を作る（互いの勝率も測る）
  const mLevels = [['M1k', 1000], ['M10k', 10000], ['M100k', 100000]];
  for (let i = 0; i < mLevels.length; i++) {
    for (let j = i + 1; j < mLevels.length; j++) {
      const [a, ai] = mLevels[i], [b, bi] = mLevels[j];
      const r = await playSet(side(null, { iterations: ai }), side(null, { iterations: bi }), GAMES, openings, 3000 + ai + bi);
      matches.push({ a, b, rate: r.aWinRate, games: r.games });
      console.log(`  ${a} vs ${b}: ${(r.aWinRate * 100).toFixed(1)}%`);
    }
  }

  // ---- 2. Elo の表 ----
  const R = fitElo([...names], matches, 'M1k');
  console.log('\nElo の表（M1k = 0）');
  for (const n of [...names].sort((x, y) => R[y] - R[x])) console.log(`  ${n.padEnd(10)} ${R[n].toFixed(0)}`);

  // ---- 3. 「最強」の合格: 同じ 1 手 1 秒で、最良の NN と素の MCTS を 400 局 ----
  let passed = null;
  if (best) {
    const r = await playSet(side(best, { timeMs: TIME_MS }), side(null, { timeMs: TIME_MS }), MATCH_GAMES, openings, 9000);
    passed = r.aWinRate >= 0.9;
    console.log(`\n「最強」の合格: NN 側の勝率 ${(r.aWinRate * 100).toFixed(1)}%（同じ 1 手 ${TIME_MS}ms） → ${passed ? '合格' : '不合格（素の MCTS を使う）'}`);
    // ---- 5. 先手の勝率 ----
    console.log(`先手の勝率: ${(r.firstWinRate * 100).toFixed(1)}%`);
  }

  pool.stop();
})();
