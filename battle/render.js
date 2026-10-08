// Сообщения движка для чата. Каждое ≤ 500 символов.

import { renderHpBar, renderPlayerStatus } from '../src/renderer.js';
import { clip, plural } from '../src/text.js';
import { contribution } from './state.js';

const MAX = 500;
const PLAYER_FORMS = ['боец', 'бойца', 'бойцов'];
const TURN_FORMS = ['ход', 'хода', 'ходов'];

const TARGET_TEXT = {
  single: 'в одного!',
  aoe: 'по всем!',
  debuff: 'на отряд!',
  buff: 'на себя!',
};

export function renderInvite(config) {
  const n = config.BATTLE.lobbySeconds;
  return `📜 Запись: !join (класс выдаётся случайно), ${n} ${plural(n, ['секунда', 'секунды', 'секунд'])}`;
}

const JOIN_HINT = 'Напиши !я для получения информации';

// Ответ одному игроку (joinReplyMode = always).
export function renderJoinNotice(displayName) {
  return clip(`@${displayName}, ты в отряде! ${JOIN_HINT}`, MAX);
}

// Сводка вступлений (auto, batch): «⚔️ В отряд вступили: @a, @b. Напиши !я для получения информации»,
// разбитая на сообщения ≤ 500 символов.
export function renderJoinBatch(names) {
  const messages = [];
  const tail = `. ${JOIN_HINT}`;
  let current = [];
  const build = (list) => `⚔️ В отряд вступили: ${list.map((n) => `@${n}`).join(', ')}${tail}`;
  for (const name of names) {
    if (current.length > 0 && build([...current, name]).length > MAX) {
      messages.push(build(current));
      current = [];
    }
    current.push(name);
  }
  if (current.length > 0) messages.push(clip(build(current), MAX));
  return messages;
}

export function renderLobbyProgress(count) {
  return `👥 В отряде уже ${count} ${plural(count, PLAYER_FORMS)}`;
}

export function renderBossHp(boss) {
  return clip(`${boss.emoji} ${boss.name}: ❤️ ${renderHpBar(boss)}`, MAX);
}

// «⚔️ Ход 3/15 | 🐉 Ржавый Дракон Бездны [██████░░░░] 7200/12000 | ⚠️ Готовит «Огненное дыхание» по всем! | !атака !навык !особый (40 с)»
export function renderTurnHeader(state, config) {
  const { boss, pendingTelegraph: skill } = state;
  const threat = skill ? `⚠️ Готовит «${skill.name}» ${TARGET_TEXT[skill.kind] ?? ''}`.trim() : '⚠️ Босс медлит';
  return clip(
    `⚔️ Ход ${state.turn}/${config.BATTLE.maxTurns} | ${boss.emoji} ${boss.name} ${renderHpBar(boss)} | ${threat} | !атака !навык !особый (${state.turn === 1 ? config.BATTLE.firstTurnWindowSeconds ?? config.BATTLE.turnWindowSeconds : config.BATTLE.turnWindowSeconds} с)`,
    MAX,
  );
}

function namesList(names, max) {
  const shown = names.slice(0, max).map((n) => `@${n}`).join(', ');
  return names.length > max ? `${shown} и ещё ${names.length - max}` : shown;
}

// Итог хода. Возвращает 1 или 2 сообщения; maxMessages = 1 — всё в одно (с обрезкой).
// «📊 Ход 3: чат нанёс 1840 урона (босс −15%). 💚 Вылечено 420. Огненное дыхание задело 12 бойцов, пали: @a, @b. Топ урона: @x 220, @y 190, @z 150»
export function renderTurnSummary(state, config, { maxMessages = 2 } = {}) {
  const log = state.turnLog;
  const boss = state.boss;
  const lostPct = Math.max(0, Math.round(((log.bossHpStart - boss.hp) / boss.maxHp) * 100));

  const parts = [`📊 Ход ${state.turn}: чат нанёс ${log.chatDamage} урона (босс −${lostPct}%).`];
  if (log.streamerDamage > 0) parts.push(`🎯 Стример снял ${log.streamerDamage}.`);
  for (const note of log.notes ?? []) parts.push(`${note}.`);
  if (log.healed > 0) parts.push(`💚 Вылечено ${log.healed}.`);
  if (log.revived.length > 0) parts.push(`✨ Поднялись: ${namesList(log.revived, config.BATTLE.maxNamesInSummary)}.`);
  if (log.bossAction) parts.push(`${log.bossAction}.`);
  if (log.fallen.length > 0) parts.push(`💀 Пали: ${namesList(log.fallen, config.BATTLE.maxNamesInSummary)}.`);

  const top = Object.entries(log.damageBy)
    .filter(([, dmg]) => dmg > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([userId, dmg]) => `@${state.registry.get(userId)?.displayName ?? userId} ${dmg}`);
  const topText = top.length > 0 ? `🏅 Топ урона: ${top.join(', ')}` : '';

  const main = parts.join(' ');
  const single = topText ? `${main} ${topText}` : main;
  if (single.length <= MAX || maxMessages === 1) return [clip(single, MAX)];
  return [clip(main, MAX), clip(topText, MAX)].filter(Boolean);
}

function topContributors(state, n = 3) {
  return [...state.registry.values()]
    .filter((p) => contribution(p) > 0)
    .sort((a, b) => contribution(b) - contribution(a) || (a.userId < b.userId ? -1 : 1))
    .slice(0, n)
    .map((p) => `@${p.displayName} ${contribution(p)}`);
}

export function renderVictory(state) {
  const lastHit = state.registry.get(state.lastHitUserId);
  const top = topContributors(state);
  return clip(
    `🏆 Победа! ${state.boss.emoji} ${state.boss.name} повержен за ${state.turn} ${plural(state.turn, TURN_FORMS)}.` +
      (lastHit ? ` Добивающий удар: @${lastHit.displayName}.` : '') +
      (top.length ? ` Лучшие по вкладу: ${top.join(', ')}.` : ''),
    MAX,
  );
}

export function renderDefeat(state, outcome) {
  const pct = Math.round((state.boss.hp / state.boss.maxHp) * 100);
  const top = topContributors(state);
  const head = outcome === 'wipe'
    ? `💀 Отряд пал на ходу ${state.turn}. ${state.boss.emoji} ${state.boss.name} остался с ${pct}% HP.`
    : `🏃 ${state.boss.emoji} ${state.boss.name} убегает с ${pct}% HP после ${state.turn} ${plural(state.turn, TURN_FORMS)}.`;
  return clip(`${head}${top.length ? ` Лучшие по вкладу: ${top.join(', ')}.` : ''}`, MAX);
}

// Начало итогового сообщения боя, к которому движок дописывает начисление очков (часть 6).
export function renderEndHead(state, outcome) {
  const { boss } = state;
  if (outcome === 'victory') {
    const lastHit = state.registry.get(state.lastHitUserId);
    return clip(`🏆 Победа! ${boss.emoji} ${boss.name} повержен за ${state.turn} ${plural(state.turn, TURN_FORMS)}.`
      + (lastHit ? ` Добивающий удар: @${lastHit.displayName}.` : ''), 300);
  }
  const pct = Math.round((boss.hp / boss.maxHp) * 100);
  return clip(outcome === 'wipe'
    ? `💀 Отряд пал на ходу ${state.turn}. ${boss.emoji} ${boss.name} остался с ${pct}% HP.`
    : `🏃 ${boss.emoji} ${boss.name} убегает с ${pct}% HP после ${state.turn} ${plural(state.turn, TURN_FORMS)}.`, 300);
}

export function renderCancelled(reason) {
  return reason === 'noPlayers' ? '😴 Никто не пришёл, босс ушёл.' : '🛑 Бой отменён.';
}

// Ответ на !я: персонаж в формате renderJoinInfo с текущими HP и маной (часть 2).
export function renderMe(player, config) {
  return renderPlayerStatus(player, config);
}
