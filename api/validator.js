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

const lastProcessedDate = new Map();
let isPresaleRunning = false; 

function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// Полегшений API клієнт (таймаут 8с)
async function intercomApi(method, endpoint, data = null) {
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
      timeout: 8000
    });
    return res.data;
  } catch (error) {
    log('API-ERROR', `${method.toUpperCase()} ${endpoint}: ${error.message}`);
    throw error;
  }
}

async function handlePresale(adminId) {
  if (isPresaleRunning) return;

  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('SKIP', `Адмін ${adminId} вже перевірявся сьогодні.`);
    return;
  }

  isPresaleRunning = true;
  log('START', `Запуск присейл-черги для адміна ${adminId}`);

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    
    // Шукаємо тільки 10 чатів за раз, щоб не "повісити" API
    const search = await intercomApi('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID }
        ]
      },
      pagination: { per_page: 10 }
    });

    const conversations = search?.conversations || [];
    const toProcess = conversations.filter(c => {
      const lastAdmin = c.statistics?.last_admin_reply_at || 0;
      const lastContact = c.statistics?.last_contact_reply_at || 0;
      // Тільки старі чати (до сьогоднішньої півночі) і без Follow-Up
      return lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix && c.custom_attributes?.['Follow-Up'] !== true;
    });

    log('INFO', `Знайдено чатів: ${conversations.length}, підходять під критерії: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Обробка чату ${conv.id}`);
      
      // Використовуємо Promise.allSettled для швидкості всередині одного чату
      await Promise.allSettled([
        intercomApi('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snoozed_until: Math.floor(Date.now() / 1000) + 60
        }),
        intercomApi('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        })
      ]);
      
      // Велика пауза між різними чатами, щоб Intercom "відпочив"
      await new Promise(r => setTimeout(r, 2000));
    }

    lastProcessedDate.set(adminId, today);
    log('FINISH', `Присейл успішно завершено для адміна ${adminId}`);
  } catch (e) {
    log('FAIL', `Помилка присейлу: ${e.message}`);
  } finally {
    isPresaleRunning = false;
  }
}

// Вебхук обробляє ТІЛЬКИ одну подію
app.post('/validate-email', (req, res) => {
  res.sendStatus(200); // Відповідаємо відразу

  const { topic, data } = req.body;
  if (topic === 'admin.away_mode_updated' && data?.item?.away_mode_enabled === false) {
    handlePresale(data.item.id).catch(err => log('ASYNC-ERR', err.message));
  }
});

app.get('/', (req, res) => res.send('Presale Worker Only Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on ${PORT}`));
