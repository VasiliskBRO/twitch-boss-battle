// Поддельный адаптер для тестов и консольного режима: никакой сети.
// inject(raw) — «прислать» сообщение в чат; sent — всё, что бот отправил.

export class FakeAdapter {
  constructor({ channelId = 'channel', selfUserId = 'bot', roles = { broadcaster: false, moderator: true, vip: false }, now = Date.now, onSend = null } = {}) {
    this.channelId = channelId;
    this.selfUserId = selfUserId;
    this.roles = { ...roles };
    this.now = now;
    this.onSend = onSend;
    this.isConnected = false;
    this.sent = []; // { text, at, replyToMessageId }
    this.failNext = 0; // сколько следующих отправок завершить ошибкой
    this.messageHandlers = [];
    this.statusHandlers = [];
    this.roleHandlers = [];
    this.seq = 0;
  }

  async connect() {
    this.isConnected = true;
    for (const cb of this.statusHandlers) cb({ connected: true });
  }

  async disconnect() {
    this.isConnected = false;
    for (const cb of this.statusHandlers) cb({ connected: false });
  }

  // Имитация обрыва связи (для тестов переподключения).
  drop(error = new Error('connection lost')) {
    this.isConnected = false;
    for (const cb of this.statusHandlers) cb({ connected: false, error });
  }

  onMessage(cb) { this.messageHandlers.push(cb); }
  onStatus(cb) { this.statusHandlers.push(cb); }
  onRolesChange(cb) { this.roleHandlers.push(cb); }
  selfRoles() { return { ...this.roles }; }

  setRoles(roles) {
    this.roles = { ...this.roles, ...roles };
    for (const cb of this.roleHandlers) cb(this.selfRoles());
  }

  async send(text, { replyToMessageId, priority } = {}) {
    if (!this.isConnected) throw new Error('not connected');
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('fake send failure');
    }
    if (text.length > 500) throw new Error('message too long');
    const entry = { text, at: this.now(), replyToMessageId: replyToMessageId ?? null, priority: priority ?? null };
    this.sent.push(entry);
    this.onSend?.(entry);
  }

  // Прислать сообщение зрителя. badges: { moderator: '1' } и т. п.
  inject({ userId, userLogin, displayName, text, badges = {}, messageId, sourceChannelId = null }) {
    const raw = {
      userId: String(userId),
      userLogin: userLogin ?? String(displayName ?? userId).toLowerCase(),
      displayName: displayName ?? String(userId),
      text,
      badges,
      messageId: messageId ?? `fake-${++this.seq}`,
      channelId: this.channelId,
      sourceChannelId,
    };
    for (const cb of this.messageHandlers) cb(raw);
    return raw;
  }
}
