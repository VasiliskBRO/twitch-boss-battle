import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import { validateEffect } from '../src/effects.js';
import {
  createDeck, createStreamerState, drawCard, parseCardCommand, canPlay, playCard, onPhaseChange,
  consumePendingCard, tickTurn, toJSON, fromJSON, renderHand, renderHandPrivate, renderPlay, renderMoment,
  getCard,
} from '../src/streamer_cards.js';
import { makeRng } from './helpers.js';

const STREAMER = { isBroadcaster: true, isModerator: false };
const MOD = { isBroadcaster: false, isModerator: true };
const VIEWER = { isBroadcaster: false, isModerator: false };
const T0 = 1_000_000;

const withStreamer = (patch) => ({ ...CONFIG, STREAMER: { ...CONFIG.STREAMER, ...patch } });
const PRIVATE = withStreamer({ handVisibility: 'private' });
const kinds = (state) => state.hand.map((id) => getCard(id).kind);
const play = (state, index, turn, { roles = STREAMER, now = T0, config = CONFIG } = {}) =>
  playCard(state, index, 'streamer', roles, turn, now, makeRng(1), config);

test('Рука: 3 разные карты, минимум 1 помощь и 1 помеха (10000 раздач)', () => {
  const rng = makeRng(2024);
  const counts = {};
  for (let i = 0; i < 10000; i++) {
    const s = createStreamerState(rng);
    assert.strictEqual(s.hand.length, 3);
    assert.strictEqual(new Set(s.hand).size, 3);
    assert.ok(kinds(s).includes('help') && kinds(s).includes('hinder'), s.hand.join(','));
    for (const id of s.hand) counts[id] = (counts[id] || 0) + 1;
  }
  assert.strictEqual(Object.keys(counts).length, 13, 'в раздачах встречаются все карты');
});

test('Рука: раздача детерминирована при одном seed', () => {
  for (let seed = 1; seed <= 50; seed++) {
    assert.deepStrictEqual(createStreamerState(makeRng(seed)), createStreamerState(makeRng(seed)));
  }
  const hands = new Set();
  for (let seed = 1; seed <= 50; seed++) hands.add(createStreamerState(makeRng(seed)).hand.join(','));
  assert.ok(hands.size > 10);
});

test('Права: только стример; модератор только при allowMods; остальные молча', () => {
  const s = createStreamerState(makeRng(1));
  assert.deepStrictEqual(canPlay(s, 'v', VIEWER, 1, T0), { ok: false, reason: 'notAllowed' });
  assert.deepStrictEqual(canPlay(s, 'm', MOD, 1, T0), { ok: false, reason: 'notAllowed' });
  assert.strictEqual(canPlay(s, 'm', MOD, 1, T0, 1, withStreamer({ allowMods: true })).ok, true);
  assert.strictEqual(canPlay(s, 'b', STREAMER, 1, T0, 1).ok, true);
  assert.strictEqual(canPlay(s, 'x', undefined, 1, T0).reason, 'notAllowed');

  const r = play(s, 1, 1, { roles: VIEWER });
  assert.deepStrictEqual([r.ok, r.reason, r.reply, r.announce], [false, 'notAllowed', null, null]);
  assert.strictEqual(s.hand.length, 3, 'рука не тронута');
  assert.strictEqual(s.usedCount, 0);

  const loud = play(s, 1, 1, { roles: VIEWER, config: withStreamer({ replyToUnauthorized: true }) });
  assert.strictEqual(typeof loud.reply, 'string');
});

test('Посторонние не меняют состояние и не мешают стримеру (обычный ход, кулдаун, момент)', () => {
  const intruders = [VIEWER, MOD, undefined, null, { isBroadcaster: 'true' }];
  const texts = ['!карта 1', '!карта 2', '!карта 3', '!карта 9', '!карта'];
  const spam = (s, turn, now) => {
    for (const roles of intruders) {
      for (const text of texts) {
        const before = structuredClone(s);
        // playCard напрямую: у хелпера play roles = STREAMER по умолчанию, и undefined стал бы стримером.
        const r = playCard(s, parseCardCommand(text), 'intruder', roles, turn, now, makeRng(1));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reply, null, 'посторонним молчим');
        assert.deepStrictEqual(s, before, `состояние изменилось от «${text}»`);
      }
    }
  };

  for (let seed = 1; seed <= 50; seed++) {
    const s = createStreamerState(makeRng(seed));
    // Обычный ход: зрители спамят, стример всё равно играет любую карту.
    spam(s, 1, T0);
    const card = s.hand[0];
    const r = play(s, 1, 1);
    assert.deepStrictEqual([r.ok, r.card.id], [true, card]);
    consumePendingCard(s);
    tickTurn(s);

    // Кулдаун: спам не продлевает и не сбрасывает его.
    spam(s, 2, T0);
    assert.strictEqual(play(s, 1, 2).reason, 'cooldown');
    tickTurn(s);

    // Окно момента: спам не расходует окно.
    onPhaseChange(s, 2, T0, makeRng(seed));
    spam(s, 3, T0 + 1000);
    assert.strictEqual(play(s, s.hand.length, 3, { now: T0 + 2000 }).ok, true);
  }
});

test('Лимиты: одна карта за ход; сыграл на t — можно с t+2', () => {
  const s = createStreamerState(makeRng(3));
  assert.strictEqual(play(s, 1, 5).ok, true);
  consumePendingCard(s);

  const again = play(s, 1, 5);
  assert.deepStrictEqual([again.ok, again.reason], [false, 'alreadyPlayedThisTurn']);
  assert.ok(again.reply.length > 0);
  tickTurn(s); // конец хода 5

  const t6 = play(s, 1, 6);
  assert.deepStrictEqual([t6.ok, t6.reason], [false, 'cooldown']);
  tickTurn(s); // конец хода 6

  assert.strictEqual(play(s, 1, 7).ok, true);
});

test('Пока часть 5 не забрала карту, новую сыграть нельзя', () => {
  const s = createStreamerState(makeRng(4));
  play(s, 1, 1);
  tickTurn(s);
  tickTurn(s);
  assert.strictEqual(play(s, 1, 3).reason, 'alreadyPlayedThisTurn');
  consumePendingCard(s);
  assert.strictEqual(play(s, 1, 3).ok, true);
});

test('Розыгрыш: удаляет карту, ставит pendingCard, не применяет эффекты', () => {
  const s = createStreamerState(makeRng(5));
  const [first, second] = s.hand;
  const r = play(s, 1, 1);
  assert.deepStrictEqual([r.ok, r.card.id, r.applyAt], [true, first, 'thisTurn']);
  assert.deepStrictEqual(r.effects, getCard(first).effects);
  assert.ok(r.announce.startsWith(`🃏 Стример играет «${r.card.name}»!`));
  assert.deepStrictEqual(s.hand.slice(0, 1), [second]);
  assert.strictEqual(s.hand.length, 2);
  assert.deepStrictEqual(s.pendingCard, { cardId: first, applyAt: 'thisTurn', fromMoment: false, playedTurn: 1 });
  assert.strictEqual(r.fromMoment, false);

  const p = consumePendingCard(s);
  assert.deepStrictEqual([p.card.id, p.applyAt, p.fromMoment, p.playedTurn], [first, 'thisTurn', false, 1]);
  assert.strictEqual(s.pendingCard, null);
  assert.strictEqual(consumePendingCard(s), null);
});

test('Розыгрыш: индекс вне руки и повторный индекс дают ошибку; пустая рука', () => {
  const s = createStreamerState(makeRng(6));
  for (const bad of [0, 4, 9, null, -1, 1.5]) {
    assert.strictEqual(play(s, bad, 1).reason, 'badIndex', String(bad));
  }
  assert.strictEqual(play(s, 3, 1).ok, true);
  consumePendingCard(s);
  tickTurn(s);
  tickTurn(s);
  assert.strictEqual(play(s, 3, 3).reason, 'badIndex', 'карты №3 больше нет');
  assert.strictEqual(play(s, 3, 3).reply, '🃏 Нет такой карты. Выбери !карта 1-2.');

  const empty = { ...createStreamerState(makeRng(6)), hand: [] };
  assert.strictEqual(play(empty, 1, 1).reason, 'handEmpty');
});

test('parseCardCommand', () => {
  assert.strictEqual(parseCardCommand('!карта 1'), 1);
  assert.strictEqual(parseCardCommand('!КАРТА   3'), 3);
  assert.strictEqual(parseCardCommand('  !Карта 2 пожалуйста'), 2);
  assert.strictEqual(parseCardCommand('!карта 9'), 9, 'число вне руки отсекает canPlay');
  for (const bad of ['!карта', '!карта x', '!карта 0', '!карта -1', '!карта 1.5', '!картах 1', 'карта 1', '', null]) {
    assert.strictEqual(parseCardCommand(bad), null, String(bad));
  }
  const s = createStreamerState(makeRng(1));
  assert.strictEqual(play(s, parseCardCommand('!карта 9'), 1).reason, 'badIndex');
});

test('Момент: открывается при переходе в фазу и даёт +1 карту', () => {
  const s = createStreamerState(makeRng(7));
  const res = onPhaseChange(s, 2, T0, makeRng(8));
  assert.strictEqual(s.hand.length, 4);
  assert.strictEqual(s.hand[3], res.card.id);
  assert.strictEqual(s.momentUntilMs, T0 + 15000);
  assert.strictEqual(res.messages.length, 1);
  assert.strictEqual(
    res.messages[0],
    `⚡ Момент стримера! Босс на 66% HP. 15 секунд на карту (!карта 1-4). В руку добавлена: ${res.card.emoji} ${res.card.name}`,
  );
  assert.deepStrictEqual(res.privateMessages, []);
});

test('Момент: в окне можно играть мимо лимитов, потом кулдаун; через 15 с окно закрыто', () => {
  const s = createStreamerState(makeRng(9));
  play(s, 1, 4); // обычный розыгрыш на ходу 4
  consumePendingCard(s);
  assert.strictEqual(play(s, 1, 4).reason, 'alreadyPlayedThisTurn');

  onPhaseChange(s, 2, T0, makeRng(1));
  const m = play(s, 1, 4, { now: T0 + 14999 });
  assert.deepStrictEqual([m.ok, m.applyAt, m.fromMoment, s.pendingCard.fromMoment], [true, 'nextTurnStart', true, true]);
  assert.ok(m.announce.endsWith('Сработает в начале следующего хода.'));
  assert.strictEqual(s.momentUntilMs, null, 'окно израсходовано');
  consumePendingCard(s);

  // После игры в окне — обычный кулдаун.
  assert.strictEqual(play(s, 1, 4, { now: T0 + 15000 }).reason, 'alreadyPlayedThisTurn');
  tickTurn(s);
  assert.strictEqual(play(s, 1, 5).reason, 'cooldown');
  tickTurn(s);
  assert.strictEqual(play(s, 1, 6).ok, true);
});

test('Момент: если стример молчит, окно закрывается по внедрённым часам', () => {
  const s = createStreamerState(makeRng(10));
  play(s, 1, 1);
  consumePendingCard(s);
  onPhaseChange(s, 2, T0, makeRng(1));
  assert.strictEqual(canPlay(s, 'b', STREAMER, 1, T0 + 14999, 1).ok, true);
  assert.strictEqual(canPlay(s, 'b', STREAMER, 1, T0 + 15000, 1).reason, 'alreadyPlayedThisTurn');

  tickTurn(s, T0 + 10000);
  assert.strictEqual(s.momentUntilMs, T0 + 15000, 'tickTurn до конца окна его не закрывает');
  tickTurn(s, T0 + 15000);
  assert.strictEqual(s.momentUntilMs, null);
  assert.strictEqual(s.hand.length, 3, 'карта момента осталась в руке');
});

test('Момент: переход через две фазы одним ударом — +2 карты, окно продлевается', () => {
  const s = createStreamerState(makeRng(11));
  onPhaseChange(s, 2, T0, makeRng(1));
  const r3 = onPhaseChange(s, 3, T0 + 100, makeRng(2));
  assert.strictEqual(s.hand.length, 5);
  assert.strictEqual(new Set(s.hand).size, 5);
  assert.strictEqual(s.momentUntilMs, T0 + 100 + 15000);
  assert.ok(r3.messages[0].includes('Босс на 33% HP'));
});

test('Добор: нет помощи → помощь, нет помехи → помеха', () => {
  const rng = makeRng(12);
  for (let i = 0; i < 500; i++) {
    const onlyHinder = { ...createStreamerState(rng), hand: ['fury', 'fog'], seen: ['fury', 'fog'] };
    assert.strictEqual(drawCard(onlyHinder, rng).kind, 'help');
    const onlyHelp = { ...createStreamerState(rng), hand: ['shield', 'blessing'], seen: ['shield', 'blessing'] };
    assert.strictEqual(drawCard(onlyHelp, rng).kind, 'hinder');
    const empty = { ...createStreamerState(rng), hand: [], seen: [] };
    assert.strictEqual(drawCard(empty, rng).kind, 'help');
  }
});

test('Добор: сначала карты, которых ещё не было в руке; когда кончились — любые', () => {
  const rng = makeRng(13);
  const s = { ...createStreamerState(rng), hand: ['shield', 'fury'], seen: ['shield', 'fury'] };
  const drawn = [];
  for (let i = 0; i < 10; i++) {
    const card = drawCard(s, rng);
    drawn.push(card.id);
    s.hand.splice(s.hand.indexOf(card.id), 1); // «сыграли» — освобождаем место
  }
  assert.strictEqual(new Set(drawn).size, 10, 'первые 10 доборов без повторов');
  assert.strictEqual(s.seen.length, 12);
  // Колода кончилась: берётся любая карта, кроме тех, что уже в руке.
  const next = drawCard(s, rng);
  assert.ok(next, 'добор не пустой');
  assert.ok(!['shield', 'fury'].includes(next.id));
  assert.deepStrictEqual(s.hand, ['shield', 'fury', next.id]);
});

test('Добор: после двух фаз в руке на 2 карты больше (с учётом сыгранных)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = createStreamerState(makeRng(seed));
    play(s, 2, 1);
    consumePendingCard(s);
    onPhaseChange(s, 2, T0, makeRng(seed + 1000));
    onPhaseChange(s, 3, T0 + 30000, makeRng(seed + 2000));
    assert.strictEqual(s.hand.length, 3 - 1 + 2);
    assert.strictEqual(new Set(s.hand).size, s.hand.length);
    assert.ok(kinds(s).includes('help') && kinds(s).includes('hinder'));
  }
});

test('Дескрипторы 13 карт валидны по EFFECT_TYPES; числа берутся из конфига', () => {
  const deck = createDeck();
  assert.strictEqual(deck.length, 13);
  assert.strictEqual(deck.filter((c) => c.kind === 'help').length, 7);
  assert.strictEqual(deck.filter((c) => c.kind === 'hinder').length, 6);
  for (const card of deck) {
    assert.deepStrictEqual(Object.keys(card).sort(), ['announceText', 'effects', 'emoji', 'id', 'kind', 'name']);
    assert.ok(card.effects.length > 0);
    for (const e of card.effects) assert.deepStrictEqual(validateEffect(e), [], card.id);
    assert.ok(!card.announceText.includes('{'), card.announceText);
  }

  const catalog = structuredClone(CONFIG.STREAMER.CATALOG);
  catalog.find((c) => c.id === 'fury').effects[0].pct = 0.75;
  catalog.find((c) => c.id === 'fury').effects[0].turns = 2;
  const fury = createDeck(withStreamer({ CATALOG: catalog })).find((c) => c.id === 'fury');
  assert.strictEqual(fury.effects[0].pct, 0.75);
  assert.strictEqual(fury.announceText, 'Урон босса +75% на 2 хода.');
  assert.strictEqual(getCard('fury').announceText, 'Урон босса +50% в этом ходу.');
});

test('Удар стримера помечен canKill: false', () => {
  const strike = getCard('streamer_strike');
  assert.deepStrictEqual(strike.effects, [{ type: 'trueDamageBoss', pctMaxHp: 0.05, canKill: false }]);
  assert.notDeepStrictEqual(validateEffect({ type: 'trueDamageBoss', pctMaxHp: 0.05, canKill: true }), []);
});

test('toJSON / fromJSON возвращают идентичное состояние', () => {
  const s = createStreamerState(makeRng(14));
  assert.deepStrictEqual(fromJSON(toJSON(s)), s);
  play(s, 1, 1);
  onPhaseChange(s, 2, T0, makeRng(15));
  tickTurn(s);
  const restored = fromJSON(toJSON(s));
  assert.deepStrictEqual(restored, s);
  // Восстановленное состояние продолжает работать.
  assert.strictEqual(consumePendingCard(restored).playedTurn, 1);
  assert.strictEqual(play(restored, 1, 2, { now: T0 + 1000 }).ok, true, 'окно момента пережило перезапуск');
  assert.throws(() => fromJSON('{"version":99}'));
});

test('Сообщения ≤ 500 символов; private не раскрывает карты руки в чате', () => {
  const rng = makeRng(16);
  const names = createDeck().map((c) => c.name);
  for (let i = 0; i < 300; i++) {
    for (const config of [CONFIG, PRIVATE]) {
      const s = createStreamerState(rng, config);
      const phase2 = onPhaseChange(s, 2, T0, rng, config);
      const phase3 = onPhaseChange(s, 3, T0, rng, config);
      const chat = [renderHand(s, config), ...phase2.messages, ...phase3.messages];
      const all = [...chat, renderHandPrivate(s, config), ...s.hand.map((id) => renderPlay(getCard(id), { moment: true }))];
      for (const msg of all) assert.ok(msg.length <= 500 && !msg.endsWith('…'), msg);

      if (config === PRIVATE) {
        for (const msg of chat) for (const name of names) assert.ok(!msg.includes(name), `${name} в «${msg}»`);
        assert.strictEqual(phase2.privateMessages.length, 1);
        assert.ok(s.hand.every((id) => phase3.privateMessages[0].includes(getCard(id).name)));
      }
    }
  }
});

test('Рендеры: формат из примеров ТЗ', () => {
  const s = { ...createStreamerState(makeRng(1)), hand: ['shield', 'fury', 'streamer_strike'] };
  assert.strictEqual(renderHand(s), '🃏 Рука стримера: [1] 🛡️ Щит  [2] 😡 Ярость  [3] 🎯 Удар стримера');
  assert.strictEqual(renderHand(s, PRIVATE), '🃏 У стримера в руке 3 карты');
  assert.strictEqual(renderHand({ ...s, hand: ['fog'] }, PRIVATE), '🃏 У стримера в руке 1 карта');
  assert.strictEqual(renderHand({ ...s, hand: [] }, PRIVATE), '🃏 У стримера в руке 0 карт');
  assert.strictEqual(renderPlay(getCard('fury')), '🃏 Стример играет «Ярость»! Урон босса +50% в этом ходу.');
  assert.strictEqual(
    renderMoment(2, getCard('mana_gift'), { handSize: 4 }),
    '⚡ Момент стримера! Босс на 66% HP. 15 секунд на карту (!карта 1-4). В руку добавлена: 🔮 Дар маны',
  );
  assert.strictEqual(
    renderMoment(3, getCard('mana_gift'), { handSize: 2, config: PRIVATE }),
    '⚡ Момент стримера! Босс на 33% HP. 15 секунд на карту (!карта 1-2). В руку добавлена новая карта.',
  );
});

test('renderPlay в момент стримера: «в этом ходу» становится «в следующем ходу»', () => {
  assert.strictEqual(
    renderPlay(getCard('fury'), { moment: true }),
    '🃏 Стример играет «Ярость»! Урон босса +50% в следующем ходу. Сработает в начале следующего хода.',
  );
  assert.strictEqual(renderPlay(getCard('fury')), '🃏 Стример играет «Ярость»! Урон босса +50% в этом ходу.');
});

test('renderHandCompact: ≤ 120 символов при 4–5 картах, состояния «можно играть» / «пауза»', async () => {
  const { renderHandCompact } = await import('../src/streamer_cards.js');
  const ids = createDeck().map((c) => c.id);
  const rng = makeRng(77);
  for (let i = 0; i < 2000; i++) {
    const pool = [...ids];
    const hand = Array.from({ length: 4 + (i % 2) }, () => pool.splice(rng(0, pool.length - 1), 1)[0]);
    const s = { ...createStreamerState(makeRng(1)), hand, cooldownTurns: i % 3 };
    for (const config of [CONFIG, PRIVATE]) {
      const text = renderHandCompact(s, 5, config);
      assert.ok(text.length <= 120 && !text.endsWith('…'), text);
    }
  }
  const s = { ...createStreamerState(makeRng(1)), hand: ['shield', 'fury', 'streamer_strike'] };
  assert.strictEqual(renderHandCompact(s, 1), '🃏 [1]🛡️ [2]😡 [3]🎯 — можно играть');
  s.cooldownTurns = 2;
  assert.strictEqual(renderHandCompact(s, 1), '🃏 [1]🛡️ [2]😡 [3]🎯 — пауза ещё 2 хода');
  s.cooldownTurns = 1;
  assert.strictEqual(renderHandCompact(s, 2), '🃏 [1]🛡️ [2]😡 [3]🎯 — пауза ещё 1 ход');
  assert.strictEqual(renderHandCompact({ ...s, hand: [] }, 2), '🃏 рука пуста');
  assert.strictEqual(renderHandCompact(s, 2, PRIVATE), '🃏 3 карты — пауза ещё 1 ход');
});

test('!рука: только стример (модератор при allowMods), раз в 10 с; private — в чат без названий', async () => {
  const { showHand } = await import('../src/streamer_cards.js');
  const names = createDeck().map((c) => c.name);
  const s = { ...createStreamerState(makeRng(1)), hand: ['shield', 'fury', 'fog'] };
  assert.deepStrictEqual(showHand(s, VIEWER, T0), []);
  assert.deepStrictEqual(showHand(s, MOD, T0), []);
  const first = showHand(s, STREAMER, T0);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].to, 'chat');
  assert.ok(first[0].text.includes('[1] 🛡️ Щит — блок следующей атаки'), first[0].text);
  assert.deepStrictEqual(showHand(s, STREAMER, T0 + 9999), [], 'кулдаун 10 с');
  assert.strictEqual(showHand(s, MOD, T0 + 10000, withStreamer({ allowMods: true })).length, 1);

  const hidden = { ...createStreamerState(makeRng(2)), hand: ['shield', 'fury', 'fog'] };
  const msgs = showHand(hidden, STREAMER, T0, PRIVATE);
  const chat = msgs.filter((m) => m.to === 'chat');
  assert.deepStrictEqual(chat.map((m) => m.text), ['🃏 У стримера в руке 3 карты']);
  for (const m of chat) for (const n of names) assert.ok(!m.text.includes(n));
  assert.ok(msgs.find((m) => m.to === 'console').text.includes('Щит'));
});
