const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000; // 30 секунд — подбери под свой workflow

// === PRESALE НАСТРОЙКИ (новое) ===
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID; // ID команды presale из Intercom (обязательно для фичи)
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вышел в онлайн — проверяем snoozed чаты presale 😎';

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
  process.exit(1);
}
if (PRESALE_TEAM_ID) {
  console.log(`✅ Presale feature активна для команды: ${PRESALE_TEAM_ID}`);
  console.log(`   Текст заметки: "${PRESALE_NOTE_TEXT}"`);
} else {
  console.warn('⚠️  PRESALE_TEAM_ID не задан — фича "note + unsnooze при логине агента" отключена');
}

// Глобальные Set'ы
const processedConversations = new Set();
const processedSubscriptionConversations = new Set();

// === ДОБАВЛЕНИЕ ЗАМЕТКИ (с делеем) — обновлено: adminId optional ===
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
      console.log(`Заметка добавлена (через ${delay/1000}с) от ${adminId}: "${text}" → ${conversationId}`);
    } catch (error) {
      console.error(`Ошибка заметки (через ${delay/1000}с):`, error.response?.data || error.message);
    }
  }, delay);
}

// === UNSNOOZE ЧАТА (message_type: open) ===
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
    console.log(`✅ Чат unsnoozed от ${adminId}: ${conversationId}`);
  } catch (error) {
    console.error(`Ошибка unsnooze:`, error.response?.data || error.message);
  }
}

// === ФОНОВАЯ ПРОВЕРКА EMAIL/SUBSCRIPTION (оригинал без изменений) ===
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

    // === 1. ПРОВЕРКА EMAIL (Unpaid Custom) ===
    if (emails.length > 0) {
      const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
      if (Array.isArray(emailList)) {
        const isMatch = emails.some(e =>
          emailList.some(listE =>
            typeof listE === 'string' && listE.trim().toLowerCase() === e.trim().toLowerCase()
          )
        );

        if (currentCustomValue === true && isMatch) {
          console.log(`Уже Unpaid Custom = true → ${contactId}`);
        } else if (!isMatch && currentCustomValue !== false) {
          await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: { [CUSTOM_ATTR_NAME]: false }
          }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });
          console.log(`Unpaid Custom = false → ${contactId}`);
        } else if (isMatch) {
          await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: { [CUSTOM_ATTR_NAME]: true }
          }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });
          console.log(`Unpaid Custom = true → ${contactId}`);

          if (conversationId && !processedConversations.has(conversationId)) {
            processedConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем');
          }
        }
      }
    }

    // === 2. ПРОВЕРКА SUBSCRIPTION ===
    if (isEmptySubscription && conversationId && !processedSubscriptionConversations.has(conversationId)) {
      processedSubscriptionConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000); // 10 сек — быстрее
    }

  } catch (e) {
    console.error(`Ошибка для ${contactId}:`, e.response?.data || e.message);
  }
}

// === НОВАЯ ФУНКЦИЯ: обработка snoozed чатов presale при логине агента ===
async function processPresaleSnoozed(loggedAdminId) {
  if (!PRESALE_TEAM_ID) return;
  const adminIdForAction = loggedAdminId || ADMIN_ID;

  try {
    let startingAfter = null;
    let page = 1;

    while (true) {
      const searchBody = {
        query: {
          operator: "AND",
          value: [
            {
              field: "team_assignee_id",
              operator: "=",
              value: PRESALE_TEAM_ID
            },
            {
              field: "state",
              operator: "=",
              value: "snoozed"
            }
          ]
        },
        pagination: {
          per_page: 100
        }
      };

      if (startingAfter) {
        searchBody.pagination.starting_after = startingAfter;
      }

      const searchRes = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 10000
      });

      const conversations = searchRes.data.conversations || [];
      console.log(`📋 Страница ${page}: найдено ${conversations.length} snoozed чатов в presale`);

      for (const conv of conversations) {
        const conversationId = conv.id;
        // 1. Unsnooze сразу
        await unsnoozeConversation(conversationId, adminIdForAction);
        // 2. Заметка через 3 секунды (чтобы появлялась "вместе" с unsnooze)
        await addNoteWithDelay(conversationId, PRESALE_NOTE_TEXT, 3000, adminIdForAction);
      }

      const pages = searchRes.data.pages;
      startingAfter = pages?.next?.starting_after || null;
      if (!startingAfter) break;

      page++;
      await new Promise(r => setTimeout(r, 1000)); // пауза между страницами
    }
  } catch (e) {
    console.error(`❌ Ошибка processPresaleSnoozed:`, e.response?.data || e.message);
  }
}

// === POST: Webhook (обновлено — теперь поддерживает admin.logged_in + оригинал) ===
app.post('/validate-email', async (req, res) => {
  const body = req.body;
  const topic = body.topic;

  // === НОВОЕ: admin.logged_in — триггер для presale ===
  if (topic === 'admin.logged_in') {
    const adminItem = body.data?.item;
    if (adminItem && adminItem.id) {
      console.log(`👤 Admin logged in → ${adminItem.name || adminItem.email} (${adminItem.id})`);
      res.status(200).json({ ok: true, topic: 'admin_logged_in' });
      // Запускаем обработку snoozed чатов presale (fire-and-forget)
      processPresaleSnoozed(adminItem.id);
    } else {
      res.status(200).json({ ok: true });
    }
    return;
  }

  // === ОРИГИНАЛЬНАЯ ЛОГИКА ДЛЯ conversation ===
  const item = body.data?.item;
  if (!item) return res.status(200).json({ ok: true });

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
  console.log('Webhook готов — с делеем + presale unsnooze при логине агента');
});
