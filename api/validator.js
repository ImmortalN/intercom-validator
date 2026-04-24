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

const lastProcessedDate = new Map(); // adminId -> YYYY-MM-DD

// === ДОПОМІЖНІ ФУНКЦІЇ ===
function log(tag, message) {
  if (DEBUG) console.log(`[${tag}] ${message}`);
}

async function intercomRequest(method, endpoint, data = null) {
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
      timeout: 10000
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    log('API-ERROR', `${endpoint} failed: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`);
    throw error;
  }
}

// === ЛОГІКА 1 & 2: UNPAID ТА SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  if (!contactId || !conversationId) return;

  try {
    // 1. Отримуємо дані клієнта
    const contact = await intercomRequest('get', `/contacts/${contactId}`);
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase Email'];

    // 2. Перевірка Unpaid через зовнішній API
    if (email || purchaseEmail) {
      const listRes = await axios.get(LIST_URL);
      const unpaidList = listRes.data;
      const isUnpaid = unpaidList.includes(email) || (purchaseEmail && unpaidList.includes(purchaseEmail));

      if (isUnpaid) {
        await intercomRequest('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
        log('UNPAID-SET', `Marked contact ${contactId} as unpaid`);
      }
    }

    // 3. Перевірка поля Subscription
    const subValue = contact.custom_attributes?.['subscription'];
    if (!subValue || subValue.trim() === '') {
      await intercomRequest('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: 'Please fill subscription 😇'
      });
      log('SUBS-NOTE', `Sent subscription reminder for chat ${conversationId}`);
    }
  } catch (err) {
    log('VALIDATE-FAIL', err.message);
  }
}

// === ЛОГІКА 3: PRESALE (ОНОВЛЕНО) ===
async function checkPresaleSnoozedChats(adminId) {
  // Обмеження: один раз на день для одного адміна
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Admin ${adminId} already triggered today`);
    return;
  }

  log('PRESALE-START', `Searching chats for admin ${adminId}...`);

  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    // Шукаємо всі заснужені чати (спрощений запит для стабільності API)
    const searchResult = await intercomRequest('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' }
    });

    const conversations = searchResult.conversations || [];
    let count = 0;

    for (const conv of conversations) {
      // Фільтруємо за командою та часом останнього оновлення (має бути вчора або раніше)
      const isPresaleTeam = conv.team_assignee_id === PRESALE_TEAM_ID;
      const isOldEnough = conv.updated_at < startOfTodayUnix;
      const isFollowUpBlocked = conv.custom_attributes?.['Follow-Up'] === true;

      if (isPresaleTeam && isOldEnough) {
        if (isFollowUpBlocked) {
          log('PRESALE-SKIP', `Chat ${conv.id} ignored: Follow-Up is true`);
          continue;
        }

        // КРОК 1: Пробуджуємо чат (переставляємо снуз на +1 хвилину від зараз)
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snooze_until: Math.floor(Date.now() / 1000) + 60
        });

        // КРОК 2: Додаємо внутрішню нотатку
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        });

        count++;
      }
    }

    lastProcessedDate.set(adminId, today);
    log('PRESALE-COMPLETE', `Processed ${count} chats`);
  } catch (error) {
    log('PRESALE-ERROR', `Critical logic failure: ${error.message}`);
  }
}

// === WEBHOOK HANDLER ===
app.post('/webhook', async (req, res) => {
  const { topic, data } = req.body;
  const item = data?.item;

  if (!item) return res.sendStatus(200);

  // Подія: Нове повідомлення від клієнта
  if (topic === 'conversation.user.created') {
    const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
    validateContactData(contactId, item.id);
  }

  // Подія: Зміна статусу "Away Mode" адміна
  if (topic === 'admin.away_mode_updated') {
    const isBack = item.away_mode_enabled === false;
    if (isBack) {
      log('STATUS-CHANGE', `Admin ${item.id} is now ONLINE`);
      checkPresaleSnoozedChats(item.id);
    }
  }

  res.sendStatus(200);
});

// Для Vercel/Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
