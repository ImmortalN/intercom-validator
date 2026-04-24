const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ГЛОБАЛЬНЫЙ ЛОГ ===
app.use((req, res, next) => {
    console.log(`[GLOBAL] ${new Date().toISOString()} | ${req.method} ${req.url}`);
    next();
});

// === CONFIG ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати 😎';

const INTERCOM_VERSION = '2.14';
const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';

// === CACHE ===
const processedSubscriptionConversations = new Set();
const PRESALE_PROCESSED = new Map(); // convId -> date
const lastAdminRun = new Map(); // adminId -> date

// === LOG ===
function log(tag, msg, data = '') {
    console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data || '');
}

// === HELPERS ===
const normalize = e => e?.trim().toLowerCase();

function isToday(unix) {
    const d = new Date(unix * 1000);
    const now = new Date();
    return d.toDateString() === now.toDateString();
}

function canRunToday(adminId) {
    const today = new Date().toISOString().split('T')[0];

    if (lastAdminRun.get(adminId) === today) {
        log('PRESALE-SKIP', `Админ ${adminId} уже запускал сегодня`);
        return false;
    }

    lastAdminRun.set(adminId, today);
    return true;
}

function canProcessConversationToday(convId) {
    const today = new Date().toISOString().split('T')[0];

    if (PRESALE_PROCESSED.get(convId) === today) {
        log('PRESALE-SKIP', `Чат ${convId} уже обработан сегодня`);
        return false;
    }

    PRESALE_PROCESSED.set(convId, today);
    return true;
}

// === INTERCOM HELPERS ===
async function getContact(contactId) {
    return axios.get(`https://api.intercom.io/contacts/${contactId}`, {
        headers: {
            Authorization: `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION
        }
    });
}

async function updateContact(contactId, data) {
    return axios.put(`https://api.intercom.io/contacts/${contactId}`, {
        custom_attributes: data
    }, {
        headers: {
            Authorization: `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION
        }
    });
}

async function addNote(conversationId, text) {
    return axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: text
    }, {
        headers: {
            Authorization: `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION
        }
    });
}

async function unsnooze(conversationId) {
    return axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
        message_type: 'open',
        admin_id: ADMIN_ID
    }, {
        headers: {
            Authorization: `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION
        }
    });
}

async function snooze(conversationId, seconds = 60) {
    const until = Math.floor(Date.now() / 1000) + seconds;

    return axios.post(`https://api.intercom.io/conversations/${conversationId}/snooze`, {
        snoozed_until: until,
        admin_id: ADMIN_ID
    }, {
        headers: {
            Authorization: `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION
        }
    });
}

// === UNPAID + SUBSCRIPTION ===
async function processClient(conversationId, contactId) {
    if (!contactId) {
        log('SKIP', 'Нет contactId');
        return;
    }

    try {
        log('CONTACT', `Получаем контакт ${contactId}`);

        const res = await getContact(contactId);
        const contact = res.data;

        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase Email'];
        const subscription = contact.custom_attributes?.['subscription'] || '';

        log('CONTACT-DATA', `Email: ${email}, Purchase: ${purchaseEmail}`);

        // === UNPAID ===
        if (LIST_URL && (email || purchaseEmail)) {
            const { data: list } = await axios.get(LIST_URL);

            const normalizedList = list.map(normalize);

            const isMatch =
                (email && normalizedList.includes(normalize(email))) ||
                (purchaseEmail && normalizedList.includes(normalize(purchaseEmail)));

            if (isMatch) {
                log('UNPAID', `Совпадение найдено`);

                await updateContact(contactId, { [CUSTOM_ATTR_NAME]: true });

                log('UNPAID', `Атрибут установлен`);
            }
        }

        // === SUBSCRIPTION ===
        if (!subscription.trim()) {
            if (!processedSubscriptionConversations.has(conversationId)) {
                log('SUBSCRIPTION', `Пустое поле → добавляем нот`);

                await addNote(conversationId, 'Заповніть будь ласка subscription 😇🙏');

                processedSubscriptionConversations.add(conversationId);
            }
        }

    } catch (err) {
        log('ERROR', err.message);
    }
}

// === PRESALE ===
async function runPresale(adminId) {
    if (!canRunToday(adminId)) return;

    log('PRESALE', `Старт для админа ${adminId}`);

    try {
        const res = await axios.post(`https://api.intercom.io/conversations/search`, {
            query: {
                operator: 'AND',
                value: [
                    { field: 'state', operator: '=', value: 'snoozed' },
                    { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID }
                ]
            }
        }, {
            headers: {
                Authorization: `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        const conversations = res.data.conversations || [];

        log('PRESALE', `Найдено ${conversations.length}`);

        for (const conv of conversations) {
            log('CHECK', `Чат ${conv.id}`);

            if (isToday(conv.updated_at)) {
                log('SKIP', 'Обновлялся сегодня');
                continue;
            }

            if (!canProcessConversationToday(conv.id)) continue;

            const full = await axios.get(`https://api.intercom.io/conversations/${conv.id}`, {
                headers: {
                    Authorization: `Bearer ${INTERCOM_TOKEN}`,
                    'Intercom-Version': INTERCOM_VERSION
                }
            });

            if (full.data.custom_attributes?.[FOLLOW_UP_ATTR]) {
                log('SKIP', 'Есть Follow-Up');
                continue;
            }

            log('ACTION', `Обрабатываем ${conv.id}`);

            await unsnooze(conv.id);
            await addNote(conv.id, PRESALE_NOTE_TEXT);
            await snooze(conv.id, 60);

            log('DONE', `Чат ${conv.id} обработан`);
        }

    } catch (err) {
        log('PRESALE-ERROR', err.message);
    }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.status(200).json({ ok: true });

    log('WEBHOOK', topic);

    // === BOT → AGENT (SUBSCRIPTION + UNPAID)
    if (topic === 'conversation.admin.assigned') {
        const convId = item.id;
        const contactId = item.contacts?.contacts?.[0]?.id;

        if (item.previous_assignee?.type !== 'bot') {
            log('SKIP', 'Не из бота');
            return res.json({ ok: true });
        }

        log('TRANSFER', `Бот → агент | чат ${convId}`);

        processClient(convId, contactId);
    }

    // === PRESALE (AWAY OFF)
    if (topic === 'admin.away_mode_updated') {
        const adminId = item.id;
        const isAway = item.away_mode_enabled;

        log('AWAY', `Admin ${adminId} | away: ${isAway}`);

        if (isAway === false) {
            runPresale(adminId);
        }
    }

    res.status(200).json({ ok: true });
});

// === HEAD ===
app.head('/validate-email', (req, res) => res.status(200).end());

// === START ===
app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Server started');
});
