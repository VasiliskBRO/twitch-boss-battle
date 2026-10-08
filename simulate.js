#!/usr/bin/env node
// Симулятор боёв без Твича: прогоняет полные бои через createBattleEngine с фейковыми часами.
//
//   node simulate.js --players 5,10,30,100 --battles 500 --seed 1 --scenario engaged --streamer random
//
// --scenario: engaged (60% игроков шлют явную команду за ход) | lurkers (15%) | mixed (35%);
//             можно списком: engaged,lurkers,mixed.
// --streamer: none | random (в каждый разрешённый ход и в окне момента играет случайную карту с вероятностью 0.5).

import { CONFIG } from './src/config.js';
import { createBattleEngine } from './battle/engine.js';
import { canPlay } from './src/streamer_cards.js';
import { computeAwards, participantsOf } from './points/index.js';

const SCENARIOS = { engaged: 0.60, lurkers: 0.15, mixed: 0.35 };
const COMMAND_MIX = [['!атака', 0.5], ['!навык', 0.3], ['!особый', 0.2]];
const STREAMER = { broadcaster: true, moderator: false };
const VIEWER = { broadcaster: false, moderator: false };

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { players: [5, 10, 30, 100], battles: 500, seed: 1, scenario: ['engaged'], streamer: 'random' };
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`Нет значения для ${key}`);
    if (key === '--players') args.players = value.split(',').map(Number);
    else if (key === '--battles') args.battles = Number(value);
    else if (key === '--seed') args.seed = Number(value);
    else if (key === '--scenario') args.scenario = value.split(',');
    else if (key === '--streamer') args.streamer = value;
    else throw new Error(`Неизвестный параметр ${key}`);
  }
  if (args.players.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--players: целые ≥ 1');
  if (!Number.isInteger(args.battles) || args.battles < 1) throw new Error('--battles: целое ≥ 1');
  for (const s of args.scenario) if (!(s in SCENARIOS)) throw new Error(`--scenario: ${Object.keys(SCENARIOS).join(' | ')}`);
  if (!['none', 'random'].includes(args.streamer)) throw new Error('--streamer: none | random');
  return args;
}

// mulberry32 по контракту rng(min, max) → целое из [min, max].
function makeRng(seed) {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

// ---------- Инварианты ----------

function checkInvariants(state, messages, config, violations, seed) {
  const fail = (what) => violations.push(`seed ${seed}, ход ${state.turn}: ${what}`);
  const bad = (v) => typeof v !== 'number' || Number.isNaN(v);
  for (const m of messages) if (m.text.length > 500) fail(`сообщение ${m.text.length} символов`);
  const boss = state.boss;
  if (boss && boss.hpFinal) {
    if (bad(boss.hp) || boss.hp < 0 || boss.hp > boss.maxHp) fail(`HP босса ${boss.hp}/${boss.maxHp}`);
  }
  for (const p of state.registry.values()) {
    if (bad(p.hp) || p.hp < 0 || p.hp > p.maxHp) fail(`HP ${p.userId} ${p.hp}/${p.maxHp}`);
    if (bad(p.mana) || p.mana < 0 || p.mana > p.maxMana) fail(`мана ${p.userId} ${p.mana}/${p.maxMana}`);
    for (const [k, v] of Object.entries(p.stats)) if (bad(v) || v < 0) fail(`stats.${k} ${p.userId} = ${v}`);
  }
  if (state.turn > config.BATTLE.maxTurns + 1) fail(`ходов ${state.turn}`);
}

// ---------- Один бой ----------

function runBattle({ players, seed, explicitShare, streamerMode, config }) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const rng = makeRng(seed);
  const act = makeRng(seed ^ 0x9e3779b9); // поведение чата — отдельный поток
  const chance = (p) => act(0, 999_999) < p * 1_000_000;
  const eng = createBattleEngine({ config, rng, now });
  const violations = [];
  const state = eng.getState();
  const step = (msgs) => checkInvariants(eng.getState(), msgs, config, violations, seed);

  step(eng.handleMessage({ userId: 'streamer', text: '!босс', roles: STREAMER }));
  const users = [];
  for (let i = 0; i < players; i++) {
    const userId = `u${i}`;
    users.push(userId);
    eng.handleMessage({ userId, displayName: `p${i}`, text: '!join', roles: VIEWER }); // класс выдаёт хеш
  }
  t += config.BATTLE.lobbySeconds * 1000;
  step(eng.tick());

  while (eng.getState().phase === 'running') {
    const st = eng.getState();
    t += 3000; // через 3 секунды после начала хода (окно момента ещё открыто)
    for (const userId of users) {
      if (!chance(explicitShare)) continue;
      let r = act(0, 999) / 1000;
      const cmd = COMMAND_MIX.find(([, w]) => (r -= w) < 0)?.[0] ?? '!атака';
      eng.handleMessage({ userId, text: cmd, roles: VIEWER });
    }
    if (streamerMode === 'random' && st.streamer.hand.length > 0
        && canPlay(st.streamer, 'streamer', { isBroadcaster: true }, st.turn, t).ok && chance(0.5)) {
      step(eng.handleMessage({ userId: 'streamer', text: `!карта ${act(1, st.streamer.hand.length)}`, roles: STREAMER }));
    }
    t = st.turnEndsAtMs;
    step(eng.tick());
  }

  const final = eng.getState();
  const { awards } = computeAwards(final.result, config);
  return { result: final.result, boss: final.boss, awards, violations };
}

// ---------- Сводка ----------

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function summarize(runs) {
  const outcomes = { victory: 0, defeat: 0, wipe: 0, cancelled: 0 };
  const byArchetype = {};
  const byWeakness = {};
  const lossHp = [];
  const turns = [];
  const fallenShare = [];
  for (const { result, boss } of runs) {
    outcomes[result.outcome]++;
    turns.push(result.turns);
    if (result.outcome === 'defeat' || result.outcome === 'wipe') lossHp.push(result.bossFinalHpPct);
    fallenShare.push(result.players.filter((p) => p.status === 'downed').length / result.players.length);
    const win = result.outcome === 'victory' ? 1 : 0;
    for (const [bucket, key] of [[byArchetype, boss.archetype], [byWeakness, boss.weakness]]) {
      bucket[key] ??= { wins: 0, total: 0 };
      bucket[key].wins += win;
      bucket[key].total++;
    }
  }
  const n = runs.length;
  return {
    win: outcomes.victory / n,
    defeat: outcomes.defeat / n,
    wipe: outcomes.wipe / n,
    avgTurns: avg(turns),
    lossHp: avg(lossHp),
    fallen: avg(fallenShare),
    byArchetype,
    byWeakness,
  };
}

// Вклад и очки по классам: средний вклад на игрока, средние очки на участника и отклонение
// вклада класса от среднего по всем игрокам.
// «Свой» показатель класса, который не связан с уроном: его вес поднимают, если класс отстаёт.
const SIGNATURE_STAT = { healer: 'healing', warrior: 'absorbed', mage: 'support', archer: null };
const STAT_NAMES = { damage: 'урон', healing: 'лечение', absorbed: 'принятый за других урон', support: 'поддержка' };

function classTable(runs, config) {
  const acc = {};
  let totalContribution = 0;
  let totalPlayers = 0;
  for (const { result, awards } of runs) {
    const points = new Map(awards.map((a) => [a.userId, a.total]));
    const participants = new Set(participantsOf(result, config).map((p) => p.userId));
    for (const p of result.players) {
      const c = (acc[p.classId] ??= { players: 0, contribution: 0, participants: 0, points: 0, parts: {} });
      c.players++;
      c.contribution += p.stats.contribution ?? 0;
      for (const [k, w] of Object.entries(config.POINTS.weights)) c.parts[k] = (c.parts[k] ?? 0) + (p.stats[k] ?? 0) * w;
      totalContribution += p.stats.contribution ?? 0;
      totalPlayers++;
      if (participants.has(p.userId)) {
        c.participants++;
        c.points += points.get(p.userId) ?? 0;
      }
    }
  }
  const mean = totalContribution / Math.max(1, totalPlayers);
  return Object.keys(config.PLAYER_CLASSES).filter((id) => acc[id]).map((id) => {
    const c = acc[id];
    const avgContribution = c.contribution / c.players;
    const partsTotal = Object.values(c.parts).reduce((a, b) => a + b, 0) || 1;
    const shares = Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, v / partsTotal]));
    return {
      classId: id,
      avgContribution,
      avgPoints: c.participants ? c.points / c.participants : NaN,
      relative: mean > 0 ? avgContribution / mean - 1 : 0,
      shares,
    };
  });
}

function printClassTable(rows, config) {
  console.log('  Класс       | Ср. вклад | Ср. очки участника | Вклад к среднему | Состав вклада');
  for (const r of rows) {
    const cls = config.PLAYER_CLASSES[r.classId];
    const rel = `${r.relative >= 0 ? '+' : '−'}${Math.abs(r.relative * 100).toFixed(1)}%`;
    const mix = Object.entries(r.shares).filter(([, v]) => v >= 0.01).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${STAT_NAMES[k]} ${Math.round(v * 100)}%`).join(', ');
    console.log(`  ${(cls.emoji + ' ' + cls.name).padEnd(11)} | ${r.avgContribution.toFixed(0).padStart(9)} | ${(Number.isFinite(r.avgPoints) ? r.avgPoints.toFixed(1) : '—').padStart(18)} | ${rel.padStart(16)} | ${mix}`);
  }
  const off = rows.filter((r) => Math.abs(r.relative) > 0.15);
  if (off.length === 0) {
    console.log('  ✅ Вклад классов в пределах ±15% от среднего');
    return;
  }
  for (const r of off) {
    const name = config.PLAYER_CLASSES[r.classId].name;
    const head = `  ⚖️ ${name}: вклад ${r.relative < 0 ? 'ниже' : 'выше'} среднего на ${Math.abs(r.relative * 100).toFixed(0)}% — `;
    const dominant = Object.entries(r.shares).sort((a, b) => b[1] - a[1])[0][0];
    const signature = SIGNATURE_STAT[r.classId];
    let advice;
    if (r.relative < 0) {
      advice = signature
        ? `поднять POINTS.weights.${signature} (${STAT_NAMES[signature]} сейчас ${Math.round((r.shares[signature] ?? 0) * 100)}% вклада класса)`
        : 'поднять урон класса (power навыков в PLAYER_CLASSES) — веса вклада ему не помогут';
    } else if (dominant === 'damage') {
      advice = `вклад в основном из урона (${Math.round(r.shares.damage * 100)}%): снизить урон класса (power в PLAYER_CLASSES), веса healing/absorbed/support тут не помогут`;
    } else {
      advice = `снизить POINTS.weights.${dominant} (${STAT_NAMES[dominant]} — ${Math.round(r.shares[dominant] * 100)}% вклада класса)`;
    }
    console.log(head + advice);
  }
}

function bucketText(bucket) {
  return Object.entries(bucket)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${pct(v.wins / v.total)} (${v.total})`)
    .join(', ');
}

function hints(scenario, rows, target) {
  const out = [];
  for (const [players, s] of rows) {
    if (s.win < target.min) {
      const why = s.wipe > s.defeat
        ? 'чаще всего отряд погибает: снизить урон навыков босса (DAMAGE_VALUES, power навыков, BOSS_PHASE_DAMAGE_MULT, dmgMult архетипов)'
        : `босс убегает с ~${pct(s.lossHp)} HP: снизить HP (BOSS_BASE_STATS.baseHp${players >= 30 ? ', и особенно perPlayerHp' : ''}) или поднять BATTLE.maxTurns`;
      out.push(`  ${players} игр.: победы ${pct(s.win)} < ${pct(target.min)} — ${why}`);
    } else if (s.win > target.max) {
      const why = s.avgTurns < 8
        ? 'бой слишком короткий: поднять HP (perPlayerHp, baseHp)'
        : s.fallen < 0.05
          ? `игроки почти не падают (${pct(s.fallen)}), урон босса ничего не решает: поднять HP (${players >= 30 ? 'perPlayerHp' : 'baseHp'}), затем урон босса`
          : 'поднять урон босса (DAMAGE_VALUES, BOSS_PHASE_DAMAGE_MULT) или HP (perPlayerHp)';
      out.push(`  ${players} игр.: победы ${pct(s.win)} > ${pct(target.max)} — ${why}`);
    }
  }
  if (out.length === 0) return [`  ✅ Цель ${pct(target.min)}–${pct(target.max)} достигнута для всех размеров`];
  const spread = rows.map(([, s]) => s.win);
  if (Math.max(...spread) - Math.min(...spread) > 0.3) {
    out.push('  ⚖️ Сильный разброс между малыми и большими группами: менять соотношение baseHp / perPlayerHp');
  }
  return out;
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = CONFIG;
  let totalViolations = [];

  for (const scenario of args.scenario) {
    const target = config.SIM_TARGETS[scenario];
    const started = Date.now();
    console.log(`\n=== Сценарий ${scenario} (${pct(SCENARIOS[scenario])} явных команд), стример: ${args.streamer}, боёв на размер: ${args.battles}, seed ${args.seed} ===`);
    console.log('Игроков | Победы | Поражения | Wipe   | Ср. ходов | HP босса при поражении | Павших к концу');
    const rows = [];
    const allRuns = [];
    for (const players of args.players) {
      const runs = [];
      for (let b = 0; b < args.battles; b++) {
        const seed = (args.seed * 1_000_003 + players * 10_007 + b * 97 + scenario.length) >>> 0;
        const run = runBattle({ players, seed, explicitShare: SCENARIOS[scenario], streamerMode: args.streamer, config });
        totalViolations = totalViolations.concat(run.violations);
        runs.push(run);
      }
      const s = summarize(runs);
      rows.push([players, s]);
      allRuns.push(...runs);
      console.log(
        `${String(players).padStart(7)} | ${pct(s.win).padStart(6)} | ${pct(s.defeat).padStart(9)} | ${pct(s.wipe).padStart(6)} | ${s.avgTurns.toFixed(1).padStart(9)} | ${pct(s.lossHp).padStart(22)} | ${pct(s.fallen).padStart(14)}`,
      );
    }
    for (const [players, s] of rows) {
      console.log(`  ${players} игр. — победы по архетипам: ${bucketText(s.byArchetype)}`);
      console.log(`  ${players} игр. — победы по слабости: ${bucketText(s.byWeakness)}`);
    }
    console.log(`Цель побед (SIM_TARGETS.${scenario}): ${pct(target.min)}–${pct(target.max)}`);
    for (const line of hints(scenario, rows, target)) console.log(line);
    console.log('Вклад и очки по классам (все размеры отряда вместе):');
    printClassTable(classTable(allRuns, config), config);
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)} с)`);
  }

  console.log(`\nИнварианты: ${totalViolations.length === 0 ? 'нарушений нет' : `${totalViolations.length} нарушений`}`);
  for (const v of totalViolations.slice(0, 20)) console.log(`  ✖ ${v}`);
  if (totalViolations.length > 0) process.exitCode = 1;
}

main();
