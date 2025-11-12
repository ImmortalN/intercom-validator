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

// === АСИНХРОННАЯ ОБРАБОТКА ===
async function processEmailValidation(email) {
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
        console.log('[ФОН] Intercom: обновлено');
      } catch (e) {
        if (e.response?.status === 409) {
          console.log('[ФОН] 409 OK');
        }
      }
    }
  } catch (e) {
    console.error('[ФОН] Ошибка:', e.message);
  }
}

app.post('/validate-email', async (req, res) => {
  console.log('Webhook получен:', JSON.stringify(req.body, null, 2));

  // === ТЕСТ PING ===
  if (req.body.type === "notification_event" && req.body.data?.item?.type === "ping") {
    console.log('Intercom Test: PING');
    return res.status(200).json({ message: "Webhook test received" });
  }

  // === ИЗВЛЕЧЕНИЕ EMAIL (УНИВЕРСАЛЬНОЕ) ===
  let email = '';
  if (req.body.data?.item?.email) {
    email = req.body.data.item.email;
  } else if (req.body.data?.email) {
    email = req.body.data.email;
  } else if (req.body.email) {
    email = req.body.email;
  }

  if (!email || !email.includes('@')) {
    console.log('Email НЕ найден в payload');
    return res.status(400).json({ error: 'No valid email' });
  }

  console.log(`Найден email: ${email}`);

  // ОТВЕЧАЕМ СРАЗУ
  res.status(200).json({ received: true, email });

  // ОБРАБАТЫВАЕМ В ФОНЕ
  processEmailValidation(email).catch(console.error);
});

// === HEAD: валидация ===
app.head('/validate-email', (req, res) => {
  console.log('Intercom: HEAD validation');
  res.status(200).send('OK');
});

// === ЗАПУСК ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
  console.log(`Webhook: https://intercom-validator-production.up.railway.app/validate-email`);
});
