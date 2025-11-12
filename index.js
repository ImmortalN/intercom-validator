const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';

if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ОШИБКА: INTERCOM_TOKEN или LIST_URL не заданы!');
  process.exit(1);
}

// === ФОНОВАЯ ПРОВЕРКА ===
async function validateAndSetCustom(contactId) {
  if (!contactId) {
    console.log('[ФОН] Нет contactId — пропуск');
    return;
  }

  try {
    console.log(`[ФОН] Получаем контакт: ${contactId}`);
    const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Accept': 'application/json' },
      timeout: 5000
    });

    const contact = contactRes.data;
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase email'];
    const emails = [email, purchaseEmail].filter(e => e && e.includes('@'));

    if (emails.length === 0) {
      console.log(`[ФОН] Нет email для ${contactId}`);
      return;
    }

    console.log(`[ФОН] Проверка: ${emails.join(', ')}`);

    const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
    if (!Array.isArray(emailList)) return;

    const isMatch = emails.some(e => 
      emailList.some(listE => 
        typeof listE === 'string' && listE.trim().toLowerCase() === e.trim().toLowerCase()
      )
    );

    if (isMatch) {
      await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
      }, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 4000
      });
      console.log(`[ФОН] Unpaid Custom = true → ${contactId}`);
    } else {
      console.log(`[ФОН] Нет совпадения для ${contactId}`);
    }
  } catch (e) {
    console.error(`[ФОН] Ошибка для ${contactId}:`, e.response?.data || e.message);
  }
}

// === POST: Webhook ===
app.post('/validate-email', async (req, res) => {
  console.log('Webhook получен:', JSON.stringify(req.body, null, 2));

  // === 1. PING ===
  if (req.body.type === "notification_event" && req.body.data?.item?.type === "ping") {
    console.log('Intercom Test: PING');
    return res.status(200).json({ message: "OK" });
  }

  const item = req.body.data?.item;
  if (!item) {
    console.log('Нет data.item — но продолжаем');
    return res.status(200).json({ received: true });
  }

  const author = item.author;
  const contactId = item.contacts?.contacts?.[0]?.id || author?.id;

  // === ФИЛЬТР БОТОВ ===
  if (
    author?.type === 'bot' ||
    author?.from_ai_agent === true ||
    author?.is_ai_answer === true ||
    (author?.email && (author.email.includes('operator+') || author.email.includes('@intercom.io')))
  ) {
    console.log(`Бот пропущен: ${author?.name || 'Unknown'}`);
    return res.status(200).json({ skipped: true, reason: 'bot' });
  }

  if (!contactId) {
    console.log('Нет contactId — но продолжаем с fallback');
    // Попробуем извлечь из author.id
    if (author?.id) {
      validateAndSetCustom(author.id);
    }
    return res.status(200).json({ received: true, fallback: true });
  }

  console.log(`Обрабатываем контакт: ${contactId}`);

  // === ВСЕГДА 200! ===
  res.status(200).json({ received: true, contactId });

  // === ФОН ===
  validateAndSetCustom(contactId);
});

// === HEAD ===
app.head('/validate-email', (req, res) => res.status(200).send('OK'));

// === ЗАПУСК ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен: https://intercom-validator-production.up.railway.app/validate-email`);
});
