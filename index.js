const express = require('express');

const app = express();
app.use(express.json());

// ===== BASIC CHECK =====
app.get('/', (req, res) => {
  console.log('✅ HEALTH CHECK');
  res.send('OK');
});

// ===== GLOBAL RAW LOGGER (CRITICAL) =====
app.use((req, res, next) => {
  console.log('\n========================');
  console.log('➡️ METHOD:', req.method);
  console.log('➡️ URL:', req.url);
  console.log('➡️ TIME:', new Date().toISOString());

  if (req.method === 'POST') {
    console.log('📦 HEADERS:', JSON.stringify(req.headers, null, 2));
    console.log('📦 BODY:', JSON.stringify(req.body, null, 2));
  }

  console.log('========================\n');

  next();
});

// ===== SPECIFIC WEBHOOK ROUTE =====
app.post('/validate-email', (req, res) => {
  console.log('🔥🔥🔥 VALIDATE EMAIL WEBHOOK HIT');
  console.log('📩 FULL BODY:', JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

// ===== CATCH ALL POST (IMPORTANT) =====
app.post('*', (req, res) => {
  console.log('🚨 CATCH-ALL POST HIT:', req.url);
  res.sendStatus(200);
});

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 SERVER STARTED');
});
