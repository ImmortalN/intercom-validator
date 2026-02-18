const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000;
const PRESALE_FOLLOWUP_TAG_ID = '13404165';

// Включаем/выключаем подробные логи через переменную окружения DEBUG (true/false)
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// Глобальные Set'ы
const processedConversations = new Set();
const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set();

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
  process.exit(1);
}

console.log('Webhook запущен');
console.log('DEBUG режим:', DEBUG ? 'включён (подробные логи)' : 'выключен');
if (PRESALE_TEAM_ID) {
  console.log(`Presale активна для команди: ${PRESALE_TEAM_ID}`);
} else {
  console.log('Presale вимкнена');
}

// === Удобная функция логирования (только если DEBUG=true) ===
function log(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ ===
async function addNoteWithDelay(conversationId, text, delay = DELAY_MS, adminId = ADMIN_ID) {
  if (!conversationId) return;

  setTimeout(async () => {
    try {
      await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: adminId,
        body: text
      }, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 6000
      });
      log(`[NOTE] от ${adminId} (delay ${delay/1000}с): "${text.slice(0,60)}..." → ${conversationId}`);
    } catch (error) {
      console.error(`[NOTE FAIL] conv ${conversationId}:`, error.response?.data || error.message);
    }
  }, delay);
}

// === ДОБАВЛЕНИЕ ТЕГА ===
async function addTagToConversation(conversationId, tagId = PRESALE_FOLLOWUP_TAG_ID, adminId = ADMIN_ID) {
  if (!conversationId) return;

  try {
    log(`[TAG ATTEMPT] ID ${tagId} → conv ${conversationId} от admin ${adminId}`);

    await axios.post(`https://api.intercom.io/conversations/${conversationId}/tags`, {
      id: tagId,
      admin_id: adminId
    }, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      timeout: 8000
    });

    log(`[TAG SUCCESS] ID ${tagId} добавлен в ${conversationId}`);
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 409) {
        log(`[TAG] ID ${tagId} уже есть в ${conversationId}`);
      } else {
        console.error(`[TAG FAIL ${status}] conv ${conversationId}:`, data || error.message);
      }
    } else {
      console.error(`[TAG FAIL] ${conversationId}:`, error.message);
    }
  }
}

// === UNSNOOZE ===
async function unsnoozeConversation(conversationId, adminId = ADMIN_ID) {
  if (!conversationId) return;
  try {
    await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
      message_type: 'open',
      admin_id: adminId
    }, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      timeout: 6000
    });
    log(`[UNSNZ] от ${adminId}: ${conversationId}`);
  } catch (error) {
    console.error(`[UNSNZ FAIL] ${conversationId}:`, error.response?.data || error.message);
  }
}

// === PRESALE: обработка snoozed ===
async function processSnoozedForAdmin(adminId) {
  if (!PRESALE_TEAM_ID || !adminId) return;

  try {
    let startingAfter = null;
    let page = 1;

    do {
      const searchBody = {
        query: {
          operator: "AND",
          value: [
            { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
            { field: "admin_assignee_id", operator: "=", value: adminId },
            { field: "state", operator: "=", value: "snoozed" }
          ]
        },
        pagination: { per_page: 50 }
      };
      if (startingAfter) searchBody.pagination.starting_after = startingAfter;

      const res = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 15000
      });

      const convs = res.data.conversations || [];
      log(`Presale: найдено ${convs.length} snoozed на странице ${page}`);

      for (const conv of convs) {
        const cid = conv.id;
        await unsnoozeConversation(cid, adminId);
        await addNoteWithDelay(cid, PRESALE_NOTE_TEXT, 3000, ADMIN_ID);
        await addTagToConversation(cid);
      }

      startingAfter = res.data.pages?.next?.starting_after;
      page++;
      await new Promise(r => setTimeout(r, 1200));
    } while (startingAfter);
  } catch (e) {
    console.error('[PRESALE ERROR]:', e.response?.data || e.message);
  }
}

// === ОСНОВНАЯ ПРОВЕРКА Subscription + Unpaid ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId || !conversationId) return;

  try {
    const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      timeout: 8000
    });

    const contact = contactRes.data;
    const subscription = contact.custom_attributes?.['Subscription'] || '';
    const isEmptySubscription = !subscription.trim();

    const emails = [
      contact.email,
      contact.custom_attributes?.['Purchase email']
    ].filter(Boolean);

    // Unpaid Custom
    if (emails.length > 0) {
      const { data: emailList } = await axios.get(LIST_URL, { timeout: 5000 });
      if (Array.isArray(emailList)) {
        const isMatch = emails.some(e => 
          emailList.some(le => (le || '').trim().toLowerCase() === e.trim().toLowerCase())
        );

        if (isMatch && !processedConversations.has(conversationId)) {
          processedConversations.add(conversationId);
          await addNoteWithDelay(conversationId, 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем', 5000);
        }
      }
    }

    // Subscription
    if (isEmptySubscription && !processedSubscriptionConversations.has(conversationId)) {
      processedSubscriptionConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
    }

  } catch (e) {
    console.error(`[VALIDATE ERROR] contact ${contactId}:`, e.response?.data || e.message);
  }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
  const body = req.body;
  const topic = body.topic;
  const item = body.data?.item;

  if (!item) return res.status(200).json({ ok: true });

  const conversationId = item.id;
  let contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

  // PRESALE
  if (topic === 'admin.away_mode_updated' && item?.type === 'admin') {
    const adminId = item.id;
    const awayEnabled = item.away_mode_enabled;
    if (!awayEnabled) processSnoozedForAdmin(adminId);
    return res.status(200).json({ ok: true });
  }

  if (topic === 'admin.logged_in' && item?.id) {
    processSnoozedForAdmin(item.id);
    return res.status(200).json({ ok: true });
  }

  // Передача с бота
  if (topic === 'conversation.admin.assigned') {
    const prev = item.previous_assignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);
    const assignee = item.assignee;

    const isTransferFromBot = 
      (prev?.type === 'bot' || (prev?.type === 'admin' && (prev.id || '').startsWith('bot_'))) &&
      assignee?.type === 'team';

    if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
      processedTransferConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
    }

    if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
    return res.status(200).json({ ok: true });
  }

  // Клієнт пише
  if (topic === 'conversation.user.replied') {
    if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
    return res.status(200).json({ ok: true });
  }

  // Обычный webhook
  const author = item.author;
  if (
    author?.type === 'bot' ||
    author?.from_ai_agent ||
    author?.is_ai_answer ||
    (author?.email && (author.email.includes('operator+') || author.email.includes('@intercom.io')))
  ) {
    return res.status(200).json({ skipped: 'bot' });
  }

  if (conversationId && (processedConversations.has(conversationId) || processedSubscriptionConversations.has(conversationId))) {
    return res.status(200).json({ skipped: 'already_processed' });
  }

  if (contactId && conversationId) {
    await validateAndSetCustom(contactId, conversationId);
  }

  res.status(200).json({ ok: true });
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook готов: Presale FollowUp тег + заметки');
});
