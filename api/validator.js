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

// === HELPER: LOGGING ===
function log(tag, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${timestamp}] [${tag}] ${message}`);
}

// === HELPER: API REQUEST WITH RETRY ===
async function intercomRequest(method, endpoint, data = null, customTimeout = 15000) {
  try {
    const config = {
      method,
      url: `https://api.intercom.io${endpoint}`,
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      data,
      timeout: customTimeout
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `${method.toUpperCase()} ${endpoint} -> ${errorData}`);
    throw error;
  }
}

async function intercomRequestWithRetry(method, endpoint, data = null, retries = 2, customTimeout = 20000) {
  for (let i = 0; i <= retries; i++) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300)); // Rate limit protection
      return await intercomRequest(method, endpoint, data, customTimeout);
    } catch (error) {
      const isRateLimit = error.response?.status === 429;
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      
      if (i === retries || (!isRateLimit && !isTimeout)) throw error;
      
      const delay = isRateLimit ? 5000 : 2000 * Math.pow(2, i);
      log('RETRY', `Issue on ${endpoint}. Retrying in ${delay}ms... (Attempt ${i + 1})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  try {
    const conversation = await intercomRequestWithRetry('get', `/conversations/${conversationId}`);
    if (conversation.assignee?.type === 'bot') return;

    const contact = await intercomRequestWithRetry('get', `/contacts/${contactId}`);
    
    // Unpaid
    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'];
    if (email || pEmail) {
      const list = (await axios.get(LIST_URL)).data;
      if (list.includes(email) || list.includes(pEmail)) {
        await intercomRequestWithRetry('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
        log('ACTION', `Updated Unpaid status for ${contactId}`);
      }
    }

    // Subscription
    if (!contact.custom_attributes?.['subscription']?.trim()) {
      await intercomRequestWithRetry('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note', admin_id: ADMIN_ID, body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Sent sub note to ${conversationId}`);
    }
  } catch (err) {
    log('ERROR-VAL', err.message);
  }
}

// === LOGIC 3: PRESALE ===
async function checkPresaleSnoozedChats(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) return;

  log('PRESALE-START', `Processing for admin ${adminId}`);

  try {
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    
    // Пошук з пагінацією та великим таймаутом
    const searchResult = await intercomRequestWithRetry('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' },
      pagination: { per_page: 50 }
    }, 2, 40000);

    const conversations = searchResult.conversations || [];
    log('PRESALE-INFO', `Found ${conversations.length} snoozed chats.`);

    for (const conv of conversations) {
      // ПЕРЕВІРКА: чи чат належить команді і чи він "старий"
      if (conv.team_assignee_id === PRESALE_TEAM_ID && conv.updated_at < startOfTodayUnix) {
        
        if (conv.custom_attributes?.['Follow-Up'] === true) {
          log('PRESALE-SKIP', `Chat ${conv.id} has Follow-Up active.`);
          continue;
        }

        log('ACTION', `Waking up & noting chat ${conv.id}`);

        // КРОК 1: Пробудження (Параметр snooze_until - БЕЗ 'd')
        await intercomRequestWithRetry('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snooze_until: Math.floor(Date.now() / 1000) + 60
        });

        await new Promise(resolve => setTimeout(resolve, 1000)); // Більша пауза для стабільності

        // КРОК 2: Нотатка
        await intercomRequestWithRetry('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        });

        await new Promise(resolve => setTimeout(resolve, 500)); 
      }
    }

    lastProcessedDate.set(adminId, today);
    log('SUCCESS', `Presale check finished.`);
  } catch (err) {
    log('ERROR-PRESALE', `Check failed: ${err.message}`);
  }
}

// === ROUTES ===

app.get('/', (req, res) => res.send('Server is Up'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.post('/validate-email', (req, res) => {
  res.sendStatus(200); // Відповідаємо відразу

  const { topic, data } = req.body;
  if (!data?.item) return;

  const item = data.item;
  log('WEBHOOK-RCV', `Topic: ${topic}, ID: ${item.id}`);

  // Асинхронний запуск
  (async () => {
    try {
      if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const cId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
        if (cId) await validateContactData(cId, item.id);
      }

      if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        await checkPresaleSnoozedChats(item.id);
      }
    } catch (e) {
      log('FATAL-ASYNC', e.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on ${PORT}`));
