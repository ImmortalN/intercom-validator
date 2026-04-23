const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
// === ГЛОБАЛЬНЫЙ ЛОГГЕР (Ставить СЮДА) ===
// Он покажет абсолютно любой запрос, который пришел на ваш сервер
app.use((req, res, next) => {
    console.log(`[GLOBAL LOG] ${new Date().toISOString()} | ${req.method} ${req.url} | IP: ${req.ip}`);
    next();
});

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID; // Тот самый системный ID
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 3000;
const PRESALE_FOLLOWUP_TAG_ID = '13404165';
const FOLLOW_UP_ATTR = 'Follow-Up';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

const lastProcessedDate = new Map();

function log(...args) {
    if (DEBUG) console.log(...args);
}

// === ЛОГИКА "Один раз в день" ===
function canShowPresaleNote(adminId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    if (lastProcessedDate.has(adminId) && lastProcessedDate.get(adminId) === todayStr) {
        log(`[PRESALE SKIP] Уже обробляли сьогодні для адміна ${adminId}`);
        return false;
    }
    lastProcessedDate.set(adminId, todayStr);
    return true;
}

// === ОСНОВНОЙ ПРОЦЕСС PRESALE ===
async function processSnoozedForAdmin(adminId) {
    if (!PRESALE_TEAM_ID || !adminId) return;
    if (!canShowPresaleNote(adminId)) return;

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    
    log(`[PRESALE START] Запуск для адміна ${adminId}. Шукаємо чати до ${todayMidnight.toISOString()}`);

    try {
        let startingAfter = null;
        let processedCount = 0;

        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { 
                            field: "snoozed_until", 
                            operator: "<", 
                            value: Math.floor(todayMidnight.getTime() / 1000) 
                        }
                    ]
                },
                pagination: { per_page: 50 }
            };
            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const res = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
                headers: {
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Intercom-Version': INTERCOM_VERSION
                }
            });

            const convs = res.data.conversations || [];
            for (const conv of convs) {
                // Проверка атрибута Follow-Up
                const fullConv = await axios.get(`https://api.intercom.io/conversations/${conv.id}`, {
                    headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
                });

                if (fullConv.data.custom_attributes?.[FOLLOW_UP_ATTR] === true) {
                    log(`[SKIP] ${conv.id} — Follow-Up заблоковано`);
                    continue;
                }

                // ВЫПОЛНЕНИЕ: используем ADMIN_ID (системный), а не adminId (того кто вошел)
                await unsnoozeConversation(conv.id, ADMIN_ID);
                await new Promise(r => setTimeout(r, 1000)); // небольшая пауза
                await addNoteWithDelay(conv.id, PRESALE_NOTE_TEXT, 1000, ADMIN_ID);
                await addTagToConversation(conv.id, PRESALE_FOLLOWUP_TAG_ID, ADMIN_ID);

                processedCount++;
                log(`✅ [PROCESSED] Чат ${conv.id} розснужений`);
            }
            startingAfter = res.data.pages?.next?.starting_after;
        } while (startingAfter);

        log(`[PRESALE FINISH] Всього оброблено: ${processedCount}`);
    } catch (e) {
        console.error('[PRESALE ERROR]:', e.response?.data || e.message);
    }
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Исправленные под системный ID) ===
async function unsnoozeConversation(conversationId, performAsAdminId) {
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
            message_type: 'open',
            admin_id: performAsAdminId
        }, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
        });
    } catch (error) { log(`[UNSNZ FAIL] ${error.message}`); }
}

async function addNoteWithDelay(conversationId, text, delay, performAsAdminId) {
    setTimeout(async () => {
        try {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: performAsAdminId,
                body: text
            }, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
            });
        } catch (error) { log(`[NOTE FAIL] ${error.message}`); }
    }, delay);
}

async function addTagToConversation(conversationId, tagId, performAsAdminId) {
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/tags`, {
            id: tagId,
            admin_id: performAsAdminId
        }, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
        });
    } catch (error) { log(`[TAG FAIL] ${error.message}`); }
}

// === ЛОГИКА UNPAID И SUBSCRIPTION (Ваш оригинал) ===
const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set();

async function validateAndSetCustom(contactId, conversationId) {
    if (!contactId || !conversationId) return;
    try {
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
        });
        const contact = contactRes.data;
        const subscription = contact.custom_attributes?.['Subscription'] || '';
        
        // Email check
        const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
        if (emails.length > 0 && LIST_URL) {
            const { data: emailList } = await axios.get(LIST_URL);
            if (Array.isArray(emailList)) {
                const isMatch = emails.some(e => emailList.some(le => le.trim().toLowerCase() === e.trim().toLowerCase()));
                if (isMatch) await updateContactAttribute(contactId, { [CUSTOM_ATTR_NAME]: true });
            }
        }

        // Sub check
        if (!subscription.trim() && !processedSubscriptionConversations.has(conversationId)) {
            processedSubscriptionConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 5000, ADMIN_ID);
        }
    } catch (e) { log(`[VAL ERROR] ${e.message}`); }
}

async function updateContactAttribute(contactId, attributes) {
    try {
        await axios.put(`https://api.intercom.io/contacts/${contactId}`, { custom_attributes: attributes }, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
        });
    } catch (e) { log(`[ATTR FAIL] ${e.message}`); }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) return res.status(200).json({ ok: true });

    // ЛОГ ДЛЯ ОТЛАДКИ ( Natalie увидит его в консоли сервера )
    console.log(`[WEBHOOK] Topic: ${topic} | Item ID: ${item.id}`);

    // 1. ПРОВЕРКА ОНЛАЙН-СТАТУСА ( Natalie заходит в Intercom )
    if (topic === 'admin.logged_in' || topic === 'admin.away_mode_updated') {
        const isAway = item.away_mode_enabled ?? item.away_mode?.enabled;
        
        if (isAway === false) {
            console.log(`[PRESALE TRIGGER] Админ ${item.id} в онлайне. Проверяем старые чаты...`);
            processSnoozedForAdmin(item.id); 
        }
        return res.status(200).json({ ok: true });
    }

    // 2. ПЕРЕВОД ИЗ БОТА ( Когда бот отдал чат человеку )
    if (topic === 'conversation.admin.assigned') {
        const conversationId = item.id; // В этом топике ID чата обычно в item.id
        const prev = item.previous_assignee;
        
        if (prev?.type === 'bot' && !processedTransferConversations.has(conversationId)) {
            processedTransferConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 2000, ADMIN_ID);
        }
    }

    // 3. НОВОЕ СООБЩЕНИЕ ( Проверка Email и Unpaid Custom )
    if (topic === 'conversation.user.replied' || topic === 'conversation.user.created') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;
        const conversationId = item.id;
        
        console.log(`[USER MSG] Проверка атрибутов для чата: ${conversationId}`);
        validateAndSetCustom(contactId, conversationId);
    }

    res.status(200).json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('Validator Server Active'));
