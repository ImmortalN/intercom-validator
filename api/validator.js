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

// === HELPER: API REQUEST WITH RETRY & TIMEOUT ===
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
    const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `${method.toUpperCase()} ${endpoint} -> ${errorMsg}`);
    throw error;
  }
}

async function intercomRequestWithRetry(method, endpoint, data = null, retries = 2, customTimeout = 15000) {
  for (let i = 0; i <= retries; i++) {
    try {
      // Додаємо невелику затримку між запитами для захисту від rate limit
      await new Promise(resolve => setTimeout(resolve, 150));
      return await intercomRequest(method, endpoint, data, customTimeout);
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      if (i === retries || !isTimeout) throw error;
      
      const delay = 1000 * Math.pow(2, i); // Експоненціальний бекофф
      log('RETRY', `Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  log('START', `Processing contact ${contactId} in chat ${conversationId}`);
  try {
    const conversation = await intercomRequestWithRetry('get', `/conversations/${conversationId}`);
    const assignee = conversation.assignee;
    
    if (assignee?.type === 'bot' || assignee?.id?.startsWith('bot_')) {
      log('SKIP', `Chat ${conversationId} is with bot.`);
      return;
    }

    const contact = await intercomRequestWithRetry('get', `/contacts/${contactId}`);
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase Email'];

    // Unpaid logic
    if (email || purchaseEmail) {
      const listRes = await axios.get(LIST_URL);
      const unpaidList = listRes.data;
      if (unpaidList.includes(email) || (purchaseEmail && unpaidList.includes(purchaseEmail))) {
        log('ACTION', `Unpaid match! Updating contact ${contactId}`);
        await intercomRequestWithRetry('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
      }
    }

    // Subscription logic
    const subValue = contact.custom_attributes?.['subscription'];
    if (!subValue || subValue.trim() === '') {
      log('ACTION', `Subscription empty. Adding note to ${conversationId}`);
      await intercomRequestWithRetry('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: 'Заповніть будь ласка subscription 😇🙏'
      });
    }
  } catch (err) {
    log('ERROR-VAL', `Validation failed: ${err.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function checkPresaleSnoozedChats(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Admin ${adminId} already processed today.`);
    return;
  }

  try {
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    
    log('PRESALE-SEARCH', `Searching chats (30s timeout)...`);
    // Пошук з великим таймаутом
    const searchResult = await intercomRequestWithRetry('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' }
    }, 2, 30000);

    const conversations = searchResult.conversations || [];
    let count = 0;

    for (const conv of conversations) {
      const isPresale = conv.team_assignee_id === PRESALE_TEAM_ID;
      const isOld = conv.updated_at < startOfTodayUnix;
      const isBlocked = conv.custom_attributes?.['Follow-Up'] === true;

      if (isPresale && isOld && !isBlocked) {
        log('ACTION', `Waking up chat ${conv.id}`);
        
        // КРОК 1: Пробудження (snooze_until)
        await intercomRequestWithRetry('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snooze_until: Math.floor(Date.now() / 1000) + 60
        });

        // Пауза для стабільності
        await new Promise(resolve => setTimeout(resolve, 800));

        // КРОК 2: Нотатка
        await intercomRequestWithRetry('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        });

        count++;
        // Додаткова пауза між різними чатами для уникнення лімітів
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    lastProcessedDate.set(adminId, today);
    log('SUCCESS', `Processed ${count} presale chats.`);
  } catch (err) {
    log('ERROR-PRESALE', `Presale check failed: ${err.message}`);
  }
}

// === ROUTES ===

app.get('/', (req, res) => res.send('Active'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.post('/validate-email', (req, res) => {
  // 1. Миттєва відповідь для Intercom
  res.sendStatus(200);

  // 2. Обробка у фоні
  const { topic, data } = req.body;
  const item = data?.item;

  if (!item) return;

  log('WEBHOOK-RCV', `Topic: ${topic}, ID: ${item.id}`);

  // Виконуємо асинхронно
  (async () => {
    try {
      if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
        if (contactId) await validateContactData(contactId, item.id);
      }

      if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        log('INFO', `Admin ${item.id} online. Triggering presale check.`);
        await checkPresaleSnoozedChats(item.id);
      }
    } catch (e) {
      log('FATAL-ASYNC', e.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server running on port ${PORT}`));
