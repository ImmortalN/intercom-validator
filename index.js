if (isMatch) {
  const payload = {
    email: email,
    custom_attributes: { [CUSTOM_ATTR_NAME]: true }
  };

  try {
    // Используем PUT для обновления существующего контакта
    await axios.put('https://api.intercom.io/contacts', payload, {
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    console.log('Contact updated successfully');
  } catch (err) {
    if (err.response?.status === 404) {
      // Если контакт не найден — создаём через POST
      await axios.post('https://api.intercom.io/contacts', payload, {
        headers: {
          'Authorization': `Bearer ${INTERCOM_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Contact created');
    } else {
      throw err; // Другие ошибки
    }
  }
}
