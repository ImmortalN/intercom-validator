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

// === API CLIENT ===
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

      const remaining = res.headers['x-ratelimit-remaining'];
      if (remaining && parseInt(remaining) < 5) {
        log('RATE-LIMIT', 'Критично мало лімітів, пауза 5с');
        await new Promise(r => setTimeout(r, 5000));
      }

      return res.data;
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      if (isTimeout && attempt < 2) {
        log('RETRY', `Таймаут на ${endpoint}, спроба №2...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw error;
    }
  }
}

async function handlePresale(adminId) {
  if (isPresaleRunning) {
    log('SKIP', 'Присейл вже запущений іншим процесом');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('SKIP', `Адмін ${adminId} вже оброблявся сьогодні.`);
    return;
  }

  isPresaleRunning = true;
  log('START', `Обробка чатів для адміна ${adminId}`);

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    
    // Дуже легкий пошук (5 чатів)
    const search = await intercomApi('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID }
        ]
      },
      pagination: { per_page: 5 } 
    }, 7000); // Трохи збільшив таймаут для пошуку

    const conversations = search?.conversations || [];
    const toProcess = conversations.filter(c => {
      const lastAdmin = c.statistics?.last_admin_reply_at || 0;
      const lastContact = c.statistics?.last_contact_reply_at || 0;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;
      return lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix && noFollowUp;
    });

    log('INFO', `Знайдено чатів: ${conversations.length}, підходять: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Розморожуємо чат ${conv.id}`);
      
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
      
      await new Promise(r => setTimeout(r, 1500));
    }

    lastProcessedDate.set(adminId, today);
    log('SUCCESS', `Присейл завершено для ${adminId}`);
  } catch (e) {
    log('FATAL', `Помилка присейлу: ${e.message}`);
  } finally {
    isPresaleRunning = false;
  }
}

// === WEBHOOK (ВИПРАВЛЕНО ПОРЯДОК REQ, RES) ===
app.post('/validate-email', (req, res) => {
  const { topic, data } = req.body || {};
  
  // Відразу логуємо будь-який вхідний запит
  log('WEBHOOK-RCV', `Отримано подію: ${topic || 'невідомо'}`);

  // Відповідаємо Intercom миттєво
  res.status(200).send('OK');

  if (topic === 'admin.away_mode_updated' && data?.item?.away_mode_enabled === false) {
    const adminId = data.item.id;
    log('ACTION', `Адмін ${adminId} повернувся (Away Mode OFF).`);
    handlePresale(adminId).catch(err => log('ASYNC-ERR', err.message));
  }
});

app.get('/', (req, res) => res.send('Presale Engine 6.1 is Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on port ${PORT}`));
