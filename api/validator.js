const axios = require('axios');

// === КОНФИГУРАЦИЯ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // ID от чьего имени шлем ноуты
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const LIST_URL = process.env.LIST_URL;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_UNPAID = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const SUBSCRIPTION_ATTR = 'subscription';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';

// Временные хранилища (для Vercel это работает в рамках жизненного цикла инстанса)
const lastProcessedDate = new Map();
const processedSubNotes = new Set(); 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

async function intercomRequest(method, url, data, customTimeout = 20000) {
    return await axios({
        method,
        url: `https://api.intercom.io${url}`,
        data,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: customTimeout
    });
}

// ================= 1. ЛОГИКА "UNPAID & SUBSCRIPTION" =================
async function handleUnpaidAndSubscription(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;
    const assigneeType = item.assignee?.type; // 'admin' или 'team'

    if (!contactId) return;

    try {
        const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = contactRes.data;
        
        // --- Проверка Unpaid (Email Match) ---
        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase Email'];

        if (LIST_URL && (email || purchaseEmail)) {
            try {
                const listRes = await axios.get(LIST_URL);
                const emailsInList = listRes.data.map(e => String(e).toLowerCase());
                const isMatch = (email && emailsInList.includes(email.toLowerCase())) || 
                                (purchaseEmail && emailsInList.includes(purchaseEmail.toLowerCase()));
                
                if (isMatch) {
                    await intercomRequest('put', `/contacts/${contactId}`, {
                        custom_attributes: { [CUSTOM_ATTR_UNPAID]: true }
                    });
                    log('UNPAID', `Contact ${contactId} marked as Unpaid.`);
                }
            } catch (e) { log('LIST_ERR', 'Error fetching external list'); }
        }

        // --- Проверка Subscription (Note for Agent) ---
        const subValue = contact.custom_attributes?.[SUBSCRIPTION_ATTR];
        // Срабатывает, если чат попал к человеку (admin) и поле пустое
        if (assigneeType === 'admin' && (!subValue || subValue === '') && !processedSubNotes.has(conversationId)) {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
            processedSubNotes.add(conversationId);
            log('SUBSCRIPTION', `Note sent to chat ${conversationId}`);
        }
    } catch (err) {
        log('CHECK_ERR', err.message);
    }
}

// ================= 2 & 3. ЛОГИКА PRESALE (TRIGGER & ACTION) =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('SKIP', `Admin ${adminId} already processed today.`);
        return;
    }

    // Unix timestamp начала сегодняшнего дня (число, не строка)
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    let startingAfter = null;

    log('PRESALE', `Starting scan for Admin ${adminId}. Team: ${PRESALE_TEAM_ID}`);

    try {
        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 20 }
            };

            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            // Лог для отладки структуры запроса
            log('DEBUG', 'Search query:', searchBody);

            const searchRes = await intercomRequest('post', '/conversations/search', searchBody);
            const chats = searchRes.data.conversations || [];
            
            log('DEBUG', `Found ${chats.length} chats on this page.`);

            for (const conv of chats) {
                try {
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;

                    // Игнорируем, если Follow-Up = true
                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] === true) continue;

                    const oneMinuteFromNow = Math.floor(Date.now() / 1000) + 60;
                    
                    // 1. Обновляем снуз на +1 минуту (это "разбудит" чат через 60 сек)
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'snoozed', 
                        admin_id: ADMIN_ID, 
                        snoozed_until: oneMinuteFromNow
                    });

                    // 2. Оставляем заметку
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'note', 
                        admin_id: ADMIN_ID, 
                        body: PRESALE_NOTE_TEXT
                    });

                    log('ACTION', `Chat ${conv.id} woken up via snooze update.`);
                    await sleep(300); // Защита от лимитов
                } catch (err) {
                    log('CHAT_ERR', `Conv ${conv.id}: ${err.message}`);
                }
            }
            startingAfter = searchRes.data.pages?.next?.starting_after;
        } while (startingAfter);

        lastProcessedDate.set(adminId, todayStr);
        log('SUCCESS', 'Presale scan finished.');
    } catch (e) {
        log('SEARCH_FATAL', e.response?.data || e.message);
    }
}

// ================= ВЕБХУК ХЕНДЛЕР =================
module.exports = async (req, res) => {
    // Для проверки жизни Vercel
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    if (!body || !body.topic) return res.status(200).json({ ok: true });

    // Моментальный ответ Intercom
    res.status(200).json({ ok: true });

    const topic = body.topic;
    const item = body.data?.item;

    try {
        // 1. Логика сообщений (Unpaid & Subscription)
        if (topic.includes('conversation.user') || topic === 'conversation.admin.replied') {
            handleUnpaidAndSubscription(item).catch(e => log('ASYNC_MSG_ERR', e.message));
        }

        // 2. Логика входа агента (Presale Trigger)
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            log('WEBHOOK', `Admin ${item.id} BACK online.`);
            processPresale(item.id).catch(e => log('ASYNC_PRESALE_ERR', e.message));
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
