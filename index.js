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

// Глобальный Set для предотвращения дублирования по чату
const processedConversations = new Set();

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
  console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
  process.exit(1);
}

// === ФОНОВАЯ ПРОВЕРКА ===
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
    const emails = [email, purchaseEmail].filter(e => e && e.includes('@'));

    if (emails.length === 0) return;

    // 2. Получаем список
    const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
    if (!Array.isArray(emailList)) return;

    const isMatch = emails.some(e => 
      emailList.some(listE => 
        typeof listE === 'string' && listE.trim().toLowerCase() === e.trim().toLowerCase()
      )
    );

    // 3. ЕСЛИ УЖЕ TRUE И СОВПАДАЕТ — ПРОПУСК
    if (currentCustomValue === true && isMatch) {
      console.log(`Уже Unpaid Custom = true → ${contactId}`);
      return;
    }

    // 4. ЕСЛИ НЕ СОВПАДАЕТ — СБРАСЫВАЕМ В FALSE
    if (!isMatch && currentCustomValue !== false) {
      await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
        custom_attributes: { [CUSTOM_ATTR_NAME]: false }
      }, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 4000
      });
      console.log(`Unpaid Custom = false → ${contactId}`);
      return;
    }

    // 5. ЕСЛИ СОВПАДАЕТ И НЕ TRUE — СТАВИМ TRUE + ЗАМЕТКА
    if (isMatch) {
      await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
      }, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Intercom-Version': INTERCOM_VERSION
        },
        timeout: 4000
      });
      console.log(`Unpaid Custom = true → ${contactId}`);

      // ДОБАВЛЯЕМ ЗАМЕТКУ ТОЛЬКО ОДИН РАЗ
      if (conversationId && !processedConversations.has(conversationId)) {
        processedConversations.add(conversationId);
        try {
          await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
            message_type: 'note',
            admin_id: ADMIN_ID,
            body: 'Attention!!! Клиент не заплатил за кастом - саппорт не предоставляем' // ← ТЕКСТ ЗДЕСЬ
          }, {
            headers: {
              'Authorization': `Bearer ${INTERCOM_TOKEN}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 4000
          });
          console.log(`Заметка добавлена: ${conversationId}`);
        } catch (noteError) {
          console.error(`Ошибка заметки:`, noteError.response?.data || noteError.message);
        }
      }
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

  // ПРОВЕРКА: УЖЕ ОБРАБОТАН ЧАТ?
  if (conversationId && processedConversations.has(conversationId)) {
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
  console.log('Webhook готов');
});
