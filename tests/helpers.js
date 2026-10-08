// Воспроизводимый rng по контракту rng(min, max) → целое из [min, max] (mulberry32).
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (min, max) => min + Math.floor(next() * (max - min + 1));
}

// Минимальный босс с нужными полями части 1.
export function makeBoss({ archetype = 'beast', weakness = 'ice', resistance = 'physical', skills = [], currentPhase = 1 } = {}) {
  return { archetype, weakness, resistance, skills, currentPhase, statusEffects: [] };
}

// Фиксированные боссы для тестов и демо (навыки — из каталога части 1).
export const DRAGON = makeBoss({
  archetype: 'dragon',
  weakness: 'ice',
  resistance: 'fire',
  skills: [
    { id: 'drag_bite', kind: 'single' },
    { id: 'drag_breath', kind: 'aoe' },
    { id: 'drag_claw', kind: 'single' },
    { id: 'drag_scale', kind: 'buff', effect: 'armor' },
  ],
});

export const GOLEM = makeBoss({
  archetype: 'golem',
  weakness: 'magic',
  resistance: 'physical',
  skills: [
    { id: 'golem_slam', kind: 'single' },
    { id: 'golem_quake', kind: 'aoe' },
    { id: 'golem_slow', kind: 'debuff', effect: 'weaken' },
    { id: 'golem_harden', kind: 'buff', effect: 'armor' },
  ],
});

export const CLASSES = ['warrior', 'archer', 'mage', 'healer'];
