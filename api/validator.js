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

const lastProcessedDate = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

// Универсальный запрос с экспоненциальным backoff и кастомным таймаутом
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
        // Если таймаут (ECONNABORTED) или 429 (лимиты)
        const isTimeout = error.code === 'ECONNABORTED';
        const isRateLimit = error.response?.status === 429;

        if ((isTimeout || isRateLimit) && retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 2000; // 2s, 4s, 8s
            log('RETRY', `Reason: ${isTimeout ? 'Timeout' : 'Rate Limit'}. Retrying in ${delay}ms...`);
            await sleep(delay);
            // При таймауте увеличиваем время ожидания в следующей попытке
            return intercomRequest(method, url, data, customTimeout + 10000, retryCount + 1);
        }
        throw error;
    }
}

// ================= LOGIC: PRESALE ENGINE (FIXED TIMEOUT) =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('PRESALE', `Admin ${adminId} already processed today.`);
        return;
    }

    log('PRESALE', `Starting scan for Admin ${adminId}`);
    
    // УМЕНЬШАЕМ per_page для стабильности
    let pagination = { per_page: 20 }; 
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    try {
        while (pagination) {
            log('DEBUG', `Fetching page with starting_after: ${pagination.starting_after || 'START'}`);
            
            // Используем увеличенный таймаут для поиска (30 секунд)
            const searchRes = await intercomRequest('post', '/conversations/search', {
                query: {
                    field: 'state',
                    operator: '=',
                    value: 'snoozed'
                },
                pagination: pagination
            }, 30000); 

            const allSnoozed = searchRes.data.conversations || [];
            
            const presaleChats = allSnoozed.filter(conv => 
                conv.team_assignee_id === PRESALE_TEAM_ID
            );

            log('PRESALE', `Found ${presaleChats.length} presale chats on page (Total snoozed in batch: ${allSnoozed.length})`);

            for (const conv of presaleChats) {
                try {
                    await sleep(500); // Чуть увеличил паузу, чтобы не спамить API
                    
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;
                    
                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] !== true && chat.updated_at < startOfTodayUnix) {
                        const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                        
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'snoozed', 
                            admin_id: ADMIN_ID, 
                            snoozed_until: inOneMinute
                        });

                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'note', 
                            admin_id: ADMIN_ID, 
                            body: PRESALE_NOTE_TEXT
                        });
                        log('ACTION', `Snoozed & noted chat ${conv.id}`);
                    }
                } catch (err) {
                    log('CHAT_ERR', `Chat ${conv.id} skip: ${err.message}`);
                }
            }

            if (searchRes.data.pages?.next) {
                pagination = { 
                    per_page: 20, 
                    starting_after: searchRes.data.pages.next.starting_after 
                };
            } else {
                pagination = null;
            }
        }
        
        lastProcessedDate.set(adminId, todayStr);
        log('PRESALE', 'Success: All pages processed.');
        
    } catch (e) { 
        log('SEARCH_FATAL', `Critical failure: ${e.message}`); 
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
            log('WEBHOOK', `Admin ${data.item.id} returned. Running Presale check...`);
            // Запускаем асинхронно, чтобы не держать ответ вебхука
            processPresale(data.item.id).catch(e => log('ASYNC_ERR', e.message));
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
