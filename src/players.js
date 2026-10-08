import { CONFIG } from './config.js';
import { assignElement, assignClass } from './players_utils.js';
import { assignPersonalSkill } from './personal_skills.js';
import { assignTraits, applyTraits, defaultMods } from './traits.js';
import { pickWeighted, rand01 } from './rng.js';

// Голая запись игрока: стихия есть, навыка и черт ещё нет (их ставит joinPlayer).
export function createPlayer(userId, name, classId, battleId, config = CONFIG) {
  const cls = config.PLAYER_CLASSES[classId];
  if (!cls) throw new Error(`Unknown classId: ${classId}`);

  return {
    userId,
    displayName: name,
    classId,
    element: assignElement(battleId, userId, classId, config),
    hp: cls.hp,
    maxHp: cls.hp,
    mana: cls.mana,
    maxMana: cls.mana,
    status: 'alive',
    downedTurnsLeft: 0,
    personalSkill: null,
    traits: null,
    mods: defaultMods(config),
    cooldowns: {},
    lastCommand: null,
    activeFromTurn: 0,
    // support и contribution пишет движок боя (часть 5) для очков (часть 6).
    stats: { damage: 0, healing: 0, absorbed: 0, support: 0, activeTurns: 0, contribution: 0 },
  };
}

// Полная сборка игрока заданного класса: createPlayer (со стихией) → assignPersonalSkill →
// assignTraits → applyTraits. В бою класс выдаёт joinPlayer; напрямую — для тестов и инструментов.
export function buildPlayer(battleId, userId, name, classId, { boss = null, config = CONFIG } = {}) {
  const player = createPlayer(userId, name, classId, battleId, config);
  if (boss) assignPersonalSkill(boss, player, battleId, config);
  applyTraits(player, assignTraits(player, battleId, config), config);
  return player;
}

// Возвращает { ok, player, reason }; reason: joined | already_joined | full.
// Класс выдаётся случайно (assignClass), выбрать или сменить его нельзя.
// boss нужен для выдачи личного навыка; без него навык null (выдать позже через
// assignPersonalSkillsForAll).
export function joinPlayer(registry, battleId, userId, name, currentTurn, battleStarted, { boss = null, config = CONFIG } = {}) {
  const existing = registry.get(userId);
  if (existing) return { ok: true, player: existing, reason: 'already_joined' };
  if (registry.size >= config.PLAYER_LIMIT) return { ok: false, player: null, reason: 'full' };

  const classId = assignClass(battleId, userId, config);
  const player = buildPlayer(battleId, userId, name, classId, { boss, config });
  player.activeFromTurn = battleStarted ? currentTurn + 1 : currentTurn;
  registry.set(userId, player);
  return { ok: true, player, reason: 'joined' };
}

// Для игроков, записавшихся до появления босса.
export function assignPersonalSkillsForAll(registry, boss, battleId, config = CONFIG) {
  for (const player of registry.values()) {
    if (!player.personalSkill) assignPersonalSkill(boss, player, battleId, config);
  }
}

export function leavePlayer(registry, userId) {
  return registry.delete(userId);
}

export function resetAll(registry) {
  registry.clear();
}

function isActive(player, turn) {
  return player.status === 'alive' && (turn == null || player.activeFromTurn <= turn);
}

function pickRandom(list, rng) {
  return list[rng(0, list.length - 1)];
}

// Живой активный игрок с наименьшим hp/maxHp; при равенстве — случайный через rng.
export function findMostWounded(registry, currentTurn, rng) {
  const candidates = [...registry.values()].filter((p) => isActive(p, currentTurn));
  if (candidates.length === 0) return null;
  const minRatio = Math.min(...candidates.map((p) => p.hp / p.maxHp));
  return pickRandom(candidates.filter((p) => p.hp / p.maxHp === minRatio), rng);
}

// Цель одиночной атаки босса среди живых активных, с весом bossTargetWeight.
//   mode 'random'    — взвешенно-случайно среди всех
//   mode 'topDamage' — самый большой stats.damage; при равенстве взвешенно-случайно
// players — Map реестра или массив. turn не задан — активность не проверяется.
export function pickSingleTarget(players, rng, { mode = 'random', turn = null } = {}) {
  let pool = [...(players instanceof Map ? players.values() : players)].filter((p) => isActive(p, turn));
  if (pool.length === 0) return null;
  if (mode === 'topDamage') {
    const top = Math.max(...pool.map((p) => p.stats.damage));
    pool = pool.filter((p) => p.stats.damage === top);
  } else if (mode !== 'random') {
    throw new Error(`Unknown target mode: ${mode}`);
  }
  return pickWeighted(
    pool.map((p) => ({ item: p, weight: p.mods?.bossTargetWeight ?? 1 })),
    rand01(rng),
  );
}
