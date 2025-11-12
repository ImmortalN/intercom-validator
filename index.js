const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ЧИТАЕМ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ (НЕТ В КОДЕ!)
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';

if (!INTERCOM_TOKEN || !LIST_URL) {
  console.error('Missing INTERCOM_TOKEN or LIST_URL in environment variables!');
  process.exit(1);
}

app.post('/validate-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'No email' });

  try {
    const { data: emailList } = await axios.get(LIST_URL);
    const isMatch = emailList.some(e => e.toLowerCase().trim() === email.toLowerCase().trim());

    if (isMatch) {
      const payload = { email, custom_attributes: { [CUSTOM_ATTR_NAME]: true } };
      await axios.post('https://api.intercom.io/contacts', payload, {
        headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json' }
      });
    }

    res.json({ match: isMatch });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
