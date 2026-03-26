const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const WORKER_URL = process.env.WORKER_URL; 
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

if (!INTERCOM_TOKEN || !WORKER_URL) {
    console.error('ОШИБКА: Проверьте переменные INTERCOM_TOKEN и WORKER_URL!');
    process.exit(1);
}

function log(...args) {
    if (DEBUG) console.log(`[LOG]`, ...args);
}

// === ФУНКЦИЯ ЗАПРОСА К ВОРКЕРУ ===
async function getVerificationFromWorker(email) {
    if (!email) return { exists: false, valid: false };
    try {
        log(`Запрос к воркеру: ${email}`);
        const url = WORKER_URL.includes('?') ? `${WORKER_URL}${encodeURIComponent(email)}` : `${WORKER_URL}?email=${encodeURIComponent(email)}`;
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

// === ЛОГИКА ПРОВЕРКИ ===
async function verifyContact(contactId) {
    if (!contactId) return;

    try {
        log(`--- Начинаем процесс для контакта ${contactId} ---`);

        // 1. Получаем текущие данные из Intercom
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        const contact = contactRes.data;
        const attrs = contact.custom_attributes || {};

        // СТОП-КРАН: Если проверка уже когда-то была выполнена полностью
        if (attrs['User exists'] !== null && attrs['User exists'] !== undefined) {
            log(`Контакт ${contactId} уже имеет статус "${attrs['User exists']}". Новая проверка не требуется.`);
            return;
        }

        const defaultEmail = contact.email;
        const purchaseEmail = attrs['Purchase Email'] || attrs['purchase_email'];

        log(`Данные для проверки: Default=${defaultEmail}, Purchase=${purchaseEmail}`);

        let finalResult = { exists: false, valid: false };

        // 2. ПРОВЕРКА №1: Дефолтный Email
        if (defaultEmail) {
            finalResult = await getVerificationFromWorker(defaultEmail);
        }

        // 3. ПРОВЕРКА №2: Если первого нет в базе, проверяем Purchase Email
        if (!finalResult.exists && purchaseEmail) {
            log(`Дефолтный email не найден в базе. Проверяем Purchase Email...`);
            finalResult = await getVerificationFromWorker(purchaseEmail);
        }

        // 4. ЕДИНСТВЕННОЕ ОБНОВЛЕНИЕ: Отправляем финальный результат
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

        console.log(`✅ Контакт ${contactId} обновлен. Итог: Exists=${finalResult.exists}, Sub=${finalResult.valid}`);

    } catch (e) {
        console.error(`❌ Ошибка обработки:`, e.response?.data || e.message);
    }
}

// === ЭНДПОИНТ ===
app.post('/validate-email', (req, res) => {
    res.status(200).json({ ok: true });

    const item = req.body.data?.item;
    if (!item) return;

    const contactId = item.user?.id || 
                      item.contacts?.contacts?.[0]?.id || 
                      item.author?.id || 
                      (item.type === 'contact' ? item.id : null) ||
                      item.contacts?.[0]?.id;

    if (contactId) {
        log(`Получен вебхук для ${contactId}`);
        verifyContact(contactId);
    }
});

app.get('/', (req, res) => res.send('Verifier v4: Active'));

app.listen(process.env.PORT || 3000, () => {
    console.log(`🚀 Сервер запущен. Путь: /validate-email`);
});
