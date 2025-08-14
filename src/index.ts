import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from 'redis';

// Загрузка переменных окружения
dotenv.config();

// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const URL = 'https://puppet-minsk.by/afisha';
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 минуты в миллисекундах
const PORT = process.env.PORT || 3000;
const HEARTBEAT_HOUR = 9;
const HEARTBEAT_MINUTE = 0;

// Создание Express приложения
const app = express();

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Запуск веб-сервера
app.listen(PORT, () => {
  console.log(`Веб-сервер запущен на порту ${PORT}`);
});

// Создание клиента Redis
const redisClient = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('Превышено максимальное количество попыток подключения к Redis');
        return new Error('Превышено максимальное количество попыток');
      }
      // Увеличиваем время между попытками
      return Math.min(retries * 1000, 10000);
    }
  }
});

// Обработка ошибок Redis
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
  // Не завершаем процесс при ошибке Redis
});

redisClient.on('connect', () => {
  console.log('Успешное подключение к Redis');
});

redisClient.on('reconnecting', () => {
  console.log('Переподключение к Redis...');
});

// Создание экземпляра бота
if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN не найден в переменных окружения');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

interface Show {
  date: string;
  time: string;
  name: string;
  url: string;
}

const parseShows = async (): Promise<Show[]> => {
  try {
    const response = await axios.get(URL);
    const $ = cheerio.load(response.data);
    const shows: Show[] = [];

    $('.afisha_item').each((_, element) => {
      const day = $(element).find('.afisha-day').text().trim();
      const time = $(element).find('.afisha-time').text().trim();
      const name = $(element).find('.afisha-title').text().trim();
      const url = $(element).find('.afisha_item-hover').attr('href') || '';

      if (day && time && name) {
        shows.push({
          date: day,
          time,
          name,
          url: `https://puppet-minsk.by${url}`
        });
      }
    });

    return shows;
  } catch (error) {
    console.error('Ошибка при парсинге сайта:', error);
    return [];
  }
};

const sendTelegramMessage = async (show: Show): Promise<void> => {
  if (!TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_CHAT_ID не найден в переменных окружения');
  }

  try {
    const message = `🎭 ${show.name}\n📅 ${show.date}\n⏰ ${show.time}\n🔗 ${show.url}`;
    await bot.sendMessage(TELEGRAM_CHAT_ID, message);
  } catch (error) {
    console.error('Ошибка при отправке сообщения в Telegram:', error);
  }
};

const sendHeartbeatMessage = async (): Promise<void> => {
  if (!TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_CHAT_ID не найден в переменных окружения');
  }

  try {
    const now = new Date();
    const timeLabel = now.toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
    const message = `✅ Бот работает\n🕒 ${timeLabel}`;
    await bot.sendMessage(TELEGRAM_CHAT_ID, message);
  } catch (error) {
    console.error('Ошибка при отправке ежедневного сообщения в Telegram:', error);
  }
};

const getIsoDate = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

const isHeartbeatSent = async (isoDate: string): Promise<boolean> => {
  const key = `heartbeat|${isoDate}`;
  const result = await redisClient.get(key);
  return result !== null;
};

const markHeartbeatSent = async (isoDate: string): Promise<void> => {
  const key = `heartbeat|${isoDate}`;
  await redisClient.set(key, 'sent', { EX: 60 * 60 * 24 * 60 });
};

const sendDailyHeartbeatIfDue = async (): Promise<void> => {
  const now = new Date();
  const isoDate = getIsoDate(now);

  const alreadySent = await isHeartbeatSent(isoDate);
  if (alreadySent) return;

  const isAfterScheduledTime = now.getHours() > HEARTBEAT_HOUR || (now.getHours() === HEARTBEAT_HOUR && now.getMinutes() >= HEARTBEAT_MINUTE);
  if (!isAfterScheduledTime) return;

  await sendHeartbeatMessage();
  await markHeartbeatSent(isoDate);
  console.log('✔️ Отправлено ежедневное сообщение о работоспособности');
};

const isShowSent = async (show: Show): Promise<boolean> => {
  const key = `${show.date}|${show.time}|${show.name}|${show.url}`;
  const result = await redisClient.get(key);
  return result !== null;
};

const markShowAsSent = async (show: Show): Promise<void> => {
  const key = `${show.date}|${show.time}|${show.name}|${show.url}`;
  await redisClient.set(key, 'sent');
};

const checkNewShows = async (): Promise<void> => {
  try {
    console.log('🔄 Начинаю парсинг афиши...');
    const shows = await parseShows();
    console.log(`📊 Найдено ${shows.length} спектаклей`);

    let newShows = 0;
    for (const show of shows) {
      if (!(await isShowSent(show))) {
        console.log(`🎭 Новый спектакль: ${show.name} (${show.date} ${show.time})`);
        await sendTelegramMessage(show);
        await markShowAsSent(show);
        newShows++;
      }
    }

    if (newShows > 0) {
      console.log(`✨ Отправлено ${newShows} новых уведомлений`);
    } else {
      console.log('ℹ️ Новых спектаклей не найдено');
    }
  } catch (error) {
    console.error('❌ Ошибка при проверке новых афиш:', error);
  }
};

// Основной цикл проверки
const startMonitoring = async (): Promise<void> => {
  try {
    // Подключение к Redis с повторными попытками
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        await redisClient.connect();
        console.log('Подключение к Redis установлено');
        break;
      } catch (error) {
        retries++;
        console.error(`Ошибка подключения к Redis (попытка ${retries}/${maxRetries}):`, error);
        if (retries === maxRetries) {
          throw new Error('Не удалось подключиться к Redis после нескольких попыток');
        }
        // Ждем перед следующей попыткой
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.log('Бот запущен и начал мониторинг афиши...');

    while (true) {
      try {
        await checkNewShows();
        await sendDailyHeartbeatIfDue();
        console.log(`⏳ Следующая проверка через ${CHECK_INTERVAL / 1000 / 60} минут...`);
      } catch (error) {
        console.error('❌ Ошибка при проверке новых афиш:', error);
      }
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
    }
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  }
};

// Запуск бота
startMonitoring().catch(error => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
}); 