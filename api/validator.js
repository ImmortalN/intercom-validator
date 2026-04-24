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
let consecutiveFailures = 0;
const MAX_FAILURES = 3;

// === HELPER: LOGGING ===
function log(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${ts}] [${tag}] ${message}`);
}

// === HELPER: API WITH CIRCUIT BREAKER & VERBOSE LOGS ===
async function intercomApi(method, endpoint, data = null, timeout = 20000) {
  if (consecutiveFailures >= MAX_FAILURES) {
    log('CIRCUIT-BREAKER', `ПЕРЕРИВНИК АКТИВНИЙ: Пропускаємо ${method} ${endpoint}`);
    return null;
  }

  try {
    log('API-CALL', `Запит: ${method.toUpperCase()} ${endpoint}`);
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
    consecutiveFailures++;
    const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `Помилка ${endpoint}: ${details}`);
    throw error;
  }
}

// === LOGIC 1 & 2: UNPAID & SUBSCRIPTION ===
async function handleValidation(contactId, convId) {
  log('VAL-START', `Початок перевірки чату ${convId} (контакт: ${contactId})`);
  try {
    const conv = await intercomApi('get', `/conversations/${convId}`);
    if (!conv) return;

    const assignee = conv.assignee;
    log('VAL-INFO', `Призначено на: ${assignee?.type} (ID: ${assignee?.id})`);
    
    if (assignee?.type === 'bot' || assignee?.id?.startsWith('bot_')) {
      log('VAL-SKIP', `Чат ${convId} у бота. Пропускаємо валідацію.`);
      return;
    }

    const contact = await intercomApi('get', `/contacts/${contactId}`);
    if (!contact) {
      log('VAL-ERROR', `Не вдалося отримати дані контакту ${contactId}`);
      return;
    }

    // 1. Unpaid Logic
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase email'];
    log('VAL-INFO', `Email: ${email} | Purchase Email: ${purchaseEmail}`);

    if (email || purchaseEmail) {
      log('VAL-FETCH-LIST', `Завантажуємо список із ${LIST_URL}`);
      const { data: list } = await axios.get(LIST_URL, { timeout: 8000 });
      
      const checkEmail = (e) => e && list.some(le => le?.trim().toLowerCase() === e.trim().toLowerCase());
      const isMatch = checkEmail(email) || checkEmail(purchaseEmail);

      if (isMatch) {
        log('VAL-ACTION', `Знайдено співпадіння в списку для ${contactId}. Оновлюємо Unpaid Custom.`);
        await intercomApi('put', `/contacts/${contactId}`, { custom_attributes: { 'Unpaid Custom': true } });
      } else {
        log('VAL-INFO', `Співпадінь у списку Unpaid немає.`);
      }
    }

    // 2. Subscription Logic
    const subValue = contact.custom_attributes?.['subscription'];
    log('VAL-INFO', `Поточне значення subscription: "${subValue || 'порожньо'}"`);
    
    if (!subValue || subValue.trim() === '') {
      log('VAL-ACTION', `Subscription порожній. Додаємо нотатку в чат ${convId}`);
      await intercomApi('post', `/conversations/${convId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: 'Заповніть будь ласка subscription 😇🙏'
      });
    }
  } catch (e) {
    log('VAL-FATAL', `Помилка в handleValidation: ${e.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function handlePresale(adminId) {
  const today = new Date().toISOString().split('T')[0];
  log('PRESALE-TRIGGER', `Перевірка для адміна ${adminId}. Дата: ${today}`);

  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Адмін ${adminId} вже оброблявся сьогодні. Зупиняємо.`);
    return;
  }

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    log('PRESALE-SEARCH', `Шукаємо snoozed чати команди ${PRESALE_TEAM_ID}. Межа часу (північ): ${todayMidnightUnix}`);

    const search = await intercomApi('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID }
        ]
      },
      pagination: { per_page: 30 }
    }, 25000);

    const conversations = search?.conversations || [];
    log('PRESALE-INFO', `Знайдено всього snoozed чатів: ${conversations.length}`);

    let processedCount = 0;

    for (const conv of conversations) {
      log('PRESALE-CHECK', `Аналіз чату ${conv.id}: updated_at=${conv.updated_at}`);

      const isOld = conv.updated_at < todayMidnightUnix;
      const isFollowUp = conv.custom_attributes?.['Follow-Up'] === true;

      if (!isOld) {
        log('PRESALE-SKIP-ITEM', `Чат ${conv.id} оновлювався сьогодні (${conv.updated_at}). Пропускаємо.`);
        continue;
      }

      if (isFollowUp) {
        log('PRESALE-SKIP-ITEM', `Чат ${conv.id} має Follow-Up: true. Пропускаємо.`);
        continue;
      }

      log('PRESALE-ACTION', `Чат ${conv.id} підходить! Пробуджуємо та ставимо нотатку.`);
      
      // Крок 1: Пробудження
      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'snoozed',
        admin_id: adminId,
        snoozed_until: Math.floor(Date.now() / 1000) + 60
      });

      await new Promise(r => setTimeout(r, 1500));

      // Крок 2: Нотатка
      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'note',
        admin_id: adminId,
        body: PRESALE_NOTE_TEXT
      });

      processedCount++;
      if (processedCount >= 15) {
        log('PRESALE-LIMIT', `Досягнуто ліміту 15 чатів за один прохід для безпеки.`);
        break;
      }
    }

    lastProcessedDate.set(adminId, today);
    log('PRESALE-SUCCESS', `Обробку завершено. Оброблено чатів: ${processedCount}`);
  } catch (e) {
    log('PRESALE-FATAL', `Помилка в handlePresale: ${e.message}`);
  }
}

// === WEBHOOK HANDLER ===
app.post('/validate-email', (req, res) => {
  const { topic, data } = req.body;
  const itemId = data?.item?.id;

  log('WEBHOOK-RCV', `Отримано: ${topic} | ID: ${itemId}`);
  
  // Миттєва відповідь
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (!data?.item) {
        log('WEBHOOK-VOID', 'Порожні дані в item. Пропускаємо.');
        return;
      }

      const item = data.item;

      // Присейл: повернення з авею
      if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        log('FLOW', `Адмін ${item.id} повернувся в онлайн. Запускаємо присейл-логіку.`);
        await handlePresale(item.id);
      }

      // Валідація: нові повідомлення або призначення
      if (topic.includes('conversation.user') || topic === 'conversation.admin.assigned') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id || item.author?.id;
        log('FLOW', `Подія чату. Чат: ${item.id}, Контакт: ${contactId || 'не знайдено'}`);
        if (contactId) {
          await handleValidation(contactId, item.id);
        } else {
          log('FLOW-WARN', `Не вдалося визначити contactId для чату ${item.id}`);
        }
      }
    } catch (err) {
      log('ASYNC-ERROR-CORE', `Критичний збій обробки: ${err.message}`);
    }
  });
});

app.get('/', (req, res) => res.send('LOGS ACTIVE'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Сервер з розширеними логами на порту ${PORT}`));
