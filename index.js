const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Custom';

if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ОШИБКА: INTERCOM_TOKEN или LIST_URL не заданы!');
  process.exit(1);
}

// === ФОНОВАЯ ПРОВЕРКА ===
async function processEmailValidation(email) {
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
        console.log('[ФОН] Intercom: Custom = true (200)');
      } catch (e) {
        if (e.response?.status === 409) {
          console.log('[ФОН] 409 OK — уже установлено');
        }
      }
    }
  } catch (e) {
    console.error('[ФОН] Ошибка:', e.message);
  }
}

// === POST: Webhook от Intercom ===
app.post('/validate-email', async (req, res) => {
  console.log('Webhook получен:', JSON.stringify(req.body, null, 2));

  // === 1. PING ТЕСТ ===
  if (req.body.type === "notification_event" && req.body.data?.item?.type === "ping") {
    console.log('Intercom Test: PING');
    return res.status(200).json({ message: "Webhook test received" });
  }

  // === 2. ИЗВЛЕЧЕНИЕ КОНТАКТА ИЗ CONVERSATION ===
  const conversation = req.body.data?.item;
  const contact = conversation?.contacts?.contacts?.[0];

  if (!contact) {
    console.log('Контакт не найден в conversation');
    return res.status(400).json({ error: 'No contact in conversation' });
  }

  const email = contact.email;
  const purchaseEmail = contact.custom_attributes?.purchase_email;
  const role = contact.role;

  // === 3. ФИЛЬТР: ТОЛЬКО РЕАЛЬНЫЕ КЛИЕНТЫ ===
  if (!email && !purchaseEmail) {
    console.log('Ни один email не найден');
    return res.status(400).json({ error: 'No email or purchase_email' });
  }

  if (email?.includes('operator+') || email?.includes('@intercom.io')) {
    console.log(`Бот пропущен: ${email}`);
    return res.status(200).json({ skipped: true, reason: 'bot' });
  }

  if (!['lead', 'user'].includes(role)) {
    console.log(`Роль не подходит: ${role}`);
    return res.status(200).json({ skipped: true, reason: 'role' });
  }

  // === 4. ПРОВЕРЯЕМ ОБА ПОЛЯ ===
  const emailsToCheck = [email, purchaseEmail].filter(Boolean);
  console.log(`Проверяем email(s): ${emailsToCheck.join(', ')}`);

  // === 5. ОТВЕЧАЕМ СРАЗУ ===
  res.status(200).json({ received: true, emails: emailsToCheck, role });

  // === 6. ФОНОВАЯ ПРОВЕРКА ===
  emailsToCheck.forEach(email => processEmailValidation(email));
});

// === HEAD: валидация ===
app.head('/validate-email', (req, res) => {
  res.status(200).send('OK');
});

// === ЗАПУСК ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
  console.log(`Webhook: https://intercom-validator-production.up.railway.app/validate-email`);
});
