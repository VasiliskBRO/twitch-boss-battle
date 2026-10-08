// Модуль очков (часть 6): начисление за бой, рейтинг, звания, команды !очки и !топ.

import { CONFIG } from '../src/config.js';
import { computeAwards } from './awards.js';
import { checkNewTitles } from './titles.js';
import { renderMe, renderNoRecord, renderTop, renderAwardsSummary } from './render.js';

export { computeContribution, computeAwards, participantsOf } from './awards.js';
export { createFileStore, createMemoryStore, compareRecords } from './store.js';
export { checkNewTitles, topTitle, getTitleDef } from './titles.js';
export { renderMe, renderTop, renderAwardsSummary, renderNoRecord } from './render.js';

function newRecord(userId, displayName, nowMs) {
  return {
    userId,
    displayName,
    totalPoints: 0,
    battles: 0,
    wins: 0,
    mvps: 0,
    lastHits: 0,
    totalDamage: 0,
    totalHealing: 0,
    totalSupport: 0,
    bestBattlePoints: 0,
    titles: [],
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
  };
}

// Начисляет очки за бой ровно один раз на battleId. Возвращает
// { awards, newTitles: [{ userId, displayName, title }], messages, skipped? }.
export function processBattleResult(result, store, config = CONFIG, nowMs = Date.now()) {
  if (!result || result.outcome === 'cancelled') return { awards: [], newTitles: [], messages: [], skipped: 'cancelled' };
  if (store.isBattleProcessed(result.battleId)) return { awards: [], newTitles: [], messages: [], skipped: 'duplicate' };

  const { awards, mvpUserId } = computeAwards(result, config);
  const players = new Map(result.players.map((p) => [p.userId, p]));
  const newTitles = [];

  for (const a of awards) {
    const p = players.get(a.userId);
    store.update(a.userId, (rec) => {
      const r = rec ?? newRecord(a.userId, p.displayName, nowMs);
      r.displayName = p.displayName;
      r.totalPoints += a.total;
      r.battles += 1;
      if (result.outcome === 'victory') r.wins += 1;
      if (a.userId === mvpUserId) r.mvps += 1;
      if (a.lastHit > 0) r.lastHits += 1;
      r.totalDamage += p.stats.damage ?? 0;
      r.totalHealing += p.stats.healing ?? 0;
      r.totalSupport += p.stats.support ?? 0;
      r.bestBattlePoints = Math.max(r.bestBattlePoints, a.total);
      r.lastSeenAt = nowMs;
      for (const title of checkNewTitles(r, config)) {
        r.titles.push(title.id);
        newTitles.push({ userId: a.userId, displayName: p.displayName, title });
      }
      return r;
    });
  }

  store.markBattleProcessed(result.battleId);
  store.save(); // принудительная запись после каждого боя

  const text = renderAwardsSummary(result, awards, { newTitles, mvpUserId });
  return { awards, newTitles, mvpUserId, messages: text ? [{ text, to: 'chat', priority: 'normal' }] : [] };
}

// !очки (кулдаун на игрока) и !топ (общий кулдаун). cooldowns — сериализуемый объект
// состояния кулдаунов (движок хранит его в своём состоянии). Возвращает сообщения.
export function handleCommand(event, store, config = CONFIG, nowMs = Date.now(), cooldowns = {}) {
  const text = String(event?.text ?? '').trim().toLowerCase().split(/\s+/)[0];
  const P = config.POINTS;
  cooldowns.points ??= {};

  if (text === '!очки') {
    const last = cooldowns.points[event.userId];
    if (last != null && nowMs - last < P.pointsCooldownSeconds * 1000) return [];
    cooldowns.points[event.userId] = nowMs;
    const record = store.get(event.userId);
    const reply = record ? renderMe(record, store.rankOf(event.userId), config) : renderNoRecord(event.displayName ?? event.userId);
    return [{ text: reply, to: 'chat', priority: 'normal' }];
  }
  if (text === '!топ') {
    if (cooldowns.top != null && nowMs - cooldowns.top < P.topCooldownSeconds * 1000) return [];
    cooldowns.top = nowMs;
    return [{ text: renderTop(store.top(P.topSize)), to: 'chat', priority: 'normal' }];
  }
  return [];
}
