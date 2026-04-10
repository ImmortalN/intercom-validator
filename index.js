const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000;
const PRESALE_FOLLOWUP_TAG_ID = '13404165';
const FOLLOW_UP_ATTR = 'Follow-Up';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// === НОВЫЙ ПОДХОД: только logged_in + проверка времени (утро следующего дня) ===
const lastProcessedDate = new Map(); // adminId → YYYY-MM-DD

console.log('Webhook запущен — presale ноут ТОЛЬКО при logged_in + утром');

function log(...args) {
    if (DEBUG) console.log(...args);
}

// === ПРОВЕРКА — можно ли сейчас показывать ноут (утро + новый день) ===
function canShowPresaleNote(adminId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentHour = now.getHours();

    // Показываем только если:
    // 1. Новый день
    // 2. Утро (до 13:00 например)
    if (lastProcessedDate.has(adminId) && lastProcessedDate.get(adminId) === todayStr) {
        log(`[PRESALE SKIP] Уже было сегодня для ${adminId}`);
        return false;
    }

    if (currentHour >= 13) {
        log(`[PRESALE SKIP] Уже после обеда (${currentHour}:00) — ноут не показываем`);
        return false;
    }

    lastProcessedDate.set(adminId, todayStr);
    return true;
}

// === PRESALE PROCESSING ===
async function processSnoozedForAdmin(adminId) {
    if (!PRESALE_TEAM_ID || !adminId) return;

    if (!canShowPresaleNote(adminId)) return;

    log(`[PRESALE START] Запуск presale-логики для админа ${adminId} (утро нового дня)`);

    try {
        let startingAfter = null;
        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "admin_assignee_id", operator: "=", value: adminId },
                        { field: "state", operator: "=", value: "snoozed" }
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
                if (await isFollowUpBlocked(conv.id)) continue;

                await unsnoozeConversation(conv.id, adminId);
                await addNoteWithDelay(conv.id, PRESALE_NOTE_TEXT, 3000, ADMIN_ID);
                await addTagToConversation(conv.id);
            }
            startingAfter = res.data.pages?.next?.starting_after;
        } while (startingAfter);
    } catch (e) {
        console.error('[PRESALE ERROR]:', e.message);
    }
}

// === UNSNOOZE ===
async function unsnoozeConversation(conversationId, adminId = ADMIN_ID) {
    if (!conversationId) return;
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
            message_type: 'open',
            admin_id: adminId
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 6000
        });
    } catch (error) {
        console.error(`[UNSNZ FAIL] ${conversationId}:`, error.message);
    }
}

// === ПРОВЕРКА Follow-Up ===
async function isFollowUpBlocked(conversationId) {
    try {
        const res = await axios.get(`https://api.intercom.io/conversations/${conversationId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });
        return res.data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
    } catch (e) {
        return false;
    }
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ, ТЕГА, АТРИБУТОВ — (оставил без изменений) ===
async function addNoteWithDelay(conversationId, text, delay = DELAY_MS, adminId = ADMIN_ID) {
    if (!conversationId) return;
    setTimeout(async () => {
        try {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: adminId,
                body: text
            }, {
                headers: {
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Intercom-Version': INTERCOM_VERSION
                },
                timeout: 6000
            });
            log(`[NOTE] "${text.slice(0, 60)}..." → ${conversationId}`);
        } catch (error) {
            console.error(`[NOTE FAIL] ${conversationId}:`, error.message);
        }
    }, delay);
}

async function addTagToConversation(conversationId, tagId = PRESALE_FOLLOWUP_TAG_ID, adminId = ADMIN_ID) {
    if (!conversationId) return;
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/tags`, {
            id: tagId,
            admin_id: adminId
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 8000
        });
    } catch (error) {
        log(`[TAG FAIL] ${conversationId}:`, error.message);
    }
}

async function updateContactAttribute(contactId, attributes) {
    if (!contactId || !attributes) return;
    try {
        await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: attributes
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 8000
        });
    } catch (error) {
        console.error(`[ATTR FAIL] ${contactId}:`, error.message);
    }
}

// === ОСНОВНАЯ ЛОГИКА validateAndSetCustom (без изменений) ===
async function validateAndSetCustom(contactId, conversationId) {
    if (!contactId || !conversationId) return;
    try {
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });
        const contact = contactRes.data;
        
        const subscription = contact.custom_attributes?.['Subscription'] || '';
        const currentUnpaidStatus = contact.custom_attributes?.[CUSTOM_ATTR_NAME];
        
        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean);

        if (emails.length > 0) {
            const { data: emailList } = await axios.get(LIST_URL, { timeout: 5000 });
            if (Array.isArray(emailList)) {
                const isMatch = emails.some(e =>
                    emailList.some(le => (le || '').trim().toLowerCase() === e.trim().toLowerCase())
                );
                if (isMatch && currentUnpaidStatus !== true) {
                    await updateContactAttribute(contactId, { [CUSTOM_ATTR_NAME]: true });
                }
            }
        }

        if (!subscription.trim() && !processedSubscriptionConversations.has(conversationId)) {
            processedSubscriptionConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
        }
    } catch (e) {
        console.error(`[VALIDATE ERROR] contact ${contactId}:`, e.message);
    }
}

const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set();

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;
    if (!item) return res.status(200).json({ ok: true });

    const conversationId = item.id;
    let contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

    // === ТОЛЬКО logged_in — убрали away_mode_updated полностью ===
    if (topic === 'admin.logged_in') {
        processSnoozedForAdmin(item.id);
        return res.status(200).json({ ok: true });
    }

    // Передача від бота
    if (topic === 'conversation.admin.assigned') {
        const prev = item.previous_assignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);
        const assignee = item.assignee;
        
        const isTransferFromBot = (prev?.type === 'bot' || (prev?.type === 'admin' && prev.id?.startsWith('bot_'))) 
                               && assignee?.type === 'team';
        
        if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
            processedTransferConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
        }
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    if (topic === 'conversation.user.replied') {
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    if (contactId && conversationId) {
        await validateAndSetCustom(contactId, conversationId);
    }

    res.status(200).json({ ok: true });
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
    console.log('Webhook активний: presale ноут ТОЛЬКО при logged_in + утром следующего дня');
});
