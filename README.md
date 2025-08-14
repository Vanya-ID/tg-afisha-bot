tg-afisha-bot
================

Телеграм-бот, который парсит афишу сайта кукольного театра Минска и отправляет новые спектакли в чат. Также ежедневно отправляет сообщение о работоспособности (heartbeat) после 09:00 по времени Europe/Minsk.

Переменные окружения
--------------------
- TELEGRAM_TOKEN — токен бота
- TELEGRAM_CHAT_ID — ID чата/канала для уведомлений
- REDIS_URL — строка подключения к Redis
  - локально: redis://127.0.0.1:6379
  - облако (Upstash и т.п.): rediss://default:<PASSWORD>@<HOST>:<PORT>

Локальный запуск
----------------
```
npm ci
npm run build
npm start
```

Railway деплой
--------------
В проекте есть railway.toml:
- build: npm run build
- start: npm start

Шаги:
1. Подключи репозиторий к Railway (Deploy from GitHub)
2. В Variables добавь TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, REDIS_URL
3. В Settings сервиса проверь Source = GitHub, ветку и Auto Deploy
4. Сделай git push или нажми Redeploy

Важно: на бесплатном плане сервис может «усыпляться». Если включён Autosleep — процесс может не работать 24/7, а heartbeat придёт только после пробуждения.

VPS деплой (Ubuntu/Debian + pm2)
--------------------------------
```
sudo apt update
sudo apt install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs build-essential redis-server
sudo npm i -g pm2

git clone <REPO_URL> tg-afisha-bot
cd tg-afisha-bot

cat > .env << EOF
TELEGRAM_TOKEN=...
TELEGRAM_CHAT_ID=...
REDIS_URL=redis://127.0.0.1:6379
EOF

npm ci --production
npm run build
pm2 start dist/index.js --name tg-afisha-bot
pm2 save
pm2 startup
```

Логи
----
- локально — в консоли
- pm2 — `pm2 logs tg-afisha-bot`
- Railway — вкладка Logs

Ключевые сообщения в логах
--------------------------
- 🔄 Начинаю парсинг афиши...
- 📊 Найдено N спектаклей
- 🧭 Первая афиша..., 🏁 Последняя афиша..., 🔎 Пример первых афиш: ...
- 🎭 Новый спектакль: ...
- ✔️ Отправлено ежедневное сообщение о работоспособности
- Успешное подключение к Redis / ошибки подключения

Примечания
----------
- Heartbeat отправляется один раз в день после 09:00 (Europe/Minsk)
- Дедупликация выполняется через Redis (ключи спектаклей и heartbeat на дату)

