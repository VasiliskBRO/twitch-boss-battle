// Фасад движка боя: события чата и tick → сообщения { text, to: 'chat' | 'console', priority }.
// rng(min, max), now() (мс) и хранилище очков store (часть 6) внедряются снаружи.
// priority: high — ход боя; normal — ответы на команды; low — можно отбросить при перегрузке.

import { CONFIG } from '../src/config.js';
import { generateBoss, finalizeHp } from '../src/boss.js';
import { joinPlayer } from '../src/players.js';
import { setCommand } from '../src/player_actions.js';
import {
  createStreamerState, parseCardCommand, playCard, renderHand, renderHandPrivate, showHand,
} from '../src/streamer_cards.js';
import { renderSpawn, renderRoster } from '../src/renderer.js';
import { clip } from '../src/text.js';
import { createMemoryStore, handleCommand as handlePointsCommand } from '../points/index.js';
import { createInitialState, serializeState, deserializeState } from './state.js';
import { findSuggestion, availableCommands, renderSuggestion } from './suggest.js';
import { startTurn, resolveTurn, finishBattle, chat, toConsole } from './turn.js';
import {
  renderInvite, renderLobbyProgress, renderBossHp, renderMe, renderJoinNotice, renderJoinBatch,
  renderAutoNextNotice, renderBossWait, renderAutoNextStatus,
} from './render.js';

const ACTION_COMMANDS = { '!атака': 'атака', '!навык': 'навык', '!особый': 'особый' };
const POINTS_COMMANDS = new Set(['!очки', '!топ']);

// store — хранилище очков (по умолчанию в памяти; для бота — createFileStore из points/).
// isLive() — идёт ли сейчас стрим (для автобосса); без Твича считаем, что идёт.
export function createBattleEngine({ config = CONFIG, rng, now, store = createMemoryStore(), isLive = () => true }) {
  return makeEngine(createInitialState(), { config, rng, now, store, isLive });
}

// Восстановление после перезапуска: rng, now, store и isLive внедряются заново.
export function fromJSON(data, { config = CONFIG, rng, now, store = createMemoryStore(), isLive = () => true }) {
  return makeEngine(deserializeState(data), { config, rng, now, store, isLive });
}

function makeEngine(state, { config, rng, now, store, isLive }) {
  if (typeof rng !== 'function' || typeof now !== 'function') throw new Error('rng and now are required');
  // Старые сохранения (до части 6) могут не иметь новых полей.
  state.pointsCooldowns ??= {};
  state.suggestCooldowns ??= { users: {}, lastMs: null };
  state.joinQueue ??= [];
  state.joinQueueSinceMs ??= null;
  state.autoNext ??= null;
  state.autoNextArmed ??= false;
  state.bossWaitNoticeMs ??= null;
  const ctx = { state, config, rng, now, store, isLive };
  return {
    handleMessage: (event) => withPriority(handleMessage(ctx, event)),
    tick: () => withPriority(tick(ctx)),
    getState: () => state,
    toJSON: () => serializeState(state),
    resume: (nowMs) => resume(ctx, nowMs),
    store,
  };
}

// После перезапуска бота: у текущего окна (лобби или ход) остаётся не меньше
// BATTLE.resumeGraceSeconds, чтобы чат успел заметить, что бот вернулся. Пропущенные
// ходы пачкой не накатываются: tick по-прежнему разрешает не больше одного хода за раз.
function resume(ctx, nowMs) {
  const { state, config } = ctx;
  const minEnd = nowMs + config.BATTLE.resumeGraceSeconds * 1000;
  if (state.phase === 'lobby' && state.lobbyEndsAtMs < minEnd) state.lobbyEndsAtMs = minEnd;
  if (state.phase === 'running' && state.turnEndsAtMs < minEnd) state.turnEndsAtMs = minEnd;
  return [];
}

const withPriority = (messages) => messages.map((m) => ({ priority: 'normal', ...m }));

// ---------- Команды чата ----------

function handleMessage(ctx, event) {
  const text = String(event?.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text.startsWith('!')) return [];
  const [command] = text.split(' ');
  const roles = {
    isBroadcaster: event.roles?.broadcaster === true,
    isModerator: event.roles?.moderator === true,
  };
  const staff = roles.isBroadcaster || roles.isModerator;
  const { state, config, now } = ctx;

  if (command === '!босс') return staff ? boss(ctx) : [];
  if (command === '!стоп') {
    if (!staff) return [];
    if (state.phase === 'ended' && state.autoNextArmed) {
      state.autoNextArmed = false;
      return [chat('⏸️ Следующий босс не появится сам. Новый бой — !босс', 'normal')];
    }
    if (state.phase !== 'lobby' && state.phase !== 'running') return [];
    return [...flushJoins(ctx), ...finishBattle(ctx, 'cancelled')];
  }
  if (command === '!автобосс') return staff ? autoNextCommand(ctx, text) : [];
  if (command === '!join') return join(ctx, event); // текст после !join игнорируется
  if (command in ACTION_COMMANDS) {
    const player = state.registry.get(event.userId);
    if (state.phase === 'running' && player?.status === 'alive') setCommand(player, ACTION_COMMANDS[command], state.turn);
    return [];
  }
  if (command === '!я') return me(ctx, event);
  if (command === '!карта') return card(ctx, event, roles);
  if (command === '!рука') {
    if (state.phase !== 'running' || !state.streamer) return [];
    return showHand(state.streamer, roles, now(), config).map((m) => ({ ...m, priority: 'normal' }));
  }
  if (POINTS_COMMANDS.has(command)) return handlePointsCommand(event, ctx.store, config, now(), state.pointsCooldowns);
  return suggest(ctx, event, text, staff);
}

// Неизвестная команда: подсказываем, только если это близкая опечатка нашей команды
// (или набор в другой раскладке) и не сработал кулдаун. Чужие команды — молча.
function suggest(ctx, event, text, staff) {
  const { state, config, now } = ctx;
  if (!config.BATTLE.suggestCommands) return [];
  const [command, ...args] = text.split(' ');
  const suggestion = findSuggestion(command, availableCommands(state.phase, staff));
  if (!suggestion) return [];

  const t = now();
  const cd = state.suggestCooldowns;
  const last = cd.users[event.userId];
  if (last != null && t - last < config.BATTLE.suggestUserCooldownSeconds * 1000) return [];
  if (cd.lastMs != null && t - cd.lastMs < config.BATTLE.suggestGlobalCooldownSeconds * 1000) return [];
  cd.users[event.userId] = t;
  cd.lastMs = t;

  const full = [suggestion, ...args].join(' ').slice(0, 60); // аргументы сохраняем: «!карты 2» → «!карта 2»
  return [chat(renderSuggestion(event.displayName ?? event.userId, full), 'low')];
}

// Сколько секунд осталось до конца паузы после боя (0 — можно начинать).
function pauseLeftSeconds(ctx) {
  const { state, config, now } = ctx;
  if (state.phase !== 'ended') return 0;
  return Math.max(0, config.BATTLE.pauseAfterBattleSeconds - (now() - state.endedAtMs) / 1000);
}

const autoNextEnabled = ({ state, config }) => state.autoNext ?? config.BATTLE.autoNextBoss === true;

// !босс: во время паузы после боя — подсказка, сколько ждать; во время боя — молчание.
function boss(ctx) {
  const { state, config, now } = ctx;
  const left = pauseLeftSeconds(ctx);
  if (state.phase === 'ended' && left > 0) {
    const last = state.bossWaitNoticeMs;
    if (last != null && now() - last < config.BATTLE.bossWaitNoticeCooldownSeconds * 1000) return [];
    state.bossWaitNoticeMs = now();
    return [chat(renderBossWait(left), 'normal')];
  }
  return startLobby(ctx);
}

// !автобосс [вкл|выкл] — стример и модераторы. Без аргумента — показать, включён ли.
// Включили в паузе после победы или поражения — следующий бой начнётся сам и для этого боя
// (пауза уже прошла — на ближайшем tick).
function autoNextCommand(ctx, text) {
  const { state, config, isLive } = ctx;
  const arg = text.split(' ')[1];
  if (['вкл', 'on', 'да'].includes(arg)) {
    state.autoNext = true;
    if (state.phase === 'ended' && state.result?.outcome !== 'cancelled' && isLive() === true) state.autoNextArmed = true;
  } else if (['выкл', 'off', 'нет'].includes(arg)) {
    state.autoNext = false;
    state.autoNextArmed = false;
  }
  return [chat(renderAutoNextStatus(autoNextEnabled(ctx), config.BATTLE.pauseAfterBattleSeconds), 'normal')];
}

// Конец боя: при победе или поражении во время стрима и включённом автобоссе следующий бой начнётся сам.
function armAutoNext(ctx) {
  const { state, config, isLive } = ctx;
  state.autoNextArmed = autoNextEnabled(ctx) && state.result?.outcome !== 'cancelled' && isLive() === true;
  return state.autoNextArmed ? [chat(renderAutoNextNotice(config.BATTLE.pauseAfterBattleSeconds), 'low')] : [];
}

function startLobby(ctx) {
  const { state, config, rng, now } = ctx;
  const canStart = state.phase === 'idle' || (state.phase === 'ended' && pauseLeftSeconds(ctx) === 0);
  if (!canStart) return [];

  // Реестр прошлого боя сбрасывается только здесь: часть 6 успевает прочитать result.
  // Кулдауны !очки, !топ и подсказок и выбор автобосса переживают смену боя.
  const { pointsCooldowns, suggestCooldowns, autoNext } = state;
  Object.assign(state, createInitialState());
  state.pointsCooldowns = pointsCooldowns;
  state.suggestCooldowns = suggestCooldowns;
  state.autoNext = autoNext;
  state.battleId = `battle-${now()}-${rng(0, 999999)}`;
  state.boss = generateBoss(rng, config);
  state.phase = 'lobby';
  state.lobbyStartedAtMs = now();
  state.lobbyEndsAtMs = now() + config.BATTLE.lobbySeconds * 1000;
  return [chat(clip(renderSpawn(state.boss).join(' | '), 500)), chat(renderInvite(config))];
}

function join(ctx, event) {
  const { state, config, now } = ctx;
  if (state.phase !== 'lobby' && state.phase !== 'running') return [];
  const name = event.displayName ?? event.userId;
  const res = joinPlayer(state.registry, state.battleId, event.userId, name,
    state.turn, state.phase === 'running', { boss: state.boss, config });
  if (res.reason !== 'joined') return []; // повторный !join и полный отряд — молча

  const mode = config.BATTLE.joinReplyMode;
  if (mode === 'off') return [];
  if (mode === 'always') return [chat(renderJoinNotice(name), 'low')];
  // auto и batch: сводка раз в joinBatchSeconds (отправляет tick).
  if (state.joinQueue.length === 0) state.joinQueueSinceMs = now();
  state.joinQueue.push(name);
  return [];
}

// Отправляет накопленную сводку вступлений.
function flushJoins(ctx) {
  const { state } = ctx;
  if (state.joinQueue.length === 0) return [];
  const messages = renderJoinBatch(state.joinQueue).map((text) => chat(text, 'low'));
  state.joinQueue = [];
  state.joinQueueSinceMs = null;
  return messages;
}

function me(ctx, event) {
  const { state, config, now } = ctx;
  const player = state.registry.get(event.userId);
  if (!player) return [];
  const last = state.meCooldowns[event.userId];
  if (last != null && now() - last < config.BATTLE.meCooldownSeconds * 1000) return [];
  state.meCooldowns[event.userId] = now();
  return [chat(renderMe(player, config), 'normal')];
}

function card(ctx, event, roles) {
  const { state, config, rng, now } = ctx;
  if (state.phase !== 'running' || !state.streamer) return [];
  const r = playCard(state.streamer, parseCardCommand(event.text), event.userId, roles, state.turn, now(), rng, config);
  if (!r.ok) return []; // при ошибке — молчание
  const messages = [chat(r.announce, 'normal')];
  if (config.STREAMER.handVisibility === 'private') messages.push(toConsole(renderHandPrivate(state.streamer, config)));
  return messages;
}

// ---------- Время ----------

function tick(ctx) {
  const { state, config, now } = ctx;
  const t = now();
  const messages = [];

  // Сводка вступлений раз в joinBatchSeconds.
  if (state.joinQueue.length > 0 && t - state.joinQueueSinceMs >= config.BATTLE.joinBatchSeconds * 1000) {
    messages.push(...flushJoins(ctx));
  }

  if (state.phase === 'lobby') {
    if (t >= state.lobbyEndsAtMs) return [...messages, ...flushJoins(ctx), ...closeLobby(ctx)];
    const count = state.registry.size;
    const since = t - (state.lastLobbyProgressMs ?? state.lobbyStartedAtMs);
    if (count > 0 && count !== state.lastLobbyProgressCount && since >= config.BATTLE.lobbyProgressSeconds * 1000) {
      state.lastLobbyProgressMs = t;
      state.lastLobbyProgressCount = count;
      messages.push(chat(renderLobbyProgress(count), 'low'));
    }
    return messages;
  }

  // Автобосс: пауза прошла — новый бой, если стрим всё ещё идёт (если закончился — ждём !босс).
  if (state.phase === 'ended' && state.autoNextArmed && pauseLeftSeconds(ctx) === 0) {
    state.autoNextArmed = false;
    if (autoNextEnabled(ctx) && ctx.isLive() === true) messages.push(...startLobby(ctx));
    return messages;
  }

  // Просроченное окно (в том числе после перезапуска) разрешается на первом же tick.
  if (state.phase === 'running' && t >= state.turnEndsAtMs) {
    messages.push(...resolveTurn(ctx));
    if (state.phase === 'ended') messages.push(...armAutoNext(ctx));
  }
  return messages;
}

function closeLobby(ctx) {
  const { state, config, rng } = ctx;
  const count = state.registry.size;
  if (count < config.BATTLE.minPlayers) return finishBattle(ctx, 'cancelled', { reason: 'noPlayers' });

  finalizeHp(state.boss, count, rng, config);
  state.streamer = createStreamerState(rng, config);
  state.phase = 'running';
  state.lobbyEndsAtMs = null;

  const messages = [chat(renderBossHp(state.boss)), chat(renderRoster(state.registry, config))];
  messages.push(chat(renderHand(state.streamer, config)));
  if (config.STREAMER.handVisibility === 'private') messages.push(toConsole(renderHandPrivate(state.streamer, config)));
  messages.push(...startTurn(ctx));
  return messages;
}
