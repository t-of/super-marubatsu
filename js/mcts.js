// スーパーマルバツゲームの AI（探索）。ブラウザでは <script src="./js/mcts.js"> のグローバル SMAI、
// node では require('./mcts.js') から使う（js/game.js と同じ読み込み方。node では game.js を require する）。
// docs/private/specs/super-marubatsu.md「6. AI」のとおり:
//   - 素の MCTS（UCT + MCTS-Solver、でたらめに最後まで打つ）
//   - NN（js/net.js）があれば PUCT（葉は NN の価値、方策を道しるべに、solver つき、木の使い回し）
// 画面から使う入口は SMAI.chooseMove(moves, opts) だけに固定する。
(function (global) {
  'use strict';

  const SMGame = typeof module !== 'undefined' && module.exports ? require('./game.js') : global.SMGame;
  const {
    newGame, replay, place, legalMoves, legalBoards, decided, cloneState, randomMove,
  } = SMGame;

  // ---- 種つきの乱数（テスト・学習で同じ棋譜を作れるように） ----
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function rand() {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // 勝ち 1・引き分け 0.5・負け 0（mover から見た値）
  function outcomeFor(winner, mover) {
    if (winner === -1) return 0.5;
    return winner === mover ? 1 : 0;
  }

  // 木のノード。mover = このノードを作った（1 手前に打った）側。root は mover: null
  function makeNode(state, mover) {
    return {
      state, mover,
      children: new Map(), // move -> node
      untried: null,       // 素の MCTS 用。まだ試していない手（遅延で作る）
      expanded: false,      // PUCT 用。NN で評価して子を作ったか
      prior: 0,             // PUCT 用。親からこの手を選ぶ事前確率
      visits: 0,
      valueSum: 0,
      solved: state.over ? outcomeFor(state.winner, mover) : null,
    };
  }

  // path の末尾（葉）の mover にとっての値 value を、木の上まで交互に反転しながら足す
  function backup(path, value) {
    let v = value;
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      node.visits++; // root にも積む（UCT・PUCT の探索項がこの数を使うため）
      if (node.mover !== null) node.valueSum += v;
      v = 1 - v;
    }
  }

  // 新しく分かった局面（path の末尾）から、上の未確定のノードへ確定を伝える（MCTS-Solver）
  function propagateSolved(path) {
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      if (node.solved !== null) continue;
      if (node.children.size === 0) break;
      let sawWin = false, best = -Infinity, allKnown = node.untried != null && node.untried.length === 0;
      for (const child of node.children.values()) {
        if (child.solved === null) { allKnown = false; continue; }
        if (child.solved === 1) { sawWin = true; break; }
        if (child.solved > best) best = child.solved;
      }
      if (sawWin) node.solved = 0;                 // 次の手番が勝てるなら、このノードを作った側は負け
      else if (allKnown && node.children.size > 0) node.solved = 1 - best; // 全部確定していれば、その最善を反転
      else break; // まだ分からない。これ以上は上に伝えられない
    }
  }

  // 確定ノードの solved（node.mover から見た値）から、実際の勝者を逆算する
  function winnerFromSolved(node) {
    if (node.solved === 0.5) return -1;
    return node.solved === 1 ? node.mover : 1 - node.mover;
  }

  // ---- UCT（素の MCTS）の選び方 ----
  const UCT_C = Math.SQRT2;
  function selectUCT(node, rand) {
    let best = null, bestScore = -Infinity, ties = 0;
    const logN = Math.log(node.visits);
    for (const child of node.children.values()) {
      const q = child.solved !== null ? (child.solved === 0.5 ? 0.5 : child.solved) : child.valueSum / child.visits;
      const score = q + UCT_C * Math.sqrt(logN / child.visits);
      if (score > bestScore + 1e-9) { best = child; bestScore = score; ties = 1; }
      else if (score > bestScore - 1e-9 && rand() < 1 / ++ties) { best = child; }
    }
    return best;
  }

  // 1 回分の反復（でたらめな最後まで打つ、素の MCTS）
  function plainIteration(root, rand) {
    let node = root;
    const path = [node];
    while (node.solved === null && !node.state.over) {
      if (node.untried === null) node.untried = legalMoves(node.state);
      if (node.untried.length > 0 || node.children.size === 0) break;
      node = selectUCT(node, rand);
      path.push(node);
    }
    let winner;
    if (node.state.over) {
      winner = node.state.winner;
    } else if (node.solved !== null) {
      winner = winnerFromSolved(node);
    } else {
      const i = (rand() * node.untried.length) | 0;
      const move = node.untried[i];
      node.untried[i] = node.untried[node.untried.length - 1];
      node.untried.pop();
      const cs = cloneState(node.state);
      place(cs, move);
      const child = makeNode(cs, node.state.turn);
      node.children.set(move, child);
      path.push(child);
      if (child.state.over) winner = child.state.winner;
      else {
        const rs = cloneState(child.state);
        let m;
        while (!rs.over) { m = randomMove(rs, rand); place(rs, m); }
        winner = rs.winner;
      }
    }
    backup(path, outcomeFor(winner, path[path.length - 1].mover));
    propagateSolved(path);
  }

  // ---- PUCT（NN あり）の選び方 ----
  function selectPUCT(node, cPuct) {
    let best = null, bestScore = -Infinity;
    const sqrtN = Math.sqrt(node.visits);
    for (const child of node.children.values()) {
      const q = child.solved !== null ? (child.solved === 0.5 ? 0.5 : child.solved) : (child.visits > 0 ? child.valueSum / child.visits : 0);
      const u = cPuct * child.prior * sqrtN / (1 + child.visits);
      const score = q + u;
      if (score > bestScore) { bestScore = score; best = child; }
    }
    return best;
  }

  // ルートに一様のディリクレのゆらぎを混ぜる（学習の自己対戦だけで使う）
  function addDirichletNoise(root, moves, alpha, frac, rand) {
    const g = moves.map(() => {
      // Marsaglia–Tsang 法ほど正確でなくてよいので、Gamma(alpha,1) を簡単な近似で作る
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += -Math.log(1 - rand());
      return Math.pow(rand(), 1 / alpha) * (sum / 12);
    });
    const total = g.reduce((a, b) => a + b, 0) || 1;
    moves.forEach((m, i) => {
      const child = root.children.get(m);
      if (child) child.prior = child.prior * (1 - frac) + (g[i] / total) * frac;
    });
  }

  function expandPUCT(node, net, rand) {
    const moves = legalMoves(node.state);
    const { policy, value } = net.evaluate(node.state);
    for (const m of moves) {
      const b = (m / 9) | 0, c = m % 9;
      const cs = cloneState(node.state);
      place(cs, m);
      const child = makeNode(cs, node.state.turn);
      child.prior = policy[m] || 1e-6;
      node.children.set(m, child);
    }
    node.expanded = true;
    return value; // node.state.turn から見た値（-1〜1）
  }

  function puctIteration(root, net, cPuct, rand) {
    let node = root;
    const path = [node];
    while (node.solved === null && !node.state.over && node.expanded) {
      node = selectPUCT(node, cPuct);
      path.push(node);
    }
    let value01; // path 末尾の mover から見た値（0〜1）
    if (node.state.over) {
      backup(path, outcomeFor(node.state.winner, node.mover));
      propagateSolved(path);
      return;
    }
    if (node.solved !== null) {
      backup(path, node.solved === 0.5 ? 0.5 : node.solved);
      propagateSolved(path);
      return;
    }
    const v = expandPUCT(node, net, rand); // node.state.turn（次の手番）から見た値
    value01 = (1 - v) / 2; // node.mover（node を作った側）から見た値に変える
    backup(path, value01);
    propagateSolved(path);
  }

  // ---- root から最善の手を選ぶ（勝ちがあれば勝ち、負け確定は避ける、それ以外は訪問数最大） ----
  function pickRootMove(root, rand) {
    let win = [];
    for (const [m, c] of root.children) if (c.solved === 1) win.push([m, c]);
    if (win.length) {
      win.sort((a, b) => b[1].visits - a[1].visits);
      return win[0][0];
    }
    let pool = [...root.children].filter(([, c]) => c.solved !== 0);
    if (pool.length === 0) pool = [...root.children];
    let bestMove = null, bestVisits = -1, ties = 0;
    for (const [m, c] of pool) {
      if (c.visits > bestVisits) { bestVisits = c.visits; bestMove = m; ties = 1; }
      else if (c.visits === bestVisits && rand() < 1 / ++ties) bestMove = m;
    }
    return bestMove;
  }

  // 小盤・大盤をすぐ取れる手（あれば見逃さない）。段階 1 の「でたらめ」用
  function forcedMoves(state, legal) {
    const mover = state.turn;
    let bigWin = null;
    const captures = [];
    for (const m of legal) {
      const b = (m / 9) | 0;
      const cs = cloneState(state);
      place(cs, m);
      if (cs.over && cs.winner === mover) { bigWin = m; break; }
      if (!((state.owner[mover] >> b) & 1) && ((cs.owner[mover] >> b) & 1)) captures.push(m);
    }
    return { bigWin, captures };
  }

  // ---- 探索本体（回数 or 時間で打ち切る） ----
  function runSearch(state, opts, rand) {
    const root = makeNode(cloneState(state), null);
    const net = opts.net;
    const cPuct = opts.cPuct || 1.5;
    const iterFn = net
      ? () => puctIteration(root, net, cPuct, rand)
      : () => plainIteration(root, rand);
    if (net) expandPUCT(root, net, rand); // ルートは先に展開しておく（訪問数で手を選ぶため）
    let iterations = 0;
    const t0 = now();
    const maxIter = opts.iterations || Infinity;
    const timeMs = opts.timeMs || Infinity;
    while (iterations < maxIter && (now() - t0) < timeMs) {
      iterFn();
      iterations++;
      if (root.solved !== null) break; // 根まで確定したら、それ以上読んでも変わらない
      if (iterations % 64 === 0 && (now() - t0) >= timeMs) break;
    }
    return { root, iterations, ms: now() - t0 };
  }

  // ---- 強さの段階（仕様「6. AI」の表。tools/arena.js で測った Elo（M1k = 0）を README「AI」に貼り、
  //      段階の間がだいたい 100〜200 の差になるよう決めた: つよい 410 → 達人 513 → 最強 601（見込み）。
  //      段階 4 は当初 iterations: 100 だったが、それだと段階 3 より弱かった（測って分かった）ので時間ぎめに変えた ----
  const LEVELS = [
    { id: 1, name: 'はじめて', iterations: 50, randomRate: 0.3, needsNet: false },
    { id: 2, name: 'ふつう', iterations: 1000, needsNet: false },
    { id: 3, name: 'つよい', iterations: 20000, needsNet: false },
    { id: 4, name: '達人', timeMs: 500, needsNet: true },
    { id: 5, name: '最強', timeMs: 2000, needsNet: true },
  ];

  // ---- 画面から使う入口 ----
  // moves: 打った手の履歴（0〜80）。opts: { iterations, timeMs, net, randomRate, seed }
  function chooseMove(moves, opts = {}) {
    const state = replay(moves || []);
    const legal = legalMoves(state);
    const t0 = now();
    if (legal.length === 0) return { move: null, iterations: 0, ms: now() - t0 };
    const rand = opts.seed != null ? makeRng(opts.seed) : Math.random;

    if (opts.randomRate && rand() < opts.randomRate) {
      const { bigWin, captures } = forcedMoves(state, legal);
      if (bigWin != null) return { move: bigWin, iterations: 0, ms: now() - t0 };
      const pool = captures.length ? captures : legal;
      const move = pool[(rand() * pool.length) | 0];
      return { move, iterations: 0, ms: now() - t0 };
    }

    const search = runSearch(state, opts, rand);
    const move = pickRootMove(search.root, rand);
    return { move, iterations: search.iterations, ms: search.ms };
  }

  const SMAI = {
    LEVELS, chooseMove, makeRng,
    // 学習・測定の道具（tools/）が使う内側の部品
    makeNode, backup, propagateSolved, outcomeFor, winnerFromSolved,
    plainIteration, puctIteration, expandPUCT, selectUCT, selectPUCT,
    pickRootMove, forcedMoves, runSearch, addDirichletNoise,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SMAI;
  else global.SMAI = SMAI;
})(typeof self !== 'undefined' ? self : this);
