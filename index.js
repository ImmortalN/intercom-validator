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
async function validateAndSetCustom(contactId, email, purchaseEmail) {
  const emailsToCheck = [email, purchaseEmail].filter(e => e && e.includes('@'));
  if (emailsToCheck.length === 0) return;

  try {
    console.log(`[ФОН] Проверка для ID ${contactId}: ${emailsToCheck.join(', ')}`);
    const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
    if (!Array.isArray(emailList)) return;

    const isMatch = emailsToCheck.some(e => 
      emailList.some(listEmail =>
        typeof listEmail === 'string' && listEmail.trim().toLowerCase() === e.trim().toLowerCase()
      )
    );

    if (isMatch) {
      const payload = { custom_attributes: { [CUSTOM_ATTR_NAME]: true } };
      try {
        const response = await axios.put(`https://api.intercom.io/contacts/${contactId}`, payload, {
          headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 4000
        });
        console.log(`[ФОН] ${CUSTOM_ATTR_NAME} = true (Status: ${response.status})`);
      } catch (apiError) {
        console.error(`[ФОН] Полная ошибка API для ${contactId}: Status ${apiError.response?.status}, Data:`, apiError.response?.data || apiError.message);
      }
    } else {
      console.log(`[ФОН] Нет совпадения для ${contactId}`);
    }
  } catch (e) {
    console.error('[ФОН] Критическая ошибка:', e.message);
  }
}

// === POST: Webhook ===
app.post('/validate-email', async (req, res) => {
  console.log('Webhook получен:', JSON.stringify(req.body, null, 2));

  // === 1. PING ТЕСТ ===
  if (req.body.type === "notification_event" && req.body.data?.item?.type === "ping") {
    console.log('Intercom Test: PING');
    return res.status(200).json({ message: "Webhook test received" });
  }

  // === 2. ИЗВЛЕЧЕНИЕ ===
  const item = req.body.data?.item;
  if (!item) {
    console.log('Нет data.item');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const author = item.author;
  const contactId = item.contacts?.contacts?.[0]?.id || author.id; // ID из контакта или author

  if (!contactId) {
    console.log('Нет contact ID');
    return res.status(400).json({ error: 'No contact ID' });
  }

  // === 3. ФИЛЬТР БОТОВ ===
  if (
    author?.type === 'bot' ||
    author?.from_ai_agent === true ||
    author?.is_ai_answer === true ||
    author?.email?.includes('operator+') ||
    author?.email?.includes('@intercom.io')
  ) {
    console.log(`Бот пропущен: ${author?.name} (${author?.email})`);
    return res.status(200).json({ skipped: true, reason: 'bot_message' });
  }

  // === 4. ПОЛУЧАЕМ EMAIL (из author для user.replied) ===
  const email = author.email;

  if (!email || !email.includes('@')) {
    console.log('Нет email в author');
    return res.status(400).json({ error: 'No email' });
  }

  // === 5. ПОЛУЧАЕМ PURCHASE EMAIL (API-вызов по ID) ===
  let purchaseEmail = null;
  try {
    const contactResponse = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json'
      },
      timeout: 3000
    });
    purchaseEmail = contactResponse.data.custom_attributes?.['Purchase email'];
    console.log(`[API] Purchase email для ${contactId}: ${purchaseEmail}`);
  } catch (e) {
    console.error('[API] Ошибка получения контакта:', e.response?.status || e.message);
  }

  // === 6. ОТВЕЧАЕМ СРАЗУ ===
  res.status(200).json({ received: true, email, purchaseEmail, contactId });

  // === 7. ФОНОВАЯ ПРОВЕРКА ===
  validateAndSetCustom(contactId, email, purchaseEmail);
});

// === HEAD ===
app.head('/validate-email', (req, res) => {
  res.status(200).send('OK');
});

// === ЗАПУСК ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
});
