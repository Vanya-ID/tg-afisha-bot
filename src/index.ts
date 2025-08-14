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
const ALT_URL = 'https://puppet-minsk.by/bilety/afisha';
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

const sendTextMessage = async (text: string): Promise<void> => {
  if (!TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_CHAT_ID не найден в переменных окружения');
  }

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (error) {
    console.error('Ошибка при отправке текстового сообщения в Telegram:', error);
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

const parseShowsFromAlt = async (): Promise<Show[]> => {
  try {
    const response = await axios.get(ALT_URL);
    const $ = cheerio.load(response.data);
    const shows: Show[] = [];

    $('table tr').each((_, row) => {
      const headerCells = $(row).find('th');
      if (headerCells.length > 0) return;
      const tds = $(row).find('td');
      if (tds.length < 2) return;

      const dateTimeRaw = $(tds[0]).text().trim();
      const name = $(tds[1]).text().trim();
      const href = $(tds[1]).find('a').attr('href') || '';

      if (!dateTimeRaw || !name) return;

      let date = '';
      let time = '';
      const match = dateTimeRaw.match(/(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/);
      if (match) {
        date = match[1];
        time = match[2];
      } else {
        // Если не удалось разделить дату/время, оставляем как есть в поле date
        date = dateTimeRaw;
      }

      let url = href;
      if (url && !/^https?:/i.test(url)) {
        url = `https://puppet-minsk.by${url}`;
      }

      shows.push({ date, time, name, url });
    });

    return shows;
  } catch (error) {
    console.error('Ошибка при парсинге альтернативной страницы афиши:', error);
    return [];
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
    let shows = await parseShows();
    let fromAlt = false;
    if (shows.length === 0) {
      console.warn('⚠️ Основная страница афиши вернула пустой список. Пробую альтернативную страницу...');
      const altShows = await parseShowsFromAlt();
      if (altShows.length === 0) {
        console.warn('⚠️ Альтернативная страница афиши тоже пустая');
        await sendTextMessage(`⚠️ Афиша пуста на обеих страницах.\n🔗 ${URL}\n🔗 ${ALT_URL}`);
        return;
      }
      shows = altShows;
      fromAlt = true;
    }

    console.log(`📊 Найдено ${shows.length} спектаклей${fromAlt ? ' (альтернативная страница)' : ''}`);
    const first = shows[0];
    const last = shows[shows.length - 1];
    console.log(`🧭 Первая афиша на странице: ${first.date} ${first.time} — ${first.name}`);
    console.log(`🏁 Последняя афиша на странице: ${last.date} ${last.time} — ${last.name}`);
    const sample = shows
      .slice(0, Math.min(3, shows.length))
      .map(s => `${s.date} ${s.time} — ${s.name}`)
      .join(' | ');
    console.log(`🔎 Пример первых афиш: ${sample}`);

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