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
  if (emailsToCheck.length === 0 || !contactId) return;

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
        console.error(`[ФОН] Ошибка API: ${apiError.response?.status} |`, apiError.response?.data || apiError.message);
      }
    }
  } catch (e) {
    console.error('[ФОН] Ошибка:', e.message);
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
  const contacts = item.contacts?.contacts || [];
  const contact = contacts[0];

  // === 3. БЕЗОПАСНАЯ ПРОВЕРКА AUTHOR ===
  if (!author || !author.email || !author.email.includes('@')) {
    console.log('Нет валидного author.email');
    return res.status(400).json({ error: 'No valid author email' });
  }

  // === 4. ФИЛЬТР БОТОВ ===
  if (
    author.type === 'bot' ||
    author.from_ai_agent === true ||
    author.is_ai_answer === true ||
    author.email.includes('operator+') ||
    author.email.includes('@intercom.io')
  ) {
    console.log(`Бот пропущен: ${author.name || 'Unknown'} (${author.email})`);
    return res.status(200).json({ skipped: true, reason: 'bot' });
  }

  // === 5. CONTACT ID (из contacts или author) ===
  const contactId = contact?.id || author.id;
  if (!contactId) {
    console.log('Нет contact ID');
    return res.status(400).json({ error: 'No contact ID' });
  }

  const email = author.email;

  // === 6. ПОЛУЧАЕМ PURCHASE EMAIL (GET /contacts/{id}) ===
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
    console.log(`[API] Purchase email: ${purchaseEmail || 'не найден'}`);
  } catch (e) {
    console.error('[API] Ошибка получения контакта:', e.message);
  }

  // === 7. ОТВЕЧАЕМ СРАЗУ ===
  res.status(200).json({ received: true, email, purchaseEmail, contactId });

  // === 8. ФОНОВАЯ ПРОВЕРКА ===
  validateAndSetCustom(contactId, email, purchaseEmail);
});

// === HEAD ===
app.head('/validate-email', (req, res) => {
  res.status(200).send('OK');
});

// === ЗАПУСК ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Webhook: https://intercom-validator-production.up.railway.app/validate-email`);
});
