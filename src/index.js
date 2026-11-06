'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, Events, GatewayIntentBits } = require('discord.js');
const {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

// prism-media ищет ffmpeg сам, но явный путь из ffmpeg-static надёжнее,
// если в системе нет глобального ffmpeg.
if (!process.env.FFMPEG_PATH) {
  try {
    process.env.FFMPEG_PATH = require('ffmpeg-static');
  } catch {
    // остаётся надежда на ffmpeg в PATH
  }
}

const TOKEN = process.env.DISCORD_TOKEN;
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'users.json');
const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

const DEFAULT_JOIN_DELAY_MS = 4000; // дефолтная пауза после подключения перед проигрыванием
const COOLDOWN_MS = 60_000; // анти-спам: не чаще одного срабатывания в минуту на пользователя

function parseJoinDelayMs(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_JOIN_DELAY_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`Некорректное значение JOIN_DELAY_MS="${raw}" — использую дефолт ${DEFAULT_JOIN_DELAY_MS} мс.`);
    return DEFAULT_JOIN_DELAY_MS;
  }
  return value;
}

const JOIN_DELAY_MS = parseJoinDelayMs(process.env.JOIN_DELAY_MS);
const CONNECTION_READY_TIMEOUT_MS = 15_000;
const PLAYBACK_TIMEOUT_MS = 60_000;

if (!TOKEN) {
  console.error(
    'Ошибка: не задана переменная окружения DISCORD_TOKEN.\n' +
      'Создайте файл .env по образцу .env.example и укажите в нём токен бота.',
  );
  process.exit(1);
}

// Значение в конфиге: строка (звук входа) или объект { join, leave }.
// Приводит его к виду { join?: string, leave?: string }; null — запись непригодна.
function normalizeUserEntry(userId, value) {
  if (typeof value === 'string') return { join: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const sounds = {};
  for (const kind of ['join', 'leave']) {
    if (value[kind] === undefined) continue;
    if (typeof value[kind] === 'string') {
      sounds[kind] = value[kind];
    } else {
      console.warn(`Внимание: поле "${kind}" пользователя ${userId} должно быть строкой — игнорирую.`);
    }
  }
  return Object.keys(sounds).length > 0 ? sounds : null;
}

function warnIfSoundMissing(userId, kind, file) {
  const filePath = path.join(SOUNDS_DIR, file);
  if (!filePath.startsWith(SOUNDS_DIR + path.sep) || !fs.existsSync(filePath)) {
    console.warn(`Внимание: звуковой файл (${kind}) для пользователя ${userId} не найден: ${filePath}`);
  }
}

function loadUserSounds() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error(`Не удалось прочитать конфиг ${CONFIG_PATH}: ${error.message}`);
    process.exit(1);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error(
      `Конфиг ${CONFIG_PATH} должен быть объектом вида { "userId": "файл.mp3" } ` +
        'или { "userId": { "join": "вход.mp3", "leave": "выход.mp3" } }.',
    );
    process.exit(1);
  }

  const entries = [];
  for (const [userId, value] of Object.entries(data)) {
    const sounds = normalizeUserEntry(userId, value);
    if (!sounds) continue;
    for (const [kind, file] of Object.entries(sounds)) warnIfSoundMissing(userId, kind, file);
    entries.push([userId, sounds]);
  }

  if (entries.length === 0) {
    console.warn(`Внимание: в ${CONFIG_PATH} нет ни одной привязки "userId -> файл" — бот будет молчать.`);
  }

  return new Map(entries);
}

const userSounds = loadUserSounds();
const lastTriggeredAt = new Map(); // "join:userId" / "leave:userId" -> timestamp последнего срабатывания

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playSoundInChannel(channel, soundFile, delayMs) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_READY_TIMEOUT_MS);
    if (delayMs > 0) await sleep(delayMs);

    const resource = createAudioResource(path.join(SOUNDS_DIR, soundFile));
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    connection.subscribe(player);
    player.play(resource);
    console.log(`Играю "${soundFile}" в канале "${channel.name}" (${channel.guild.name})`);

    await entersState(player, AudioPlayerStatus.Idle, PLAYBACK_TIMEOUT_MS);
  } finally {
    connection.destroy();
    console.log(`Отключился от канала "${channel.name}" (${channel.guild.name})`);
  }
}

// kind — "join" или "leave"; channel — канал, в котором нужно сыграть звук.
async function triggerSound(kind, member, channel, soundFile, delayMs) {
  const cooldownKey = `${kind}:${member.id}`;
  const now = Date.now();
  const last = lastTriggeredAt.get(cooldownKey) ?? 0;
  if (now - last < COOLDOWN_MS) {
    console.log(`Анти-спам: пропускаю звук (${kind}) для ${member.user.tag} — прошло меньше минуты.`);
    return;
  }

  const existingConnection = getVoiceConnection(channel.guild.id);
  if (existingConnection) {
    console.log(`Бот уже подключён к голосовому каналу на сервере "${channel.guild.name}" — повторно не захожу.`);
    return;
  }

  lastTriggeredAt.set(cooldownKey, now);
  await playSoundInChannel(channel, soundFile, delayMs);
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const sounds = userSounds.get(newState.id);
    if (!sounds) return;

    if (!newState.channelId) {
      // Полный выход из голосовых каналов: играем звук выхода в канале, который пользователь только что покинул.
      if (!oldState.channelId || !sounds.leave) return;
      const channel = oldState.channel;
      if (!channel) return;
      await triggerSound('leave', member, channel, sounds.leave, 0);
      return;
    }

    if (oldState.channelId === newState.channelId) return; // мьют/дефен и т.п. в том же канале

    // Вход в канал или переход между каналами — оба считаются новым входом.
    if (!sounds.join) return;
    const channel = newState.channel;
    if (!channel) return;
    await triggerSound('join', member, channel, sounds.join, JOIN_DELAY_MS);
  } catch (error) {
    console.error('Ошибка при обработке voiceStateUpdate:', error);
  }
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Бот запущен как ${readyClient.user.tag}. Отслеживаю пользователей: ${userSounds.size}.`);
});

client.login(TOKEN).catch((error) => {
  console.error(`Не удалось авторизоваться: ${error.message}`);
  process.exit(1);
});
