const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'User exists'; // можно поменять на 'Unpaid Custom'
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

if (!INTERCOM_TOKEN || !LIST_URL) {
    console.error('❌ ОШИБКА: INTERCOM_TOKEN и LIST_URL обязательны!');
    process.exit(1);
}

function log(...args) {
    if (DEBUG) console.log('[LOG]', ...args);
}

// === ПРОВЕРКА EMAIL В СПИСКЕ ===
async function isEmailInUnpaidList(email) {
    if (!email) return false;
    try {
        const { data: emailList } = await axios.get(LIST_URL, { timeout: 10000 });
        
        if (!Array.isArray(emailList)) {
            log('LIST_URL вернул не массив');
            return false;
        }

        const normalizedEmail = email.trim().toLowerCase();
        return emailList.some(listEmail => 
            (listEmail || '').trim().toLowerCase() === normalizedEmail
        );
    } catch (e) {
        log(`Ошибка при запросе LIST_URL:`, e.message);
        return false;
    }
}

// === ОСНОВНАЯ ПРОВЕРКА КОНТАКТА ===
async function verifyContact(contactId) {
    if (!contactId) return;

    try {
        log(`--- Проверка контакта ${contactId} ---`);

        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        const contact = contactRes.data;
        const attrs = contact.custom_attributes || {};

        // Защита от повторной проверки
        if (attrs[CUSTOM_ATTR_NAME] !== undefined) {
            log(`Контакт уже проверен (${CUSTOM_ATTR_NAME} = ${attrs[CUSTOM_ATTR_NAME]}). Пропускаем.`);
            return;
        }

        // Собираем все возможные email
        const emailsToCheck = [
            contact.email,
            attrs['Purchase Email'],
            attrs['Purchase email'],
            attrs['purchase_email'],
            attrs['purchase email']
        ].filter(Boolean);

        log(`Emails для проверки:`, emailsToCheck);

        let isUnpaid = false;
        for (const email of emailsToCheck) {
            if (await isEmailInUnpaidList(email)) {
                isUnpaid = true;
                log(`Найден в списке неоплаченных: ${email}`);
                break;
            }
        }

        // Обновляем атрибут в Intercom
        await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: {
                [CUSTOM_ATTR_NAME]: isUnpaid
            }
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        console.log(`✅ Контакт ${contactId} обновлён → ${CUSTOM_ATTR_NAME} = ${isUnpaid}`);
    } catch (e) {
        console.error(`❌ Ошибка при проверке контакта ${contactId}:`, e.response?.data || e.message);
    }
}

// ===================== WEBHOOK =====================
app.post('/validate-email', (req, res) => {
    res.status(200).json({ ok: true }); // сразу отвечаем

    const item = req.body.data?.item;
    if (!item) return;

    const contactId = item.user?.id ||
                      item.contacts?.contacts?.[0]?.id ||
                      item.author?.id ||
                      (item.type === 'contact' ? item.id : null);

    if (contactId) {
        log(`Webhook: ${req.body.topic} → contact ${contactId}`);
        verifyContact(contactId); // асинхронно
    }
});

app.get('/', (req, res) => res.send('✅ Unpaid Custom Verifier is running'));

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`   LIST_URL подключён: ${LIST_URL}`);
    console.log(`   Атрибут: ${CUSTOM_ATTR_NAME}`);
});
