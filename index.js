const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === НАСТРОЙКИ (из переменных окружения) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Custom';

// Проверка, что токены заданы
if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ОШИБКА: INTERCOM_TOKEN или LIST_URL не заданы в переменных окружения!');
  process.exit(1);
}

// === HEAD-handler для валидации Intercom (тест при сохранении webhook) ===
app.head('/validate-email', (req, res) => {
  console.log('Intercom validation: HEAD request received');
  res.status(200).send('OK');
});

// === POST-handler: основной webhook от Intercom ===
app.post('/validate-email', async (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));

  // Извлекаем email из payload Intercom
  let email = '';
  try {
    if (req.body.data && req.body.data.email) {
      email = req.body.data.email;
    } else if (req.body.data && req.body.data.attributes && req.body.data.attributes.email) {
      email = req.body.data.attributes.email;
    } else if (req.body.email) {
      email = req.body.email; // для тестов в Postman
    }
  } catch (e) {
    console.error('Ошибка парсинга email:', e.message);
  }

  if (!email || !email.includes('@')) {
    console.log('Email не найден или некорректный:', email);
    return res.status(400).json({ error: 'No valid email in payload' });
  }

  console.log(`Обрабатываем email: ${email}`);

  try {
    // 1. Загружаем список emails
    const { data: emailList } = await axios.get(LIST_URL);
    if (!Array.isArray(emailList)) {
      throw new Error('Список emails не является массивом');
    }

    // 2. Проверяем совпадение
    const isMatch = emailList.some(e =>
      typeof e === 'string' && e.trim().toLowerCase() === email.trim().toLowerCase()
    );
    console.log(`Совпадение в списке: ${isMatch}`);

    // 3. Если совпадение — обновляем Intercom
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
          }
        });
        console.log('Intercom: контакт обновлён/создан (200)');
      } catch (apiError) {
        if (apiError.response?.status === 409) {
          console.log('Intercom: контакт уже существует — атрибут обновлён (409 OK)');
        } else {
          console.error('Ошибка Intercom API:', apiError.response?.data || apiError.message);
          throw apiError;
        }
      }
    }

    // Отвечаем Intercom — 200 OK
    res.status(200).json({ match: isMatch, processed: true, email });

  } catch (error) {
    console.error('Критическая ошибка:', error.message);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Универсальный handler для GET/HEAD (для тестов Intercom)
app.use('/validate-email', (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    console.log(`Test request: ${req.method}`);
    res.status(200).json({ status: 'OK', ready: true });
  }
});

// === ЗАПУСК СЕРВЕРА ===
app.listen(process.env.PORT, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT}`);
  console.log(`Webhook URL: https://intercom-validator-production.up.railway.app/validate-email`);
});
