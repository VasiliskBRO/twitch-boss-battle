// Правки части 5 под части 2, 4 и 6: !join без класса, приоритеты, рука в заголовке, !рука,
// поддержка (stats.support), вклад за ход с потолком, начисление очков, !очки и !топ.

import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../../src/config.js';
import { createBattleEngine } from '../../battle/engine.js';
import { createMemoryStore } from '../../points/index.js';
import { makeRng, makeClock, startBattle, DET, SKILLS, STREAMER, VIEWER } from './helpers.js';
import { runScriptedBattle } from './script.js';

const lobby = (config = CONFIG, store) => {
  const clock = makeClock();
  const eng = createBattleEngine({ config, rng: makeRng(3), now: clock.now, ...(store ? { store } : {}) });
  eng.handleMessage({ userId: 'streamer', text: '!босс', roles: STREAMER });
  return { eng, clock, say: (id, text, roles = VIEWER) => eng.handleMessage({ userId: id, displayName: id, text, roles }) };
};
const withBattle = (patch) => ({ ...DET, BATTLE: { ...DET.BATTLE, ...patch } });

// ---------- !join ----------

test('!join: сводка раз в 5 с с подсказкой «Напиши !я», priority low; повторный !join молчит', () => {
  const { eng, clock, say } = lobby();
  assert.deepStrictEqual(say('anna', '!join'), []);
  assert.deepStrictEqual(say('boris', '!join воин пожалуйста'), [], 'текст после !join игнорируется');
  assert.deepStrictEqual(say('anna', '!join'), [], 'повторный !join');
  clock.advance(4000);
  assert.deepStrictEqual(eng.tick(), []);
  clock.advance(1000);
  const msgs = eng.tick();
  assert.deepStrictEqual(msgs, [{
    text: '⚔️ В отряд вступили: @anna, @boris. Напиши !я для получения информации', to: 'chat', priority: 'low',
  }]);
  clock.advance(10_000);
  assert.deepStrictEqual(eng.tick().filter((m) => m.text.startsWith('⚔️ В отряд')), [], 'повтор не попадает в сводку');
});

test('!join: режимы always и off', () => {
  const always = lobby(withBattle({ joinReplyMode: 'always' }));
  assert.deepStrictEqual(always.say('anna', '!join'), [
    { text: '@anna, ты в отряде! Напиши !я для получения информации', to: 'chat', priority: 'low' },
  ]);
  assert.deepStrictEqual(always.say('anna', '!join'), []);
  const off = lobby(withBattle({ joinReplyMode: 'off' }));
  assert.deepStrictEqual(off.say('anna', '!join'), []);
  off.clock.advance(10_000);
  assert.ok(!off.eng.tick().some((m) => m.text.includes('anna')));
});

test('!join: 30 присоединений за 10 секунд в режиме auto дают не более 4 сообщений', () => {
  const { eng, clock, say } = lobby();
  const out = [];
  for (let i = 0; i < 30; i++) {
    out.push(...say(`viewer_with_long_name_${i}`, '!join'));
    if (i % 3 === 2) {
      clock.advance(1000);
      out.push(...eng.tick());
    }
  }
  clock.advance(5000);
  out.push(...eng.tick());
  const joinMsgs = out.filter((m) => m.text.startsWith('⚔️ В отряд вступили'));
  assert.ok(joinMsgs.length >= 1 && joinMsgs.length <= 4, `${joinMsgs.length} сообщений`);
  assert.ok(out.length <= 4 + 1, 'плюс не больше одного «В отряде уже N»');
  const named = joinMsgs.map((m) => m.text).join(' ');
  for (let i = 0; i < 30; i++) assert.ok(named.includes(`@viewer_with_long_name_${i},`) || named.includes(`@viewer_with_long_name_${i}.`));
  for (const m of joinMsgs) assert.ok(m.text.length <= 500 && m.priority === 'low');
});

test('!join во время боя: сводка вступивших тоже приходит', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  b.say('late', '!join');
  b.clock.advance(5000);
  const msgs = b.eng.tick();
  assert.ok(msgs.some((m) => m.text === '⚔️ В отряд вступили: @late. Напиши !я для получения информации'));
});

// ---------- Рука ----------

test('В каждом заголовке хода есть строка руки; при закрытой руке — без названий и подробно на консоль', () => {
  const { journal } = runScriptedBattle({ seed: 5, players: 8 });
  const headers = journal.filter((m) => m.text.startsWith('⚔️ Ход '));
  assert.ok(headers.length >= 3);
  for (const h of headers) {
    assert.ok(/\| 🃏 (\[1\].* — (можно играть|пауза ещё \d+ ход\S*)|рука пуста)$/.test(h.text), h.text);
    assert.strictEqual(h.priority, 'high');
  }

  const hidden = { ...CONFIG, STREAMER: { ...CONFIG.STREAMER, handVisibility: 'private' } };
  const priv = runScriptedBattle({ seed: 5, players: 8, config: hidden });
  const names = CONFIG.STREAMER.CATALOG.map((c) => c.name);
  const privHeaders = priv.journal.filter((m) => m.text.startsWith('⚔️ Ход '));
  for (const h of privHeaders) {
    assert.ok(/\| 🃏 (\d+ карт\S* — .*|рука пуста)$/.test(h.text), h.text);
  }
  for (const m of priv.journal.filter((x) => x.to === 'chat' && !x.text.startsWith('🃏 Стример играет'))) {
    for (const n of names) assert.ok(!m.text.includes(`] ${n}`) && !m.text.includes(`: ${n}`), `${n} в «${m.text}»`);
  }
  const consoleHands = priv.journal.filter((m) => m.to === 'console' && m.text.startsWith('[рука стримера]'));
  assert.ok(consoleHands.length >= privHeaders.length, 'подробная рука на консоль каждый ход');
});

test('!рука: стример получает руку с описаниями, зрители — ничего; не чаще раза в 10 с', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  b.giveHand(['shield', 'fury', 'fog']);
  assert.deepStrictEqual(b.say('v', '!рука'), []);
  const msgs = b.say('streamer', '!РУКА', STREAMER);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].priority, 'normal');
  assert.ok(msgs[0].text.startsWith('🃏 Рука стримера: [1] 🛡️ Щит — блок следующей атаки'), msgs[0].text);
  assert.deepStrictEqual(b.say('streamer', '!рука', STREAMER), []);
  b.clock.advance(10_000);
  assert.strictEqual(b.say('streamer', '!рука', STREAMER).length, 1);
});

// ---------- Поддержка ----------

test('Поддержка: два Благословения не складываются, поддержка делится поровну между источниками; Боевой клич стримера не даёт поддержки', () => {
  const b = startBattle({ players: [['h1', 'хиллер'], ['h2', 'хиллер'], ['w', 'воин']] });
  b.giveSkill('h1', 'blessing');
  b.giveSkill('h2', 'blessing');
  b.say('h1', '!особый');
  b.say('h2', '!особый');
  b.say('w', '!атака');
  b.telegraph(SKILLS.armor);
  b.resolve();
  const dealt = Math.round(40 * 1.25); // 50: одинаковые бусты не перемножаются, действует самый сильный
  const extra = dealt * (1 - 1 / 1.25);
  assert.strictEqual(b.p('w').stats.damage, dealt);
  assert.ok(Math.abs(b.p('h1').stats.support - extra / 2) < 0.02, `${b.p('h1').stats.support}`);
  assert.strictEqual(b.p('h1').stats.support, b.p('h2').stats.support);

  const card = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  card.giveHand(['war_cry', 'fury', 'fog']);
  card.say('streamer', '!карта 1', STREAMER);
  card.say('w', '!атака');
  card.telegraph(SKILLS.armor);
  card.resolve();
  assert.strictEqual(card.p('w').stats.damage, 50);
  assert.deepStrictEqual([card.p('w').stats.support, card.p('m').stats.support], [0, 0]);
});

test('Поддержка: Щит стримера — 0; Магический барьер и Щит света записывают предотвращённый урон', () => {
  const shield = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  shield.giveHand(['shield', 'fury', 'fog']);
  shield.say('streamer', '!карта 1', STREAMER);
  shield.telegraph(SKILLS.aoe);
  shield.resolve();
  assert.deepStrictEqual([shield.p('w').stats.support, shield.p('m').stats.support], [0, 0]);

  const barrier = startBattle({ players: [['m', 'маг'], ['w', 'воин']] });
  barrier.giveSkill('m', 'magic_barrier');
  barrier.say('m', '!особый');
  barrier.telegraph(SKILLS.aoe);
  barrier.resolve();
  assert.strictEqual(barrier.p('m').stats.support, (24 - 17) + (14 - 10), 'воин 24→17, маг 14→10');

  const light = startBattle({ players: [['h', 'хиллер'], ['w', 'воин']] });
  light.giveSkill('h', 'light_shield');
  light.say('h', '!особый');
  light.telegraph(SKILLS.aoe);
  light.resolve();
  assert.strictEqual(light.p('h').stats.support, (24 - 12) + (17 - 9));
});

test('Поддержка: Раскол брони, Антимагия и Очищение', () => {
  const vuln = startBattle({ players: [['a', 'воин'], ['b', 'воин']] });
  vuln.giveSkill('a', 'armor_break');
  vuln.say('a', '!особый');
  vuln.say('b', '!атака');
  vuln.telegraph(SKILLS.silence);
  vuln.resolve();
  assert.strictEqual(vuln.p('b').stats.damage, 50);
  assert.ok(Math.abs(vuln.p('a').stats.support - 10) < 0.01, `${vuln.p('a').stats.support}`);

  const anti = startBattle({ players: [['m', 'маг']] });
  anti.giveSkill('m', 'antimagic');
  anti.say('m', '!особый');
  anti.telegraph(SKILLS.armor);
  anti.resolve();
  assert.strictEqual(anti.p('m').stats.support, 0.03 * 100000, 'бафф сорван');
  anti.p('m').cooldowns.personal = 0;
  anti.say('m', '!особый');
  anti.telegraph(SKILLS.aoe);
  anti.resolve();
  assert.strictEqual(anti.p('m').stats.support, 3000, 'нечего отменять и снимать — нет поддержки');

  const cleanse = startBattle({ players: [['h', 'хиллер'], ['m', 'маг']] });
  cleanse.st.teamEffects.push({ type: 'silenceClass', classId: 'mage', turnsLeft: 2 });
  cleanse.giveSkill('h', 'purification');
  cleanse.say('h', '!особый');
  cleanse.telegraph(SKILLS.silence);
  cleanse.resolve();
  assert.strictEqual(cleanse.p('h').stats.support, 0.02 * 100000, 'снял и отразил — один раз за ход');
});

// ---------- Вклад и очки ----------

test('Вклад: перелечивание не считается; потолок за ход срабатывает', () => {
  const b = startBattle({ players: [['h', 'хиллер'], ['w', 'воин']] });
  b.say('h', '!атака'); // все на полном HP
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.p('h').stats.healing, 0);
  assert.strictEqual(b.p('h').stats.contribution, 0);

  const cfg = { ...DET, POINTS: { ...DET.POINTS, turnContributionCap: 0.0001 } }; // 10 HP на ход при 100000
  const capped = startBattle({ players: [['w', 'воин']], config: cfg });
  for (let i = 0; i < 3; i++) {
    capped.say('w', '!атака');
    capped.telegraph(SKILLS.silence);
    capped.resolve();
  }
  assert.strictEqual(capped.p('w').stats.damage, 120);
  assert.strictEqual(capped.p('w').stats.contribution, 30, 'по 10 за каждый из трёх ходов');
});

test('Конец боя: очки начисляются один раз, сообщение итога ≤ 500, result содержит support и contribution', () => {
  const store = createMemoryStore();
  const b = startBattle({ players: [['a1', 'воин'], ['a2', 'лучник']], store });
  for (let i = 0; i < 2; i++) {
    b.say('a1', '!атака');
    b.say('a2', '!атака');
    b.telegraph(SKILLS.silence);
    b.resolve();
  }
  b.st.boss.hp = 1;
  b.say('a1', '!атака');
  b.telegraph(SKILLS.silence);
  const msgs = b.resolve();
  const final = msgs.at(-1);
  assert.ok(final.text.startsWith('🏆 Победа!') && final.text.includes('MVP: @') && final.text.endsWith('Свои очки: !очки'), final.text);
  assert.ok(final.text.length <= 500);
  assert.strictEqual(final.priority, 'high');
  assert.ok(msgs.length <= 2, 'итог хода + финал');

  const r = b.st.result;
  assert.strictEqual(r.bossMaxHp, 100000);
  for (const p of r.players) {
    assert.ok('support' in p.stats && 'contribution' in p.stats);
  }
  assert.ok(store.isBattleProcessed(r.battleId));
  const rec = store.get(b.id('a1'));
  assert.deepStrictEqual([rec.battles, rec.wins], [1, 1]);
  assert.strictEqual(store.top(10).length, 2);
});

test('!очки и !топ маршрутизируются в модуль очков (в бою и после)', () => {
  const store = createMemoryStore();
  const b = startBattle({ players: [['a1', 'воин']], store });
  const none = b.say('a1', '!очки');
  assert.deepStrictEqual(none.map((m) => m.text), ['@a1, у тебя ещё нет очков: заходи в бой через !join']);
  for (let i = 0; i < 2; i++) {
    b.say('a1', '!атака');
    b.telegraph(SKILLS.silence);
    b.resolve();
  }
  b.st.boss.hp = 1;
  b.say('a1', '!атака');
  b.resolve();
  b.clock.advance(30_000);
  const pts = b.say('a1', '!очки');
  assert.ok(pts[0].text.startsWith('@a1 — '), pts[0].text);
  assert.ok(pts[0].text.includes('(#1 в рейтинге) | боёв 1, побед 1, MVP 1'));
  const top = b.say('x', '!топ');
  assert.ok(top[0].text.startsWith('🏆 Топ чата: 1. @a1 '));
  assert.deepStrictEqual(b.say('y', '!топ'), [], 'общий кулдаун 60 с');
});

test('Отмена: очки не начисляются', () => {
  const store = createMemoryStore();
  const b = startBattle({ players: [['a1', 'воин']], store });
  b.say('a1', '!атака');
  b.resolve();
  b.say('streamer', '!стоп', STREAMER);
  assert.strictEqual(b.st.result.outcome, 'cancelled');
  assert.deepStrictEqual(store.top(10), []);
});

test('У каждого сообщения есть priority', () => {
  const { journal } = runScriptedBattle({ seed: 9, players: 12 });
  for (const m of journal) assert.ok(['low', 'normal', 'high'].includes(m.priority), JSON.stringify(m));
  assert.ok(journal.some((m) => m.priority === 'low'));
});
