const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 2500;

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

function log(...args) {
    if (DEBUG) console.log(...args);
}

// === ЗАЩИТА "ОДИН РАЗ В ДЕНЬ" ===
const lastProcessedDate = new Map(); // adminId → YYYY-MM-DD

function canProcessPresaleToday(adminId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (lastProcessedDate.has(adminId) && lastProcessedDate.get(adminId) === todayStr) {
        log(`[PRESALE SKIP] Уже обрабатывали сегодня для админа ${adminId}`);
        return false;
    }

    lastProcessedDate.set(adminId, todayStr);
    log(`[PRESALE ALLOWED] Первый logged_in / away_mode=false сегодня для ${adminId}`);
    return true;
}

// === УНИВЕРСАЛЬНЫЙ ЗАПРОС К INTERCOM ===
async function intercomRequest(method, endpoint, data = null) {
    try {
        const config = {
            method,
            url: `https://api.intercom.io${endpoint}`,
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION,
            }
        };
        if (data) {
            config.data = data;
            config.headers['Content-Type'] = 'application/json';
        }
        const res = await axios(config);
        return res.data;
    } catch (error) {
        console.error(`[INTERCOM ERROR] ${method} ${endpoint}:`, error.response?.data || error.message);
        throw error;
    }
}

// === PRESALE ЛОГИКА (самое важное) ===
async function processPresaleSnoozedChats(adminId) {
    if (!PRESALE_TEAM_ID || !canProcessPresaleToday(adminId)) return;

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const todayMidnightUnix = Math.floor(todayMidnight.getTime() / 1000);

    log(`[PRESALE] Ищем snoozed чаты presale, snoozed_until < ${todayMidnight.toISOString()}`);

    try {
        let startingAfter = null;
        let processed = 0;

        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: todayMidnightUnix }
                    ]
                },
                pagination: { per_page: 50 }
            };
            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const res = await intercomRequest('post', '/conversations/search', searchBody);
            const conversations = res.conversations || [];

            log(`[PRESALE SEARCH] Найдено ${conversations.length} чатов`);

            for (const conv of conversations) {
                // Проверяем атрибут Follow-Up
                if (conv.custom_attributes?.[FOLLOW_UP_ATTR] === true) {
                    log(`[PRESALE SKIP] ${conv.id} — стоит Follow-Up`);
                    continue;
                }

                log(`[PRESALE PROCESS] Обрабатываем чат ${conv.id}`);

                // 1. Добавляем ноут
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                // 2. Снузим на 1 минуту
                const snoozeUntil = Math.floor(Date.now() / 1000) + 60;
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'snoozed',
                    admin_id: ADMIN_ID,
                    snoozed_until: snoozeUntil
                });

                processed++;
                await new Promise(r => setTimeout(r, 800)); // небольшая задержка
            }

            startingAfter = res.pages?.next?.starting_after;
        } while (startingAfter);

        log(`[PRESALE FINISH] Успешно обработано чатов: ${processed}`);

    } catch (e) {
        console.error('[PRESALE ERROR]', e.message);
    }
}

// === SUBSCRIPTION + UNPAID CUSTOM ===
async function handleSubscriptionAndUnpaid(conversationId, contactId) {
    if (!conversationId || !contactId) return;

    try {
        const contact = await intercomRequest('get', `/contacts/${contactId}`);
        const customAttrs = contact.custom_attributes || {};

        // === SUBSCRIPTION ===
        const subscription = (customAttrs['Subscription'] || customAttrs['subscription'] || '').trim();
        if (!subscription) {
            log(`[SUBSCRIPTION] Пустое поле — добавляем ноут в чат ${conversationId}`);
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });
        }

        // === UNPAID CUSTOM ===
        const emails = [
            contact.email,
            customAttrs['Purchase email']
        ].filter(Boolean);

        if (emails.length > 0 && LIST_URL) {
            const { data: emailList } = await axios.get(LIST_URL, { timeout: 8000 });

            if (Array.isArray(emailList)) {
                const isMatch = emails.some(userEmail =>
                    emailList.some(listEmail =>
                        (listEmail || '').trim().toLowerCase() === userEmail.trim().toLowerCase()
                    )
                );

                if (isMatch && customAttrs[CUSTOM_ATTR_NAME] !== true) {
                    log(`[UNPAID] Совпадение email — ставим ${CUSTOM_ATTR_NAME} = true`);
                    await intercomRequest('put', `/contacts/${contactId}`, {
                        custom_attributes: { [CUSTOM_ATTR_NAME]: true }
                    });
                }
            }
        }
    } catch (e) {
        console.error(`[UNPAID/SUB ERROR] чат ${conversationId}:`, e.message);
    }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    res.status(200).json({ ok: true }); // сразу отвечаем Intercom

    const body = req.body;
    const topic = body?.topic;

    if (!topic) return;

    try {
        // === PRESALE ТРИГГЕР ===
        if (topic === 'admin.away_mode_updated') {
            const item = body.data?.item || {};
            const awayModeEnabled = item.away_mode_enabled;

            if (awayModeEnabled === false) {
                const adminId = item.admin?.id || item.id;
                log(`[TRIGGER] Агент ${adminId} вышел из Away Mode → запускаем presale проверку`);
                await processPresaleSnoozedChats(adminId);
            }
            return;
        }

        // === SUBSCRIPTION + UNPAID (когда чат попадает живому агенту) ===
        if (topic === 'conversation.admin.assigned' || 
            topic === 'conversation.user.replied' ||
            topic === 'conversation.admin.replied') {

            const conv = body.data?.item || {};
            const conversationId = conv.id;

            let contactId = conv.user?.id || 
                           conv.contacts?.contacts?.[0]?.id ||
                           conv.author?.id;

            // Дополнительно проверяем, что assignee — не бот
            const assignee = conv.assignee || {};
            const isLiveAgent = assignee.type === 'admin' && !assignee.id?.startsWith('bot_');

            if (conversationId && contactId && isLiveAgent) {
                log(`[LIVE AGENT] Чат ${conversationId} попал живому агенту → проверяем subscription/unpaid`);
                await handleSubscriptionAndUnpaid(conversationId, contactId);
            }
        }

    } catch (error) {
        console.error('[WEBHOOK ERROR]', error.message);
    }
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Webhook сервер запущен на порту ${PORT}`);
    console.log(`   Presale ноут только при первом away_mode=false за день`);
    console.log(`   Subscription ноут только живому агенту`);
});

module.exports = app;
