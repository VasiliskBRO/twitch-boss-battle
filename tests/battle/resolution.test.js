// Порядок разрешения хода и семантика эффектов (раздел 5–6 ТЗ).
// Конфиг DET без случайности в числах, черты нейтрализованы, босс — «зверь» с 100000 HP,
// его слабость ice и сопротивление fire не задевают physical/magic/holy.

import test from 'node:test';
import assert from 'node:assert';
import { DET, SKILLS, STREAMER, startBattle } from './helpers.js';
import { teamDamageMult } from '../../battle/effects.js';
import { leavePlayer } from '../../src/players.js';

const dmg = (b, id) => b.p(id).stats.damage;

test('Лечение происходит до ответа босса', () => {
  const b = startBattle({ players: [['w', 'воин'], ['h', 'хиллер']] });
  b.p('w').hp = 10;
  b.say('h', '!атака'); // явное Лечение, 35%
  b.telegraph(SKILLS.aoe);
  b.resolve();
  assert.strictEqual(b.p('w').hp, 10 + 42 - 24, 'вылечен до удара (иначе пал бы)');
  assert.strictEqual(b.p('w').status, 'alive');
  assert.strictEqual(b.p('h').hp, 85 - 17);
  assert.strictEqual(b.p('h').stats.healing, 42);
});

test('Игроки бьют до атаки босса; убитый босс не атакует', () => {
  const b = startBattle({ players: [['a1', 'воин'], ['a2', 'лучник']] });
  b.st.boss.hp = 1;
  b.telegraph(SKILLS.aoe);
  const msgs = b.resolve();
  assert.strictEqual(b.st.result.outcome, 'victory');
  assert.strictEqual(b.st.result.lastHitUserId, b.id('a1'), 'первый по userId добил');
  assert.strictEqual(b.p('a1').hp, 120);
  assert.strictEqual(b.p('a2').hp, 90);
  assert.ok(msgs.some((m) => m.text.includes('не успел ударить')));
  assert.ok(msgs.at(-1).text.startsWith('🏆 Победа!'));
  assert.ok(msgs.length <= 2);
});

test('Щит блокирует атаку один раз', () => {
  const b = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  b.giveHand(['shield', 'fury', 'fog']);
  const played = b.say('streamer', '!карта 1', STREAMER);
  assert.strictEqual(played[0].text, '🃏 Стример играет «Щит»! Следующая атака босса полностью блокируется.');
  b.telegraph(SKILLS.aoe);
  const msgs = b.resolve();
  assert.deepStrictEqual([b.p('w').hp, b.p('m').hp], [120, 70]);
  assert.ok(msgs[0].text.includes('Щит заблокировал «Тест-волна»'));

  b.telegraph(SKILLS.aoe);
  b.resolve();
  assert.deepStrictEqual([b.p('w').hp, b.p('m').hp], [96, 56], 'щит израсходован');
});

test('Щит не тратится на бафф босса', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  b.giveHand(['shield', 'fury', 'fog']);
  b.say('streamer', '!карта 1', STREAMER);
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.ok(b.st.boss.statusEffects.some((s) => s.id === 'armor'));
  b.telegraph(SKILLS.aoe);
  b.resolve();
  assert.strictEqual(b.p('w').hp, 120, 'щит сработал на следующей атаке');
});

test('Провокация: одиночный удар идёт в воина с −50%, записывается absorbed', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const b = startBattle({ seed, players: [['a', 'лучник'], ['m', 'маг'], ['w', 'воин']] });
    b.say('w', '!навык');
    b.telegraph(SKILLS.single);
    const msgs = b.resolve();
    assert.strictEqual(b.p('w').hp, 120 - 18);
    assert.strictEqual(b.p('w').stats.absorbed, 18);
    assert.deepStrictEqual([b.p('a').hp, b.p('m').hp], [90, 70]);
    assert.ok(msgs[0].text.includes('(провокация)'));
  }
});

test('Магический барьер снижает урон, Щит света поглощает', () => {
  const barrier = startBattle({ players: [['m', 'маг'], ['w', 'воин']] });
  barrier.giveSkill('m', 'magic_barrier');
  barrier.say('m', '!особый');
  barrier.telegraph(SKILLS.aoe);
  barrier.resolve();
  assert.strictEqual(barrier.p('w').hp, 120 - 17, '24 × 0.7 = 16.8');
  assert.strictEqual(barrier.p('m').hp, 70 - 10, '14 × 0.7 = 9.8');

  const shield = startBattle({ players: [['h', 'хиллер'], ['w', 'воин']] });
  shield.giveSkill('h', 'light_shield');
  shield.say('h', '!особый');
  shield.telegraph(SKILLS.aoe);
  shield.resolve();
  assert.strictEqual(shield.p('w').hp, 120 - 12, '24 − 10% от 120');
  assert.strictEqual(shield.p('h').hp, 85 - 9, 'round(17 − 8.5)');
});

test('Очищение: иммунитет к дебаффу босса и снятие заглушки', () => {
  const b = startBattle({ players: [['h', 'хиллер'], ['m', 'маг']] });
  b.st.teamEffects.push({ type: 'silenceClass', classId: 'mage', turnsLeft: 2 });
  b.giveSkill('h', 'purification');
  b.say('h', '!особый');
  b.telegraph(SKILLS.silence);
  const msgs = b.resolve();
  assert.ok(msgs[0].text.includes('Очищение отразило «Тест-немота»'));
  assert.ok(!b.st.teamEffects.some((e) => e.type === 'silenceClass'));

  const before = b.p('m').stats.damage;
  b.say('m', '!навык');
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.p('m').stats.damage - before, 90, 'Шар прошёл — заглушки нет');
});

test('Заглушка босса действует со следующего хода, карта «Проклятие» — с текущего', () => {
  const b = startBattle({ players: [['m', 'маг']] });
  b.say('m', '!навык');
  b.telegraph(SKILLS.silence);
  b.resolve();
  assert.strictEqual(dmg(b, 'm'), 90, 'в ходу заявки Шар ещё работает');
  b.say('m', '!навык');
  b.telegraph(SKILLS.single); // без брони босса, чтобы урон считался чисто
  b.resolve();
  assert.strictEqual(dmg(b, 'm'), 90 + 40, 'следующий ход: заглушён, вместо Шара Искра');
  b.say('m', '!навык');
  b.telegraph(SKILLS.single);
  b.resolve();
  assert.strictEqual(dmg(b, 'm'), 130 + 90, 'через ход заглушка снята');

  const c = startBattle({ players: [['m', 'маг']] });
  c.giveHand(['curse', 'fury', 'fog']);
  c.say('streamer', '!карта 1', STREAMER);
  c.say('m', '!навык');
  c.telegraph(SKILLS.armor);
  c.resolve();
  assert.strictEqual(dmg(c, 'm'), 40, 'Проклятие работает в этом же ходу');
});

test('Метеор падает на шаге урона следующего хода и засчитывается магу', () => {
  const b = startBattle({ players: [['m', 'маг']] });
  b.giveSkill('m', 'meteor');
  b.say('m', '!особый');
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(dmg(b, 'm'), 0);
  assert.deepStrictEqual(b.st.delayedHits.map((h) => [h.sourceId, h.amount, h.dueTurn]), [[b.id('m'), 140, 2]]);
  b.telegraph(SKILLS.single);
  b.resolve();
  // броня босса из хода 1 (×0.7) действует и на метеор: (140 + автоатака 30) × 0.7
  assert.strictEqual(dmg(b, 'm'), Math.round(140 * 0.7) + Math.round(30 * 0.7));
  assert.deepStrictEqual(b.st.delayedHits, []);
});

test('Яд тикает со следующего хода и засчитывается лучнику', () => {
  const b = startBattle({ players: [['a', 'лучник']] });
  b.giveSkill('a', 'poison_arrow');
  b.say('a', '!особый');
  b.telegraph(SKILLS.silence); // босс не бьёт и не меняет урон: лучник доживёт до конца яда
  b.resolve();
  assert.strictEqual(dmg(b, 'a'), 36, 'ход 1: только выстрел ×0.8');
  const perTurn = [];
  for (let i = 0; i < 4; i++) {
    const before = dmg(b, 'a');
    b.telegraph(SKILLS.silence);
    b.resolve();
    perTurn.push(dmg(b, 'a') - before);
  }
  assert.deepStrictEqual(perTurn, [14 + 34, 14 + 34, 14 + 34, 34], '3 тика яда по 14 + автоатака 34');
});

test('Контрудар засчитывается воину', () => {
  const b = startBattle({ players: [['w', 'воин']] });
  b.giveSkill('w', 'counter_strike');
  b.say('w', '!особый');
  b.telegraph(SKILLS.single);
  b.resolve();
  assert.strictEqual(b.p('w').hp, 120 - 36);
  assert.strictEqual(dmg(b, 'w'), 18);
});

test('Удар стримера не убивает босса и не становится last hit', () => {
  const b = startBattle({ players: [['h', 'хиллер']] });
  b.giveHand(['streamer_strike', 'fury', 'fog']);
  b.st.boss.hp = 3;
  b.say('streamer', '!карта 1', STREAMER);
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.st.boss.hp, 1);
  assert.strictEqual(b.st.phase, 'running');
  assert.strictEqual(b.st.lastHitUserId, null);

  b.p('h').mana = 0; // Искра света вместо Лечения
  b.say('h', '!атака');
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.st.result.outcome, 'victory');
  assert.strictEqual(b.st.result.lastHitUserId, b.id('h'));
});

test('Командный множитель: Боевой клич и Благословение перемножаются; Туман и weaken уменьшают', () => {
  const b = startBattle({ players: [['h', 'хиллер'], ['w', 'воин']] });
  b.giveHand(['war_cry', 'fury', 'fog']);
  b.giveSkill('h', 'blessing');
  b.say('streamer', '!карта 1', STREAMER);
  b.say('h', '!особый');
  b.say('w', '!атака');
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(dmg(b, 'w'), Math.round(40 * 1.25 * 1.25));

  const fog = startBattle({ players: [['w', 'воин']] });
  fog.giveHand(['fog', 'fury', 'shield']);
  fog.say('streamer', '!карта 1', STREAMER);
  fog.say('w', '!атака');
  fog.telegraph(SKILLS.weaken);
  fog.resolve();
  assert.strictEqual(dmg(fog, 'w'), 30, 'Туман −25%');
  fog.say('w', '!атака');
  fog.telegraph(SKILLS.single);
  fog.resolve();
  assert.strictEqual(dmg(fog, 'w') - 30, 30, 'weaken босса −25% со следующего хода (Туман уже кончился)');
  assert.ok(Math.abs(teamDamageMult({ teamEffects: [
    { type: 'teamDamageBoost', pct: 0.25 }, { type: 'teamDamagePenalty', pct: 0.25 }, { type: 'teamDamagePenalty', pct: 0.25 },
  ] }) - 1.25 * 0.75 * 0.75) < 1e-9);
});

test('Новичок посреди боя действует со следующего хода; перезаход не меняет стихию и черты', () => {
  const b = startBattle({ players: [['w', 'воин']], neutral: false });
  b.joinAs('n', 'маг');
  const n = b.p('n');
  n.mods.missChance = 0; // черты случайные: «Дрожащие руки» дали бы промах
  assert.strictEqual(n.activeFromTurn, 2);
  b.telegraph(SKILLS.aoe);
  b.resolve();
  assert.strictEqual(n.stats.damage, 0, 'в ходу входа не действует');
  assert.strictEqual(n.hp, n.maxHp, 'и не получает урон');
  b.resolve();
  assert.ok(n.stats.damage > 0, 'со следующего хода бьёт');

  const { element, traits, personalSkill, classId } = n;
  leavePlayer(b.st.registry, b.id('n'));
  b.say('n', '!join');
  assert.deepStrictEqual(
    [b.p('n').classId, b.p('n').element, b.p('n').traits, b.p('n').personalSkill.skillId],
    [classId, element, traits, personalSkill.skillId],
  );
  assert.deepStrictEqual(b.say('w', '!join маг'), [], 'повторный !join молчит, текст после него игнорируется');
  assert.strictEqual(b.p('w').classId, 'warrior');
});

test('Смена фазы открывает момент стримера; карта из момента — в начале следующего хода', () => {
  const b = startBattle({ players: [['w', 'воин']], bossHp: 1000 });
  b.st.boss.hp = 670;
  b.say('w', '!атака');
  b.telegraph(SKILLS.armor);
  const msgs = b.resolve();
  const moment = msgs.find((m) => m.text.startsWith('⚡ Момент стримера!'));
  assert.ok(moment, 'момент открыт');
  assert.ok(moment.text.includes('Босс на 66% HP'));

  b.giveHand(['war_cry', 'fury', 'fog']);
  const played = b.say('streamer', '!карта 1', STREAMER);
  assert.ok(played[0].text.endsWith('Сработает в начале следующего хода.'));
  b.st.boss.statusEffects = [];
  b.st.boss.damageTakenMult = 1;
  const before = dmg(b, 'w');
  b.say('w', '!атака');
  b.telegraph(SKILLS.single);
  b.resolve();
  assert.strictEqual(dmg(b, 'w') - before, 40, 'в ходу розыгрыша клич ещё не действует');
  assert.ok(b.st.teamEffects.some((e) => e.type === 'teamDamageBoost'), 'применён в начале следующего хода');
  const before2 = dmg(b, 'w');
  b.say('w', '!атака');
  b.telegraph(SKILLS.single);
  b.resolve();
  assert.strictEqual(dmg(b, 'w') - before2, 50);
});

test('Wipe: все активные пали — поражение', () => {
  const b = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  b.p('w').hp = 1;
  b.p('m').hp = 1;
  b.telegraph(SKILLS.aoe);
  const msgs = b.resolve();
  assert.strictEqual(b.st.result.outcome, 'wipe');
  assert.ok(msgs.at(-1).text.startsWith('💀 Отряд пал на ходу 1.'));
  assert.ok(msgs[0].text.includes('💀 Пали: @m, @w'));
});

test('Конец по maxTurns: босс убегает', () => {
  const config = { ...DET, BATTLE: { ...DET.BATTLE, maxTurns: 2 } };
  const b = startBattle({ players: [['w', 'воин']], config });
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.st.phase, 'running');
  b.telegraph(SKILLS.armor);
  const msgs = b.resolve();
  assert.deepStrictEqual([b.st.result.outcome, b.st.result.turns, b.st.result.lastHitUserId], ['defeat', 2, null]);
  assert.ok(msgs.at(-1).text.includes('убегает'));
});

test('last hit ядом и метеором: тики раньше обычных ударов', () => {
  const poison = startBattle({ players: [['aaa', 'воин'], ['zzz', 'лучник']] });
  poison.giveSkill('zzz', 'poison_arrow');
  poison.say('zzz', '!особый');
  poison.telegraph(SKILLS.armor);
  poison.resolve();
  poison.st.boss.hp = 10;
  poison.telegraph(SKILLS.armor);
  poison.resolve();
  assert.deepStrictEqual([poison.st.result.outcome, poison.st.result.lastHitUserId], ['victory', poison.id('zzz')]);

  const meteor = startBattle({ players: [['aaa', 'воин'], ['zzz', 'маг']] });
  meteor.giveSkill('zzz', 'meteor');
  meteor.say('zzz', '!особый');
  meteor.telegraph(SKILLS.single);
  meteor.resolve();
  meteor.st.boss.hp = 100;
  meteor.telegraph(SKILLS.single);
  meteor.resolve();
  assert.deepStrictEqual([meteor.st.result.outcome, meteor.st.result.lastHitUserId], ['victory', meteor.id('zzz')]);
});

test('Проклятие: итог хода называет заглушённый класс', () => {
  const b = startBattle({ players: [['m', 'маг']] });
  b.giveHand(['curse', 'fury', 'fog']);
  b.say('streamer', '!карта 1', STREAMER);
  b.telegraph(SKILLS.armor);
  const msgs = b.resolve();
  assert.ok(msgs[0].text.includes('🤐 Проклятие: 🔮 Маг без !навык и !особый'), msgs[0].text);
});
