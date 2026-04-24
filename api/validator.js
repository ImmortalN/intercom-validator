const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === НАЛАШТУВАННЯ (ENV) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо заснужені чати presale 🚀';
const INTERCOM_VERSION = '2.14';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

const lastProcessedDate = new Map(); // adminId -> YYYY-MM-DD

// === ФУНКЦІЯ ЛОГУВАННЯ ===
function log(tag, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${timestamp}] [${tag}] ${message}`);
}

async function intercomRequest(method, endpoint, data = null) {
  try {
    log('API-CALL', `${method.toUpperCase()} ${endpoint}`);
    const config = {
      method,
      url: `https://api.intercom.io${endpoint}`,
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      },
      data,
      timeout: 10000
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('API-ERROR', `${endpoint} failed: ${error.response?.status} - ${errorData}`);
    throw error;
  }
}

// === ЛОГІКА 1 & 2: UNPAID ТА SUBSCRIPTION ===
async function validateContactData(contactId, conversationId) {
  log('VALIDATE-START', `Checking contact ${contactId} in conversation ${conversationId}`);

  try {
    const contact = await intercomRequest('get', `/contacts/${contactId}`);
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase Email'];
    
    log('INFO', `Contact emails: Primary: ${email}, Purchase: ${purchaseEmail}`);

    // Перевірка Unpaid
    if (email || purchaseEmail) {
      log('CHECK-UNPAID', `Fetching unpaid list from external source...`);
      const listRes = await axios.get(LIST_URL);
      const unpaidList = listRes.data;
      
      const isUnpaid = (email && unpaidList.includes(email)) || (purchaseEmail && unpaidList.includes(purchaseEmail));

      if (isUnpaid) {
        log('ACTION', `Email match found! Setting 'Unpaid Custom' = true for ${contactId}`);
        await intercomRequest('put', `/contacts/${contactId}`, {
          custom_attributes: { 'Unpaid Custom': true }
        });
      } else {
        log('INFO', `No match in unpaid list for ${contactId}`);
      }
    }

    // Перевірка Subscription
    const subValue = contact.custom_attributes?.['subscription'];
    log('CHECK-SUBS', `Current subscription value: "${subValue}"`);
    
    if (!subValue || subValue.trim() === '') {
      log('ACTION', `Subscription is empty. Adding internal note to conversation ${conversationId}`);
      await intercomRequest('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: 'Please fill subscription 😇'
      });
    } else {
      log('INFO', `Subscription field is already filled.`);
    }

  } catch (err) {
    log('VALIDATE-FAIL', `Error processing contact ${contactId}: ${err.message}`);
  }
}

// === ЛОГІКА 3: PRESALE ===
async function checkPresaleSnoozedChats(adminId) {
  const today = new Date().toISOString().split('T')[0];
  
  log('PRESALE-TRIGGER', `Admin ${adminId} returned from away. Checking daily limit...`);

  if (lastProcessedDate.get(adminId) === today) {
    log('PRESALE-SKIP', `Admin ${adminId} already triggered the check today (${today}). Aborting.`);
    return;
  }

  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    log('PRESALE-SEARCH', `Searching for snoozed conversations...`);
    const searchResult = await intercomRequest('post', '/conversations/search', {
      query: { field: 'state', operator: '=', value: 'snoozed' }
    });

    const conversations = searchResult.conversations || [];
    log('PRESALE-INFO', `Found ${conversations.length} total snoozed chats. Starting filtration...`);

    let processedCount = 0;

    for (const conv of conversations) {
      const isPresaleTeam = conv.team_assignee_id === PRESALE_TEAM_ID;
      const isOldEnough = conv.updated_at < startOfTodayUnix;
      const isFollowUpBlocked = conv.custom_attributes?.['Follow-Up'] === true;

      log('CHAT-DEBUG', `Chat ${conv.id}: TeamMatch=${isPresaleTeam}, OlderThanToday=${isOldEnough}, FollowUpBlocked=${isFollowUpBlocked}`);

      if (isPresaleTeam && isOldEnough) {
        if (isFollowUpBlocked) {
          log('INFO', `Chat ${conv.id} matches criteria but is blocked by Follow-Up attribute.`);
          continue;
        }

        log('ACTION', `Processing chat ${conv.id}: Waking up with 1-min snooze.`);
        
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'snoozed',
          admin_id: adminId,
          snooze_until: Math.floor(Date.now() / 1000) + 60
        });

        log('INFO', `Waiting 500ms for Intercom to update state...`);
        await new Promise(resolve => setTimeout(resolve, 500));

        log('ACTION', `Adding presale note to chat ${conv.id}`);
        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
          message_type: 'note',
          admin_id: adminId,
          body: PRESALE_NOTE_TEXT
        });

        processedCount++;
      }
    }

    lastProcessedDate.set(adminId, today);
    log('PRESALE-SUCCESS', `Finished. Processed ${processedCount} conversations for admin ${adminId}`);
    
  } catch (error) {
    log('PRESALE-ERROR', `Critical failure in checkPresaleSnoozedChats: ${error.message}`);
  }
}

// === WEBHOOK HANDLER ===
app.post('/webhook', async (req, res) => {
  const { topic, data } = req.body;
  const item = data?.item;

  if (!item) {
    log('WEBHOOK-EMPTY', 'Received webhook without item data.');
    return res.sendStatus(200);
  }

  log('WEBHOOK-RCV', `Topic: ${topic}, Item ID: ${item.id}`);

  if (topic === 'conversation.user.created') {
    const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
    validateContactData(contactId, item.id);
  }

  if (topic === 'admin.away_mode_updated') {
    const isBack = item.away_mode_enabled === false;
    log('INFO', `Away mode update for admin ${item.id}. away_mode_enabled = ${item.away_mode_enabled}`);
    
    if (isBack) {
      checkPresaleSnoozedChats(item.id);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('SYSTEM', `Server is running on port ${PORT}`);
  log('SYSTEM', `Debug mode: ${DEBUG}`);
});
