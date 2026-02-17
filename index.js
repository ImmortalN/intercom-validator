const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;           // для presale-фичи (опционально)
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000; // общий delay для обычных заметок

// Глобальные Set'ы
const processedConversations = new Set();
const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set(); // новый — чтобы не дублировать заметки при повторных переводах

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
  process.exit(1);
}
if (PRESALE_TEAM_ID) {
  console.log(`✅ Presale фича активна (команда: ${PRESALE_TEAM_ID})`);
} else {
  console.log(`Presale фича отключена (PRESALE_TEAM_ID не задан)`);
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ (с delay, admin_id можно переопределить) ===
async function addNoteWithDelay(conversationId, text, delay = DELAY_MS, adminId = ADMIN_ID) {
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
        timeout: 4000
      });
      console.log(`📝 Заметка добавлена (через ${delay/1000}с) от ${adminId}: "${text}" → ${conversationId}`);
    } catch (error) {
      console.error(`❌ Ошибка заметки:`, error.response?.data || error.message);
    }
  }, delay);
}

// === UNSNOOZE ===
async function unsnoozeConversation(conversationId, adminId = ADMIN_ID) {
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
      timeout: 4000
    });
    console.log(`✅ Unsnoozed: ${conversationId} от ${adminId}`);
  } catch (error) {
    console.error(`❌ Ошибка unsnooze:`, error.response?.data || error.message);
  }
}

// === ПОИСК И ОБРАБОТКА SNOOZED ЧАТОВ ДЛЯ АГЕНТА (presale) ===
async function processSnoozedForAdmin(adminId) {
  if (!PRESALE_TEAM_ID || !adminId) return;

  try {
    let startingAfter = null;
    let page = 1;

    while (true) {
      const searchBody = {
        query: {
          operator: "AND",
          value: [
            { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
            { field: "admin_assignee_id", operator: "=", value: adminId },
            { field: "state", operator: "=", value: "snoozed" }
          ]
        },
        pagination: { per_page: 100 }
      };
      if (startingAfter) searchBody.pagination.starting_after = startingAfter;

      const res = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 10000
      });

      const convs = res.data.conversations || [];
      console.log(`📋 Страница ${page}: ${convs.length} snoozed в presale у агента ${adminId}`);

      for (const conv of convs) {
        const cid = conv.id;
        await unsnoozeConversation(cid, adminId);
        await addNoteWithDelay(cid, PRESALE_NOTE_TEXT, 3000, adminId);
      }

      startingAfter = res.data.pages?.next?.starting_after;
      if (!startingAfter) break;
      page++;
      await new Promise(r => setTimeout(r, 800));
    }
  } catch (e) {
    console.error(`❌ processSnoozedForAdmin(${adminId}) ошибка:`, e.response?.data || e.message);
  }
}

// === ФОНОВАЯ ПРОВЕРКА EMAIL + SUBSCRIPTION (без изменений) ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId) return;

  try {
    const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      timeout: 5000
    });

    const contact = contactRes.data;
    const currentCustomValue = contact.custom_attributes?.[CUSTOM_ATTR_NAME];
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase email'];
    const subscription = contact.custom_attributes?.['Subscription'];

    const emails = [email, purchaseEmail].filter(e => e && e.includes('@'));
    const isEmptySubscription = !subscription || subscription === '';

    if (emails.length > 0) {
      const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
      if (Array.isArray(emailList)) {
        const isMatch = emails.some(e =>
          emailList.some(listE => typeof listE === 'string' && listE.trim().toLowerCase() === e.trim().toLowerCase())
        );

        if (isMatch) {
          if (currentCustomValue !== true) {
            await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
              custom_attributes: { [CUSTOM_ATTR_NAME]: true }
            }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });
            console.log(`Unpaid Custom → true ${contactId}`);
          }

          if (conversationId && !processedConversations.has(conversationId)) {
            processedConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем');
          }
        } else if (currentCustomValue !== false) {
          await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: { [CUSTOM_ATTR_NAME]: false }
          }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });
          console.log(`Unpaid Custom → false ${contactId}`);
        }
      }
    }

    if (isEmptySubscription && conversationId && !processedSubscriptionConversations.has(conversationId)) {
      processedSubscriptionConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
    }

  } catch (e) {
    console.error(`Ошибка validate ${contactId}:`, e.response?.data || e.message);
  }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
  const body = req.body;
  const topic = body.topic;
  const item = body.data?.item;

  if (!item) return res.status(200).json({ ok: true });

  // === 1. admin.away_mode_updated ===
  if (topic === 'admin.away_mode_updated' && item?.type === 'admin') {
    const adminId = item.id;
    const awayEnabled = item.away_mode_enabled;

    console.log(`🔄 away_mode_updated → ${item.name || item.email} (${adminId}) | away: ${awayEnabled}`);

    if (awayEnabled === false) {
      processSnoozedForAdmin(adminId);
    }
    return res.status(200).json({ ok: true, topic: 'away_mode_updated' });
  }

  // === 2. admin.logged_in ===
  if (topic === 'admin.logged_in' && item?.id) {
    console.log(`👤 logged_in → ${item.name || item.email} (${item.id})`);
    processSnoozedForAdmin(item.id);
    return res.status(200).json({ ok: true, topic: 'logged_in' });
  }

  // === 3. conversation.admin.assigned — ПЕРЕХОД С БОТА НА КОМАНДУ ===
  if (topic === 'conversation.admin.assigned') {
    const conversationId = item.id;
    const assignee = item.assignee;
    const previousAssignee = item.previous_assignee; // ← важно: в новых версиях часто previous_assignee

    // Пробуем оба варианта (в зависимости от версии API/webhook)
    const prev = previousAssignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);

    const isTransferFromBot = 
      (prev?.type === 'bot' || prev?.type === 'admin' && prev?.id?.startsWith('bot_')) &&
      assignee?.type === 'team';

    console.log(`📥 conversation.admin.assigned → ${conversationId} | prev: ${prev?.type || 'нет'}, new: ${assignee?.type}`);

    if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
      processedTransferConversations.add(conversationId);
      // Здесь можно добавить свою заметку при передаче с бота на команду
      await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
      // + можно сразу проверить subscription / unpaid custom
      const contactId = item.contacts?.contacts?.[0]?.id;
      if (contactId) validateAndSetCustom(contactId, conversationId);
    }

    return res.status(200).json({ ok: true, topic: 'conversation.admin.assigned' });
  }

  // === 4. conversation.user.replied (старый вариант — можно оставить или убрать) ===
  if (topic === 'conversation.user.replied') {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;

    // Если хочешь проверять subscription при каждом ответе клиента — раскомментируй:
    // if (contactId) validateAndSetCustom(contactId, conversationId);

    console.log(`💬 User replied → ${conversationId}`);
    return res.status(200).json({ ok: true, topic: 'user_replied' });
  }

  // === ОРИГИНАЛЬНАЯ ЛОГИКА (если пришел обычный conversation без topic) ===
  const author = item.author;
  const contactId = item.contacts?.contacts?.[0]?.id || author?.id;
  const conversationId = item.id;

  if (
    author?.type === 'bot' ||
    author?.from_ai_agent ||
    author?.is_ai_answer ||
    (author?.email && (author.email.includes('operator+') || author.email.includes('@intercom.io')))
  ) {
    return res.status(200).json({ skipped: 'bot' });
  }

  if (conversationId && (processedConversations.has(conversationId) || processedSubscriptionConversations.has(conversationId))) {
    console.log(`Чат уже обработан: ${conversationId}`);
    return res.status(200).json({ skipped: 'already_processed' });
  }

  if (contactId) {
    console.log(`Обрабатываем: ${contactId} (чат: ${conversationId})`);
    res.status(200).json({ ok: true, contactId, conversationId });
    validateAndSetCustom(contactId, conversationId);
  } else {
    res.status(200).json({ ok: true });
  }
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Webhook готов: email + subscription + presale unsnooze + transfer from bot → team');
});
