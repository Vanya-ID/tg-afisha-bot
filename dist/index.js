"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const dotenv_1 = __importDefault(require("dotenv"));
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const redis_1 = require("redis");
// Загрузка переменных окружения
dotenv_1.default.config();
// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const URL = 'https://puppet-minsk.by/afisha';
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 минуты в миллисекундах
// Создание клиента Redis
const redisClient = (0, redis_1.createClient)({
    url: REDIS_URL
});
// Обработка ошибок Redis
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
// Создание экземпляра бота
if (!TELEGRAM_TOKEN) {
    throw new Error('TELEGRAM_TOKEN не найден в переменных окружения');
}
const bot = new node_telegram_bot_api_1.default(TELEGRAM_TOKEN, { polling: false });
const parseShows = async () => {
    try {
        const response = await axios_1.default.get(URL);
        const $ = cheerio.load(response.data);
        const shows = [];
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
    }
    catch (error) {
        console.error('Ошибка при парсинге сайта:', error);
        return [];
    }
};
const sendTelegramMessage = async (show) => {
    if (!TELEGRAM_CHAT_ID) {
        throw new Error('TELEGRAM_CHAT_ID не найден в переменных окружения');
    }
    try {
        const message = `🎭 ${show.name}\n📅 ${show.date}\n⏰ ${show.time}\n🔗 ${show.url}`;
        await bot.sendMessage(TELEGRAM_CHAT_ID, message);
    }
    catch (error) {
        console.error('Ошибка при отправке сообщения в Telegram:', error);
    }
};
const isShowSent = async (show) => {
    const key = `${show.date}|${show.time}|${show.name}|${show.url}`;
    const result = await redisClient.get(key);
    return result !== null;
};
const markShowAsSent = async (show) => {
    const key = `${show.date}|${show.time}|${show.name}|${show.url}`;
    await redisClient.set(key, 'sent');
};
const checkNewShows = async () => {
    try {
        const shows = await parseShows();
        for (const show of shows) {
            if (!(await isShowSent(show))) {
                await sendTelegramMessage(show);
                await markShowAsSent(show);
            }
        }
    }
    catch (error) {
        console.error('Ошибка при проверке новых афиш:', error);
    }
};
// Основной цикл проверки
const startMonitoring = async () => {
    try {
        // Подключение к Redis
        await redisClient.connect();
        console.log('Подключение к Redis установлено');
        console.log('Бот запущен и начал мониторинг афиши...');
        while (true) {
            await checkNewShows();
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        }
    }
    catch (error) {
        console.error('Критическая ошибка:', error);
        process.exit(1);
    }
};
// Запуск бота
startMonitoring().catch(error => {
    console.error('Критическая ошибка:', error);
    process.exit(1);
});
