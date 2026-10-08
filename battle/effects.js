// Семантика эффектов из EFFECT_TYPES (части 3 и 4) и навыков босса (часть 1).
// ctx = { state, config, rng }; итоги пишутся в state.turnLog.
// Эффекты от игроков хранят sourceId — для поддержки (stats.support, часть 6);
// у эффектов карт стримера sourceId = null, поддержку они никому не дают.

import { applyDamage, addStatus, removeStatus, healBoss, swapWeaknessResistance } from '../src/boss.js';
import { healPlayer, reviveNow } from '../src/player_actions.js';
import { rand01 } from '../src/rng.js';
import { activeAlive, participants } from './state.js';

// ---------- Поддержка ----------

// Делит amount поровну между источниками (уникальные userId) и пишет в stats.support.
export function addSupport(ctx, sourceIds, amount) {
  const ids = [...new Set(sourceIds.filter((id) => id != null))];
  if (ids.length === 0 || !(amount > 0)) return;
  const share = amount / ids.length;
  for (const id of ids) {
    const p = ctx.state.registry.get(id);
    if (p) p.stats.support = Math.round((p.stats.support + share) * 100) / 100;
  }
}

// Фиксированная поддержка за реальное срабатывание (Антимагия, Очищение): доля макс. HP босса,
// не больше одного раза за ход на источник и вид.
export function fixedSupport(ctx, sourceId, kind) {
  if (sourceId == null) return;
  const log = ctx.state.turnLog;
  const key = `${kind}:${sourceId}`;
  if (log.fixedSupport[key]) return;
  log.fixedSupport[key] = true;
  addSupport(ctx, [sourceId], Math.round(ctx.config.POINTS.supportFixed[kind] * ctx.state.boss.maxHp));
}

// Лишний урон удара от бустов игроков (Благословение) и уязвимости (Раскол брони):
// итоговый урон − урон без эффекта; делится поровну между источниками эффекта.
function creditHitSupport(ctx, dealt) {
  const { state } = ctx;
  let boost = 1;
  const boostSources = [];
  for (const e of state.teamEffects) {
    if (e.type === 'teamDamageBoost' && e.sourceId != null) {
      boost = Math.max(boost, 1 + e.pct);
      boostSources.push(e.sourceId);
    }
  }
  if (boost > 1) addSupport(ctx, boostSources, dealt * (1 - 1 / boost));

  let vuln = 1;
  const vulnSources = [];
  for (const s of state.boss.statusEffects) {
    if (s.id === 'vulnerable' && s.sourceId != null) {
      vuln = Math.max(vuln, s.damageTakenMult);
      vulnSources.push(s.sourceId);
    }
  }
  if (vuln > 1) addSupport(ctx, vulnSources, dealt * (1 - 1 / vuln));
}

// ---------- Урон по боссу с атрибуцией ----------

// Наносит урон боссу и засчитывает его источнику. sourceId = null — никому (Удар стримера).
// После смерти босса удары не обрабатываются. Возвращает реально снятое HP.
export function damageBoss(ctx, sourceId, amount, damageType, opts = {}) {
  const { state, config } = ctx;
  const boss = state.boss;
  if (boss.hp <= 0 || amount <= 0) return 0;
  const { dealt, killed } = applyDamage(boss, amount, damageType, opts, config);
  if (sourceId !== null) {
    const player = state.registry.get(sourceId);
    if (player) player.stats.damage += dealt;
    state.turnLog.damageBy[sourceId] = (state.turnLog.damageBy[sourceId] ?? 0) + dealt;
    state.turnLog.chatDamage += dealt;
    if (killed) state.lastHitUserId = sourceId;
    if (!opts.trueDamage) creditHitSupport(ctx, dealt);
  } else {
    state.turnLog.streamerDamage += dealt;
  }
  return dealt;
}

// Командный множитель урона: (1 + сильнейший буст игроков) × Π(1 + буст карт) × Π(1 − penalty).
// Бусты игроков (Благословение) не складываются друг с другом — иначе большой отряд разгонял урон в разы.
export function teamDamageMult(state) {
  let mult = 1;
  let playerBoost = 0;
  for (const e of state.teamEffects) {
    if (e.type === 'teamDamageBoost' && e.sourceId != null) playerBoost = Math.max(playerBoost, e.pct);
    else if (e.type === 'teamDamageBoost') mult *= 1 + e.pct;
    if (e.type === 'teamDamagePenalty') mult *= 1 - e.pct;
  }
  return mult * (1 + playerBoost);
}

export function isSilenced(state, classId) {
  return state.teamEffects.some((e) => e.type === 'silenceClass' && e.classId === classId);
}

export function hasTeamEffect(state, type) {
  return state.teamEffects.some((e) => e.type === type);
}

// Базовый урон класса — урон бесплатного действия (у хиллера — Искры света).
export function classBaseDamage(player, config) {
  const skills = config.PLAYER_CLASSES[player.classId].skills;
  return skills.attack.kind ? skills.fallbackAttack?.power ?? 0 : skills.attack.power;
}

function pickRandomClass(ctx) {
  const classes = [...new Set(participants(ctx.state).map((p) => p.classId))].sort();
  if (classes.length === 0) return null;
  return classes[ctx.rng(0, classes.length - 1)];
}

// ---------- Не-урон эффекты (карты и личные навыки) ----------

export function applyEffect(ctx, effect, { sourceId = null } = {}) {
  const { state, config } = ctx;
  const boss = state.boss;
  const log = state.turnLog;

  switch (effect.type) {
    case 'reviveAll': {
      for (const p of participants(state)) {
        if (p.status === 'downed' && reviveNow(p, effect.pct)) log.revived.push(p.displayName);
      }
      return;
    }
    case 'healAll': {
      for (const p of activeAlive(state)) log.healed += healPlayer(p, Math.round(p.maxHp * effect.pctMaxHp));
      return;
    }
    case 'restoreManaAll': {
      for (const p of activeAlive(state)) p.mana = Math.min(p.maxMana, p.mana + Math.round(p.maxMana * effect.pctMax));
      return;
    }
    case 'teamDamageBoost':
      state.teamEffects.push({ type: 'teamDamageBoost', pct: effect.pct, turnsLeft: effect.turns, sourceId });
      return;
    case 'teamDamagePenalty':
      state.teamEffects.push({ type: 'teamDamagePenalty', pct: effect.pct, turnsLeft: effect.turns, source: 'card' });
      return;
    case 'bossDamageBoost':
      addStatus(boss, { id: 'fury', damageDealtMult: 1 + effect.pct, turnsLeft: effect.turns });
      return;
    case 'bossDamageTakenReduction':
      addStatus(boss, { id: 'minions', damageTakenMult: 1 - effect.pct, turnsLeft: effect.turns });
      return;
    case 'bossVulnerable':
      addStatus(boss, { id: 'vulnerable', damageTakenMult: 1 + effect.pct, turnsLeft: effect.turns, sourceId });
      return;
    case 'removeBossStatus':
      if (removeStatus(boss, effect.id) > 0) fixedSupport(ctx, sourceId, 'antimagic');
      return;
    case 'cancelBossBuff':
      if (state.pendingTelegraph?.kind === 'buff') {
        state.bossBuffCancelled = true;
        if (sourceId != null) log.cancelSources.push(sourceId); // поддержка — когда атака реально сорвана
      }
      return;
    case 'healBoss':
      healBoss(boss, Math.round(boss.maxHp * effect.pctMaxHp));
      return;
    case 'swapBossAffinities':
      swapWeaknessResistance(boss);
      return;
    case 'trueDamageBoss':
      damageBoss(ctx, null, Math.round(boss.maxHp * effect.pctMaxHp), null, { trueDamage: true, canKill: effect.canKill });
      return;
    case 'silenceRandomClass': {
      const classId = pickRandomClass(ctx);
      if (classId) {
        state.teamEffects.push({ type: 'silenceClass', classId, turnsLeft: effect.turns });
        const cls = config.PLAYER_CLASSES[classId];
        log.notes.push(`🤐 Проклятие: ${cls.emoji} ${cls.name} без !навык и !особый`);
      }
      return;
    }
    case 'blockNextBossAttack':
      if (!hasTeamEffect(state, 'shield')) state.teamEffects.push({ type: 'shield' });
      return;
    case 'reflect':
      state.playerEffects.push({ type: 'reflect', userId: sourceId, pct: effect.pct, turnsLeft: 1 });
      return;
    case 'teamDamageReduction':
      state.teamEffects.push({ type: 'damageReduction', pct: effect.pct, turnsLeft: 1, sourceId });
      return;
    case 'teamAbsorb':
      state.teamEffects.push({ type: 'absorb', pctMaxHp: effect.pctMaxHp, turnsLeft: 1, sourceId });
      return;
    case 'cleanse': {
      // Снимает заглушки и ослабление босса; «Туман» стримера (source: card) остаётся.
      const before = state.teamEffects.length;
      state.teamEffects = state.teamEffects.filter((e) =>
        e.type !== 'silenceClass' && !(e.type === 'teamDamagePenalty' && e.source === 'boss'));
      if (state.teamEffects.length < before) fixedSupport(ctx, sourceId, 'cleanse');
      state.teamEffects.push({ type: 'immunity', turnsLeft: effect.immunityTurns, sourceId });
      return;
    }
    default:
      throw new Error(`Effect ${effect.type} is not a non-damage effect`);
  }
}

// ---------- Эффекты навыков босса (шаг 6, debuff и buff) ----------
// Возвращают текст для итога хода. Длительности +1: статус тикает в конце этого хода.

export function applyBossDebuff(ctx, skill) {
  const { state, config } = ctx;
  const immunity = state.teamEffects.filter((e) => e.type === 'immunity');
  if (immunity.length > 0) {
    for (const e of immunity) fixedSupport(ctx, e.sourceId, 'cleanse');
    return `Очищение отразило «${skill.name}»`;
  }
  const fx = config.BOSS_SKILL_EFFECTS[skill.effect];
  if (skill.effect === 'silence_class') {
    const classId = pickRandomClass(ctx);
    if (!classId) return `«${skill.name}» ни на кого не подействовало`;
    state.teamEffects.push({ type: 'silenceClass', classId, turnsLeft: fx.turns + 1 });
    const cls = config.PLAYER_CLASSES[classId];
    return `«${skill.name}»: класс ${cls.emoji} ${cls.name} без !навык и !особый в следующем ходу`;
  }
  if (skill.effect === 'weaken') {
    state.teamEffects.push({ type: 'teamDamagePenalty', pct: fx.pct, turnsLeft: fx.turns + 1, source: 'boss' });
    return `«${skill.name}»: урон отряда −${Math.round(fx.pct * 100)}% на ${fx.turns} хода`;
  }
  return `«${skill.name}»`;
}

export function applyBossBuff(ctx, skill) {
  const { state, config } = ctx;
  const boss = state.boss;
  const fx = config.BOSS_SKILL_EFFECTS[skill.effect];
  if (skill.effect === 'armor') {
    addStatus(boss, { id: 'armor', damageTakenMult: fx.damageTakenMult, turnsLeft: fx.turns + 1 });
    return `«${skill.name}»: босс в броне на ${fx.turns} хода`;
  }
  if (skill.effect === 'heal') {
    const before = boss.hp;
    healBoss(boss, Math.round(boss.maxHp * fx.pctMaxHp));
    return `«${skill.name}»: босс лечится +${boss.hp - before}`;
  }
  if (skill.effect === 'dmg_up') {
    addStatus(boss, { id: 'dmg_up', damageDealtMult: 1 + skill.power, turnsLeft: fx.turns + 1 });
    return `«${skill.name}»: урон босса +${Math.round(skill.power * 100)}% на ${fx.turns} хода`;
  }
  return `«${skill.name}»`;
}

// Доля maxHp цели, которую снимает атака босса: случайно из DAMAGE_VALUES[kind] × power навыка.
export function rollBossHitFraction(ctx, skill) {
  const range = ctx.config.DAMAGE_VALUES[skill.kind];
  return (range.min + rand01(ctx.rng) * (range.max - range.min)) * skill.power;
}
