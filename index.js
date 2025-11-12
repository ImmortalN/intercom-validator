const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// ПЕРЕМЕННЫЕ ИЗ ENV
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Custom';

if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('ERROR: INTERCOM_TOKEN or LIST_URL not set!');
  process.exit(1);
}

// ВЕБХУК ОТ INTERCOM
app.post('/validate-email', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'No email provided' });
  }

  console.log(`Processing: ${email}`);

  try {
    // 1. Загружаем список
    const { data: emailList } = await axios.get(LIST_URL);
    if (!Array.isArray(emailList)) throw new Error('Invalid list');

    // 2. Сравниваем
    const isMatch = emailList.some(e =>
      typeof e === 'string' && e.trim().toLowerCase() === email.trim().toLowerCase()
    );
    console.log(`Match: ${isMatch}`);

    // 3. ЕСЛИ СОВПАДЕНИЕ — ОТПРАВЛЯЕМ POST /contacts
    if (isMatch) {
      const payload = {
        email: email,
        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
      };

      // ТОЛЬКО POST — Intercom сам разберётся
      await axios.post('https://api.intercom.io/contacts', payload, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
      console.log('Intercom: contact updated/created');
    }

    res.json({ match: isMatch, processed: true });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ЗАПУСК НА process.env.PORT
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
