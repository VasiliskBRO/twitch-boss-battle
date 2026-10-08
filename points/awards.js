// Вклад и награды за бой. Чистые функции: ничего не записывают.

import { CONFIG } from '../src/config.js';

const STAT_KEYS = ['damage', 'healing', 'absorbed', 'support'];

function weighted(stats, weights) {
  return STAT_KEYS.reduce((sum, k) => sum + (stats?.[k] ?? 0) * (weights[k] ?? 0), 0);
}

// Вклад игрока.
//   perTurnData = { turns: [статы за ход], bossMaxHp } — потолок применяется к каждому ходу;
//   иначе, если движок уже посчитал stats.contribution (с потолком по ходам), берётся он;
//   иначе — взвешенная сумма без потолка.
export function computeContribution(stats, config = CONFIG, perTurnData = null) {
  const { weights, turnContributionCap } = config.POINTS;
  if (perTurnData) {
    const cap = turnContributionCap * perTurnData.bossMaxHp;
    return perTurnData.turns.reduce((sum, turn) => sum + Math.min(cap, weighted(turn, weights)), 0);
  }
  if (typeof stats?.contribution === 'number') return stats.contribution;
  return weighted(stats, weights);
}

export function isExcluded(player, config = CONFIG) {
  const excluded = config.POINTS.excludeUserIds.map((id) => String(id).toLowerCase());
  return excluded.includes(String(player.userId).toLowerCase())
    || excluded.includes(String(player.displayName ?? '').toLowerCase());
}

// Участник: activeTurns ≥ minActiveTurns (автоатаки не считаются) и не бот из excludeUserIds.
export function participantsOf(result, config = CONFIG) {
  return (result.players ?? [])
    .map((p, joinOrder) => ({ ...p, joinOrder }))
    .filter((p) => (p.stats?.activeTurns ?? 0) >= config.POINTS.minActiveTurns && !isExcluded(p, config));
}

// { awards: [{ userId, displayName, contribution, participation, poolShare, mvp, lastHit, total }],
//   mvpUserId, participantsCount }. Компоненты округлены вниз; total = max(minAward, ⌊сумма⌋).
export function computeAwards(result, config = CONFIG) {
  const P = config.POINTS;
  if (!result || result.outcome === 'cancelled') return { awards: [], mvpUserId: null, participantsCount: 0 };

  const players = participantsOf(result, config);
  const n = players.length;
  if (n === 0) return { awards: [], mvpUserId: null, participantsCount: 0 };

  const contributions = players.map((p) => Math.max(0, computeContribution(p.stats, config)));
  const totalContribution = contributions.reduce((a, b) => a + b, 0);
  const pool = P.poolPerParticipant * n;

  // MVP: больший вклад → больше activeTurns → раньше присоединился.
  const ranked = players
    .map((p, i) => ({ p, c: contributions[i] }))
    .sort((a, b) => b.c - a.c || b.p.stats.activeTurns - a.p.stats.activeTurns || a.p.joinOrder - b.p.joinOrder);
  const mvpUserId = ranked[0].p.userId;
  const lastHitUserId = players.some((p) => p.userId === result.lastHitUserId) ? result.lastHitUserId : null;
  const mult = result.outcome === 'victory' ? 1 : P.defeatMult;

  const awards = players.map((p, i) => {
    const share = totalContribution > 0 ? pool * (contributions[i] / totalContribution) : pool / n;
    const parts = {
      participation: P.participation * mult,
      poolShare: share * mult,
      mvp: p.userId === mvpUserId ? P.mvpBonus * mult : 0,
      lastHit: p.userId === lastHitUserId ? P.lastHitBonus * mult : 0,
    };
    const sum = parts.participation + parts.poolShare + parts.mvp + parts.lastHit;
    return {
      userId: p.userId,
      displayName: p.displayName,
      contribution: Math.round(contributions[i]),
      participation: Math.floor(parts.participation),
      poolShare: Math.floor(parts.poolShare),
      poolShareExact: parts.poolShare, // для проверки суммы пула
      mvp: Math.floor(parts.mvp),
      lastHit: Math.floor(parts.lastHit),
      total: Math.max(P.minAward, Math.floor(sum + 1e-9)),
    };
  });

  return { awards, mvpUserId, participantsCount: n };
}
