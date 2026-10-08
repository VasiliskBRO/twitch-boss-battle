import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { CONFIG } from '../../src/config.js';
import { createBattleEngine, fromJSON } from '../../battle/engine.js';
import { makeRng, makeClock, startBattle, messagesPerTurn, STREAMER, MOD, VIEWER, DET, SKILLS } from './helpers.js';
import { runScriptedBattle, journalText } from './script.js';

const GOLDEN = new URL('../golden/battle10.txt', import.meta.url);

function fresh(seed = 1, config = CONFIG) {
  const clock = makeClock();
  const eng = createBattleEngine({ config, rng: makeRng(seed), now: clock.now });
  const say = (userId, text, roles = VIEWER) => eng.handleMessage({ userId, displayName: userId, text, roles });
  return { eng, clock, say };
}

// ---------- Лобби ----------

test('Лобби: 0 игроков — бой отменяется', () => {
  const { eng, clock, say } = fresh();
  const spawn = say('streamer', '!БОСС ', STREAMER);
  assert.strictEqual(spawn.length, 2);
  assert.strictEqual(spawn[1].text, '📜 Запись: !join (класс выдаётся случайно), 75 секунд');
  clock.advance(75_000);
  const msgs = eng.tick();
  assert.deepStrictEqual(msgs.map((m) => m.text), ['😴 Никто не пришёл, босс ушёл.']);
  assert.strictEqual(eng.getState().phase, 'ended');
  assert.strictEqual(eng.getState().result.outcome, 'cancelled');
});

test('Лобби: «В отряде уже N» не чаще раза в 20 секунд', () => {
  const { eng, clock, say } = fresh();
  say('streamer', '!босс', STREAMER);
  const progress = [];
  for (let s = 1; s < 75; s++) {
    clock.advance(1000);
    say(`u${s}`, '!join'); // каждый тик новый игрок
    for (const m of eng.tick()) if (m.text.startsWith('👥')) progress.push({ s, text: m.text });
  }
  assert.deepStrictEqual(progress.map((p) => p.s), [20, 40, 60]);
  assert.strictEqual(progress[0].text, '👥 В отряде уже 20 бойцов');
});

test('Лобби: HP босса считается по числу бойцов', () => {
  for (const n of [1, 10, 40]) {
    const { eng, clock, say } = fresh(5);
    say('streamer', '!босс', STREAMER);
    for (let i = 0; i < n; i++) say(`u${i}`, '!join');
    clock.advance(75_000);
    const msgs = eng.tick();
    const boss = eng.getState().boss;
    const base = (CONFIG.BOSS_BASE_STATS.baseHp + CONFIG.BOSS_BASE_STATS.perPlayerHp * n) * CONFIG.ARCHETYPES[boss.archetype].hpMult;
    assert.ok(boss.maxHp >= Math.round(base * 0.9) && boss.maxHp <= Math.round(base * 1.1), `${n}: ${boss.maxHp}`);
    assert.ok(msgs.some((m) => m.text.includes(`❤️ [██████████] ${boss.maxHp}/${boss.maxHp}`)));
    assert.ok(msgs.some((m) => m.text.startsWith('⚔️ Ход 1/15')));
  }
});

// ---------- Команды ----------

test('Команды: !join, !атака, !навык, !особый не дают ответов; мусор игнорируется', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  for (const text of ['!join', '!join воин', '!join паладин', '!атака', '  !НАВЫК  ', '!особый', 'привет', '!неизвестно', '']) {
    assert.deepStrictEqual(b.say('w', text), [], text);
  }
  assert.deepStrictEqual(b.say('w', '!атака'), []);
  assert.strictEqual(b.p('w').lastCommand.command, 'атака');
  b.say('w', '!навык');
  assert.strictEqual(b.p('w').lastCommand.command, 'навык', 'последняя команда побеждает');
  assert.deepStrictEqual(b.say('nobody', '!атака'), []);
});

test('Команды: !я раз в 20 секунд на игрока, ≤ 500 символов; незаписанным молчим', () => {
  const b = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  const first = b.say('w', '!я');
  assert.strictEqual(first.length, 1);
  assert.ok(first[0].text.startsWith('@w, ты 🛡️ Воин'));
  assert.ok(first[0].text.includes('✨ Особый:') && first[0].text.includes('🎁 Дар:'));
  assert.ok(first[0].text.length <= 500);
  assert.deepStrictEqual(b.say('w', '!я'), []);
  assert.strictEqual(b.say('m', '!я').length, 1, 'кулдаун у каждого свой');
  b.clock.advance(19_999);
  assert.deepStrictEqual(b.say('w', '!я'), []);
  b.clock.advance(1);
  assert.strictEqual(b.say('w', '!я').length, 1);
  assert.deepStrictEqual(b.say('stranger', '!я'), []);
});

test('Команды: !карта от зрителя и модератора (allowMods = false) игнорируется', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  const hand = [...b.st.streamer.hand];
  assert.deepStrictEqual(b.say('v', '!карта 1', VIEWER), []);
  assert.deepStrictEqual(b.say('mod', '!карта 1', MOD), []);
  assert.deepStrictEqual(b.st.streamer.hand, hand);
  assert.deepStrictEqual(b.say('streamer', '!карта 9', STREAMER), [], 'ошибка — молчание');
  const ok = b.say('streamer', '!карта 1', STREAMER);
  assert.strictEqual(ok.length, 1);
  assert.ok(ok[0].text.startsWith('🃏 Стример играет'));
});

test('Команды: !стоп только для стримера и модератора, отмена без начисления', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  assert.deepStrictEqual(b.say('w', '!стоп'), []);
  assert.strictEqual(b.st.phase, 'running');
  const msgs = b.say('mod', '!стоп', MOD);
  assert.deepStrictEqual(msgs.map((m) => m.text), ['🛑 Бой отменён.']);
  assert.strictEqual(b.st.result.outcome, 'cancelled');
  assert.strictEqual(b.st.result.lastHitUserId, null);
  assert.deepStrictEqual(b.resolve(), [], 'после отмены ходы не идут');
});

test('!босс: только стример/модератор; новый бой — после паузы, реестр сбрасывается только тогда', () => {
  const { eng, clock, say } = fresh();
  assert.deepStrictEqual(say('v', '!босс'), []);
  assert.strictEqual(say('mod', '!босс', MOD).length, 2);
  assert.deepStrictEqual(say('streamer', '!босс', STREAMER), [], 'бой уже идёт');
  say('u1', '!join');
  say('mod', '!стоп', MOD);
  assert.strictEqual(eng.getState().registry.size, 1, 'result и реестр доступны части 6');
  clock.advance(149_000);
  assert.deepStrictEqual(say('streamer', '!босс', STREAMER), []);
  clock.advance(1_000);
  assert.strictEqual(say('streamer', '!босс', STREAMER).length, 2);
  assert.strictEqual(eng.getState().registry.size, 0);
  assert.strictEqual(eng.getState().result, null);
});

// ---------- Сохранение ----------

test('toJSON в середине хода → fromJSON → тот же результат, что без перезапуска', () => {
  for (const seed of [1, 2, 3]) {
    const plain = runScriptedBattle({ seed, players: 12 });
    const restarted = runScriptedBattle({ seed, players: 12, restartAtTurn: 3 });
    assert.ok(restarted.restarted, 'перезапуск произошёл');
    assert.deepStrictEqual(restarted.journal, plain.journal);
    assert.deepStrictEqual(restarted.result, plain.result);
  }
});

test('Просроченное после перезапуска окно разрешается на первом tick, по одному ходу', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  const data = b.eng.toJSON();
  b.clock.advance(300_000); // бот лежал 5 минут
  const eng2 = fromJSON(data, { config: DET, rng: b.rng, now: b.clock.now });
  const msgs = eng2.tick();
  assert.ok(msgs.some((m) => m.text.startsWith('📊 Ход 1:')));
  assert.ok(msgs.at(-1).text.startsWith('⚔️ Ход 2/15'));
  assert.strictEqual(eng2.getState().turnEndsAtMs, b.clock.now() + 25_000, 'новый ход получает полное окно');
  assert.deepStrictEqual(eng2.tick(), []);
});

// ---------- Golden и инварианты ----------

test('Golden: полный бой на 10 игроков с фиксированным seed даёт тот же журнал', () => {
  const { journal, result } = runScriptedBattle({ seed: 42, players: 10 });
  const text = journalText(journal);
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(new URL('../golden/', import.meta.url), { recursive: true });
    fs.writeFileSync(GOLDEN, text);
  }
  assert.ok(fs.existsSync(GOLDEN), 'нет golden-файла: запустите UPDATE_GOLDEN=1 node --test');
  assert.strictEqual(text, fs.readFileSync(GOLDEN, 'utf8'));
  assert.ok(['victory', 'defeat', 'wipe'].includes(result.outcome));
});

test('Инварианты: сообщения ≤ 500, сообщений хода ≤ 3, ходов ≤ maxTurns', () => {
  for (const [seed, players, longNames] of [[1, 1, false], [2, 5, false], [3, 30, true], [4, 120, true], [5, 10, false], [6, 60, true]]) {
    const { journal, result } = runScriptedBattle({ seed, players, longNames });
    for (const m of journal) assert.ok(m.text.length <= 500, `${m.text.length}: ${m.text}`);
    for (const t of messagesPerTurn(journal)) assert.ok(t.count <= 3, `${t.count} сообщений: ${t.header}`);
    assert.ok(result.turns <= CONFIG.BATTLE.maxTurns);
    for (const p of result.players) {
      for (const v of Object.values(p.stats)) assert.ok(Number.isFinite(v) && v >= 0);
    }
  }
});

test('Детерминированный конфиг: при смене фазы сообщений хода всё равно ≤ 3', () => {
  const b = startBattle({ players: [['w', 'воин']], bossHp: 1000, config: DET });
  b.st.boss.hp = 670;
  b.say('w', '!атака');
  b.telegraph(SKILLS.aoe);
  b.resolve();
  for (const t of messagesPerTurn(b.journal)) assert.ok(t.count <= 3, t.header);
});

test('resume: после перезапуска окну хода и лобби остаётся не меньше 15 с, ходы не накатываются пачкой', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  const data = b.eng.toJSON();
  b.clock.advance(300_000); // бот лежал 5 минут — окно хода давно истекло
  const eng2 = fromJSON(data, { config: DET, rng: b.rng, now: b.clock.now });
  assert.deepStrictEqual(eng2.resume(b.clock.now()), []);
  assert.strictEqual(eng2.getState().turnEndsAtMs, b.clock.now() + 15_000);
  assert.deepStrictEqual(eng2.tick(), [], 'ход не разрешается сразу');
  b.clock.advance(14_999);
  assert.deepStrictEqual(eng2.tick(), []);
  b.clock.advance(1);
  const msgs = eng2.tick();
  assert.ok(msgs.some((m) => m.text.startsWith('📊 Ход 1:')));
  assert.ok(msgs.at(-1).text.startsWith('⚔️ Ход 2/'));
  assert.deepStrictEqual(eng2.tick(), [], 'один ход за tick');

  // Если времени и так достаточно — окно не трогаем.
  const end = eng2.getState().turnEndsAtMs;
  eng2.resume(b.clock.now());
  assert.strictEqual(eng2.getState().turnEndsAtMs, end);

  // Лобби тоже продлевается.
  const clock = makeClock();
  const eng3 = createBattleEngine({ rng: makeRng(1), now: clock.now });
  eng3.handleMessage({ userId: 's', text: '!босс', roles: STREAMER });
  clock.advance(74_000);
  eng3.resume(clock.now());
  assert.strictEqual(eng3.getState().lobbyEndsAtMs, clock.now() + 15_000);
});
