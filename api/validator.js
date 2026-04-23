const axios = require('axios');

// === ENV & CONSTANTS ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';

const lastProcessedDate = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

// Универсальный запрос с увеличенным таймаутом
async function intercomRequest(method, url, data, customTimeout = 25000) {
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

// ================= LOGIC: PRESALE ENGINE (V3 - TARGETED + CURSOR) =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('PRESALE', `Admin ${adminId} already processed today.`);
        return;
    }

    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    log('PRESALE', `Starting targeted scan for Team ${PRESALE_TEAM_ID}`);

    let startingAfter = null;

    try {
        do {
            // Формируем тело запроса как в старом коде
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 20 } // Маленький размер страницы для скорости
            };

            if (startingAfter) {
                searchBody.pagination.starting_after = startingAfter;
            }

            log('DEBUG', `Fetching page... Cursor: ${startingAfter || 'START'}`);
            
            const searchRes = await intercomRequest('post', '/conversations/search', searchBody);
            const chats = searchRes.data.conversations || [];

            log('PRESALE', `Found ${chats.length} chats on this page.`);

            for (const conv of chats) {
                try {
                    // Проверяем Follow-Up (через детальный запрос, так надежнее)
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;

                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] !== true) {
                        const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                        
                        // Снуз на 1 минуту
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'snoozed', 
                            admin_id: ADMIN_ID, 
                            snoozed_until: inOneMinute
                        });

                        // Внутренняя заметка
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'note', 
                            admin_id: ADMIN_ID, 
                            body: PRESALE_NOTE_TEXT
                        });
                        log('ACTION', `Chat ${conv.id} woken up.`);
                    }
                    await sleep(400); // Плавная работа, чтобы не забанили
                } catch (err) {
                    log('CHAT_ERR', `Skip ${conv.id}: ${err.message}`);
                }
            }

            // Обновляем курсор для следующей страницы
            startingAfter = searchRes.data.pages?.next?.starting_after;

        } while (startingAfter);

        lastProcessedDate.set(adminId, todayStr);
        log('PRESALE', 'Success: All pages processed.');

    } catch (e) {
        log('SEARCH_FATAL', `Search failed: ${e.message}`);
        // Если даже целевой запрос падает, возможно проблема в таймауте самого Vercel (10с на бесплатном тарифе)
    }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    if (!body?.data?.item) return res.status(200).json({ ok: true });

    // Моментальный ответ для Intercom
    res.status(200).json({ ok: true });

    const topic = body.topic;
    const data = body.data;

    try {
        if (topic === 'admin.away_mode_updated' && data.item.away_mode_enabled === false) {
            log('WEBHOOK', `Admin ${data.item.id} BACK online.`);
            // Запуск процесса без await, чтобы не тормозить вебхук
            processPresale(data.item.id).catch(e => log('ASYNC_ERR', e.message));
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
