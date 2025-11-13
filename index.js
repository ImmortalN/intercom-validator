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

// Глобальные Set'ы
const processedConversations = new Set();           // Для Unpaid Custom
const processedSubscriptionConversations = new Set(); // Для Subscription

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
  process.exit(1);
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ (универсальная функция) ===
async function addNote(conversationId, text) {
  try {
    await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
      message_type: 'note',
      admin_id: ADMIN_ID,
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
    console.log(`Заметка добавлена: "${text}" → ${conversationId}`);
  } catch (error) {
    console.error(`Ошибка заметки:`, error.response?.data || error.message);
  }
}

// === ФОНОВАЯ ПРОВЕРКА (Unpaid + Subscription) ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId) return;

  try {
    // 1. Получаем контакт
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
            await addNote(conversationId, 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем');
          }
        }
      }
    }

    // === 2. ПРОВЕРКА SUBSCRIPTION (независимо от email) ===
    if (isEmptySubscription && conversationId && !processedSubscriptionConversations.has(conversationId)) {
      processedSubscriptionConversations.add(conversationId);
      await addNote(conversationId, 'Заполните пожалуйста subscription');
    }

  } catch (e) {
    console.error(`Ошибка для ${contactId}:`, e.response?.data || e.message);
  }
}

// === POST: Webhook ===
app.post('/validate-email', async (req, res) => {
  const item = req.body.data?.item;
  if (!item) return res.status(200).json({ ok: true });

  const author = item.author;
  const contactId = item.contacts?.contacts?.[0]?.id || author?.id;
  const conversationId = item.id;

  // Фильтр ботов
  if (
    author?.type === 'bot' ||
    author?.from_ai_agent ||
    author?.is_ai_answer ||
    (author?.email && (author.email.includes('operator+') || author.email.includes('@intercom.io')))
  ) {
    return res.status(200).json({ skipped: 'bot' });
  }

  // Проверяем дублирование (общее для всех проверок)
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
  console.log('Webhook готов — Unpaid + Subscription');
});
