'use strict';
const bcrypt = require('bcryptjs');
const store  = require('./store');

async function initDB() {
  if (!store.anyAdminExists()) {
    const hash = await bcrypt.hash('admin', 12);
    store.insertUser({ username: 'admin', password_h: hash, role: 'admin' });
    console.log('⚠  Default admin user created: username=admin password=admin  — CHANGE THIS IMMEDIATELY');
  }
  console.log('Data store ready at', require('path').join(__dirname, 'data'));
}

module.exports = { initDB };
