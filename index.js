const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ================= ENV & CONFIG =================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

// Состояние для предотвращения дублей обработки одного чата в рамках одной смены
const processedInCurrentSession = new Set();

function log(...args) {
    console.log('[DEBUG]', new Date().toLocaleString(), ...args);
}

// Универсальный запрос к Intercom
async function intercomRequest(method, url, data) {
    return axios({
        method,
        url: `https://api.intercom.io${url}`,
        data,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 10000
    });
}

// ================= 1. EMAIL CHECK LOGIC =================
async function validateEmail(contactId) {
    if (!contactId || !LIST_URL) return;
    try {
        const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = contactRes.data;

        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean);

        if (!emails.length) return;

        const { data: list } = await axios.get(LIST_URL);
        const match = emails.some(e => 
            list.some(l => (l || '').toLowerCase().trim() === e.toLowerCase().trim())
        );

        if (match) {
            await intercomRequest('put', `/contacts/${contactId}`, {
                custom_attributes: { [CUSTOM_ATTR_NAME]: true }
            });
            log(`💰 Unpaid set to true for contact: ${contactId}`);
        }
    } catch (e) {
        console.error('[EMAIL ERROR]', e.message);
    }
}

// ================= 2. SUBSCRIPTION CHECK LOGIC =================
async function checkSubscription(conversationId, contact) {
    const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
    if (!sub || sub.toString().trim() === '') {
        await intercomRequest('post', `/conversations/${conversationId}/reply`, {
            message_type: 'note',
            admin_id: ADMIN_ID,
            body: 'Please fill subscription 😇'
        });
        log(`📝 Subscription note sent to conversation: ${conversationId}`);
    }
}

// ================= 3. PRESALE LOGIC (Next Day + 1 min Snooze) =================
async function processPresale() {
    log('🚀 Start Presale Check (Agent returned from Away Mode)');
    try {
        // Ищем чаты команды Presale в статусе snoozed
        const res = await intercomRequest('post', '/conversations/search', {
            query: {
                operator: 'AND',
                value: [
                    { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                    { field: 'state', operator: '=', value: 'snoozed' }
                ]
            }
        });

        const conversations = res.data.conversations || [];
        const today = new Date().toDateString();

        for (const conv of conversations) {
            // Чтобы не спамить в один и тот же чат, если агент часто дергает Away Mode
            if (processedInCurrentSession.has(conv.id)) continue;

            const fullConv = await intercomRequest('get', `/conversations/${conv.id}`);
            const data = fullConv.data;

            // Проверка: Не стоит ли Follow-Up
            if (data.custom_attributes?.[FOLLOW_UP_ATTR] === true) continue;

            // Проверка: "На следующий день" (updated_at меньше начала сегодняшнего дня)
            const lastUpdate = new Date(data.updated_at * 1000);
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);

            if (lastUpdate < startOfToday) {
                // Вместо OPEN делаем SNOOZE на 1 минуту от текущего момента
                const snoozeUntil = Math.floor((Date.now() / 1000) + 60);

                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'snoozed',
                    admin_id: ADMIN_ID,
                    snoozed_until: snoozeUntil
                });

                // Отправляем ноут
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedInCurrentSession.add(conv.id);
                log(`✅ Chat ${conv.id} resnoozed for 1 min + note added.`);
            }
        }
    } catch (e) {
        console.error('[PRESALE ERROR]', e.message);
    }
}

// ================= WEBHOOK HANDLER =================
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) return res.sendStatus(200);

    try {
        // --- Триггер на выход из Away Mode ---
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            await processPresale();
        }

        // --- Логика для работы с контактами в чате ---
        const conversationId = item.id;
        const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

        if (contactId && topic.startsWith('conversation')) {
            // 1. Проверка Email
            await validateEmail(contactId);

            // 2. Проверка Subscription
            const contactFull = await intercomRequest('get', `/contacts/${contactId}`);
            await checkSubscription(conversationId, contactFull.data);
        }

        res.sendStatus(200);
    } catch (e) {
        log('⚠️ Webhook process error:', e.message);
        res.sendStatus(200);
    }
});

// Сброс кэша обработанных чатов раз в сутки (в полночь)
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        processedInCurrentSession.clear();
    }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Engine running on port ${PORT}`);
});
