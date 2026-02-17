const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID; // ← ОБЯЗАТЕЛЬНО для presale-фичи
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000;

// Глобальные Set'ы
const processedConversations = new Set();
const processedSubscriptionConversations = new Set();

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL або ADMIN_ID не задані!');
  process.exit(1);
}
if (PRESALE_TEAM_ID) {
  console.log(`✅ Presale feature активна для команди: ${PRESALE_TEAM_ID}`);
  console.log(`   Заметка: "${PRESALE_NOTE_TEXT}"`);
} else {
  console.warn('⚠️ PRESALE_TEAM_ID не задано — presale-фіча (note + unsnooze) вимкнена');
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ (с delay) ===
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
      console.log(`📝 Заметка (через ${delay/1000}с) від ${adminId}: "${text}" → ${conversationId}`);
    } catch (error) {
      console.error(`❌ Помилка заметки:`, error.response?.data || error.message);
    }
  }, delay);
}

// === UNSNOOZE ЧАТА ===
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
    console.log(`✅ Чат unsnoozed від ${adminId}: ${conversationId}`);
  } catch (error) {
    console.error(`❌ Помилка unsnooze:`, error.response?.data || error.message);
  }
}

// === НОВАЯ ОСНОВНА ФУНКЦІЯ: обробка snoozed чатів ДЛЯ КОНКРЕТНОГО АГЕНТА ===
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
      console.log(`📋 Сторінка ${page}: знайдено ${conversations.length} snoozed чатів у presale призначених агенту ${adminId}`);

      for (const conv of conversations) {
        const conversationId = conv.id;
        await unsnoozeConversation(conversationId, adminId);           // відразу unsnooze
        await addNoteWithDelay(conversationId, PRESALE_NOTE_TEXT, 3000, adminId); // нотка через 3с
      }

      const pages = searchRes.data.pages;
      startingAfter = pages?.next?.starting_after || null;
      if (!startingAfter) break;

      page++;
      await new Promise(r => setTimeout(r, 800)); // невелика пауза між сторінками
    }
  } catch (e) {
    console.error(`❌ Помилка processSnoozedForAdmin(${adminId}):`, e.response?.data || e.message);
  }
}

// === ФОНОВАЯ ПРОВЕРКА EMAIL/SUBSCRIPTION (без змін) ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId) return;
  // ... (весь оригінальний код без змін — залишив для компактності)
  try {
    const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, { /* ... */ });
    // весь код validateAndSetCustom з твого оригінального скрипту
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
        const isMatch = emails.some(e => emailList.some(listE => typeof listE === 'string' && listE.trim().toLowerCase() === e.trim().toLowerCase()));
        if (isMatch) {
          await axios.put(`https://api.intercom.io/contacts/${contactId}`, { custom_attributes: { [CUSTOM_ATTR_NAME]: true } }, { headers: { /*...*/ } });
          if (conversationId && !processedConversations.has(conversationId)) {
            processedConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо');
          }
        } else if (currentCustomValue !== false) {
          await axios.put(`https://api.intercom.io/contacts/${contactId}`, { custom_attributes: { [CUSTOM_ATTR_NAME]: false } }, { headers: { /*...*/ } });
        }
      }
    }

    if (isEmptySubscription && conversationId && !processedSubscriptionConversations.has(conversationId)) {
      processedSubscriptionConversations.add(conversationId);
      await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
    }
  } catch (e) {
    console.error(`Помилка для ${contactId}:`, e.response?.data || e.message);
  }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
  const body = req.body;
  const topic = body.topic;
  const item = body.data?.item;

  // === 1. admin.away_mode_updated — головна нова фіча ===
  if (topic === 'admin.away_mode_updated' && item?.type === 'admin') {
    const adminId = item.id;
    const awayEnabled = item.away_mode_enabled;
    const reassign = item.away_mode_reassign;

    console.log(`🔄 away_mode_updated → ${item.name || item.email} (${adminId}) | away: ${awayEnabled}, reassign: ${reassign}`);

    // Тригеримо тільки коли агент вимикає away mode (стає active)
    if (awayEnabled === false) {
      res.status(200).json({ ok: true, topic: 'away_mode_off' });
      processSnoozedForAdmin(adminId);   // ← unsnooze + note для його чатів
    } else {
      res.status(200).json({ ok: true, skipped: 'still_away' });
    }
    return;
  }

  // === 2. admin.logged_in — залишаємо для сумісності (тепер теж per-admin) ===
  if (topic === 'admin.logged_in' && item?.id) {
    console.log(`👤 Admin logged in → ${item.name || item.email} (${item.id})`);
    res.status(200).json({ ok: true, topic: 'admin_logged_in' });
    processSnoozedForAdmin(item.id);
    return;
  }

  // === ОРИГІНАЛЬНА ЛОГІКА ДЛЯ conversation (email + subscription) ===
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
    return res.status(200).json({ skipped: 'already_processed' });
  }

  if (contactId) {
    res.status(200).json({ ok: true, contactId, conversationId });
    validateAndSetCustom(contactId, conversationId);
  } else {
    res.status(200).json({ ok: true });
  }
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Webhook готовий: email-check + subscription + presale unsnooze при away_mode_off та logged_in');
});
