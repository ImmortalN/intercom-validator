const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===== BASIC ROUTE =====
app.get('/', (req, res) => {
  console.log('✅ Health check hit');
  res.send('OK');
});

// ===== GLOBAL LOGGER =====
app.use((req, res, next) => {
  console.log(`[GLOBAL LOG] ${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

// ===== ENV =====
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const LIST_URL = process.env.LIST_URL;

const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = 'Агент вийшов онлайн — перевіряємо старі presale чати 😎';

const processedToday = new Map();

// ===== HELPERS =====
function log(...args) {
  console.log('[DEBUG]', ...args);
}

function canRunOncePerDay(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (processedToday.get(adminId) === today) return false;
  processedToday.set(adminId, today);
  return true;
}

async function intercomRequest(method, url, data = {}) {
  return axios({
    method,
    url: `https://api.intercom.io${url}`,
    data,
    headers: {
      Authorization: `Bearer ${INTERCOM_TOKEN}`,
      'Intercom-Version': INTERCOM_VERSION,
      'Content-Type': 'application/json'
    }
  });
}

// ===== CORE ACTIONS =====
async function resnoozeConversation(conversationId) {
  const snoozedUntil = Math.floor(Date.now() / 1000) + 60;

  try {
    await intercomRequest('post', `/conversations/${conversationId}/snooze`, {
      snoozed_until: snoozedUntil,
      admin_id: ADMIN_ID
    });

    log(`⏰ Resnoozed ${conversationId}`);
  } catch (e) {
    log('RESNOOZE ERROR', e.response?.data || e.message);
  }
}

async function addNote(conversationId, text) {
  try {
    await intercomRequest('post', `/conversations/${conversationId}/reply`, {
      message_type: 'note',
      admin_id: ADMIN_ID,
      body: text
    });

    log(`📝 Note added ${conversationId}`);
  } catch (e) {
    log('NOTE ERROR', e.response?.data || e.message);
  }
}

// ===== PRESALE =====
async function processPresale(adminId) {
  if (!PRESALE_TEAM_ID) return;
  if (!canRunOncePerDay(adminId)) return;

  console.log(`🚀 PRESALE START for admin ${adminId}`);

  try {
    const todayMidnight = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    const res = await intercomRequest('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'snoozed_until', operator: '<', value: todayMidnight }
        ]
      }
    });

    const conversations = res.data.conversations || [];

    log(`📦 Found ${conversations.length} conversations`);

    for (const conv of conversations) {
      const full = await intercomRequest('get', `/conversations/${conv.id}`);

      if (full.data.custom_attributes?.[FOLLOW_UP_ATTR] === true) {
        log(`⛔ Skip ${conv.id} (Follow-Up)`);
        continue;
      }

      await resnoozeConversation(conv.id);
      await addNote(conv.id, PRESALE_NOTE_TEXT);

      await new Promise(r => setTimeout(r, 300)); // anti-rate-limit
    }

    console.log(`✅ PRESALE DONE`);
  } catch (e) {
    console.error('PRESALE ERROR', e.response?.data || e.message);
  }
}

// ===== EMAIL =====
async function validateEmail(contactId, conversationId) {
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
      list.some(l => l.toLowerCase().trim() === e.toLowerCase().trim())
    );

    if (match) {
      await intercomRequest('put', `/contacts/${contactId}`, {
        custom_attributes: { 'Unpaid Custom': true }
      });

      log(`💰 Unpaid set ${contactId}`);
    }
  } catch (e) {
    log('EMAIL ERROR', e.message);
  }
}

// ===== WEBHOOK =====
app.post('/validate-email', async (req, res) => {
  console.log('🔥 WEBHOOK HIT');

  // 🔥 CRITICAL DEBUG — всегда смотри payload
  console.log('📦 FULL PAYLOAD:\n', JSON.stringify(req.body, null, 2));

  const topic = req.body.topic;
  const item = req.body.data?.item;

  console.log(`📩 Topic: ${topic}`);

  if (!item) return res.sendStatus(200);

  try {
    // ===== ADMIN EVENTS =====
    if (
      topic === 'admin.away_mode_updated' ||
      topic === 'admin.logged_in' ||
      topic === 'admin.status.updated'
    ) {
      const isAway =
        item.away_mode_enabled ??
        item.away_mode?.enabled ??
        item.admin?.away_mode_enabled;

      console.log('🧠 isAway:', isAway);

      if (isAway === false) {
        console.log('👀 Admin ONLINE → presale trigger');
        await processPresale(item.id);
      }
    }

    // ===== USER EVENTS =====
    if (
      topic === 'conversation.user.created' ||
      topic === 'conversation.user.replied'
    ) {
      const contactId = item.contacts?.contacts?.[0]?.id;
      const conversationId = item.id;

      await validateEmail(contactId, conversationId);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('WEBHOOK ERROR', e.message);
    res.sendStatus(200);
  }
});

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server started');
});
