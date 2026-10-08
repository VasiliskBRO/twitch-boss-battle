import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../../src/config.js';
import { findSuggestion, availableCommands, editDistance } from '../../battle/suggest.js';
import { startBattle, makeClock, makeRng, STREAMER, VIEWER } from './helpers.js';
import { createBattleEngine } from '../../battle/engine.js';

const running = (staff = false) => availableCommands('running', staff);

test('Опечатки, раскладка, оборванные и русские написания → наша команда', () => {
  const cases = {
    '!атак': '!атака', '!аткаа': '!атака', '!fnfrf': '!атака', '!навк': '!навык', '!нвык': '!навык',
    '!осбый': '!особый', '!особ': '!особый', '!очко': '!очки', '!топп': '!топ', '!z': '!я',
    '!jion': '!join', '!jon': '!join', '!ощшт': '!join', '!джоин': '!join', '!скилл': '!навык',
    '!АТАК': '!атака', '!очкё': '!очки',
  };
  for (const [typo, expected] of Object.entries(cases)) assert.strictEqual(findSuggestion(typo, running()), expected, typo);
});

test('Чужие и далёкие команды — без подсказки; известные команды — без подсказки', () => {
  for (const w of ['!uptime', '!discord', '!so', '!top', '!points', '!stop', '!hi', '!lurk', '!ау', '!а', '!да',
    '!нет', '!ja', '!ты', '!dice', '!followage', '!неизвестно', '!', 'атака', '!атака', '!join', '!я']) {
    assert.strictEqual(findSuggestion(w, running(true)), null, w);
  }
});

test('Команды стримера подсказываются только стримеру и модераторам; по фазе боя', () => {
  assert.strictEqual(findSuggestion('!карты', running(false)), null);
  assert.strictEqual(findSuggestion('!карты', running(true)), '!карта');
  assert.strictEqual(findSuggestion('!рукка', running(true)), '!рука');
  assert.strictEqual(findSuggestion('!бос', availableCommands('idle', true)), '!босс');
  assert.strictEqual(findSuggestion('!бос', running(true)), null, 'в бою !босс не нужен');
  assert.strictEqual(findSuggestion('!атак', availableCommands('idle', false)), null, 'вне боя !атака не нужна');
  assert.strictEqual(findSuggestion('!jion', availableCommands('lobby', false)), '!join');
});

test('editDistance: перестановка соседних букв — одна правка', () => {
  assert.strictEqual(editDistance('!атака', '!аткаа'), 1);
  assert.strictEqual(editDistance('!навык', '!нвык'), 1);
  assert.strictEqual(editDistance('abc', 'abc'), 0);
});

test('Движок: подсказка в чат с priority low, аргументы сохраняются, кулдауны 30 с на зрителя и 5 с общий', () => {
  const b = startBattle({ players: [['w', 'воин'], ['m', 'маг']] });
  const first = b.say('w', '!атак');
  assert.deepStrictEqual(first, [{ text: '@w, такой команды нет. Может, ты про !атака?', to: 'chat', priority: 'low' }]);
  assert.strictEqual(b.p('w').lastCommand, null, 'опечатка не ставит команду');

  b.clock.advance(4_999);
  assert.deepStrictEqual(b.say('m', '!навк'), [], 'общий кулдаун 5 с');
  b.clock.advance(1);
  assert.strictEqual(b.say('m', '!навк')[0].text, '@m, такой команды нет. Может, ты про !навык?');
  assert.deepStrictEqual(b.say('w', '!осбый'), [], 'кулдаун зрителя 30 с');
  b.clock.advance(30_000);
  assert.strictEqual(b.say('w', '!осбый').length, 1);

  b.clock.advance(30_000);
  const card = b.say('streamer', '!карты 2', STREAMER);
  assert.strictEqual(card[0].text, '@streamer, такой команды нет. Может, ты про !карта 2?');
  b.clock.advance(30_000);
  assert.deepStrictEqual(b.say('v', '!uptime'), []);
  assert.deepStrictEqual(b.say('v', '!карты 2', VIEWER), [], 'зрителю команды стримера не подсказываем');
});

test('Движок: подсказки можно выключить; вне боя стример получает «!босс»', () => {
  const off = startBattle({ players: [['w', 'воин']], config: { ...CONFIG, BATTLE: { ...CONFIG.BATTLE, suggestCommands: false } } });
  assert.deepStrictEqual(off.say('w', '!атак'), []);

  const clock = makeClock();
  const eng = createBattleEngine({ rng: makeRng(1), now: clock.now });
  const msgs = eng.handleMessage({ userId: 's', displayName: 'Стример', text: '!бос', roles: STREAMER });
  assert.deepStrictEqual(msgs.map((m) => m.text), ['@Стример, такой команды нет. Может, ты про !босс?']);
});
