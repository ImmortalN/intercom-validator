const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === CONFIGURATION ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // Системный ID для отправки ноутов
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо заснужені чати presale 🚀';
const INTERCOM_VERSION = '2.14';

// === STATE ===
const lastProcessedDate = new Map();
let isPresaleRunning = false;

// === HELPER: LOGGING ===
function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// === HELPER: INTERCOM API CLIENT WITH RETRY & RATE LIMIT ===
async function intercomApi(method, endpoint, data = null, timeout = 5000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios({
        method,
        url: `https://api.intercom.io${endpoint}`,
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        data,
        timeout
      });

      // Защита от лимитов (Rate Limit)
      const remaining = res.headers['x-ratelimit-remaining'];
      if (remaining && parseInt(remaining) < 5) {
        log('RATE-LIMIT', 'Критически мало лимитов Intercom, пауза 5 сек...');
        await new Promise(r => setTimeout(r, 5000));
      }

      return res.data;
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      if (isTimeout && attempt < 2) {
        log('RETRY', `Таймаут на ${endpoint}, попытка №2... (ждем 2 сек)`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw error;
    }
  }
}

// === PRESALE CORE LOGIC ===
async function handlePresale(adminId) {
  if (isPresaleRunning) {
    log('SKIP', 'Процесс пресейла уже запущен, пропускаем дубликат.');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('SKIP', `Админ ${adminId} уже обрабатывался сегодня (${today}).`);
    return;
  }

  isPresaleRunning = true;
  log('START', `Начинаем поиск чатов для админа ${adminId}`);

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    log('INFO', `Полночь сегодня (Unix): ${todayMidnightUnix}`);
    
    // ЛЕГКИЙ ПОИСК: Запрашиваем только статус snoozed (50 чатов, таймаут 15 секунд)
    log('API-CALL', `Отправляем запрос на поиск чатов...`);
    const search = await intercomApi('post', '/conversations/search', {
      query: {
        field: 'state', 
        operator: '=', 
        value: 'snoozed'
      },
      pagination: { per_page: 50 } 
    }, 15000); 

    const conversations = search?.conversations || [];
    log('INFO', `Intercom вернул снузнутых чатов всего: ${conversations.length}`);

    // ФИЛЬТРАЦИЯ НА СТОРОНЕ СЕРВЕРА
    const toProcess = conversations.filter(c => {
      const isPresaleTeam = String(c.team_assignee_id) === String(PRESALE_TEAM_ID);
      const lastAdmin = c.statistics?.last_admin_reply_at || 0;
      const lastContact = c.statistics?.last_contact_reply_at || 0;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;
      
      const isOld = lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix;

      // Детальный лог для дебага каждого чата из пресейл команды
      if (isPresaleTeam) {
         log('DEBUG-CHAT', `Чат ${c.id} | isOld: ${isOld} | noFollowUp: ${noFollowUp}`);
      }

      return isPresaleTeam && isOld && noFollowUp;
    });

    log('INFO', `Итого чатов, подходящих под условия пресейла: ${toProcess.length}`);

    // ОБРАБОТКА ЧАТОВ
    for (const conv of toProcess) {
      log('ACTION', `Начинаем расснуживать чат ${conv.id} и писать ноут...`);
      
      // Выполняем снуз и ноут параллельно для экономии времени
      const [snoozeRes, noteRes] = await Promise.allSettled([
        intercomApi('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: ADMIN_ID,
          snoozed_until: Math.floor(Date.now() / 1000) + 60
        }),
        intercomApi('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: ADMIN_ID,
          body: PRESALE_NOTE_TEXT
        })
      ]);
      
      log('RESULT', `Чат ${conv.id} -> Snooze: ${snoozeRes.status} | Note: ${noteRes.status}`);
      await new Promise(r => setTimeout(r, 1000)); // Пауза в 1 сек между разными чатами
    }

    lastProcessedDate.set(adminId, today);
    log('SUCCESS', `Логика пресейла успешно завершена для админа ${adminId}`);
  } catch (e) {
    log('FATAL', `Критическая ошибка логики пресейла: ${e.message}`);
  } finally {
    isPresaleRunning = false;
  }
}

// === WEBHOOK HANDLER ===
app.post('/validate-email', (req, res) => {
  const { topic, data } = req.body || {};
  
  // 1. МГНОВЕННЫЙ ЛОГ И ОТВЕТ
  log('WEBHOOK-RCV', `Получено событие: ${topic || 'unknown'}`);
  res.status(200).send('OK');

  // 2. АСИНХРОННАЯ ОБРАБОТКА (чтобы не блокировать Intercom)
  setImmediate(() => {
    try {
      if (topic === 'admin.away_mode_updated') {
        const item = data?.item;
        if (!item) return;

        const isAway = item.away_mode_enabled ?? item.away_mode?.enabled;
        
        if (isAway === false) {
          log('ACTION', `Админ ${item.id} вернулся (Away Mode OFF). Запускаем код!`);
          handlePresale(item.id).catch(err => log('ASYNC-ERR', err.message));
        } else {
          log('INFO', `Админ ${item.id} ушел (Away Mode ON). Ничего не делаем.`);
        }
      }
    } catch (err) {
      log('GLOBAL-ERR', `Ошибка в обработчике вебхука: ${err.message}`);
    }
  });
});

// === HEALTH CHECK ===
app.get('/', (req, res) => res.send('Presale Engine is Active 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('==============================================');
  console.log(`SERVER STARTED ON PORT ${PORT} - MONITORING ACTIVE`);
  console.log('==============================================');
});

module.exports = app; // Для поддержки Vercel
