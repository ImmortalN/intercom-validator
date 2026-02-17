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

// Глобальні Set'и — чітко розділені
const processedUnpaidConversations = new Set();       // тільки Unpaid Custom
const processedSubscriptionConversations = new Set(); // тільки Subscription
const processedTransferConversations = new Set();     // тільки передача з бота

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL або ADMIN_ID не задані!');
  process.exit(1);
}

console.log('Webhook стартував. ADMIN_ID:', ADMIN_ID);
if (PRESALE_TEAM_ID) {
  console.log(`Presale активна для команди: ${PRESALE_TEAM_ID}`);
} else {
  console.log('Presale вимкнена (PRESALE_TEAM_ID не задано)');
}

// === ДОДАВАННЯ НОТАТКИ ===
async function addNoteWithDelay(conversationId, text, delay = DELAY_MS, adminId = ADMIN_ID) {
  if (!conversationId) return console.warn('addNoteWithDelay: немає conversationId');

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
      console.log(`[NOTE OK] від ${adminId} (delay ${delay/1000}с): "${text.slice(0,60)}..." → ${conversationId}`);
    } catch (error) {
      console.error(`[NOTE FAIL] conv ${conversationId}:`, error.response?.data || error.message);
    }
  }, delay);
}

// === UNSNOOZE (тільки presale) ===
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
    console.log(`[UNSNZ OK] від ${adminId}: ${conversationId}`);
  } catch (error) {
    console.error(`[UNSNZ FAIL] ${conversationId}:`, error.response?.data || error.message);
  }
}

// === PRESALE: обробка snoozed ===
async function processSnoozedForAdmin(adminId) {
  if (!PRESALE_TEAM_ID || !adminId) return console.log('Presale вимкнена або немає adminId');

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
      console.log(`Presale: знайдено ${convs.length} snoozed на сторінці ${page}`);

      for (const conv of convs) {
        const cid = conv.id;
        await unsnoozeConversation(cid, adminId);
        await addNoteWithDelay(cid, PRESALE_NOTE_TEXT, 3000, adminId);
      }

      startingAfter = res.data.pages?.next?.starting_after;
      page++;
      await new Promise(r => setTimeout(r, 1200));
    } while (startingAfter);
  } catch (e) {
    console.error('Помилка processSnoozedForAdmin:', e.response?.data || e.message);
  }
}

// === ОСНОВНА ПЕРЕВІРКА Subscription + Unpaid ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId || !conversationId) {
    console.warn(`validate пропущено: contact ${contactId || 'немає'}, conv ${conversationId || 'немає'}`);
    return;
  }

  try {
    console.log(`[VALIDATE] Початок перевірки для contact ${contactId}, conv ${conversationId}`);

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
    ].filter(e => e && e.includes('@'));

    // Unpaid Custom
    if (emails.length > 0) {
      const { data: emailList } = await axios.get(LIST_URL, { timeout: 5000 });
      if (Array.isArray(emailList)) {
        const isMatch = emails.some(e => 
          emailList.some(le => le?.trim?.().toLowerCase() === e.trim().toLowerCase())
        );

        if (isMatch && !processedUnpaidConversations.has(conversationId)) {
          processedUnpaidConversations.add(conversationId);
          await addNoteWithDelay(conversationId, 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем', 5000);
        }
      }
    }

    // Subscription — незалежно від всього
    if (isEmptySubscription && !processedSubscriptionConversations.has(conversationId)) {
      console.log(`[SUBS] Порожнє поле Subscription → додаємо нотатку в ${conversationId}`);
      processedSubscriptionConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
    } else if (!isEmptySubscription) {
      console.log(`[SUBS] Поле Subscription заповнене: "${subscription}"`);
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

  if (!item) {
    console.log('Webhook без item → OK');
    return res.status(200).json({ ok: true });
  }

  const conversationId = item.id;
  let contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

  console.log(`[WEBHOOK] topic: ${topic || 'без topic'}, conv: ${conversationId || '?'}, contact: ${contactId || '?'}`);

  // 1. PRESALE тільки
  if (topic === 'admin.away_mode_updated' && item?.type === 'admin') {
    const adminId = item.id;
    const awayEnabled = item.away_mode_enabled;
    console.log(`[AWAY] ${item.name || item.email} (${adminId}) → away: ${awayEnabled}`);

    if (!awayEnabled) processSnoozedForAdmin(adminId);
    return res.status(200).json({ ok: true });
  }

  if (topic === 'admin.logged_in' && item?.id) {
    console.log(`[LOGIN] ${item.name || item.email} (${item.id})`);
    processSnoozedForAdmin(item.id);
    return res.status(200).json({ ok: true });
  }

  // 2. Передача з бота → команда
  if (topic === 'conversation.admin.assigned') {
    const prev = item.previous_assignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);
    const assignee = item.assignee;

    const isTransferFromBot = 
      (prev?.type === 'bot' || (prev?.type === 'admin' && (prev.id || '').startsWith('bot_'))) &&
      assignee?.type === 'team';

    console.log(`[ASSIGNED] ${conversationId} | prev: ${prev?.type || '—'}, new: ${assignee?.type || '—'}`);

    if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
      processedTransferConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
    }

    // Перевірка Subscription + Unpaid завжди
    if (contactId && conversationId) {
      await validateAndSetCustom(contactId, conversationId);
    }
    return res.status(200).json({ ok: true });
  }

  // 3. Клієнт пише → найважливіший тригер для Subscription
  if (topic === 'conversation.user.replied') {
    console.log(`[USER REPLY] conv ${conversationId}`);
    if (contactId && conversationId) {
      await validateAndSetCustom(contactId, conversationId);
    }
    return res.status(200).json({ ok: true });
  }

  // 4. Звичайний webhook (як в оригіналі)
  const author = item.author;
  if (
    author?.type === 'bot' ||
    author?.from_ai_agent ||
    author?.is_ai_answer ||
    (author?.email && (author.email.includes('operator+') || author.email.includes('@intercom.io')))
  ) {
    return res.status(200).json({ skipped: 'bot' });
  }

  if (conversationId && (processedUnpaidConversations.has(conversationId) || processedSubscriptionConversations.has(conversationId))) {
    console.log(`[SKIP] чат ${conversationId} вже оброблено`);
    return res.status(200).json({ skipped: 'already_processed' });
  }

  if (contactId && conversationId) {
    console.log(`[ОБРОБКА] звичайний чат ${conversationId} (contact ${contactId})`);
    await validateAndSetCustom(contactId, conversationId);
  }

  res.status(200).json({ ok: true });
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook запущено на порту', process.env.PORT || 3000);
  console.log('Підписка на події: conversation.user.replied, conversation.admin.assigned, admin.away_mode_updated, admin.logged_in');
});
