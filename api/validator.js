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
async function intercomApi(method, endpoint, data = null, timeout = 20000) {
  if (consecutiveFailures >= MAX_FAILURES) {
    log('CIRCUIT-BREAKER', `ОТМЕНА: ${method} ${endpoint}. Слишком много ошибок.`);
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
        log('RETRY', `Таймаут на ${endpoint}, попытка №${attempt + 1}...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      consecutiveFailures++;
      const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      log('API-ERROR', `${endpoint}: ${details}`);
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

    const email = contact.email;
    const pEmail = contact.custom_attributes?.['Purchase Email'] || contact.custom_attributes?.['Purchase email'];
    
    if (email || pEmail) {
      const { data: list } = await axios.get(LIST_URL, { timeout: 10000 });
      const check = (e) => e && list.some(le => le?.trim().toLowerCase() === e.trim().toLowerCase());
      
      if (check(email) || check(pEmail)) {
        if (contact.custom_attributes?.['Unpaid Custom'] !== true) {
          await intercomApi('put', `/contacts/${contactId}`, { custom_attributes: { 'Unpaid Custom': true } });
          log('ACTION', `Unpaid установлен для ${contactId}`);
        }
      }
    }

    const sub = contact.custom_attributes?.['subscription'] || contact.custom_attributes?.['Subscription'];
    if (!sub || sub.trim() === '') {
      await intercomApi('post', `/conversations/${convId}/reply`, {
        message_type: 'note', admin_id: ADMIN_ID, body: 'Заповніть будь ласка subscription 😇🙏'
      });
      log('ACTION', `Заметка Sub добавлена в ${convId}`);
    }
  } catch (e) {
    log('VAL-FAIL', `Ошибка валідації чату ${convId}: ${e.message}`);
  }
}

// === LOGIC 3: PRESALE ===
async function handlePresale(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Админ ${adminId} уже обрабатывался сегодня.`);
    return;
  }

  try {
    const todayMidnightUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    log('PRESALE-START', `Полночь (Unix): ${todayMidnightUnix}`);

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
    log('PRESALE-INFO', `Найдено snoozed чатов команды присейл: ${conversations.length}`);

    const toProcess = conversations.filter(c => {
      // Natalie подсказала: используем время сообщений, а не updated_at
      const lastAdminMsg = c.statistics?.last_admin_reply_at || 0;
      const lastContactMsg = c.statistics?.last_contact_reply_at || 0;
      
      // Чат "старый", если и админ, и клиент писали до полуночи
      const isOldMessage = lastAdminMsg < todayMidnightUnix && lastContactMsg < todayMidnightUnix;
      const noFollowUp = c.custom_attributes?.['Follow-Up'] !== true;

      // ОЧЕНЬ ДЕТАЛЬНЫЙ ЛОГ ДЛЯ КАЖДОГО ЧАТА
      log('PRESALE-DEBUG-CHAT', `Чат: ${c.id} | AdminMsg: ${lastAdminMsg} | ContactMsg: ${lastContactMsg} | FollowUp: ${c.custom_attributes?.['Follow-Up']}`);
      log('PRESALE-DEBUG-RES', `Результат фильтра чата ${c.id}: isOld=${isOldMessage}, noFollowUp=${noFollowUp}`);

      return isOldMessage && noFollowUp;
    }).slice(0, 15);

    log('PRESALE-INFO', `ИТОГО к обработке: ${toProcess.length}`);

    for (const conv of toProcess) {
      log('ACTION', `Пробуждаем чат ${conv.id}`);
      
      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'snoozed',
        admin_id: adminId,
        snoozed_until: Math.floor(Date.now() / 1000) + 60
      });

      await new Promise(r => setTimeout(r, 1500));

      await intercomApi('post', `/conversations/${conv.id}/reply`, {
        message_type: 'note',
        admin_id: adminId,
        body: PRESALE_NOTE_TEXT
      });

      await new Promise(r => setTimeout(r, 500));
    }

    lastProcessedDate.set(adminId, today);
  } catch (e) {
    log('PRESALE-FAIL', `Критическая ошибка присейла: ${e.message}`);
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

      // 1. Присейл логика (Away Mode)
      if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        log('FLOW', `Админ ${item.id} вернулся. Запуск присейла...`);
        await handlePresale(item.id);
      }

      // 2. Сабскрипшн и Unpaid логика
      if (topic.includes('conversation.user') || topic === 'conversation.admin.assigned') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id || item.source?.author?.id;
        if (contactId) await handleValidation(contactId, item.id);
      }
    } catch (err) {
      log('ASYNC-ERR', err.message);
    }
  });
});

app.get('/', (req, res) => res.send('Monitoring Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SYSTEM', `Server started on ${PORT}`));
