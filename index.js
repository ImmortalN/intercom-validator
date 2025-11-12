const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// ПЕРЕМЕННЫЕ ИЗ ENV (безопасно)
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Custom';

// Проверка, что токены есть
if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ERROR: INTERCOM_TOKEN or LIST_URL not set in environment variables!');
  process.exit(1);
}

// Эндпоинт для Intercom webhook
app.post('/validate-email', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    console.log('No email received');
    return res.status(400).json({ error: 'No email provided' });
  }

  console.log(`Processing email: ${email}`);

  try {
    // 1. Загружаем список emails
    const { data: emailList } = await axios.get(LIST_URL);
    if (!Array.isArray(emailList)) {
      throw new Error('Invalid email list format');
    }

    // 2. Сравниваем
    const isMatch = emailList.some(e => 
      typeof e === 'string' && e.trim().toLowerCase() === email.trim().toLowerCase()
    );
    console.log(`Match found: ${isMatch}`);

    // 3. Обновляем Intercom
    if (isMatch) {
      const payload = {
        email: email,
        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
      };

      try {
        // PUT — обновить существующий контакт
        await axios.put('https://api.intercom.io/contacts', payload, {
          headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });
        console.log('Contact updated via PUT');
      } catch (err) {
        if (err.response?.status === 404) {
          // POST — создать новый
          await axios.post('https://api.intercom.io/contacts', payload, {
            headers: {
              'Authorization': `Bearer ${INTERCOM_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          console.log('Contact created via POST');
        } else {
          console.error('Intercom API error:', err.response?.data || err.message);
          throw err;
        }
      }
    }

    res.json({ match: isMatch, processed: true });

  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ЗАПУСК — ТОЛЬКО НА process.env.PORT!
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
