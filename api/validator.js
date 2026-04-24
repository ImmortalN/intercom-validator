const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === НАЛАШТУВАННЯ (ENV) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо заснужені чати presale 🚀';
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// Точний текст для ноута підписки
const SUBSCRIPTION_NOTE_TEXT = 'Заповніть будь ласка subscription 😇🙏';

const lastProcessedDate = new Map(); // adminId -> YYYY-MM-DD

// === ФУНКЦІЯ ЛОГУВАННЯ ===
function log(tag, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${timestamp}] [${tag}] ${message}`);
}

async function intercomRequest(method, endpoint, data = null) {
  try {
    log('API-CALL', `${method.toUpperCase()} ${endpoint}`);
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
      timeout: 10000
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `${endpoint} failed: ${error.response?.status} - ${errorData}`);
    throw error;
  }
}

// === ЛОГІКА 1 & 2: UNPAID ТА SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  log('VALIDATE-START', `Checking contact ${contactId} in conversation ${conversationId}`);

  try {
    // 1. Отримуємо дані чату для перевірки на бота
    const conversation = await intercomRequest('get', `/conversations/${conversationId}`);
    const assignee = conversation.assignee;
    
    // Пропускаємо, якщо чат все ще у бота
    if (!assignee || assignee.type === 'bot' || (assignee.type === 'admin' && assignee.id?.startsWith('bot_'))) {
      log('SKIP', `Conversation ${conversationId} is currently with a bot. Skipping notes.`);
      return;
    }

    // 2. Отримуємо дані контакту
    const contact = await intercomRequest('get', `/contacts/${contactId}`);
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase Email'];
    
    log('INFO', `Contact emails: Primary: ${email}, Purchase: ${purchaseEmail}`);

    // Перевірка Unpaid
    if (email || purchaseEmail) {
      log('CHECK-UNPAID', `Fetching unpaid list...`);
      const listRes = await axios.get(LIST_URL);
      const unpaidList = listRes.data;
      
      const isUnpaid = (email && unpaidList.includes(email)) || (purchaseEmail && unpaidList.includes(purchaseEmail));

      if (isUnpaid) {
        log('ACTION', `Unpaid match found. Setting attribute for ${contactId}`);
        await intercomRequest('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
      }
    }

    // Перевірка Subscription
    const subValue = contact.custom_attributes?.['subscription'];
    if (!subValue || subValue.trim() === '') {
      log('ACTION', `Subscription is empty. Adding reminder note.`);
      await intercomRequest('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: SUBSCRIPTION_NOTE_TEXT
      });
    }

  } catch (err) {
    log('VALIDATE-FAIL', `Error: ${err.message}`);
  }
}

// === ЛОГІКА 3: PRESALE ===
async function checkPresaleSnoozedChats(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Admin ${adminId} already checked today.`);
    return;
  }

  try {
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    log('PRESALE-SEARCH', `Searching snoozed chats...`);
    const searchResult = await intercomRequest('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' }
    });

    const conversations = searchResult.conversations || [];
    let count = 0;

    for (const conv of conversations) {
      const isPresaleTeam = conv.team_assignee_id === PRESALE_TEAM_ID;
      const isOldEnough = conv.updated_at < startOfTodayUnix;
      const isFollowUpBlocked = conv.custom_attributes?.['Follow-Up'] === true;

      if (isPresaleTeam && isOldEnough) {
        if (isFollowUpBlocked) {
          log('INFO', `Chat ${conv.id} skipped due to Follow-Up attribute.`);
          continue;
        }

        // КРОК 1: Пробуджуємо (snooze_until)
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snooze_until: Math.floor(Date.now() / 1000) + 60
        });

        // КРОК 2: Затримка
        await new Promise(resolve => setTimeout(resolve, 500));

        // КРОК 3: Нотатка
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        });

        count++;
      }
    }

    lastProcessedDate.set(adminId, today);
    log('PRESALE-SUCCESS', `Processed ${count} chats for admin ${adminId}`);
  } catch (error) {
    log('PRESALE-ERROR', error.message);
  }
}

// === ROUTES ===

// Обробка головної сторінки (щоб не було 404 при переході по URL)
app.get('/', (req, res) => {
  res.send('Webhook server is running');
});

// Обробка фавіконки
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ОСНОВНИЙ ВЕБХУК (Змінено шлях на /validate-email)
app.post('/validate-email', async (req, res) => {
  const { topic, data } = req.body;
  const item = data?.item;

  if (!item) return res.sendStatus(200);

  log('WEBHOOK-RCV', `Topic: ${topic}, ID: ${item.id}`);

  if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
    const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
    validateContactData(contactId, item.id);
  }

  if (topic === 'admin.away_mode_updated') {
    if (item.away_mode_enabled === false) {
      log('INFO', `Admin ${item.id} is back online.`);
      checkPresaleSnoozedChats(item.id);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server active on port ${PORT}`));
