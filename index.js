const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom'; // ← ТВОЁ ИМЯ

if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ОШИБКА: INTERCOM_TOKEN или LIST_URL не заданы!');
  process.exit(1);
}

// === ФОНОВАЯ ПРОВЕРКА ===
async function validateAndSetCustom(email) {
  if (!email || !email.includes('@')) return;

  try {
    console.log(`[ФОН] Проверка: ${email}`);
    const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
    if (!Array.isArray(emailList)) return;

    const isMatch = emailList.some(e =>
      typeof e === 'string' && e.trim().toLowerCase() === email.trim().toLowerCase()
    );

    if (isMatch) {
      const payload = { email, custom_attributes: { [CUSTOM_ATTR_NAME]: true } };
      try {
        await axios.post('https://api.intercom.io/contacts', payload, {
          headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 4000
        });
        console.log(`[ФОН] ${CUSTOM_ATTR_NAME} = true для ${email}`);
      } catch (e) {
        if (e.response?.status === 409) {
          console.log(`[ФОН] 409 OK — уже установлено`);
        }
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

  // === 2. ТОЛЬКО conversation.user.replied ===
  if (req.body.topic !== 'conversation.user.replied') {
    console.log(`Пропущен topic: ${req.body.topic}`);
    return res.status(200).json({ skipped: true, reason: 'wrong_topic' });
  }

  // === 3. ИЗВЛЕЧЕНИЕ КОНТАКТА ===
  const contact = req.body.data?.item?.contacts?.contacts?.[0];
  if (!contact) {
    console.log('Контакт не найден');
    return res.status(400).json({ error: 'No contact' });
  }

  // === 4. ПОЛУЧАЕМ ОБА EMAIL ===
  const email = contact.email;
  const purchaseEmail = contact.custom_attributes?.['Purchase email']; // ← ТОЧНОЕ ИМЯ!

  const emailsToCheck = [email, purchaseEmail].filter(e => e && e.includes('@'));
  if (emailsToCheck.length === 0) {
    console.log('Нет email');
    return res.status(400).json({ error: 'No email' });
  }

  console.log(`Обрабатываем: ${emailsToCheck.join(', ')}`);

  // === 5. ОТВЕЧАЕМ СРАЗУ ===
  res.status(200).json({ received: true, emails: emailsToCheck });

  // === 6. ФОНОВАЯ ПРОВЕРКА ===
  emailsToCheck.forEach(email => validateAndSetCustom(email));
});

// === HEAD ===
app.head('/validate-email', (req, res) => {
  res.status(200).send('OK');
});

// === ЗАПУСК ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
  console.log(`Webhook: https://intercom-validator-production.up.railway.app/validate-email`);
});
