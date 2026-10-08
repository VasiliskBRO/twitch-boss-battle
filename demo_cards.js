import { CONFIG } from './src/config.js';
import {
  createStreamerState, parseCardCommand, playCard, onPhaseChange, consumePendingCard, tickTurn,
  renderHand, renderHandPrivate, getCard, toJSON, fromJSON,
} from './src/streamer_cards.js';

// Воспроизводимый rng (mulberry32) по контракту rng(min, max) → целое из [min, max].
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

const PRIVATE = { ...CONFIG, STREAMER: { ...CONFIG.STREAMER, handVisibility: 'private' } };
const STREAMER = { isBroadcaster: true, isModerator: false };
const VIEWER = { isBroadcaster: false, isModerator: false };
const KIND = { help: 'помощь', hinder: 'помеха' };
const chat = (msg) => console.log(`  [чат ${String(msg.length).padStart(3)}] ${msg}`);
const bot = (msg) => console.log(`  [консоль]   ${msg}`);
const note = (msg) => console.log(`  · ${msg}`);

// ---------- 1. Раздачи для 5 seed ----------
console.log('=== 1. ТЕСТОВЫЕ РАЗДАЧИ ===');
for (const seed of [1, 7, 42, 1337, 2024]) {
  const state = createStreamerState(makeRng(seed));
  const kinds = state.hand.map((id) => KIND[getCard(id).kind]).join(', ');
  console.log(`\nseed ${seed} (${kinds}):`);
  chat(renderHand(state));
  console.log('  при handVisibility = private:');
  chat(renderHand(state, PRIVATE));
  bot(renderHandPrivate(state, PRIVATE));
}

// ---------- 2. Сценарий ----------
console.log('\n=== 2. СЦЕНАРИЙ: РОЗЫГРЫШ, ЗАТЕМ ФАЗА 2 И МОМЕНТ СТРИМЕРА ===');
const rng = makeRng(42);
let now = 1_700_000_000_000; // внедрённые часы
let state = createStreamerState(rng);

console.log('\nХод 1. Начало боя.');
chat(renderHand(state));

const tryPlay = (who, roles, text, turn) => {
  const index = parseCardCommand(text);
  note(`${who}: «${text}» → parseCardCommand = ${index}`);
  const r = playCard(state, index, who, roles, turn, now, rng);
  if (r.ok) {
    chat(r.announce);
    note(`эффекты для части 5 (applyAt = ${r.applyAt}): ${JSON.stringify(r.effects)}`);
  } else if (r.reply) {
    chat(r.reply);
    note(`отказ: ${r.reason}`);
  } else {
    note(`отказ: ${r.reason}, в чат ничего не пишем`);
  }
  return r;
};

tryPlay('зритель', VIEWER, '!карта 1', 1);
tryPlay('стример', STREAMER, '!КАРТА   2 давай', 1);
chat(renderHand(state));
note(`часть 5 забирает карту: ${consumePendingCard(state).card.name}`);
tryPlay('стример', STREAMER, '!карта 1', 1);
tickTurn(state, now);
note(`tickTurn → cooldownTurns = ${state.cooldownTurns}`);

now += 25_000;
console.log('\nХод 2.');
tryPlay('стример', STREAMER, '!карта 1', 2);
console.log('  … чат бьёт босса, HP падает ниже 66% → фаза 2');
const moment = onPhaseChange(state, 2, now, rng);
moment.messages.forEach(chat);
chat(renderHand(state));

now += 6_000;
note('через 6 секунд, окно момента ещё открыто');
tryPlay('стример', STREAMER, '!карта 4', 2);
tryPlay('стример', STREAMER, '!карта 3', 2);
note(`часть 5 забирает карту: ${(() => { const p = consumePendingCard(state); return `${p.card.name}, applyAt = ${p.applyAt}`; })()}`);
tryPlay('стример', STREAMER, '!карта 1', 2);
tickTurn(state, now);
note(`tickTurn → cooldownTurns = ${state.cooldownTurns}, окно ${state.momentUntilMs === null ? 'закрыто' : 'открыто'}`);

// Перезапуск бота посреди боя.
state = fromJSON(toJSON(state));
note('бот перезапущен: состояние восстановлено из toJSON/fromJSON');

now += 25_000;
console.log('\nХод 3.');
tryPlay('стример', STREAMER, '!карта 1', 3);
tickTurn(state, now);

now += 25_000;
console.log('\nХод 4.');
tryPlay('стример', STREAMER, '!карта 9', 4);
tryPlay('стример', STREAMER, '!карта 1', 4);
chat(renderHand(state));
note(`итог: сыграно карт ${state.usedCount}, в руке ${state.hand.length}`);

// ---------- 3. Тот же момент в режиме private ----------
console.log('\n=== 3. МОМЕНТ СТРИМЕРА ПРИ handVisibility = private ===');
const hidden = createStreamerState(makeRng(42), PRIVATE);
const hiddenMoment = onPhaseChange(hidden, 2, now, makeRng(5), PRIVATE);
hiddenMoment.messages.forEach(chat);
chat(renderHand(hidden, PRIVATE));
hiddenMoment.privateMessages.forEach(bot);
