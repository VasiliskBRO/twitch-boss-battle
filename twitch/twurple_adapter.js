// Настоящий адаптер Твича на Twurple 8 (единственное место, где используется Twurple).
//
// По документации Твича (dev.twitch.tv/docs/chat) предпочтительный способ — не IRC, а:
//   чтение  — EventSub `channel.chat.message` через WebSocket (EventSubWsListener),
//   отправка — Send Chat Message API (`POST /helix/chat/messages`), от имени бота.
// Скоупы токена бота: user:read:chat, user:write:chat, user:read:moderated_channels.
//
// Пакеты Twurple подгружаются только в connect(): тесты и консольный режим работают без них.

import fs from 'node:fs';
import { writeFileAtomic } from './persistence.js';

// Событие Twurple EventSubChannelChatMessageEvent → нейтральное «сырое» сообщение (см. inbound.js).
export function rawFromTwurpleEvent(e, channelId) {
  return {
    userId: e.chatterId,
    userLogin: e.chatterName,
    displayName: e.chatterDisplayName,
    text: e.messageText,
    badges: e.badges ?? {},
    messageId: e.messageId,
    channelId,
    sourceChannelId: e.sourceBroadcasterId ?? null,
  };
}

export class TwurpleAdapter {
  // log — логгер с addSecret: токены и client secret не попадают в лог.
  constructor({ clientId, clientSecret, channelName, botUserName, tokensFile, log }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.channelName = channelName;
    this.botUserName = botUserName;
    this.tokensFile = tokensFile;
    this.log = log;
    this.isConnected = false;
    this.selfUserId = null;
    this.channelId = null;
    this.roles = { broadcaster: false, moderator: false, vip: false };
    this.handlers = { message: [], status: [], roles: [] };
    this.listener = null;
    this.api = null;
    log.addSecret(clientSecret);
  }

  onMessage(cb) { this.handlers.message.push(cb); }
  onStatus(cb) { this.handlers.status.push(cb); }
  onRolesChange(cb) { this.handlers.roles.push(cb); }
  selfRoles() { return { ...this.roles }; }

  // Роли бота меняются по значкам его собственных сообщений (VIP иначе не узнать токеном бота).
  updateSelfRoles(roles) {
    const next = { ...this.roles, ...roles };
    const changed = ['broadcaster', 'moderator', 'vip'].some((k) => next[k] !== this.roles[k]);
    this.roles = next;
    if (changed) {
      this.log.info(`роль бота изменилась: модератор=${next.moderator}, VIP=${next.vip}`);
      for (const cb of this.handlers.roles) cb(this.selfRoles());
    }
  }

  setConnected(connected, error) {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    for (const cb of this.handlers.status) cb({ connected, error });
  }

  readTokens() {
    if (!fs.existsSync(this.tokensFile)) {
      throw new Error(`нет ${this.tokensFile} — сначала запустите «Установить.bat» (node setup.js)`);
    }
    const data = JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'));
    this.log.addSecret(data.accessToken);
    this.log.addSecret(data.refreshToken);
    return data;
  }

  async connect() {
    // Повторный вызов (переподключение): перезапускаем WebSocket EventSub.
    if (this.listener) {
      this.listener.stop();
      this.listener.start();
      return;
    }

    const { RefreshingAuthProvider } = await import('@twurple/auth');
    const { ApiClient } = await import('@twurple/api');
    const { EventSubWsListener } = await import('@twurple/eventsub-ws');

    // Секрет есть только у своего (Confidential) приложения; публичное обновляет токен без него.
    const authProvider = new RefreshingAuthProvider(this.clientSecret ? { clientId: this.clientId, clientSecret: this.clientSecret } : { clientId: this.clientId });
    // Новый токен записывается в tokens.json при каждом обновлении.
    authProvider.onRefresh((userId, newTokenData) => {
      this.log.addSecret(newTokenData.accessToken);
      this.log.addSecret(newTokenData.refreshToken);
      writeFileAtomic(this.tokensFile, JSON.stringify(newTokenData, null, 2), { mode: 0o600 });
      this.log.info('токен бота обновлён и сохранён');
    });
    authProvider.onRefreshFailure((userId, error) => {
      this.log.error(`не удалось обновить токен: ${error?.message ?? error}. Запустите «Установить.bat» (node setup.js) ещё раз — например, если бот не запускался больше 30 дней`);
    });

    const botId = await authProvider.addUserForToken(this.readTokens(), ['chat']);
    const api = new ApiClient({ authProvider });
    const [botUser, channel] = await Promise.all([api.users.getUserById(botId), api.users.getUserByName(this.channelName)]);
    if (!channel) throw new Error(`канал ${this.channelName} не найден`);
    if (this.botUserName && botUser && botUser.name.toLowerCase() !== this.botUserName.toLowerCase()) {
      this.log.warn(`токен выдан для @${botUser.name}, а в .env указан BOT_USER_NAME=${this.botUserName}`);
    }
    this.api = api;
    this.selfUserId = botId;
    this.channelId = channel.id;

    // Модератор ли бот в канале (VIP так не узнать — его покажут значки первого сообщения бота).
    const isBroadcaster = botId === channel.id;
    let isModerator = false;
    try {
      const moderated = await api.moderation.getModeratedChannelsPaginated(botId).getAll();
      isModerator = moderated.some((c) => c.id === channel.id);
    } catch (err) {
      this.log.warn(`не удалось проверить модераторство: ${err?.message ?? err}`);
    }
    this.updateSelfRoles({ broadcaster: isBroadcaster, moderator: isModerator });
    this.log.info(`бот @${botUser?.name ?? botId} в канале ${channel.name}: ${isBroadcaster ? 'стример' : isModerator ? 'модератор' : 'без прав модератора (лимиты строже)'}`);

    const listener = new EventSubWsListener({ apiClient: api });
    listener.onUserSocketConnect(() => this.setConnected(true));
    listener.onUserSocketDisconnect((userId, error) => this.setConnected(false, error));
    listener.onSubscriptionCreateFailure((subscription, error) => {
      this.log.error(`подписка на чат не создана: ${error?.message ?? error}`);
    });
    listener.onChannelChatMessage(channel.id, botId, (e) => {
      const raw = rawFromTwurpleEvent(e, channel.id);
      for (const cb of this.handlers.message) cb(raw);
    });
    this.listener = listener;
    listener.start();
  }

  async disconnect() {
    if (this.listener) this.listener.stop();
    this.setConnected(false);
  }

  // Отправка от имени бота (по умолчанию Twurple отправил бы от имени стримера).
  async send(text, { replyToMessageId } = {}) {
    if (!this.api) throw new Error('not connected');
    const params = replyToMessageId ? { replyParentMessageId: replyToMessageId } : {};
    const result = await this.api.asUser(this.selfUserId, (ctx) => ctx.chat.sendChatMessage(this.channelId, text, params));
    if (!result.isSent) {
      throw new Error(`Твич не принял сообщение: ${result.dropReasonCode ?? 'unknown'} ${result.dropReasonMessage ?? ''}`.trim());
    }
  }
}
