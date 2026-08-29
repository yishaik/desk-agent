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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../core/config.ts';
import { createChildLogger } from '../core/logger.ts';
import { loadSettings, updateSettings } from '../core/settings.ts';
import type { PairingState, Message, MessageKey } from '../core/types.ts';

const log = createChildLogger('whatsapp');

export type MessageHandler = (message: Message) => Promise<void>;

export class WhatsAppClient {
  private socket: WASocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private pairingState: PairingState = { isPaired: false };
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private ownerJid: string | null = null;
  private ownerLid: string | null = null;

  async connect(): Promise<void> {
    const authDir = join(config.dataDir, 'whatsapp-auth');
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const baileysLogger = pino({ level: 'silent' });

    this.socket = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      generateHighQualityLinkPreview: true,
    });

    this.setupEventHandlers(saveCreds);
    log.info('WhatsApp client initialized');
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
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        log.warn(
          { statusCode, shouldReconnect, attempts: this.reconnectAttempts },
          'Connection closed'
        );

        this.pairingState.isPaired = false;

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          log.info({ delay }, 'Reconnecting...');
          setTimeout(() => this.connect(), delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          log.warn('Logged out, clearing session and reconnecting for a fresh QR');
          this.pairingState = { isPaired: false };
          // Stale creds would just 401 again — wipe them so connect() pairs anew.
          rmSync(join(config.dataDir, 'whatsapp-auth'), { recursive: true, force: true });
          this.reconnectAttempts = 0;
          setTimeout(() => this.connect(), 1000);
        }
      }

      if (connection === 'open') {
        this.pairingState = {
          isPaired: true,
          phoneNumber: this.socket?.user?.id?.split(':')[0],
          name: this.socket?.user?.name,
        };
        this.ownerJid = this.socket?.user?.id ?? null;
        // "Message yourself" chats use the account's LID, not the phone JID.
        this.ownerLid = (this.socket?.user as { lid?: string } | undefined)?.lid ?? null;
        this.reconnectAttempts = 0;

        const settings = loadSettings();
        if (!settings.ownerPhone && this.pairingState.phoneNumber) {
          updateSettings({ ownerPhone: this.pairingState.phoneNumber });
        }

        log.info(
          { phone: this.pairingState.phoneNumber, name: this.pairingState.name },
          'Connected to WhatsApp'
        );
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

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

    // React in the chat the message actually lives in — the LID self-chat and
    // the phone-JID self-chat are different conversations.
    const targetJid = messageKey.remoteJid ?? this.resolveSelfChatJid();
    if (!targetJid) {
      log.warn('No self-chat JID available for reaction');
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

  resolveSelfChatJid(): string | null {
    if (!this.ownerJid) return null;

    if (this.ownerJid.includes(':') && this.ownerJid.endsWith('@s.whatsapp.net')) {
      return this.ownerJid;
    }

    if (this.ownerJid.endsWith('@lid')) {
      return this.ownerJid;
    }

    return this.ownerJid;
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

  isConnected(): boolean {
    return this.pairingState.isPaired;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
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
