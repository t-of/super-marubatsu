'use strict';
// 対局をワーカー（worker_threads）に配って並列に打つ共通の道具。tools/train.js・tools/arena.js から使う。
// 依存なしの node（SESTET の tools/pool.js と同じ作り）。
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

// ---- ワーカー側: 1 局ぶんの仕事をこなして結果を返す ----
// job:
//   { kind: 'selfplay', net, seed, iterFast, iterSlow, everyN, opening, temperatureMoves, dirichlet }
//     いまの最良ネットで PUCT の自己対戦をし、局面（NN の入力）・読んだ回数の分布・そのあとの結果を記録する
//   { kind: 'match', a, b, seed, iterations, opening }
//     2 つの側（a・b はそれぞれ { net? } または {}（net なしは素の MCTS））で 1 局打ち、勝者を返す
if (!isMainThread) {
  const SMGame = require('../js/game.js');
  const SMNet = require('../js/net.js');
  const SMAI = require('../js/mcts.js');

  function openingMoves(state, opening) {
    // opening: 決まった出だし（打つ手の配列、0〜80）。合法でなければ途中で止める
    for (const m of opening || []) {
      if (!SMGame.canPlace(state, m)) break;
      SMGame.place(state, m);
    }
  }

  parentPort.on('message', (job) => {
    try {
      if (job.kind === 'selfplay') {
        parentPort.postMessage({ id: job.id, result: playSelfplayFull(job) });
      } else if (job.kind === 'match') {
        parentPort.postMessage({ id: job.id, result: playMatch(job) });
      } else if (job.kind === 'imitate') {
        parentPort.postMessage({ id: job.id, result: playImitate(job) });
      }
    } catch (err) {
      parentPort.postMessage({ id: job.id, error: err.stack || String(err) });
    }
  });

  // 手本（第 0 世代）: M10k どうしで打ち、各手のあとの「読んだ回数の分布」と局の結果を集める
  function playImitate({ seed, iterations = 10000, opening }) {
    const rand = SMAI.makeRng(seed);
    const state0 = SMGame.newGame();
    openingMoves(state0, opening);
    let state = state0;
    const recs = []; // { x, pi }
    while (!state.over) {
      const { root } = SMAI.runSearch(state, { iterations }, rand);
      const x = SMNet.encode(state, 0);
      const pi = new Float64Array(81);
      let total = 0;
      for (const [m, c] of root.children) { pi[m] = c.visits; total += c.visits; }
      if (total > 0) for (let i = 0; i < 81; i++) pi[i] /= total;
      recs.push({ x, pi, mover: state.turn });
      const move = SMAI.pickRootMove(root, rand);
      state = SMGame.cloneState(state);
      SMGame.place(state, move);
    }
    const winner = state.winner;
    const D = SMNet.INPUT;
    const inputs = new Float32Array(recs.length * D), policies = new Float32Array(recs.length * 81), values = new Float32Array(recs.length);
    recs.forEach((r, i) => {
      inputs.set(r.x, i * D);
      policies.set(r.pi, i * 81);
      values[i] = winner === -1 ? 0 : (winner === r.mover ? 1 : -1);
    });
    return { inputs, policies, values, count: recs.length, winner };
  }

  // 自己対戦（正式版）: 局面ごとに実際の x（270 個）も一緒に作る
  function playSelfplayFull({ net, seed, iterFast = 80, iterSlow = 400, everyN = 4, temperatureMoves = 8, dirichlet = true, opening, cPuct }) {
    const rand = SMAI.makeRng(seed);
    const loaded = SMNet.load(net);
    let state = SMGame.newGame();
    openingMoves(state, opening);
    const recs = []; // { x, pi, mover, rootValue }
    let ply = 0;
    while (!state.over) {
      const useSlow = ply % everyN === 0;
      const iterations = useSlow ? iterSlow : iterFast;
      const { root } = SMAI.runSearch(state, { iterations, net: loaded, cPuct }, rand);
      if (ply === 0 && dirichlet) {
        const moves = [...root.children.keys()];
        SMAI.addDirichletNoise(root, moves, 0.3, 0.25, rand);
      }
      if (useSlow) {
        const pi = new Float64Array(81);
        let total = 0;
        for (const [m, c] of root.children) { pi[m] = c.visits; total += c.visits; }
        if (total > 0) for (let i = 0; i < 81; i++) pi[i] /= total;
        let rootValue = 0;
        for (const c of root.children.values()) rootValue += (c.solved !== null ? c.solved : c.valueSum / Math.max(1, c.visits)) * (c.visits / Math.max(1, total));
        recs.push({ x: SMNet.encode(state, 0), pi, mover: state.turn, rootValue });
      }
      let move;
      if (ply < temperatureMoves) {
        const entries = [...root.children.entries()];
        const total = entries.reduce((s, [, c]) => s + c.visits, 0) || 1;
        let r = rand() * total, picked = entries[0][0];
        for (const [m, c] of entries) { r -= c.visits; if (r <= 0) { picked = m; break; } }
        move = picked;
      } else {
        move = SMAI.pickRootMove(root, rand);
      }
      SMGame.place(state, move);
      ply++;
    }
    const winner = state.winner;
    const D = SMNet.INPUT;
    const inputs = new Float32Array(recs.length * D), policies = new Float32Array(recs.length * 81), values = new Float32Array(recs.length);
    recs.forEach((r, i) => {
      inputs.set(r.x, i * D);
      policies.set(r.pi, i * 81);
      const finalV = winner === -1 ? 0 : (winner === r.mover ? 1 : -1);
      values[i] = finalV * 0.5 + r.rootValue * 0.5; // 結果と根の見積もりの平均
    });
    return { inputs, policies, values, count: recs.length, winner };
  }

  // 2 つの側を対局させ、勝者（0 = a が先手として勝った、など呼ぶ側で解釈）を返す
  function playMatch({ seed, opening, a, b, iterations = 200 }) {
    const rand = SMAI.makeRng(seed);
    const sides = [a, b].map((s) => (s && s.net ? { net: SMNet.load(s.net), iterations: s.iterations || iterations } : { net: null, iterations: s && s.iterations || iterations }));
    let state = SMGame.newGame();
    openingMoves(state, opening);
    while (!state.over) {
      const side = sides[state.turn];
      const { root } = SMAI.runSearch(state, { iterations: side.iterations, net: side.net }, rand);
      const move = SMAI.pickRootMove(root, rand);
      SMGame.place(state, move);
    }
    return { winner: state.winner };
  }
}

// ---- 呼ぶ側 ----
let workers = null;
const idle = [];
const waiting = [];
const pending = new Map();
let nextId = 0;

function start(n) {
  if (workers) return;
  workers = Array.from({ length: n || Math.max(1, os.cpus().length - 1) }, () => new Worker(__filename));
  workers.forEach((w) => w.on('message', (msg) => { const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg); }));
  idle.push(...workers);
}

function run(job) {
  return new Promise((resolve, reject) => {
    const go = (w) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        const q = waiting.shift();
        if (q) q(w); else idle.push(w);
        if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
      });
      w.postMessage({ id, ...job });
    };
    const w = idle.pop();
    if (w) go(w); else waiting.push(go);
  });
}

function stop() {
  if (workers) workers.forEach((w) => w.terminate());
  workers = null;
  idle.length = 0;
}

module.exports = { start, run, stop, path };
