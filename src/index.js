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

const JOIN_DELAY_MS = 4000; // пауза после подключения перед проигрыванием
const COOLDOWN_MS = 60_000; // анти-спам: не чаще одного срабатывания в минуту на пользователя
const CONNECTION_READY_TIMEOUT_MS = 15_000;
const PLAYBACK_TIMEOUT_MS = 60_000;

if (!TOKEN) {
  console.error(
    'Ошибка: не задана переменная окружения DISCORD_TOKEN.\n' +
      'Создайте файл .env по образцу .env.example и укажите в нём токен бота.',
  );
  process.exit(1);
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
    console.error(`Конфиг ${CONFIG_PATH} должен быть объектом вида { "userId": "файл.mp3" }.`);
    process.exit(1);
  }

  const entries = Object.entries(data).filter(
    ([userId, file]) => typeof userId === 'string' && typeof file === 'string',
  );

  for (const [userId, file] of entries) {
    const filePath = path.join(SOUNDS_DIR, file);
    if (!filePath.startsWith(SOUNDS_DIR + path.sep) || !fs.existsSync(filePath)) {
      console.warn(`Внимание: звуковой файл для пользователя ${userId} не найден: ${filePath}`);
    }
  }

  if (entries.length === 0) {
    console.warn(`Внимание: в ${CONFIG_PATH} нет ни одной привязки "userId -> файл" — бот будет молчать.`);
  }

  return new Map(entries);
}

const userSounds = loadUserSounds();
const lastTriggeredAt = new Map(); // userId -> timestamp последнего срабатывания

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playSoundInChannel(channel, soundFile) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_READY_TIMEOUT_MS);
    await sleep(JOIN_DELAY_MS);

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

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const joinedChannelId = newState.channelId;
    if (!joinedChannelId) return; // пользователь вышел из канала
    if (oldState.channelId === joinedChannelId) return; // мьют/дефен и т.п. в том же канале

    // Вход в канал или переход между каналами — оба считаются новым входом.
    const soundFile = userSounds.get(newState.id);
    if (!soundFile) return;

    const now = Date.now();
    const last = lastTriggeredAt.get(newState.id) ?? 0;
    if (now - last < COOLDOWN_MS) {
      console.log(`Анти-спам: пропускаю вход ${member.user.tag} — прошло меньше минуты.`);
      return;
    }

    const channel = newState.channel;
    if (!channel) return;

    const existingConnection = getVoiceConnection(newState.guild.id);
    if (existingConnection) {
      console.log(`Бот уже подключён к голосовому каналу на сервере "${newState.guild.name}" — повторно не захожу.`);
      return;
    }

    lastTriggeredAt.set(newState.id, now);
    await playSoundInChannel(channel, soundFile);
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
