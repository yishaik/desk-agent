import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings } from '../core/settings.ts';
import type { PairingState, Message, MessageKey } from '../core/types.ts';
import { bareJid } from './self-chat.ts';

const log = createChildLogger('whatsapp');

const VERSION_CACHE_PATH = join(config.dataDir, 'wa-version.json');
const VERSION_FETCH_TIMEOUT_MS = 5000;

interface VersionCache {
  version: [number, number, number];
  fetchedAt: string;
}

async function fetchVersionWithFallback(): Promise<[number, number, number]> {
  const loadCached = (): [number, number, number] | null => {
    try {
      if (existsSync(VERSION_CACHE_PATH)) {
        const data = JSON.parse(readFileSync(VERSION_CACHE_PATH, 'utf8')) as VersionCache;
        return data.version;
      }
    } catch {
      // Ignore read errors
    }
    return null;
  };

  const saveCache = (version: [number, number, number]): void => {
    try {
      const cache: VersionCache = { version, fetchedAt: new Date().toISOString() };
      writeFileSync(VERSION_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch {
      // Ignore write errors
    }
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);

    const { version } = await fetchLatestBaileysVersion({ signal: controller.signal });
    clearTimeout(timeoutId);

    saveCache(version);
    log.debug({ version }, 'Fetched Baileys version');
    return version;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch Baileys version, trying cache');

    const cached = loadCached();
    if (cached) {
      log.info({ version: cached }, 'Using cached Baileys version');
      return cached;
    }

    log.warn('No cached version available, using hardcoded fallback');
    return [2, 3000, 1015629576];
  }
}

export type MessageHandler = (message: Message) => Promise<void>;

export class WhatsAppClient {
  private socket: WASocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private pairingState: PairingState = { isPaired: false };
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private ownerJid: string | null = null;
  private ownerLid: string | null = null;
  private warnedNoLid = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.removeSocketListeners();
      this.socket = null;
    }

    const authDir = join(config.dataDir, 'whatsapp-auth');
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await fetchVersionWithFallback();

    const baileysLogger = pino({ level: 'silent' });

    this.socket = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      generateHighQualityLinkPreview: false,
    });

    this.setupEventHandlers(saveCreds);
    log.info('WhatsApp client initialized');
  }

  private removeSocketListeners(): void {
    if (this.socket) {
      this.socket.ev.removeAllListeners('connection.update');
      this.socket.ev.removeAllListeners('creds.update');
      this.socket.ev.removeAllListeners('messages.upsert');
    }
  }

  private scheduleReconnect(delay: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        log.error({ err }, 'Reconnect failed');
        const nextDelay = Math.min(delay * 2, 60000);
        this.scheduleReconnect(nextDelay);
      });
    }, delay);
  }

  private setupEventHandlers(saveCreds: () => Promise<void>): void {
    if (!this.socket) return;

    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.pairingState = {
          isPaired: false,
          qrCode: qr,
          qrExpiry: Date.now() + 60000,
        };
        log.info('New QR code generated');
        qrcode.generate(qr, { small: true });
        console.log('\n[whatsapp] Scan the QR code above to pair WhatsApp');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        log.warn(
          { statusCode, attempts: this.reconnectAttempts },
          'Connection closed'
        );

        this.pairingState.isPaired = false;

        const shouldWipeAuth =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === DisconnectReason.forbidden;

        if (shouldWipeAuth) {
          const reason =
            statusCode === DisconnectReason.loggedOut
              ? 'Logged out'
              : statusCode === DisconnectReason.connectionReplaced
                ? 'Connection replaced by another session'
                : 'Connection forbidden (403)';

          log.warn({ statusCode }, `${reason}, clearing session and reconnecting for a fresh QR`);
          this.pairingState = { isPaired: false };
          rmSync(join(config.dataDir, 'whatsapp-auth'), { recursive: true, force: true });
          this.reconnectAttempts = 0;
          this.scheduleReconnect(1000);
          return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          log.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnect...');
          this.scheduleReconnect(delay);
        } else {
          log.error({ statusCode }, 'Reconnect attempts exhausted, retrying in 60s');
          this.reconnectAttempts = 0;
          this.scheduleReconnect(60000);
        }
      }

      if (connection === 'open') {
        const newPhoneNumber = this.socket?.user?.id?.split(':')[0]?.split('@')[0];
        const newName = this.socket?.user?.name;
        const settings = loadSettings();

        if (settings.ownerPhone && newPhoneNumber && newPhoneNumber !== settings.ownerPhone) {
          log.error(
            { attemptedPhone: newPhoneNumber, ownerPhone: settings.ownerPhone },
            'ניסיון צימוד לא מורשה: מספר טלפון שונה מהבעלים הרשום'
          );
          this.pairingState = {
            isPaired: false,
            error: `צימוד נדחה: מספר ${newPhoneNumber} אינו הבעלים הרשום (${settings.ownerPhone}). יש לבצע איפוס מפורש של הבעלים או לסרוק עם הטלפון המקורי.`,
          };
          this.ownerJid = null;
          this.ownerLid = null;
          if (this.socket) {
            this.socket.end(undefined);
            this.socket = null;
          }
          return;
        }

        this.pairingState = {
          isPaired: true,
          phoneNumber: newPhoneNumber,
          name: newName,
        };
        this.ownerJid = this.socket?.user?.id ?? null;
        this.ownerLid = (this.socket?.user as { lid?: string } | undefined)?.lid ?? null;
        this.pairingState.selfChat = this.selfChatMode();
        this.reconnectAttempts = 0;

        if (!settings.ownerPhone && this.pairingState.phoneNumber) {
          updateSettings({ ownerPhone: this.pairingState.phoneNumber });
        }

        log.info(
          { phone: this.pairingState.phoneNumber, name: this.pairingState.name },
          'Connected to WhatsApp'
        );
      }
    });

    this.socket.ev.on('creds.update', async () => {
      await saveCreds();
      // The LID can arrive after 'open' (creds sync); pick it up as soon as it exists.
      const me = this.socket?.authState?.creds?.me as { id?: string; lid?: string } | undefined;
      if (me?.lid && me.lid !== this.ownerLid) {
        this.ownerLid = me.lid;
        this.pairingState.selfChat = this.selfChatMode();
        log.info({ lid: me.lid }, 'Self-chat LID became available');
      }
      if (me?.id && !this.ownerJid) this.ownerJid = me.id;
    });

    this.socket.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        await this.handleIncomingMessage(msg);
      }
    });
  }

  private async handleIncomingMessage(
    msg: proto.IWebMessageInfo
  ): Promise<void> {
    if (!msg.message || !msg.key.remoteJid) return;

    const isFromMe = msg.key.fromMe ?? false;
    const remoteJid = msg.key.remoteJid;

    if (!this.isOwnerMessage(remoteJid, isFromMe)) {
      log.debug({ remoteJid }, 'Ignoring message from non-owner');
      return;
    }

    const body = this.extractMessageBody(msg.message);
    if (!body) return;

    const messageKey: MessageKey = {
      remoteJid,
      id: msg.key.id ?? `msg_${Date.now()}`,
      fromMe: isFromMe,
      participant: msg.key.participant ?? undefined,
    };

    const message: Message = {
      id: messageKey.id,
      from: isFromMe ? (this.ownerJid ?? remoteJid) : remoteJid,
      to: isFromMe ? remoteJid : (this.ownerJid ?? remoteJid),
      body,
      // messageTimestamp is a protobuf Long at runtime; passing it straight to
      // SQLite throws on bind, so normalize to a plain number.
      timestamp: Number(msg.messageTimestamp?.toString() ?? '') || Math.floor(Date.now() / 1000),
      isFromMe,
      messageKey,
    };

    log.debug({ messageId: message.id, isFromMe }, 'Processing message');

    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (err) {
        log.error({ err, messageId: message.id }, 'Message handler error');
      }
    }
  }

  isSelfJid(jid: string | null | undefined): boolean {
    const bare = (j: string | null | undefined) => j?.split(':')[0]?.split('@')[0];
    const target = bare(jid);
    if (!target) return false;
    return target === bare(this.ownerJid) || target === bare(this.ownerLid);
  }

  private isOwnerMessage(remoteJid: string, isFromMe: boolean): boolean {
    if (isFromMe) return true;
    if (remoteJid === this.ownerJid) return true;
    if (remoteJid.endsWith('@s.whatsapp.net')) {
      const phoneFromJid = remoteJid.split('@')[0];
      const ownerPhone = this.pairingState.phoneNumber;
      return phoneFromJid === ownerPhone;
    }
    return false;
  }

  private extractMessageBody(message: proto.IMessage): string | null {
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    return null;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp client not connected');
    }

    const MAX_LENGTH = 4096;
    const parts = this.splitMessage(text, MAX_LENGTH);

    for (const part of parts) {
      await this.socket.sendMessage(jid, { text: part });
      if (parts.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    log.debug({ jid, parts: parts.length }, 'Message sent');
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        parts.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      parts.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return parts;
  }

  async sendReaction(messageKey: MessageKey, emoji: string): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp client not connected');
    }

    const targetJid = this.getSelfChatJid();
    if (!targetJid) {
      log.debug({ messageId: messageKey.id }, 'Skipping reaction: no self-chat available');
      return;
    }

    await this.socket.sendMessage(targetJid, {
      react: {
        text: emoji,
        key: {
          remoteJid: messageKey.remoteJid,
          id: messageKey.id,
          fromMe: messageKey.fromMe,
          participant: messageKey.participant,
        },
      },
    });
  }

  /**
   * The owner's own chat. Prefers the account LID ("message yourself"); when the
   * account has no LID yet, falls back to the owner's phone JID — still the
   * owner's own chat, never anyone else's. Without either there is no target (#73).
   */
  getSelfChatJid(): string | null {
    if (this.ownerLid && this.ownerLid.endsWith('@lid')) {
      return this.ownerLid;
    }
    const phone = bareJid(this.ownerJid);
    if (phone) {
      if (!this.warnedNoLid) {
        this.warnedNoLid = true;
        log.warn({ ownerJid: this.ownerJid }, 'No LID available for this account — replying via the phone JID self-chat');
      }
      return `${phone}@s.whatsapp.net`;
    }
    log.debug('getSelfChatJid: not connected (no LID, no owner JID)');
    return null;
  }

  private selfChatMode(): 'lid' | 'phone' | 'none' {
    if (this.ownerLid && this.ownerLid.endsWith('@lid')) return 'lid';
    if (bareJid(this.ownerJid)) return 'phone';
    return 'none';
  }

  async sendFile(
    jid: string,
    buffer: Buffer,
    filename: string,
    mimetype: string,
    caption?: string
  ): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp client not connected');
    }

    await this.socket.sendMessage(jid, {
      document: buffer,
      mimetype,
      fileName: filename,
      caption,
    });

    log.debug({ jid, filename }, 'File sent');
  }

  getPairingState(): PairingState {
    return { ...this.pairingState };
  }

  getOwnerJid(): string | null {
    return this.ownerJid;
  }

  getOwnerPhone(): string | null {
    return this.pairingState.phoneNumber ?? null;
  }

  getOwnerLid(): string | null {
    return this.ownerLid;
  }

  isConnected(): boolean {
    return this.pairingState.isPaired;
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.removeSocketListeners();
      this.socket.end(undefined);
      this.socket = null;
      this.pairingState = { isPaired: false };
      log.info('Disconnected from WhatsApp');
    }
  }
}

let clientInstance: WhatsAppClient | null = null;

export function getWhatsAppClient(): WhatsAppClient {
  if (!clientInstance) {
    clientInstance = new WhatsAppClient();
  }
  return clientInstance;
}
