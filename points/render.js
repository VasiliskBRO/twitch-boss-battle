// Сообщения модуля очков. Каждое ≤ 500 символов.

import { CONFIG } from '../src/config.js';
import { plural, clip } from '../src/text.js';
import { topTitle } from './titles.js';

const MAX = 500;
const POINT_FORMS = ['очко', 'очка', 'очков'];
const TURN_FORMS = ['ход', 'хода', 'ходов'];

// Собирает строку из обязательной части и необязательных элементов списка, пока влезает в лимит.
function fitList(prefix, items, suffix, max = MAX, sep = ' · ') {
  const shown = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i - 1;
    const tail = rest > 0 ? ` и ещё ${rest}` : '';
    const candidate = `${prefix}${[...shown, items[i]].join(sep)}${tail}${suffix}`;
    if (candidate.length > max) {
      const hidden = items.length - shown.length;
      return shown.length ? `${prefix}${shown.join(sep)} и ещё ${hidden}${suffix}` : null;
    }
    shown.push(items[i]);
  }
  return `${prefix}${shown.join(sep)}${suffix}`;
}

// «@ник — Убийца драконов | 1240 очков (#7 в рейтинге) | боёв 23, побед 15, MVP 4»
export function renderMe(record, rank, config = CONFIG) {
  const title = topTitle(record, config);
  const head = title ? `@${record.displayName} — ${title.name}` : `@${record.displayName}`;
  const pts = `${record.totalPoints} ${plural(record.totalPoints, POINT_FORMS)}`;
  const place = rank ? ` (#${rank} в рейтинге)` : '';
  return clip(`${head} | ${pts}${place} | боёв ${record.battles}, побед ${record.wins}, MVP ${record.mvps}`, MAX);
}

export function renderNoRecord(displayName) {
  return clip(`@${displayName}, у тебя ещё нет очков: заходи в бой через !join`, MAX);
}

// «🏆 Топ чата: 1. @a 5120 · 2. @b 4310 · …»
export function renderTop(entries) {
  if (entries.length === 0) return '🏆 Топ чата пока пуст: сыграйте первый бой!';
  const items = entries.map((r, i) => `${i + 1}. @${r.displayName} ${r.totalPoints}`);
  return fitList('🏆 Топ чата: ', items, '') ?? clip(`🏆 Топ чата: ${items[0]}`, MAX);
}

// Итог начисления за бой. newTitles: [{ userId, displayName, title }].
//   победа: «🏆 Победа за 9 ходов! MVP: @x (+312). Лучший вклад: 1. @x 312 · 2. @y 201 · 3. @z 187.
//            Новые звания: @y «Боец». Свои очки: !очки»
//   поражение: «💀 Босс ушёл... Участникам начислена часть очков: !очки»
//   отмена: null
// head: false — без вступления («🏆 Победа за N ходов!» / «💀 Босс ушёл...»), когда движок
// склеивает начисление со своим итоговым сообщением; maxLength — сколько места осталось.
export function renderAwardsSummary(result, awards, { newTitles = [], mvpUserId = null, head = true, maxLength = MAX } = {}) {
  if (!result || result.outcome === 'cancelled') return null;
  const text = buildAwardsSummary(result, awards, { newTitles, mvpUserId, head, maxLength });
  return head ? text : text.trim();
}

function buildAwardsSummary(result, awards, { newTitles, mvpUserId, head: withHead, maxLength }) {
  const LIMIT = maxLength;
  const outro = ' Свои очки: !очки';
  // Звания группируются по игроку: «@y «Боец», «Лучший в бою»».
  const byPlayer = new Map();
  for (const t of newTitles) {
    if (!byPlayer.has(t.userId)) byPlayer.set(t.userId, { displayName: t.displayName, names: [] });
    byPlayer.get(t.userId).names.push(`«${t.title.name}»`);
  }
  const titleItems = [...byPlayer.values()].map((p) => `@${p.displayName} ${p.names.join(', ')}`);

  if (result.outcome !== 'victory') {
    const lead = withHead ? '💀 Босс ушёл... ' : '';
    if (awards.length === 0) return clip(`${lead}Очки никому не начислены.`, LIMIT);
    const base = `${lead}Участникам начислена часть очков: !очки`;
    return titleItems.length ? fitList(`${base}. Новые звания: `, titleItems, '', LIMIT, ', ') ?? clip(base, LIMIT) : clip(base, LIMIT);
  }

  const head = withHead ? `🏆 Победа за ${result.turns} ${plural(result.turns, TURN_FORMS)}!` : '';
  if (awards.length === 0) return clip(`${head} Очки не начислены: никто не отправил достаточно команд.`, LIMIT);

  const byTotal = [...awards].sort((a, b) => b.total - a.total || (a.userId < b.userId ? -1 : 1));
  const mvp = awards.find((a) => a.userId === mvpUserId);
  const mvpText = mvp ? ` MVP: @${mvp.displayName} (+${mvp.total}).` : '';
  const topItems = byTotal.slice(0, 3).map((a, i) => `${i + 1}. @${a.displayName} ${a.total}`);

  // Звания отрезаются первыми, затем топ: обязательны заголовок, MVP и подсказка.
  let text = `${head}${mvpText}`;
  const withTop = fitList(`${text} Лучший вклад: `, topItems, '.', LIMIT - outro.length);
  if (withTop) text = withTop;
  if (titleItems.length) {
    const withTitles = fitList(`${text} Новые звания: `, titleItems, '.', LIMIT - outro.length, ', ');
    if (withTitles) text = withTitles;
  }
  return clip(`${text}${outro}`, LIMIT);
}
