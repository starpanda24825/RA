'use strict';
/* ============================================================
   Pure-JS JSON-file data store. No native dependencies, so this
   installs and runs identically on Windows/Mac/Linux without any
   compiler toolchain — important since better-sqlite3 needs one
   and that's exactly the kind of setup friction we're avoiding.

   Trade-off: each write rewrites the whole file. Completely fine
   at the scale of a Minecraft server's nation site (a few dozen
   accounts, a few dozen articles); if this ever needs to handle
   thousands of records, swap this module for a real database —
   nothing outside this file knows or cares how data is stored.

   Writes are synchronous (fs.*Sync) on purpose: since Node runs
   one callback at a time and these functions never await mid-way
   through a read-modify-write, two requests can't interleave and
   corrupt a record.
   ============================================================ */
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('Failed to parse', file, '— starting from empty.', e); return fallback; }
}

function saveJSON(file, data) {
  const p = path.join(DATA_DIR, file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p); // rename is atomic on the same filesystem
}

function nextId(list) {
  return list.length ? Math.max(...list.map(x => x.id)) + 1 : 1;
}

// ════════════════════════════════════════════════════════════
// Users
// ════════════════════════════════════════════════════════════
function readUsers()        { return loadJSON('users.json', []); }
function writeUsers(users)  { saveJSON('users.json', users); }

function findUserByUsername(username) {
  const u = String(username || '').toLowerCase();
  return readUsers().find(x => x.username.toLowerCase() === u) || null;
}
function findUserById(id) {
  return readUsers().find(x => x.id === Number(id)) || null;
}
function listUsers() {
  return readUsers()
    .map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at }))
    .sort((a, b) => a.id - b.id);
}
function anyAdminExists() {
  return readUsers().some(u => u.role === 'admin');
}
function insertUser({ username, password_h, role }) {
  const users = readUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    const err = new Error('UNIQUE constraint: username already exists');
    err.code = 'UNIQUE';
    throw err;
  }
  const user = {
    id: nextId(users),
    username, password_h,
    role: role || 'citizen',
    created_at: new Date().toISOString()
  };
  users.push(user);
  writeUsers(users);
  return user;
}
function updateUser(id, fields) {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === Number(id));
  if (idx === -1) return null;
  users[idx] = Object.assign({}, users[idx], fields);
  writeUsers(users);
  return users[idx];
}
function deleteUser(id) {
  const users = readUsers();
  const next = users.filter(u => u.id !== Number(id));
  const changed = next.length !== users.length;
  if (changed) writeUsers(next);
  return changed;
}

// ════════════════════════════════════════════════════════════
// Articles
// ════════════════════════════════════════════════════════════
function readArticles()         { return loadJSON('articles.json', []); }
function writeArticles(articles){ saveJSON('articles.json', articles); }

function listPublishedArticles() {
  return readArticles()
    .filter(a => a.status === 'published')
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
}
function listAllArticles() {
  return readArticles()
    .map(a => ({ id: a.id, title: a.title, subtitle: a.subtitle, author: a.author, status: a.status, created_at: a.created_at, published_at: a.published_at }))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}
function findArticleById(id) {
  return readArticles().find(a => a.id === Number(id)) || null;
}
function insertArticle({ title, subtitle, content, author }) {
  const articles = readArticles();
  const article = {
    id: nextId(articles),
    title, subtitle: subtitle || '', content, author,
    status: 'draft',
    created_at: new Date().toISOString(),
    published_at: null
  };
  articles.push(article);
  writeArticles(articles);
  return article;
}
function updateArticle(id, fields) {
  const articles = readArticles();
  const idx = articles.findIndex(a => a.id === Number(id));
  if (idx === -1) return null;
  articles[idx] = Object.assign({}, articles[idx], fields);
  writeArticles(articles);
  return articles[idx];
}
function deleteArticle(id) {
  const articles = readArticles();
  const next = articles.filter(a => a.id !== Number(id));
  const changed = next.length !== articles.length;
  if (changed) writeArticles(next);
  return changed;
}

module.exports = {
  findUserByUsername, findUserById, listUsers, anyAdminExists, insertUser, updateUser, deleteUser,
  listPublishedArticles, listAllArticles, findArticleById, insertArticle, updateArticle, deleteArticle
};
