// Полный бой по сценарию: фейковые часы (по 1 с за tick), игроки шлют команды
// по отдельному сидируемому rng. Используется golden-тестом, тестом сохранения и инвариантами.

import { CONFIG } from '../../src/config.js';
import { createBattleEngine, fromJSON } from '../../battle/engine.js';
import { makeRng } from '../helpers.js';
import { makeClock, STREAMER, VIEWER } from './helpers.js';

const CLASS_WORDS = ['воин', 'лучник', 'маг', 'хиллер'];
const ACTIONS = ['!атака', '!атака', '!навык', '!особый'];

export function runScriptedBattle({
  seed = 1, players = 10, config = CONFIG, restartAtTurn = null, longNames = false, explicitShare = 0.6,
} = {}) {
  const clock = makeClock();
  const rng = makeRng(seed);
  const act = makeRng(seed * 7919 + 13); // поведение чата — отдельный поток, чтобы не сбивать rng движка
  let eng = createBattleEngine({ config, rng, now: clock.now });
  const journal = [];
  const push = (msgs) => { journal.push(...msgs); };
  let restarted = false;

  push(eng.handleMessage({ userId: 'streamer', displayName: 'Стример', text: '!босс', roles: STREAMER }));
  const users = [];
  for (let i = 0; i < players; i++) {
    const userId = `u${String(i).padStart(3, '0')}`;
    const name = longNames ? `${userId}_${'x'.repeat(20)}` : `игрок${i}`;
    users.push({ userId, name });
    push(eng.handleMessage({ userId, displayName: name, text: '!join', roles: VIEWER }));
  }

  let turnSeen = 0;
  let turnStartMs = 0;
  for (let s = 0; s < 2000; s++) {
    clock.advance(1000);
    const st = eng.getState();
    if (st.phase === 'running' && st.turn !== turnSeen) {
      turnSeen = st.turn;
      turnStartMs = clock.now();
    }
    if (st.phase === 'running' && clock.now() - turnStartMs === 3000) {
      for (const u of users) {
        if (act(0, 999) < explicitShare * 1000) {
          push(eng.handleMessage({ userId: u.userId, displayName: u.name, text: ACTIONS[act(0, 3)], roles: VIEWER }));
        }
      }
      if (act(0, 1) === 1 && st.streamer.hand.length > 0) {
        push(eng.handleMessage({ userId: 'streamer', text: `!карта ${act(1, st.streamer.hand.length)}`, roles: STREAMER }));
      }
      if (act(0, 9) === 0) {
        const u = users[act(0, users.length - 1)];
        push(eng.handleMessage({ userId: u.userId, displayName: u.name, text: '!я', roles: VIEWER }));
      }
    }
    if (restartAtTurn !== null && !restarted && st.phase === 'running' && st.turn === restartAtTurn
        && clock.now() - turnStartMs === 10000) {
      eng = fromJSON(eng.toJSON(), { config, rng, now: clock.now }); // тот же поток rng и часы
      restarted = true;
    }
    push(eng.tick());
    if (eng.getState().phase === 'ended') break;
  }
  return { journal, result: eng.getState().result, state: eng.getState(), restarted };
}

export function journalText(journal) {
  return journal.map((m) => `[${m.to}] ${m.text}`).join('\n') + '\n';
}
