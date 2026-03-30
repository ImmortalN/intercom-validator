const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function log(...args) {
    if (DEBUG) console.log(`[LOG]`, ...args);
}

// === ПРОВЕРКА ПЕРЕМЕННЫХ ПРИ СТАРТЕ СЕРВЕРА (а не сразу) ===
function checkEnv() {
    if (!INTERCOM_TOKEN) {
        console.error('❌ ОШИБКА: INTERCOM_TOKEN не задан!');
        process.exit(1);
    }
    if (!WORKER_URL) {
        console.error('❌ ОШИБКА: WORKER_URL не задан!');
        process.exit(1);
    }
    console.log('✅ Переменные окружения загружены успешно');
}

checkEnv(); // проверяем только когда запускается сервер

// =============================================

async function getVerificationFromWorker(email) {
    if (!email) return { exists: false, valid: false };

    try {
        log(`Отправляю запрос воркеру для: ${email}`);
        const url = WORKER_URL.includes('?') 
            ? `${WORKER_URL}${encodeURIComponent(email)}` 
            : `${WORKER_URL}?email=${encodeURIComponent(email)}`;

        const res = await axios.get(url, { timeout: 10000 });
        return {
            exists: res.data.exists === true,
            valid: res.data.valid === true
        };
    } catch (e) {
        log(`Ошибка воркера (${email}):`, e.message);
        return { exists: false, valid: false };
    }
}

async function verifyContact(contactId) {
    if (!contactId) return;

    try {
        log(`--- Начинаю проверку контакта ${contactId} ---`);

        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        const contact = contactRes.data;
        const attrs = contact.custom_attributes || {};

        log(`Все кастомные атрибуты:`, JSON.stringify(attrs));

        // Защита от повторной проверки
        if (attrs['User exists'] !== null && attrs['User exists'] !== undefined) {
            log(`Контакт уже проверен (User exists = ${attrs['User exists']}). Пропускаю.`);
            return;
        }

        const defaultEmail = contact.email;
        const purchaseEmail = attrs['Purchase Email'] ||
                             attrs['Purchase email'] ||
                             attrs['purchase_email'] ||
                             attrs['purchase email'];

        log(`Найденные имейлы: Default=${defaultEmail || 'нет'}, Purchase=${purchaseEmail || 'нет'}`);

        let finalResult = { exists: false, valid: false };

        // Проверка 1 — Default Email
        if (defaultEmail) {
            log(`Шаг 1: Проверяю Default Email...`);
            finalResult = await getVerificationFromWorker(defaultEmail);
        }

        // Проверка 2 — Purchase Email (только если по default не нашли)
        if (!finalResult.exists && purchaseEmail) {
            log(`Шаг 2: Default не найден. Проверяю Purchase Email: ${purchaseEmail}`);
            finalResult = await getVerificationFromWorker(purchaseEmail);
        } else if (!purchaseEmail) {
            log(`Шаг 2: Purchase Email не найден в профиле.`);
        }

        // Обновляем атрибуты
        await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: {
                'User exists': finalResult.exists,
                'Has active subscription': finalResult.valid
            }
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        console.log(`✅ Успешно обновлено для контакта ${contactId}`);
    } catch (e) {
        console.error(`❌ Ошибка в verifyContact для ${contactId}:`, e.response?.data || e.message);
    }
}

// ===================== WEBHOOK =====================
app.post('/validate-email', (req, res) => {
    res.status(200).json({ ok: true });   // сразу отвечаем Render/Intercom

    const body = req.body;
    const item = body.data?.item;
    if (!item) return;

    const contactId = item.user?.id ||
                      item.contacts?.contacts?.[0]?.id ||
                      item.author?.id ||
                      (item.type === 'contact' ? item.id : null);

    if (contactId) {
        log(`Webhook получен: ${body.topic} → contact ${contactId}`);
        // запускаем проверку асинхронно
        verifyContact(contactId);
    }
});

app.get('/', (req, res) => res.send('Verifier v5.1 is running ✅'));

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Verifier запущен на порту ${PORT}`);
    console.log(`   Intercom Version: ${INTERCOM_VERSION}`);
    console.log(`   Worker URL: ${WORKER_URL}`);
});
