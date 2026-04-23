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

// Универсальный запрос
async function intercomRequest(method, url, data, customTimeout = 15000, retryCount = 0) {
    try {
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
    } catch (error) {
        if (error.response?.status === 429 && retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 2000;
            log('RATE_LIMIT', `Retrying in ${delay}ms...`);
            await sleep(delay);
            return intercomRequest(method, url, data, customTimeout, retryCount + 1);
        }
        throw error;
    }
}

// ================= LOGIC: PRESALE ENGINE (TARGETED SEARCH) =================
async function processPresale(adminId) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('PRESALE', `Admin ${adminId} already processed today.`);
        return;
    }

    // Полночь сегодняшнего дня в Unix (UTC)
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    log('PRESALE', `Starting targeted scan for Presale Team. Filters: Snoozed & Until < ${startOfTodayUnix}`);
    
    let pagination = { per_page: 30 }; 

    try {
        while (pagination) {
            // ВОЗВРАЩАЕМ СЛОЖНЫЙ ФИЛЬТР (AND)
            // Это заставляет Intercom искать только в маленькой кучке ваших чатов
            const searchRes = await intercomRequest('post', '/conversations/search', {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: startOfTodayUnix }
                    ]
                },
                pagination: pagination
            }, 20000); // 20 сек таймаут

            const chats = searchRes.data.conversations || [];
            log('PRESALE', `Found ${chats.length} matching chats on this page.`);

            for (const conv of chats) {
                try {
                    // Важный нюанс: Search API не всегда отдает кастомные атрибуты сразу.
                    // Проверяем Follow-Up через детальный запрос чата.
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;

                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] !== true) {
                        const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                        
                        // 1. Продлеваем снуз на 1 минуту
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'snoozed', 
                            admin_id: ADMIN_ID, 
                            snoozed_until: inOneMinute
                        });

                        // 2. Добавляем заметку
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'note', 
                            admin_id: ADMIN_ID, 
                            body: PRESALE_NOTE_TEXT
                        });
                        log('ACTION', `Chat ${conv.id} processed.`);
                    }
                    await sleep(300); // Защита от лимитов
                } catch (err) {
                    log('CHAT_ERR', `Skip ${conv.id}: ${err.message}`);
                }
            }

            if (searchRes.data.pages?.next) {
                pagination = { 
                    per_page: 30, 
                    starting_after: searchRes.data.pages.next.starting_after 
                };
            } else {
                pagination = null;
            }
        }
        
        lastProcessedDate.set(adminId, todayStr);
        log('PRESALE', 'Scan complete.');
        
    } catch (e) { 
        log('SEARCH_FATAL', `Search failed: ${e.message}`); 
    }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    if (!body?.data?.item) return res.status(200).json({ ok: true });

    res.status(200).json({ ok: true });

    const topic = body.topic;
    const data = body.data;

    try {
        if (topic === 'admin.away_mode_updated' && data.item.away_mode_enabled === false) {
            log('WEBHOOK', `Admin ${data.item.id} is BACK. Triggering targeted scan...`);
            processPresale(data.item.id).catch(e => log('ASYNC_ERR', e.message));
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
