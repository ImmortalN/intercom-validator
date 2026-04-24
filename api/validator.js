// === Код для Vercel. Только для Presale логики ===
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === CONFIGURATION ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо заснужені чати presale 🚀';
const INTERCOM_VERSION = '2.14';

// === STATE ===
const lastProcessedDate = new Map();
let isPresaleRunning = false;

function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// === HELPER: INTERCOM API CLIENT WITH RETRY ===
async function intercomApi(method, endpoint, data = null, timeout = 7000) {
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

      return res.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        log('TIMEOUT', `Таймаут на ${endpoint} (${timeout}ms). Попытка ${attempt}/2...`);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      } else {
        log('API-ERROR', `Сбой ${endpoint}: ${error.response?.status} - ${error.message}`);
      }
      throw error;
    }
  }
}

// === PRESALE CORE LOGIC ===
async function handlePresale(adminId) {
  if (isPresaleRunning) {
    log('SKIP', 'Процесс уже запущен, пропускаем.');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('SKIP', `Админ ${adminId} уже обрабатывался сегодня.`);
    return;
  }

  isPresaleRunning = true;
  log('START', `Поиск чатов для админа ${adminId}`);

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    log('INFO', `Полночь (Unix): ${todayMidnightUnix}`);
    
    // ПРАВИЛЬНЫЙ СОСТАВНОЙ ЗАПРОС (как просил Intercom AI)
    log('API-CALL', `Отправляем составной запрос на поиск...`);
    const search = await intercomApi('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'team_assignee_id', operator: '=', value: Number(PRESALE_TEAM_ID) }
        ]
      },
      pagination: { per_page: 20 } 
    }, 8000); // 8 секунд на ответ

    const conversations = search?.conversations || [];
    log('INFO', `Найдено чатов в команде Presale: ${conversations.length}`);

    const toProcess = conversations.filter(c => {
      const lastAdmin = c.statistics?.last_admin_reply_at || 0;
      const lastContact = c.statistics?.last_contact_reply_at || 0;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;
      
      const isOld = lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix;

      log('DEBUG-CHAT', `Чат ${c.id} | isOld: ${isOld} | noFollowUp: ${noFollowUp}`);
      return isOld && noFollowUp;
    });

    log('INFO', `Итого чатов для обработки: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Снуз + Ноут для чата ${conv.id}`);
      
      await Promise.allSettled([
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
      
      await new Promise(r => setTimeout(r, 500)); // Короткая пауза для стабильности
    }

    lastProcessedDate.set(adminId, today);
    log('SUCCESS', `Логика пресейла завершена для ${adminId}`);
  } catch (e) {
    log('FATAL', `Ошибка пресейла: ${e.message}`);
  } finally {
    isPresaleRunning = false;
  }
}

// === WEBHOOK HANDLER (СИНХРОННЫЙ ДЛЯ VERCEL) ===
app.post('/validate-email', async (req, res) => {
  const { topic, data } = req.body || {};
  log('WEBHOOK-RCV', `Получено событие: ${topic || 'unknown'}`);

  try {
    if (topic === 'admin.away_mode_updated') {
      const item = data?.item;
      if (!item) return res.status(200).send('OK');

      const isAway = item.away_mode_enabled ?? item.away_mode?.enabled;
      
      if (isAway === false) {
        log('ACTION', `Админ ${item.id} вернулся (Away Mode OFF).`);
        
        // В VERCEL МЫ ОБЯЗАНЫ ЖДАТЬ ЗАВЕРШЕНИЯ, ИНАЧЕ КОД УМРЕТ
        await handlePresale(item.id);
      } else {
        log('INFO', `Админ ${item.id} ушел (Away Mode ON). Пропускаем.`);
      }
    }
  } catch (err) {
    log('GLOBAL-ERR', `Сбой обработки вебхука: ${err.message}`);
  }

  // Отвечаем Intercom только после завершения всех дел!
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Presale Engine is Active 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SERVER STARTED ON PORT ${PORT}`);
});

module.exports = app;
