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
const processedWebhookIds = new Set();
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// === HELPER: LOGGING ===
function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// === HELPER: API WITH RETRY & LOGS ===
async function intercomApi(method, endpoint, data = null, timeout = 15000) {
  if (consecutiveFailures >= MAX_FAILURES) {
    log('CIRCUIT-BREAKER', `ОТМЕНА: ${method} ${endpoint}`);
    return null;
  }

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
      consecutiveFailures = 0;
      return res.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED' && attempt < 2) {
        log('RETRY', `Timeout на ${endpoint}, попытка №${attempt + 1}...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      consecutiveFailures++;
      log('API-ERROR', `${endpoint}: ${error.message}`);
      throw error;
    }
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function handleValidation(contactId, convId) {
  try {
    const conv = await intercomApi('get', `/conversations/${convId}`);
    if (!conv || conv.assignee?.type === 'bot') return;

    const contact = await intercomApi('get', `/contacts/${contactId}`);
    if (!contact) return;

    // Unpaid Logic
    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'] || contact.custom_attributes?.['Purchase email'];
    if (email || pEmail) {
      const { data: list } = await axios.get(LIST_URL, { timeout: 8000 });
      const check = (e) => e && list.some(le => le?.trim().toLowerCase() === e.trim().toLowerCase());
      if (check(email) || check(pEmail)) {
        if (contact.custom_attributes?.['Unpaid Custom'] !== true) {
          await intercomApi('put', `/contacts/${contactId}`, { custom_attributes: { 'Unpaid Custom': true } });
          log('ACTION', `Unpaid установлен для ${contactId}`);
        }
      }
    }

    // Subscription Logic
    const sub = contact.custom_attributes?.['subscription'] || contact.custom_attributes?.['Subscription'];
    if (!sub || sub.trim() === '') {
      await intercomApi('post', `/conversations/${convId}/reply`, {
        message_type: 'note', admin_id: ADMIN_ID, body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Subscription note добавлена в ${convId}`);
    }
  } catch (e) {
    log('VAL-FAIL', `${convId}: ${e.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function handlePresale(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Админ ${adminId} уже был сегодня.`);
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
      }
    });

    const conversations = search?.conversations || [];
    const toProcess = conversations.filter(c => {
      const lastAdmin = c.statistics?.last_admin_reply_at || 0;
      const lastContact = c.statistics?.last_contact_reply_at || 0;
      const isOld = lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;
      return isOld && noFollowUp;
    }).slice(0, 10); // Ограничиваем пачку до 10

    log('PRESALE-INFO', `Найдено: ${conversations.length}, к обработке: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Пробуждение + Нотатка для ${conv.id}`);

      // Запускаем оба действия параллельно, чтобы сэкономить время и избежать таймаутов
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
      
      log('PRESALE-DONE', `Чат ${conv.id} обработан.`);
      await new Promise(r => setTimeout(r, 800)); // Небольшая пауза между чатами
    }

    lastProcessedDate.set(adminId, today);
  } catch (e) {
    log('PRESALE-FAIL', e.message);
  }
}

// === WEBHOOK HANDLER ===
app.post('/validate-email', (req, res) => {
  const webhookId = req.headers['x-intercom-webhook-id'] || Math.random();
  if (processedWebhookIds.has(webhookId)) return res.sendStatus(200);
  processedWebhookIds.add(webhookId);
  setTimeout(() => processedWebhookIds.delete(webhookId), 60000);

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

app.get('/', (req, res) => res.send('Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on ${PORT}`));
