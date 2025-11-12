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

// === АСИНХРОННАЯ ОБРАБОТКА (в фоне) ===
async function processEmailValidation(email) {
  try {
    console.log(`[ФОН] Обрабатываем: ${email}`);

    // 1. Загружаем список (таймаут 3 сек)
    const { data: emailList } = await axios.get(LIST_URL, { timeout: 3000 });
    if (!Array.isArray(emailList)) throw new Error('Invalid list');

    // 2. Проверяем совпадение
    const isMatch = emailList.some(e =>
      typeof e === 'string' && e.trim().toLowerCase() === email.trim().toLowerCase()
    );
    console.log(`[ФОН] Совпадение: ${isMatch}`);

    // 3. Обновляем Intercom
    if (isMatch) {
      const payload = {
        email: email,
        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
      };

      try {
        await axios.post('https://api.intercom.io/contacts', payload, {
          headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 4000
        });
        console.log('[ФОН] Intercom: обновлено (200)');
      } catch (apiError) {
        if (apiError.response?.status === 409) {
          console.log('[ФОН] Intercom: уже существует (409 OK)');
        } else {
          console.error('[ФОН] Intercom API error:', apiError.message);
        }
      }
    }
  } catch (error) {
    console.error('[ФОН] Критическая ошибка:', error.message);
  }
}

// === HEAD: валидация Intercom ===
app.head('/validate-email', (req, res) => {
  console.log('Intercom: HEAD validation');
  res.status(200).send('OK');
});

// === POST: основной webhook ===
app.post('/validate-email', async (req, res) => {
  let email = '';

  // Извлекаем email
  try {
    if (req.body.data?.email) email = req.body.data.email;
    else if (req.body.data?.attributes?.email) email = req.body.data.attributes.email;
    else if (req.body.email) email = req.body.email;
  } catch (e) {}

  if (!email || !email.includes('@')) {
    console.log('Email не найден:', req.body);
    return res.status(400).json({ error: 'No valid email' });
  }

  console.log(`Webhook получен: ${email}`);

  // ОТВЕЧАЕМ СРАЗУ — тест пройдёт!
  res.status(200).json({ received: true, email });

  // ОБРАБАТЫВАЕМ В ФОНЕ
  processEmailValidation(email).catch(console.error);
});

// === ЗАПУСК ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
});
