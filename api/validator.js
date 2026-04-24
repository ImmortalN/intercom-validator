const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === CONFIGURATION ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо заснужені чати presale 🚀';
const INTERCOM_VERSION = '2.14';

const lastProcessedDate = new Map();
const processedWebhookIds = new Set(); // Захист від дублікатів вебхуків
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// === HELPER: LOGGING ===
function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// Скидання запобіжника кожні 10 хвилин про всяк випадок
setInterval(() => {
  if (consecutiveFailures > 0) {
    log('SYSTEM', 'Автоматичне скидання лічильника помилок.');
    consecutiveFailures = 0;
  }
}, 600000);

// === HELPER: API WITH RATE LIMIT HANDLING ===
async function intercomApi(method, endpoint, data = null, timeout = 20000) {
  if (consecutiveFailures >= MAX_FAILURES) {
    log('CIRCUIT-BREAKER', `БЛОКУВАННЯ: ${method} ${endpoint} скасовано.`);
    return null;
  }

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
    consecutiveFailures = 0;
    return res.data;
  } catch (error) {
    if (error.response?.status === 429) {
      log('RATE-LIMIT', 'Отримано 429. Чекаємо 5 секунд...');
      await new Promise(r => setTimeout(r, 5000));
      consecutiveFailures++;
    } else {
      consecutiveFailures++;
    }
    const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `${endpoint} (${error.response?.status || 'TIMEOUT'}): ${details}`);
    throw error;
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function handleValidation(contactId, convId) {
  try {
    const conv = await intercomApi('get', `/conversations/${convId}`);
    if (!conv || conv.assignee?.type === 'bot') return;

    const contact = await intercomApi('get', `/contacts/${contactId}`);
    if (!contact) return;

    // 1. Unpaid Logic (Case-insensitive check)
    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'] || contact.custom_attributes?.['Purchase email'];
    
    if (email || pEmail) {
      const { data: list } = await axios.get(LIST_URL, { timeout: 8000 });
      const check = (e) => e && list.some(le => le?.trim().toLowerCase() === e.trim().toLowerCase());
      
      if (check(email) || check(pEmail)) {
        if (contact.custom_attributes?.['Unpaid Custom'] !== true) {
          await intercomApi('put', `/contacts/${contactId}`, { custom_attributes: { 'Unpaid Custom': true } });
          log('ACTION', `Unpaid set for ${contactId}`);
        }
      }
    }

    // 2. Subscription Logic
    const sub = contact.custom_attributes?.['subscription'] || contact.custom_attributes?.['Subscription'];
    if (!sub || sub.trim() === '') {
      await intercomApi('post', `/conversations/${convId}/reply`, {
        message_type: 'note', admin_id: ADMIN_ID, body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Sub note added to ${convId}`);
    }
  } catch (e) {
    log('VAL-FAIL', e.message);
  }
}

// === LOGIC 3: PRESALE ===
async function handlePresale(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Адмін ${adminId} вже оброблявся сьогодні.`);
    return;
  }

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const search = await intercomApi('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID }
        ]
      },
      pagination: { per_page: 20 }
    });

    const conversations = search?.conversations || [];
    log('PRESALE-INFO', `Знайдено чатів: ${conversations.length}`);

    // Фільтруємо старі чати
    const toProcess = conversations.filter(c => {
      const isOld = c.updated_at < todayMidnightUnix;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;
      return isOld && noFollowUp;
    }).slice(0, 15);

    log('PRESALE-INFO', `Буде оброблено: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Обробка чату ${conv.id}`);
      
      // Snooze (пробудження)
      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'snoozed',
        admin_id: adminId,
        snoozed_until: Math.floor(Date.now() / 1000) + 60
      });

      await new Promise(r => setTimeout(r, 1500));

      // Note
      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'note',
        admin_id: adminId,
        body: PRESALE_NOTE_TEXT
      });

      await new Promise(r => setTimeout(r, 500));
    }

    lastProcessedDate.set(adminId, today);
  } catch (e) {
    log('PRESALE-FAIL', e.message);
  }
}

// === WEBHOOK HANDLER ===
app.post('/validate-email', (req, res) => {
  const webhookId = req.headers['x-intercom-webhook-id'] || JSON.stringify(req.body).length;
  
  // Захист від повторів (Intercom може слати один і той самий вебхук кілька разів)
  if (processedWebhookIds.has(webhookId)) {
    return res.sendStatus(200);
  }
  processedWebhookIds.add(webhookId);
  setTimeout(() => processedWebhookIds.delete(webhookId), 30000);

  res.sendStatus(200);

  const { topic, data } = req.body;
  if (!data?.item) return;

  setImmediate(async () => {
    try {
      const item = data.item;
      log('FLOW', `Topic: ${topic} | ID: ${item.id}`);

      if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        await handlePresale(item.id);
      }

      if (topic.includes('conversation.user') || topic === 'conversation.admin.assigned') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id || item.source?.author?.id;
        if (contactId) await handleValidation(contactId, item.id);
      }
    } catch (err) {
      log('ASYNC-ERR', err.message);
    }
  });
});

app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server listening on ${PORT}`));
