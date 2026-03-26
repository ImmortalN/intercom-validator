const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const WORKER_URL = process.env.WORKER_URL; 
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

if (!INTERCOM_TOKEN || !WORKER_URL) {
    console.error('ОШИБКА: Проверьте INTERCOM_TOKEN и WORKER_URL!');
    process.exit(1);
}

function log(...args) {
    if (DEBUG) console.log(`[LOG]`, ...args);
}

async function getVerificationFromWorker(email) {
    if (!email) return { exists: false, valid: false };
    try {
        log(`Отправляю запрос воркеру для: ${email}`);
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

        // 1. ЛОГИРУЕМ ВСЕ АТРИБУТЫ (чтобы найти точное имя Purchase Email)
        log(`Все кастомные атрибуты контакта:`, JSON.stringify(attrs));

        // 2. ЗАЩИТА (Стоп-кран)
        // Если уже стоит true или false — выходим
        if (attrs['User exists'] !== null && attrs['User exists'] !== undefined) {
            log(`Контакт уже проверен (User exists = ${attrs['User exists']}). Пропускаю.`);
            return;
        }

        // 3. ПОИСК ПРАВИЛЬНОГО EMAIL
        const defaultEmail = contact.email;
        // Пробуем разные варианты написания, которые могут быть в Intercom
        const purchaseEmail = attrs['Purchase Email'] || 
                             attrs['Purchase email'] || 
                             attrs['purchase_email'] || 
                             attrs['purchase email'];

        log(`Найденные имейлы: Default=${defaultEmail || 'нет'}, Purchase=${purchaseEmail || 'нет'}`);

        let finalResult = { exists: false, valid: false };

        // 4. ПРОВЕРКА №1: Default Email
        if (defaultEmail) {
            log(`Шаг 1: Проверяю Default Email...`);
            finalResult = await getVerificationFromWorker(defaultEmail);
        }

        // 5. ПРОВЕРКА №2: Purchase Email (если первый не найден)
        if (!finalResult.exists && purchaseEmail) {
            log(`Шаг 2: Default не найден. Проверяю Purchase Email: ${purchaseEmail}`);
            finalResult = await getVerificationFromWorker(purchaseEmail);
        } else if (!purchaseEmail) {
            log(`Шаг 2: Purchase Email не найден в профиле юзера.`);
        }

        // 6. ОБНОВЛЕНИЕ
        log(`Финальный результат для отправки: Exists=${finalResult.exists}, Valid=${finalResult.valid}`);

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

        console.log(`✅ Успешно обновлено для ${contactId}`);

    } catch (e) {
        console.error(`❌ Ошибка в verifyContact:`, e.response?.data || e.message);
    }
}

app.post('/validate-email', (req, res) => {
    res.status(200).json({ ok: true });

    const item = req.body.data?.item;
    if (!item) return;

    const contactId = item.user?.id || 
                      item.contacts?.contacts?.[0]?.id || 
                      item.author?.id || 
                      (item.type === 'contact' ? item.id : null);

    if (contactId) {
        log(`Webhook: ${req.body.topic} для ${contactId}`);
        verifyContact(contactId);
    }
});

app.get('/', (req, res) => res.send('Verifier v5 is running'));

app.listen(process.env.PORT || 3000, () => {
    console.log(`🚀 Сервер на связи`);
});
