// Начало и разрешение хода. Порядок шагов разрешения строго по ТЗ (раздел 5).
// ctx = { state, config, rng, now }.

import { pickTelegraph, getBossDamageMult, tickStatuses, tickBossCooldowns } from '../src/boss.js';
import { findMostWounded, pickSingleTarget } from '../src/players.js';
import {
  rollAction, rollDamageAmount, spendMana, regenMana, takeDamage, healPlayer, recordAbsorbed,
  tickDowned, clearCommand,
} from '../src/player_actions.js';
import { rollPersonalAction, startCooldown, tickCooldowns } from '../src/personal_skills.js';
import {
  consumePendingCard, onPhaseChange, tickTurn, getCard, renderHandCompact, renderHandPrivate,
} from '../src/streamer_cards.js';
import { rand01 } from '../src/rng.js';
import { clip } from '../src/text.js';
import { computeContribution, processBattleResult, renderAwardsSummary } from '../points/index.js';
import { activeAlive, participants, buildResult } from './state.js';
import {
  applyEffect, damageBoss, teamDamageMult, isSilenced, hasTeamEffect, classBaseDamage,
  applyBossDebuff, applyBossBuff, rollBossHitFraction, addSupport, fixedSupport,
} from './effects.js';
import {
  renderTurnHeader, renderTurnSummary, renderVictory, renderDefeat, renderCancelled, renderEndHead,
} from './render.js';

const DAMAGE_EFFECTS = new Set(['damage', 'dot', 'delayedDamage']);
const STAT_KEYS = ['damage', 'healing', 'absorbed', 'support'];
// priority: high — ход боя (заголовок, итог, момент, конец); normal — ответы на команды;
// low — то, что слой Твича может отбросить при перегрузке (вступления, прогресс лобби).
export const chat = (text, priority = 'high') => ({ text, to: 'chat', priority });
export const toConsole = (text, priority = 'normal') => ({ text, to: 'console', priority });

function newTurnLog(state) {
  return {
    bossHpStart: state.boss.hp,
    phaseHandled: state.boss.currentPhase, // фазы до этой уже обработаны (момент стримера открыт)
    chatDamage: 0,
    streamerDamage: 0,
    damageBy: {},
    healed: 0,
    revived: [],
    fallen: [],
    notes: [], // события карт для итога хода
    bossAction: '',
    cancelSources: [], // кто применил Антимагию против баффа этого хода
    fixedSupport: {}, // уже начисленная фиксированная поддержка: «вид:userId»
  };
}

// ---------- Начало хода (раздел 4) ----------

export function startTurn(ctx) {
  const { state, config, rng, now } = ctx;
  state.turn += 1;
  state.turnLog = newTurnLog(state);
  state.bossBuffCancelled = false;

  for (const p of activeAlive(state)) regenMana(p, config);

  // Карта из «момента стримера» применяется в начале хода, следующего за розыгрышем.
  const momentCards = [];
  if (state.queuedMomentCard) momentCards.push(getCard(state.queuedMomentCard, config));
  state.queuedMomentCard = null;
  if (state.streamer?.pendingCard?.fromMoment) momentCards.push(consumePendingCard(state.streamer, config).card);
  for (const card of momentCards) for (const e of card.effects) applyEffect(ctx, e);

  state.pendingTelegraph = structuredClone(pickTelegraph(state.boss, rng, config));
  state.turnEndsAtMs = now() + config.BATTLE.turnWindowSeconds * 1000;

  // В конец заголовка — короткая строка руки стримера; при закрытой руке подробная — на консоль.
  const hand = renderHandCompact(state.streamer, state.turn, config);
  const messages = [chat(clip(`${renderTurnHeader(state, config)} | ${hand}`, 500))];
  if (config.STREAMER.handVisibility === 'private') messages.push(toConsole(renderHandPrivate(state.streamer, config)));
  return messages;
}

// ---------- Разрешение хода (раздел 5) ----------

function healTarget(ctx, healer, target, fraction) {
  const v = ctx.config.BATTLE.healVariance;
  const variance = 1 - v + rand01(ctx.rng) * 2 * v;
  const restored = healPlayer(target, Math.round(target.maxHp * fraction * variance));
  healer.stats.healing += restored;
  ctx.state.turnLog.healed += restored;
}

// Новые фазы босса → «момент стримера» (часть 4). Пишет сообщения в out.
function openMoments(ctx, out) {
  const { state, config, rng, now } = ctx;
  const log = state.turnLog;
  while (log.phaseHandled < state.boss.currentPhase) {
    log.phaseHandled++;
    const res = onPhaseChange(state.streamer, log.phaseHandled, now(), rng, config);
    out.chat.push(...res.messages);
    out.console.push(...res.privateMessages);
  }
}

// baseMult — множитель урона босса без барьеров; reductionMult — Π(1 − pct) Магических барьеров.
function bossHit(ctx, target, fraction, baseMult, reductionMult, { taunted = false, tauntMult = 1 } = {}) {
  const { state, config } = ctx;
  const shields = state.teamEffects.filter((e) => e.type === 'absorb');
  const absorbPct = Math.max(0, ...shields.map((e) => e.pctMaxHp));
  const rawWithout = fraction * target.maxHp * baseMult * tauntMult;
  const raw = rawWithout * reductionMult;
  const absorbed = Math.min(raw, absorbPct * target.maxHp);
  const hpBefore = target.hp;
  const taken = takeDamage(target, Math.round(raw - absorbed), config);
  if (taunted) recordAbsorbed(target, taken);
  if (target.status === 'downed') state.turnLog.fallen.push(target.displayName);

  // Поддержка Барьера и Щита света: урон без эффектов минус полученный, поровну между источниками.
  const sources = [
    ...state.teamEffects.filter((e) => e.type === 'damageReduction').map((e) => e.sourceId),
    ...shields.map((e) => e.sourceId),
  ].filter((id) => id != null);
  if (sources.length > 0) {
    const wouldTake = Math.min(hpBefore, Math.round(Math.round(rawWithout) * (target.mods?.damageTakenMult ?? 1)));
    addSupport(ctx, sources, Math.max(0, wouldTake - taken));
  }

  // Контрудар: отражает долю реально полученного урона, засчитывается воину.
  const reflect = state.playerEffects.find((e) => e.type === 'reflect' && e.userId === target.userId);
  if (reflect && taken > 0) damageBoss(ctx, target.userId, Math.round(reflect.pct * taken), null, { trueDamage: true });
  return taken;
}

function bossAttack(ctx, skill) {
  const { state, config, rng } = ctx;
  const boss = state.boss;
  const mult = getBossDamageMult(boss, config);
  let reduction = 1;
  for (const e of state.teamEffects) if (e.type === 'damageReduction') reduction *= 1 - e.pct;
  const fraction = rollBossHitFraction(ctx, skill);
  const alive = activeAlive(state);
  if (alive.length === 0) return `«${skill.name}» не нашло целей`;

  if (skill.kind === 'single') {
    const taunts = state.playerEffects
      .filter((e) => e.type === 'taunt')
      .map((e) => ({ e, p: state.registry.get(e.userId) }))
      .filter(({ p }) => p && p.status === 'alive');
    let target;
    let opts = {};
    if (taunts.length > 0) {
      const pick = taunts[rng(0, taunts.length - 1)];
      target = pick.p;
      opts = { taunted: true, tauntMult: pick.e.mult };
    } else {
      const mode = rand01(rng) < config.BATTLE.bossTopDamageChance ? 'topDamage' : 'random';
      target = pickSingleTarget(alive, rng, { mode });
    }
    const taken = bossHit(ctx, target, fraction, mult, reduction, opts);
    const via = opts.taunted ? ' (провокация)' : '';
    return `«${skill.name}» по @${target.displayName}${via}: −${taken} HP`;
  }

  for (const target of alive) bossHit(ctx, target, fraction, mult, reduction);
  return `«${skill.name}» задело ${alive.length} ${alive.length % 10 === 1 && alive.length % 100 !== 11 ? 'бойца' : 'бойцов'}`;
}

export function resolveTurn(ctx) {
  const { state, config, rng } = ctx;
  const boss = state.boss;
  const log = state.turnLog;
  const out = { chat: [], console: [] };
  let outcome = null;
  // Статы на начало хода — для вклада за ход с потолком (часть 6).
  const statsBefore = new Map([...state.registry.values()].map((p) => [p.userId, { ...p.stats }]));

  // 1) Карта стримера.
  const card = consumePendingCard(state.streamer, config);
  if (card) {
    if (card.fromMoment) state.queuedMomentCard = card.card.id;
    else for (const e of card.effects) applyEffect(ctx, e);
  }

  // 2) Подготовка действий (по возрастанию userId).
  const actions = [];
  for (const p of activeAlive(state)) {
    const explicit = p.lastCommand?.turn === state.turn ? p.lastCommand.command : null;
    let command = explicit ?? 'атака';
    if (command !== 'атака' && isSilenced(state, p.classId)) command = 'атака';

    let d;
    if (command === 'особый') {
      // missChance уже брошен внутри rollPersonalAction (поле missed); на откате — fallback на !атака.
      d = rollPersonalAction(p, boss, rng, config);
      if (d.kind === 'personal') startCooldown(p, config);
    } else {
      d = rollAction(p, command, rng, { auto: explicit === null }, config);
    }
    spendMana(p, d.manaCost ?? 0);
    if (explicit !== null) p.stats.activeTurns += 1;
    actions.push({ player: p, d });
  }
  const personal = (a, pred) => (a.d.kind === 'personal' ? a.d.effects.filter(pred) : []);

  // 3) Не-урон эффекты: воскрешение → лечение → остальное.
  for (const a of actions) {
    for (const e of personal(a, (x) => x.type === 'reviveAll')) applyEffect(ctx, e, { sourceId: a.player.userId });
  }
  for (const a of actions) {
    if (a.d.kind === 'heal') {
      const target = findMostWounded(state.registry, state.turn, rng); // пересчёт перед каждым лечением
      if (target) healTarget(ctx, a.player, target, a.d.amount);
    } else if (a.d.kind === 'healAll') {
      for (const target of activeAlive(state)) healTarget(ctx, a.player, target, a.d.amount);
    }
  }
  for (const a of actions) {
    for (const e of personal(a, (x) => x.type !== 'reviveAll' && !DAMAGE_EFFECTS.has(x.type))) {
      applyEffect(ctx, e, { sourceId: a.player.userId });
    }
    if (a.d.kind === 'taunt') {
      state.playerEffects.push({ type: 'taunt', userId: a.player.userId, mult: a.d.amount, turnsLeft: 1 });
    }
  }

  // 4) Урон по боссу: яды прошлых ходов → отложенный урон → удары игроков.
  const teamMult = teamDamageMult(state);
  for (const dot of state.bossDots) {
    if (dot.startTurn > state.turn) continue;
    damageBoss(ctx, dot.sourceId, dot.perTick, null, { trueDamage: true });
    dot.turnsLeft--;
  }
  state.bossDots = state.bossDots.filter((d) => d.turnsLeft > 0);

  const due = state.delayedHits.filter((h) => h.dueTurn <= state.turn);
  state.delayedHits = state.delayedHits.filter((h) => h.dueTurn > state.turn);
  for (const h of due) damageBoss(ctx, h.sourceId, Math.round(h.amount * teamMult), h.damageType);

  for (const { player: p, d } of actions) {
    if (boss.hp <= 0) break;
    if (d.kind === 'damage') {
      damageBoss(ctx, p.userId, Math.round(d.amount * teamMult), d.damageType);
      continue;
    }
    const base = classBaseDamage(p, config);
    for (const e of personal({ d }, (x) => DAMAGE_EFFECTS.has(x.type))) {
      if (e.type === 'damage') {
        // mult уже итоговый: Берсерк и бонус фазы подставлены в части 3.
        for (let i = 0; i < e.hits && boss.hp > 0; i++) {
          const { amount } = rollDamageAmount(p, base * e.mult, rng, {}, config);
          damageBoss(ctx, p.userId, Math.round(amount * teamMult), e.damageType, { ignoreResist: e.ignoreResist });
        }
      } else if (e.type === 'dot') {
        state.bossDots.push({ sourceId: p.userId, perTick: Math.round(base * e.perTurnMult), turnsLeft: e.turns, startTurn: state.turn + 1 });
      } else if (e.type === 'delayedDamage') {
        const { amount } = rollDamageAmount(p, base * e.mult, rng, {}, config);
        state.delayedHits.push({ sourceId: p.userId, amount, damageType: e.damageType, dueTurn: state.turn + e.delayTurns });
      }
    }
  }

  // 5) Смерть босса и фазы.
  if (boss.hp <= 0) outcome = 'victory';
  else openMoments(ctx, out);

  // 6) Ответ босса.
  const skill = state.pendingTelegraph;
  if (!outcome && skill) {
    if (state.bossBuffCancelled) {
      log.bossAction = `✋ Антимагия сорвала «${skill.name}»`;
      for (const id of log.cancelSources) fixedSupport(ctx, id, 'antimagic');
    } else if (skill.kind !== 'buff' && hasTeamEffect(state, 'shield')) {
      state.teamEffects = state.teamEffects.filter((e) => e.type !== 'shield');
      log.bossAction = `🛡️ Щит заблокировал «${skill.name}»`;
    } else if (skill.kind === 'single' || skill.kind === 'aoe') {
      log.bossAction = `💥 ${bossAttack(ctx, skill)}`;
    } else if (skill.kind === 'debuff') {
      log.bossAction = `🌀 ${applyBossDebuff(ctx, skill)}`;
    } else if (skill.kind === 'buff') {
      log.bossAction = `🔺 ${applyBossBuff(ctx, skill)}`;
    }
    if (boss.hp <= 0) outcome = 'victory'; // добит отражением
    else openMoments(ctx, out);
  } else if (outcome === 'victory') {
    log.bossAction = '☠️ Босс повержен и не успел ударить';
  }

  // 7) Павшие и wipe.
  if (!outcome) {
    const parts = participants(state);
    if (parts.length > 0 && parts.every((p) => p.status === 'downed')) outcome = 'wipe';
  }

  // Вклад за ход с потолком: damage, healing, absorbed, support этого хода (часть 6).
  for (const p of state.registry.values()) {
    const before = statsBefore.get(p.userId) ?? {};
    const delta = Object.fromEntries(STAT_KEYS.map((k) => [k, (p.stats[k] ?? 0) - (before[k] ?? 0)]));
    const add = computeContribution(null, config, { turns: [delta], bossMaxHp: boss.maxHp });
    p.stats.contribution = Math.round(((p.stats.contribution ?? 0) + add) * 100) / 100;
  }

  // 8) Конец хода.
  endOfTurn(ctx);

  // 10) Конец боя по лимиту ходов.
  if (!outcome && state.turn >= config.BATTLE.maxTurns) outcome = 'defeat';

  // 9) Итог хода. Лимит: заголовок + не больше двух сообщений разрешения.
  const messages = [];
  if (outcome) {
    messages.push(...renderTurnSummary(state, config, { maxMessages: 1 }).map((text) => chat(text)));
    messages.push(...finishBattle(ctx, outcome));
  } else {
    const moment = out.chat.length > 0 ? clip(out.chat.join(' '), 500) : null;
    messages.push(...renderTurnSummary(state, config, { maxMessages: moment ? 1 : 2 }).map((text) => chat(text)));
    if (moment) messages.push(chat(moment));
    messages.push(...out.console.map((text) => toConsole(text)));
    messages.push(...startTurn(ctx));
  }
  return messages;
}

function tickList(list) {
  return list.filter((e) => {
    if (e.turnsLeft == null) return true; // щит — до первой атаки
    e.turnsLeft--;
    return e.turnsLeft > 0;
  });
}

function endOfTurn(ctx) {
  const { state, config, now } = ctx;
  tickStatuses(state.boss);
  tickBossCooldowns(state.boss);
  state.teamEffects = tickList(state.teamEffects);
  state.playerEffects = tickList(state.playerEffects);
  for (const p of state.registry.values()) {
    if (p.status === 'downed') tickDowned(p, config);
    tickCooldowns(p);
    clearCommand(p);
  }
  tickTurn(state.streamer, now());
  state.bossBuffCancelled = false;
}

// ---------- Конец боя (раздел 8) ----------

// Переводит бой в ended и (кроме отмены) один раз начисляет очки через часть 6.
// Итог и начисление идут одним сообщением, чтобы на ход было не больше трёх сообщений:
// «🏆 Победа! … Добивающий удар: @x. MVP: @x (+312). Лучший вклад: … Свои очки: !очки».
export function finishBattle(ctx, outcome, { reason = null } = {}) {
  const { state, config, now, store } = ctx;
  state.phase = 'ended';
  state.endedAtMs = now();
  state.turnEndsAtMs = null;
  state.lobbyEndsAtMs = null;
  state.result = buildResult(state, outcome);
  if (outcome === 'cancelled') return [chat(renderCancelled(reason))];

  const points = store ? processBattleResult(state.result, store, config, now()) : null;
  if (!points || points.skipped) {
    return [chat(outcome === 'victory' ? renderVictory(state) : renderDefeat(state, outcome))];
  }
  const head = renderEndHead(state, outcome);
  const body = renderAwardsSummary(state.result, points.awards, {
    newTitles: points.newTitles, mvpUserId: points.mvpUserId, head: false, maxLength: 500 - head.length - 1,
  });
  return [chat(body ? `${head} ${body}` : head)];
}
