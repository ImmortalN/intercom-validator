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
let isPresaleRunning = false; // Блокувальник паралельного присейлу

// === HELPER: LOGGING ===
function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// === HELPER: API WITH FAST TIMEOUT & RETRY ===
async function intercomApi(method, endpoint, data = null, timeout = 10000) {
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
    const status = error.response?.status;
    const msg = error.code === 'ECONNABORTED' ? 'TIMEOUT' : error.message;
    log('API-ERROR', `${method.toUpperCase()} ${endpoint} (${status || msg})`);
    throw error;
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function handleValidation(contactId, convId) {
  try {
    // Отримуємо чат і контакт ПАРАЛЕЛЬНО, щоб зекономити час
    const [conv, contact] = await Promise.all([
      intercomApi('get', `/conversations/${convId}`),
      intercomApi('get', `/contacts/${contactId}`)
    ]);

    if (!conv || !contact || conv.assignee?.type === 'bot') return;

    // Unpaid Logic
    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'] || contact.custom_attributes?.['Purchase email'];
    if (email || pEmail) {
      const { data: list } = await axios.get(LIST_URL, { timeout: 5000 });
      const check = (e) => e && list.some(le => le?.trim().toLowerCase() === e.trim().toLowerCase());
      if (check(email) || check(pEmail)) {
        if (contact.custom_attributes?.['Unpaid Custom'] !== true) {
          await intercomApi('put', `/contacts/${contactId}`, { custom_attributes: { 'Unpaid Custom': true } });
          log('ACTION', `Unpaid set for ${contactId}`);
        }
      }
    }

    // Subscription Logic
    const sub = contact.custom_attributes?.['subscription'] || contact.custom_attributes?.['Subscription'];
    if (!sub || sub.trim() === '') {
      await intercomApi('post', `/conversations/${convId}/reply`, {
        message_type: 'note', admin_id: ADMIN_ID, body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Sub note added to ${convId}`);
    }
  } catch (e) {
    log('VAL-FAIL', `${convId}: ${e.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function handlePresale(adminId) {
  if (isPresaleRunning) {
    log('PRESALE-SKIP', 'Присейл вже виконується, пропускаємо дублікат.');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) return;

  isPresaleRunning = true;
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
      return lastAdmin < todayMidnightUnix && lastContact < todayMidnightUnix && c.custom_attributes?.['Follow-Up'] !== true;
    }).slice(0, 8); // Зменшив до 8 для стабільності

    log('PRESALE-INFO', `До обробки: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Snooze + Note для ${conv.id}`);
      
      // Відправляємо одночасно
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
      
      await new Promise(r => setTimeout(r, 1000)); // Пауза між чатами
    }

    lastProcessedDate.set(adminId, today);
  } catch (e) {
    log('PRESALE-FAIL', e.message);
  } finally {
    isPresaleRunning = false;
  }
}

// === WEBHOOK HANDLER ===
app.post('/validate-email', (req, res) => {
  const webhookId = req.headers['x-intercom-webhook-id'] || Math.random();
  if (processedWebhookIds.has(webhookId)) return res.sendStatus(200);
  processedWebhookIds.add(webhookId);
  setTimeout(() => processedWebhookIds.delete(webhookId), 60000);

  // Відповідаємо негайно
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

app.get('/', (req, res) => res.send('Worker Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on ${PORT}`));
