// Входящие сообщения: нормализация в event движка, отсев лишнего, строго последовательная обработка.
//
// Адаптер отдаёт «сырое» сообщение в нейтральном виде (без типов Twurple):
//   { userId, userLogin, displayName, text, badges: { broadcaster: '1', moderator: '1', vip: '1', … },
//     messageId, channelId, sourceChannelId }

// Сырое сообщение → event для движка или null, если его нужно проигнорировать.
//   reason (во втором поле) — почему проигнорировано: self, notCommand, excluded, sharedChat.
export function normalizeMessage(raw, { selfUserId, config }) {
  if (!raw || typeof raw.text !== 'string') return { event: null, reason: 'invalid' };
  if (raw.userId === selfUserId) return { event: null, reason: 'self' };
  // Быстрая проверка до вызова движка: все команды начинаются с «!».
  if (!raw.text.trimStart().startsWith('!')) return { event: null, reason: 'notCommand' };

  const excluded = config.excludeUserIds.map((x) => String(x).toLowerCase());
  if (excluded.includes(String(raw.userId).toLowerCase()) || excluded.includes(String(raw.userLogin ?? '').toLowerCase())) {
    return { event: null, reason: 'excluded' };
  }
  // «Общий чат»: сообщения из соседнего канала не участвуют в нашем бою.
  if (config.ignoreSharedChat && raw.sourceChannelId && raw.channelId && raw.sourceChannelId !== raw.channelId) {
    return { event: null, reason: 'sharedChat' };
  }

  const badges = raw.badges ?? {};
  const broadcaster = 'broadcaster' in badges || (raw.channelId != null && raw.userId === raw.channelId);
  const moderator = 'moderator' in badges || 'lead_moderator' in badges || (config.vipCountsAsMod && 'vip' in badges);
  return {
    event: {
      userId: String(raw.userId),
      displayName: raw.displayName || raw.userLogin || String(raw.userId),
      text: raw.text,
      roles: { broadcaster, moderator },
      messageId: raw.messageId ?? null,
    },
    reason: null,
  };
}

// Роли самого бота по значкам его сообщения (для режима лимитов).
export function rolesFromBadges(badges = {}) {
  return {
    broadcaster: 'broadcaster' in badges,
    moderator: 'moderator' in badges || 'lead_moderator' in badges,
    vip: 'vip' in badges,
  };
}

// Повторная доставка того же messageId в течение ttl — игнор.
export class MessageDeduper {
  constructor({ ttlMs, now }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.seen = new Map(); // messageId → время
  }

  // true — сообщение новое; false — повтор.
  check(messageId) {
    if (!messageId) return true;
    const t = this.now();
    for (const [id, at] of this.seen) {
      if (t - at <= this.ttlMs) break; // Map хранит порядок вставки: дальше только свежие
      this.seen.delete(id);
    }
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, t);
    return true;
  }
}

// Очередь задач, которые выполняются строго по одной: движок никогда не вызывается параллельно.
// Ошибка задачи логируется и не останавливает очередь.
export class SerialProcessor {
  constructor({ log = console } = {}) {
    this.log = log;
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  push(task, label = 'задача') {
    this.pending++;
    const run = this.tail.then(async () => {
      try {
        return await task();
      } catch (err) {
        this.log.error(`${label}: ${err?.stack ?? err}`);
        return undefined;
      } finally {
        this.pending--;
      }
    });
    this.tail = run;
    return run;
  }

  idle() {
    return this.tail;
  }
}
