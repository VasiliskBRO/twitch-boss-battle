import { CONFIG } from '../../src/config.js';
import { defaultMods } from '../../src/traits.js';
import { assignClass } from '../../src/players_utils.js';
import { createBattleEngine } from '../../battle/engine.js';
import { makeRng } from '../helpers.js';

export { makeRng };

export const STREAMER = { broadcaster: true, moderator: false };
export const MOD = { broadcaster: false, moderator: true };
export const VIEWER = { broadcaster: false, moderator: false };
export const T0 = 1_700_000_000_000;

export function makeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Конфиг без случайности в числах: разброс ×1, крит 0, фиксированная доля урона босса,
// без множителей фаз, лечение без разброса, одиночные атаки только случайные (не topDamage).
export const DET = {
  ...CONFIG,
  COMBAT: { ...CONFIG.COMBAT, CRIT_CHANCE: 0, DMG_VARIANCE: { min: 1, max: 1 } },
  DAMAGE_VALUES: { single: { min: 0.3, max: 0.3 }, aoe: { min: 0.2, max: 0.2 } },
  BOSS_PHASE_DAMAGE_MULT: [1, 1, 1],
  BATTLE: { ...CONFIG.BATTLE, healVariance: 0, bossTopDamageChance: 0 },
};

export const SKILLS = {
  single: { id: 't_single', name: 'Тест-удар', kind: 'single', power: 1, cooldown: 0, unlockPhase: 1 },
  aoe: { id: 't_aoe', name: 'Тест-волна', kind: 'aoe', power: 1, cooldown: 0, unlockPhase: 1 },
  silence: { id: 't_silence', name: 'Тест-немота', kind: 'debuff', effect: 'silence_class', power: 1, cooldown: 0, unlockPhase: 1 },
  weaken: { id: 't_weaken', name: 'Тест-слабость', kind: 'debuff', effect: 'weaken', power: 1, cooldown: 0, unlockPhase: 1 },
  armor: { id: 't_armor', name: 'Тест-броня', kind: 'buff', effect: 'armor', power: 1, cooldown: 0, unlockPhase: 1 },
};

// Снимает случайность черт: нейтральные модификаторы, базовые HP/мана класса, стихия neutral.
export function neutralize(player, config = DET) {
  const cls = config.PLAYER_CLASSES[player.classId];
  player.mods = defaultMods(config);
  player.maxHp = player.hp = cls.hp;
  player.maxMana = player.mana = cls.mana;
  player.element = player.classId === 'healer' ? 'holy' : 'neutral';
}

const CLASS_BY_WORD = { воин: 'warrior', лучник: 'archer', маг: 'mage', хиллер: 'healer' };

// Класс выдаётся хешем (battleId, userId), выбрать его нельзя. Для тестов подбираем userId
// вида «alias», «alias~1», «alias~2»…, которому хеш выдаёт нужный класс. Порядок по userId
// сохраняется (сортировка идёт по alias), а ник в сообщениях — сам alias.
export function idForClass(battleId, alias, classWord, config = DET) {
  const classId = CLASS_BY_WORD[classWord] ?? classWord;
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? alias : `${alias}~${n}`;
    if (assignClass(battleId, id, config) === classId) return id;
  }
  throw new Error(`Не нашёлся userId для класса ${classId}`);
}

// Бой после лобби: players = [[alias, 'воин'], …]. Босс — «зверь» (dmgMult 1),
// слабость ice / сопротивление fire (не совпадают с physical/magic/holy), 100000 HP.
export function startBattle({ players, seed = 1, config = DET, neutral = true, bossHp = 100000, store } = {}) {
  const clock = makeClock();
  const rng = makeRng(seed);
  const eng = createBattleEngine({ config, rng, now: clock.now, ...(store ? { store } : {}) });
  const journal = [];
  const record = (msgs) => { journal.push(...msgs); return msgs; };

  record(eng.handleMessage({ userId: 'streamer', displayName: 'Стример', text: '!босс', roles: STREAMER }));
  const battleId = eng.getState().battleId;
  const ids = {};
  const idOf = (alias) => ids[alias] ?? alias;
  for (const [alias, cls] of players) {
    ids[alias] = idForClass(battleId, alias, cls, config);
    record(eng.handleMessage({ userId: ids[alias], displayName: alias, text: '!join', roles: VIEWER }));
  }
  clock.advance(config.BATTLE.lobbySeconds * 1000);
  record(eng.tick());

  const st = eng.getState();
  if (neutral) {
    Object.assign(st.boss, { archetype: 'beast', weakness: 'ice', resistance: 'fire', maxHp: bossHp, hp: bossHp, currentPhase: 1 });
    st.turnLog.bossHpStart = bossHp;
    for (const p of st.registry.values()) neutralize(p, config);
  }

  return {
    eng, clock, st, rng, journal,
    id: idOf,
    p: (alias) => st.registry.get(idOf(alias)),
    say: (alias, text, roles = VIEWER) => record(eng.handleMessage({ userId: idOf(alias), displayName: alias, text, roles })),
    // Вход посреди боя игроком нужного класса.
    joinAs: (alias, cls) => {
      ids[alias] = idForClass(st.battleId, alias, cls, config);
      return record(eng.handleMessage({ userId: ids[alias], displayName: alias, text: '!join', roles: VIEWER }));
    },
    telegraph: (skill) => { st.pendingTelegraph = { ...skill }; },
    // Доводит часы ровно до конца окна текущего хода (первый ход длиннее остальных).
    resolve: () => { clock.advance(Math.max(0, st.turnEndsAtMs - clock.now())); return record(eng.tick()); },
    giveSkill: (alias, skillId, rarity = 'common') => {
      const p = st.registry.get(idOf(alias));
      p.personalSkill = { skillId, rarity };
      p.cooldowns.personal = 0;
    },
    giveHand: (cards) => { st.streamer.hand = [...cards]; st.streamer.cooldownTurns = 0; },
  };
}

// Делит журнал на ходы по заголовкам «⚔️ Ход N/…» и считает сообщения хода в чат —
// priority high (ответы на команды normal и вступления low не в счёт).
export function messagesPerTurn(journal) {
  const counts = [];
  let current = null;
  for (const m of journal) {
    if (m.to !== 'chat' || m.priority !== 'high') continue;
    if (m.text.startsWith('⚔️ Ход ')) {
      current = { header: m.text, count: 1 };
      counts.push(current);
    } else if (current) {
      current.count++;
    }
  }
  return counts;
}
