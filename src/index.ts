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
  url: REDIS_URL
});

// Обработка ошибок Redis
redisClient.on('error', (err) => console.error('Redis Client Error:', err));

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
    const shows = await parseShows();

    for (const show of shows) {
      if (!(await isShowSent(show))) {
        await sendTelegramMessage(show);
        await markShowAsSent(show);
      }
    }
  } catch (error) {
    console.error('Ошибка при проверке новых афиш:', error);
  }
};

// Основной цикл проверки
const startMonitoring = async (): Promise<void> => {
  try {
    // Подключение к Redis
    await redisClient.connect();
    console.log('Подключение к Redis установлено');

    console.log('Бот запущен и начал мониторинг афиши...');

    while (true) {
      await checkNewShows();
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
    }
  } catch (error) {
    console.error('Критическая ошибка:', error);
    process.exit(1);
  }
};

// Запуск бота
startMonitoring().catch(error => {
  console.error('Критическая ошибка:', error);
  process.exit(1);
}); 