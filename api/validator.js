const axios = require('axios');

// === ENV & CONSTANTS ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';
const SUB_REMINDER_TEXT = 'Please fill subscription 😇';

const lastProcessedDate = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

// Универсальный запрос с экспоненциальным backoff
async function intercomRequest(method, url, data, customTimeout = 10000, retryCount = 0) {
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
        // Если ошибка 429 (лимиты) и мы не превысили 3 попытки
        if (error.response?.status === 429 && retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
            log('RATE_LIMIT', `Hit limits. Retrying in ${delay}ms... (Attempt ${retryCount + 1})`);
            await sleep(delay);
            return intercomRequest(method, url, data, customTimeout, retryCount + 1);
        }
        throw error;
    }
}

// ================= LOGIC: PRESALE ENGINE (OPTIMIZED) =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('PRESALE', `Admin ${adminId} already processed today.`);
        return;
    }

    log('PRESALE', `Starting scan for Admin ${adminId}`);
    
    let pagination = { per_page: 50 };
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    try {
        while (pagination) {
            // УПРОЩЕННЫЙ ЗАПРОС: только по статусу snoozed
            const searchRes = await intercomRequest('post', '/conversations/search', {
                query: {
                    field: 'state',
                    operator: '=',
                    value: 'snoozed'
                },
                pagination: pagination
            });

            const allSnoozed = searchRes.data.conversations || [];
            
            // ФИЛЬТРАЦИЯ В КОДЕ: отбираем только Presale команду
            const presaleChats = allSnoozed.filter(conv => 
                conv.team_assignee_id === PRESALE_TEAM_ID
            );

            log('PRESALE', `Found ${presaleChats.length} presale chats on this page (total snoozed: ${allSnoozed.length})`);

            for (const conv of presaleChats) {
                try {
                    await sleep(300); // Небольшая пауза между действиями
                    
                    // Получаем полные данные чата, чтобы проверить кастомные атрибуты
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;
                    
                    // Условие: Не Follow-Up и обновлен вчера или раньше
                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] !== true && chat.updated_at < startOfTodayUnix) {
                        const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                        
                        // 1. Продлеваем снуз на 1 минуту (чтобы он сам вылетел)
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'snoozed', 
                            admin_id: ADMIN_ID, 
                            snoozed_until: inOneMinute
                        });

                        // 2. Добавляем внутреннюю заметку
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'note', 
                            admin_id: ADMIN_ID, 
                            body: PRESALE_NOTE_TEXT
                        });
                        log('ACTION', `Updated snooze & added note for chat ${conv.id}`);
                    }
                } catch (err) {
                    log('CHAT_ERR', `Failed to process chat ${conv.id}: ${err.message}`);
                }
            }

            // Переход на следующую страницу
            if (searchRes.data.pages?.next) {
                pagination = { 
                    per_page: 50, 
                    starting_after: searchRes.data.pages.next.starting_after 
                };
            } else {
                pagination = null;
            }
        }
        
        lastProcessedDate.set(adminId, todayStr);
        log('PRESALE', 'Finished processing all pages.');
        
    } catch (e) { 
        log('SEARCH_FATAL', `Search failed: ${e.message}`); 
    }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    // HEAD запрос для проверки жизни сервера
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    if (!body?.data?.item) return res.status(200).json({ ok: true });

    // Сразу отвечаем Intercom (в рамках 500мс), чтобы он не считал вебхук упавшим
    res.status(200).json({ ok: true });

    const topic = body.topic;
    const data = body.data;

    try {
        // Событие: агент вышел из Away режима
        if (topic === 'admin.away_mode_updated' && data.item.away_mode_enabled === false) {
            log('WEBHOOK', `Admin ${data.item.id} is BACK. Triggering scan...`);
            processPresale(data.item.id).catch(e => log('ASYNC_PRESALE_ERR', e.message));
        }

        // Логика проверки данных (Unpaid / Subscription) при назначении чата
        if (topic === 'conversation.admin.assigned') {
            const contactId = data.item.contacts?.contacts?.[0]?.id;
            const conversationId = data.item.id;
            if (contactId && conversationId) {
                // Вызываем функцию проверки (её можно оставить из прошлого кода)
                // checkClientData(conversationId, contactId).catch(...);
            }
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
