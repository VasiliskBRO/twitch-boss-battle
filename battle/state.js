// Состояние боя: создание, сериализация, выборки игроков, итоговый result.
// Всё состояние — простые данные (кроме registry: Map ↔ массив при сериализации).

export const STATE_VERSION = 1;

export function createInitialState() {
  return {
    version: STATE_VERSION,
    battleId: null,
    phase: 'idle', // idle | lobby | running | ended
    turn: 0,
    boss: null,
    registry: new Map(),
    streamer: null, // состояние карт (часть 4)
    // Командные эффекты: { type, turnsLeft, ... }; shield без turnsLeft (до первой атаки).
    //   teamDamageBoost { pct } | teamDamagePenalty { pct, source } | silenceClass { classId }
    //   immunity | shield | damageReduction { pct } | absorb { pctMaxHp }
    teamEffects: [],
    // Личные эффекты на ход: taunt { userId, mult } | reflect { userId, pct }.
    playerEffects: [],
    bossDots: [], // { sourceId, perTick, turnsLeft, startTurn }
    delayedHits: [], // { sourceId, amount, damageType, dueTurn }
    queuedMomentCard: null, // cardId карты из «момента стримера», применяется в начале следующего хода
    pendingTelegraph: null, // навык босса, заявленный на этот ход
    bossBuffCancelled: false, // Антимагия отменила бафф этого хода
    lobbyStartedAtMs: null,
    lobbyEndsAtMs: null,
    lastLobbyProgressMs: null,
    lastLobbyProgressCount: 0,
    turnEndsAtMs: null,
    endedAtMs: null,
    meCooldowns: {}, // userId → ms последнего ответа на !я
    pointsCooldowns: {}, // кулдауны !очки и !топ (часть 6)
    suggestCooldowns: { users: {}, lastMs: null }, // кулдауны подсказок на опечатки
    joinQueue: [], // displayName вступивших, ждущих сводки
    joinQueueSinceMs: null, // когда в очередь попал первый

    lastHitUserId: null,
    turnLog: null, // данные для итога текущего хода
    result: null,
  };
}

export function serializeState(state) {
  return JSON.stringify({ ...state, registry: [...state.registry.values()] });
}

export function deserializeState(data) {
  const raw = typeof data === 'string' ? JSON.parse(data) : structuredClone(data);
  if (raw?.version !== STATE_VERSION || !Array.isArray(raw.registry)) {
    throw new Error('Bad battle state data');
  }
  raw.registry = new Map(raw.registry.map((p) => [p.userId, p]));
  return raw;
}

const byUserId = (a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

// Участники хода: записаны и активны с этого хода (живые и павшие), по возрастанию userId.
export function participants(state) {
  return [...state.registry.values()].filter((p) => p.activeFromTurn <= state.turn).sort(byUserId);
}

// Живые активные игроки по возрастанию userId.
export function activeAlive(state) {
  return participants(state).filter((p) => p.status === 'alive');
}

export function contribution(p) {
  return p.stats.damage + p.stats.healing + p.stats.absorbed;
}

export function buildResult(state, outcome) {
  const boss = state.boss;
  return {
    battleId: state.battleId,
    outcome, // victory | defeat | wipe | cancelled
    turns: state.turn,
    bossName: boss?.name ?? null,
    bossArchetype: boss?.archetype ?? null,
    bossMaxHp: boss?.maxHp ?? null,
    bossFinalHpPct: boss && boss.maxHp > 0 ? boss.hp / boss.maxHp : null,
    lastHitUserId: outcome === 'victory' ? state.lastHitUserId : null,
    players: [...state.registry.values()].map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      classId: p.classId,
      element: p.element,
      traits: p.traits ? { gift: p.traits.gift, curses: [...p.traits.curses] } : null,
      personalSkillId: p.personalSkill?.skillId ?? null,
      status: p.status,
      stats: { ...p.stats },
    })),
  };
}
