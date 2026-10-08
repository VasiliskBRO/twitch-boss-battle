import { CONFIG } from './config.js';
import { plural, clip, fillTemplate } from './text.js';

// Модуль карт стримера: колода, рука, права и лимиты розыгрыша, «момент стримера».
// Эффекты к бою НЕ применяются — playCard кладёт карту в state.pendingCard,
// часть 5 забирает её через consumePendingCard.
// Часы внедряются: все функции получают nowMs (число миллисекунд) снаружи.

const STATE_VERSION = 1;
const CARD_FORMS = ['карта', 'карты', 'карт'];
const KIND_NAMES = { help: 'помощь', hinder: 'помеха' };

// Дескрипторы карт { id, name, emoji, kind, effects, announceText } с числами из конфига.
function buildCard(c) {
  const effects = structuredClone(c.effects);
  return {
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    kind: c.kind,
    effects,
    announceText: fillTemplate(c.announceText, effects),
  };
}

export function createDeck(config = CONFIG) {
  return config.STREAMER.CATALOG.map(buildCard);
}

export function getCard(cardId, config = CONFIG) {
  const entry = config.STREAMER.CATALOG.find((c) => c.id === cardId);
  if (!entry) throw new Error(`Unknown card: ${cardId}`);
  return buildCard(entry);
}

const kindsById = (deck) => Object.fromEntries(deck.map((c) => [c.id, c.kind]));

// Рука из handSize разных карт, минимум 1 помощь и 1 помеха. Повторяем выбор, пока рука
// не станет допустимой, — так все допустимые руки равновероятны.
export function createStreamerState(rng, config = CONFIG) {
  const deck = createDeck(config);
  const size = config.STREAMER.handSize;
  if (size < 2 || !deck.some((c) => c.kind === 'help') || !deck.some((c) => c.kind === 'hinder')) {
    throw new Error('Hand needs size >= 2 and both help and hinder cards in the catalog');
  }

  const kind = kindsById(deck);
  let hand;
  do {
    const ids = deck.map((c) => c.id);
    hand = [];
    for (let i = 0; i < size; i++) hand.push(ids.splice(rng(0, ids.length - 1), 1)[0]);
  } while (!(hand.some((id) => kind[id] === 'help') && hand.some((id) => kind[id] === 'hinder')));

  return {
    version: STATE_VERSION,
    hand,
    seen: [...hand], // карты, побывавшие в руке в этом бою
    cooldownTurns: 0,
    momentUntilMs: null,
    momentPhase: null,
    lastPlayedTurn: null,
    usedCount: 0,
    pendingCard: null,
    lastHandShownMs: null, // кулдаун !рука
  };
}

// Добор: нет помощи → помощь, нет помехи → помеха, иначе любая. Сначала из тех, что
// ещё не были в руке в этом бою; когда такие кончились — из любых (но не из текущей руки).
export function drawCard(state, rng, config = CONFIG) {
  const deck = createDeck(config);
  const kind = kindsById(deck);
  const kinds = new Set(state.hand.map((id) => kind[id]));
  const wantKind = !kinds.has('help') ? 'help' : !kinds.has('hinder') ? 'hinder' : null;
  const fits = (c) => !state.hand.includes(c.id) && (wantKind === null || c.kind === wantKind);

  let pool = deck.filter((c) => fits(c) && !state.seen.includes(c.id));
  if (pool.length === 0) pool = deck.filter(fits);
  if (pool.length === 0) return null;

  const card = pool[rng(0, pool.length - 1)];
  state.hand.push(card.id);
  if (!state.seen.includes(card.id)) state.seen.push(card.id);
  return card;
}

// «!карта 2», «!КАРТА   3», «!карта 2 пожалуйста» → номер (с 1). Иначе null.
// Номер вне руки здесь не проверяется — это делает canPlay (badIndex).
export function parseCardCommand(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().toLowerCase().match(/^!карта\s+(\d+)(?=\s|$)/);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 ? n : null;
}

function isAllowed(roles, config) {
  return roles?.isBroadcaster === true || (config.STREAMER.allowMods === true && roles?.isModerator === true);
}

export function isMomentOpen(state, nowMs) {
  return state.momentUntilMs !== null && nowMs < state.momentUntilMs;
}

// { ok, reason, moment }. reason: notAllowed | handEmpty | badIndex | alreadyPlayedThisTurn | cooldown.
// index (номер карты с 1) — необязательный: без него проверяются только права и лимиты.
export function canPlay(state, userId, roles, currentTurn, nowMs, index = undefined, config = CONFIG) {
  if (!isAllowed(roles, config)) return { ok: false, reason: 'notAllowed' };
  if (state.hand.length === 0) return { ok: false, reason: 'handEmpty' };
  if (index !== undefined && !(Number.isInteger(index) && index >= 1 && index <= state.hand.length)) {
    return { ok: false, reason: 'badIndex' };
  }
  // Пока часть 5 не забрала прошлую карту, новую не принимаем — иначе первая потеряется.
  if (state.pendingCard) return { ok: false, reason: 'alreadyPlayedThisTurn' };
  // Момент стримера: одна карта мимо лимитов «раз в N ходов» и «одна за ход».
  if (isMomentOpen(state, nowMs)) return { ok: true, reason: null, moment: true };
  if (state.lastPlayedTurn === currentTurn) return { ok: false, reason: 'alreadyPlayedThisTurn' };
  if (state.cooldownTurns > 0) return { ok: false, reason: 'cooldown' };
  return { ok: true, reason: null, moment: false };
}

// Проверяет права и лимиты, убирает карту из руки и ставит state.pendingCard.
// К бою ничего не применяет. Возвращает { ok, card, effects, announce, reason, reply, applyAt, fromMoment }:
//   announce — объявление для чата при успехе; reply — ответ в чат при ошибке (null = молчать).
// rng сейчас не используется (класс для «Проклятия» выбирает часть 5), оставлен по API из ТЗ.
export function playCard(state, index, userId, roles, currentTurn, nowMs, rng, config = CONFIG) {
  const check = canPlay(state, userId, roles, currentTurn, nowMs, index ?? NaN, config);
  if (!check.ok) {
    return {
      ok: false, card: null, effects: [], announce: null, reason: check.reason,
      reply: renderPlayError(check.reason, state, config), applyAt: null, fromMoment: false,
    };
  }

  const [cardId] = state.hand.splice(index - 1, 1);
  const card = getCard(cardId, config);
  const applyAt = check.moment ? 'nextTurnStart' : 'thisTurn';

  // После игры в окне действуют обычные правила кулдауна; окно расходуется.
  state.cooldownTurns = config.STREAMER.minTurnsBetween;
  state.lastPlayedTurn = currentTurn;
  state.usedCount++;
  if (check.moment) {
    state.momentUntilMs = null;
    state.momentPhase = null;
  }
  const fromMoment = check.moment === true;
  state.pendingCard = { cardId, applyAt, fromMoment, playedTurn: currentTurn };

  return {
    ok: true, card, effects: card.effects, announce: renderPlay(card, { moment: check.moment }),
    reason: null, reply: null, applyAt, fromMoment,
  };
}

// Для части 5: { card, effects, applyAt: 'thisTurn' | 'nextTurnStart', fromMoment, playedTurn } или null.
export function consumePendingCard(state, config = CONFIG) {
  if (!state.pendingCard) return null;
  const { cardId, applyAt, fromMoment = applyAt === 'nextTurnStart', playedTurn } = state.pendingCard;
  state.pendingCard = null;
  const card = getCard(cardId, config);
  return { card, effects: card.effects, applyAt, fromMoment, playedTurn };
}

// Конец хода. Кулдаун 2: сыграл на t → в конце t стало 1, в конце t+1 стало 0 → можно на t+2.
// Окно момента закрывается, только если передан nowMs и время вышло (окно открывается
// в конце хода, и безусловное закрытие убило бы его сразу). canPlay и так сверяет время.
export function tickTurn(state, nowMs = null) {
  if (state.cooldownTurns > 0) state.cooldownTurns--;
  if (nowMs !== null && state.momentUntilMs !== null && nowMs >= state.momentUntilMs) {
    state.momentUntilMs = null;
    state.momentPhase = null;
  }
  return state;
}

// Переход босса в новую фазу: +1 карта и окно момента на momentSeconds.
// Возвращает { card, messages (в чат), privateMessages (в консоль бота) }.
// При переходе через две фазы одним ударом вызывать для каждой: +2 карты, окно продлевается.
export function onPhaseChange(state, newPhase, nowMs, rng, config = CONFIG) {
  const card = drawCard(state, rng, config);
  state.momentUntilMs = nowMs + config.STREAMER.momentSeconds * 1000;
  state.momentPhase = newPhase;

  const isPrivate = config.STREAMER.handVisibility === 'private';
  return {
    card,
    messages: [renderMoment(newPhase, card, { handSize: state.hand.length, config })],
    privateMessages: isPrivate ? [renderHandPrivate(state, config)] : [],
  };
}

export function toJSON(state) {
  return JSON.stringify(state);
}

export function fromJSON(data) {
  const state = JSON.parse(data);
  if (state?.version !== STATE_VERSION || !Array.isArray(state.hand) || !Array.isArray(state.seen)) {
    throw new Error('Bad streamer state data');
  }
  return state;
}

// ---------- Сообщения (каждое ≤ 500) ----------

const cardLabel = (card) => `${card.emoji} ${card.name}`;

// public: «🃏 Рука стримера: [1] 🛡️ Щит  [2] 😡 Ярость  …»; private: только число карт.
export function renderHand(state, config = CONFIG) {
  const n = state.hand.length;
  if (config.STREAMER.handVisibility === 'private') {
    return `🃏 У стримера в руке ${n} ${plural(n, CARD_FORMS)}`;
  }
  if (n === 0) return '🃏 Рука стримера пуста';
  const list = state.hand.map((id, i) => `[${i + 1}] ${cardLabel(getCard(id, config))}`).join('  ');
  return clip(`🃏 Рука стримера: ${list}`, 500);
}

// Короткая строка руки для заголовка хода (≤ 120):
// «🃏 [1]🛡️ [2]😡 [3]🎯 — можно играть» | «… — пауза ещё 2 хода» | «🃏 рука пуста».
// В режиме private названий и значков нет: «🃏 3 карты — можно играть».
export function renderHandCompact(state, currentTurn, config = CONFIG) {
  const n = state.hand.length;
  if (n === 0) return '🃏 рука пуста';
  const cards = config.STREAMER.handVisibility === 'private'
    ? `${n} ${plural(n, CARD_FORMS)}`
    : state.hand.map((id, i) => `[${i + 1}]${getCard(id, config).emoji}`).join(' ');
  const blocked = state.cooldownTurns > 0 || state.lastPlayedTurn === currentTurn || state.pendingCard;
  const turns = Math.max(1, state.cooldownTurns);
  const status = blocked ? `пауза ещё ${turns} ${plural(turns, ['ход', 'хода', 'ходов'])}` : 'можно играть';
  return clip(`🃏 ${cards} — ${status}`, 120);
}

// Полная рука с короткими описаниями (для !рука).
export function renderHandFull(state, config = CONFIG) {
  if (state.hand.length === 0) return '🃏 Рука стримера пуста';
  const list = state.hand.map((id, i) => {
    const entry = config.STREAMER.CATALOG.find((c) => c.id === id);
    const card = getCard(id, config);
    const short = entry.short ? fillTemplate(entry.short, card.effects) : card.announceText;
    return `[${i + 1}] ${cardLabel(card)} — ${short}`;
  }).join(' · ');
  return clip(`🃏 Рука стримера: ${list}`, 500);
}

// Команда !рука: стример (модераторы — при allowMods), не чаще раза в handCommandCooldownSeconds.
// Возвращает сообщения { text, to }: при public полная рука в чат; при private в чат только
// число карт, а полная рука — на консоль бота. Посторонним и на кулдауне — пустой список.
export function showHand(state, roles, nowMs, config = CONFIG) {
  if (!isAllowed(roles, config)) return [];
  const cd = config.STREAMER.handCommandCooldownSeconds * 1000;
  if (state.lastHandShownMs != null && nowMs - state.lastHandShownMs < cd) return [];
  state.lastHandShownMs = nowMs;
  if (config.STREAMER.handVisibility === 'private') {
    return [
      { text: renderHand(state, config), to: 'chat' },
      { text: renderHandFull(state, config), to: 'console' },
    ];
  }
  return [{ text: renderHandFull(state, config), to: 'chat' }];
}

// Полная рука для консоли бота (в чат не отправлять).
export function renderHandPrivate(state, config = CONFIG) {
  if (state.hand.length === 0) return '[рука стримера] пусто';
  const list = state.hand.map((id, i) => {
    const card = getCard(id, config);
    return `[${i + 1}] ${cardLabel(card)} (${KIND_NAMES[card.kind]}): ${card.announceText}`;
  }).join(' | ');
  return clip(`[рука стримера] ${list}`, 500);
}

// «🃏 Стример играет «Ярость»! Урон босса +50% в этом ходу.»
export function renderPlay(card, { moment = false } = {}) {
  // Карта из момента применяется в начале следующего хода: «в этом ходу» там означает следующий.
  const text = moment ? card.announceText.replace('в этом ходу', 'в следующем ходу') : card.announceText;
  const when = moment ? ' Сработает в начале следующего хода.' : '';
  return clip(`🃏 Стример играет «${card.name}»! ${text}${when}`, 500);
}

// «⚡ Момент стримера! Босс на 66% HP. 15 секунд на карту (!карта 1-4). В руку добавлена: 🔮 Дар маны»
// В режиме private название добавленной карты не раскрывается.
export function renderMoment(phase, newCard, { handSize = null, config = CONFIG } = {}) {
  const threshold = config.PHASE_THRESHOLDS[phase - 2];
  const where = threshold !== undefined ? `Босс на ${Math.round(threshold * 100)}% HP.` : `Босс в фазе ${phase}.`;
  const range = handSize === null ? '!карта N' : handSize === 1 ? '!карта 1' : `!карта 1-${handSize}`;
  let added = '';
  if (newCard) {
    added = config.STREAMER.handVisibility === 'private'
      ? ' В руку добавлена новая карта.'
      : ` В руку добавлена: ${cardLabel(newCard)}`;
  }
  return clip(`⚡ Момент стримера! ${where} ${config.STREAMER.momentSeconds} секунд на карту (${range}).${added}`, 500);
}

// Ответ в чат на неудачный розыгрыш; null — промолчать.
export function renderPlayError(reason, state, config = CONFIG) {
  switch (reason) {
    case 'notAllowed':
      return config.STREAMER.replyToUnauthorized ? '🃏 Карты может играть только стример.' : null;
    case 'handEmpty':
      return '🃏 Рука стримера пуста.';
    case 'badIndex':
      return state.hand.length === 1 ? '🃏 Нет такой карты. Есть только !карта 1.' : `🃏 Нет такой карты. Выбери !карта 1-${state.hand.length}.`;
    case 'alreadyPlayedThisTurn':
      return '🃏 В этом ходу карта уже сыграна.';
    case 'cooldown':
      return `🃏 Карты перезаряжаются: следующая через ${state.cooldownTurns} ${plural(state.cooldownTurns, ['ход', 'хода', 'ходов'])}.`;
    default:
      return null;
  }
}
