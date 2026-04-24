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
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 3; // Обмеження одночасних запитів

// === HELPER: LOGGING ===
function log(tag, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${timestamp}] [${tag}] ${message}`);
}

// === HELPER: API REQUEST WITH RETRY & CONCURRENCY CONTROL ===
async function intercomRequest(method, endpoint, data = null, customTimeout = 30000) {
  // Простий механізм очікування черги
  while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  activeRequests++;
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
  } finally {
    activeRequests--;
  }
}

async function intercomRequestWithRetry(method, endpoint, data = null, retries = 2, customTimeout = 30000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await intercomRequest(method, endpoint, data, customTimeout);
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      if (i === retries || !isTimeout) throw error;
      
      const delay = 2000 * Math.pow(2, i);
      log('RETRY', `Attempt ${i + 1} for ${endpoint}. Waiting ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  log('START', `Processing chat ${conversationId}`);
  try {
    const conversation = await intercomRequestWithRetry('get', `/conversations/${conversationId}`);
    
    // Перевірка на бота
    const assignee = conversation.assignee;
    if (assignee?.type === 'bot' || assignee?.id?.startsWith('bot_')) {
      log('SKIP', `Chat ${conversationId} is currently with a bot.`);
      return;
    }

    const contact = await intercomRequestWithRetry('get', `/contacts/${contactId}`);
    
    // Unpaid Logic
    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'];
    if (email || pEmail) {
      const listRes = await axios.get(LIST_URL);
      const list = listRes.data;
      if (list.includes(email) || list.includes(pEmail)) {
        await intercomRequestWithRetry('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
        log('ACTION', `Unpaid attribute set for ${contactId}`);
      }
    }

    // Subscription Logic
    const sub = contact.custom_attributes?.['subscription'];
    if (!sub || sub.trim() === '') {
      await intercomRequestWithRetry('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Subscription note added to ${conversationId}`);
    }

  } catch (err) {
    log('ERROR-VAL', `Validation failed for ${conversationId}: ${err.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function checkPresaleSnoozedChats(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) return;

  log('PRESALE-START', `Triggered by admin ${adminId}`);

  try {
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    
    const searchResult = await intercomRequestWithRetry('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' },
      pagination: { per_page: 50 }
    }, 2, 50000); // Дуже великий таймаут для пошуку

    const conversations = searchResult.conversations || [];
    log('PRESALE-INFO', `Snoozed chats found: ${conversations.length}`);

    for (const conv of conversations) {
      // Фільтрація: команда + час + атрибут
      if (conv.team_assignee_id === PRESALE_TEAM_ID && conv.updated_at < startOfTodayUnix) {
        
        if (conv.custom_attributes?.['Follow-Up'] === true) {
          log('PRESALE-SKIP', `Chat ${conv.id} has Follow-Up blocked.`);
          continue;
        }

        log('ACTION', `Waking up chat ${conv.id}`);

        // КРОК 1: Пробудження (Використовуємо snoozed_until)
        await intercomRequestWithRetry('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snoozed_until: Math.floor(Date.now() / 1000) + 60
        });

        await new Promise(resolve => setTimeout(resolve, 1200));

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
    log('SUCCESS', `Presale check completed for ${adminId}`);
  } catch (err) {
    log('ERROR-PRESALE', `Presale logic failed: ${err.message}`);
  }
}

// === ROUTES ===

app.get('/', (req, res) => res.send('Server Running'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.post('/validate-email', (req, res) => {
  res.sendStatus(200);

  const { topic, data } = req.body;
  if (!data?.item) return;

  const item = data.item;
  log('WEBHOOK-RCV', `Topic: ${topic}, ID: ${item.id}`);

  (async () => {
    try {
      if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
        if (contactId) await validateContactData(contactId, item.id);
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
app.listen(PORT, () => log('SYSTEM', `Server listening on ${PORT}`));
