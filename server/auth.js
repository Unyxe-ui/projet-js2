const bcrypt = require('bcryptjs');
const db = require('./database');
const sessionMgr = require('./session');
const { parseBody, renderTemplate, sendHTML, redirect } = require('./utils');

function registerPage(req, res) {
  if (sessionMgr.getUser(req)) return redirect(res, '/');
  redirect(res, '/login?panel=signup');
}

async function registerSubmit(req, res) {
  const body = await parseBody(req);
  const email = (body.email || '').trim();
  const username = (body.username || '').trim();
  const password = body.password || '';
  const confirmPassword = body.confirm_password || '';

  let error = '';
  if (!email || !username || !password) error = 'Tous les champs sont obligatoires';
  else if (!email.includes('@') || !email.includes('.')) error = 'Adresse e-mail invalide';
  else if (username.length < 3 || username.length > 30) error = 'Le nom doit faire entre 3 et 30 caractères';
  else if (password.length < 6) error = 'Le mot de passe doit faire au moins 6 caractères';
  else if (password !== confirmPassword) error = 'Les mots de passe ne correspondent pas';

  if (error) {
    return sendHTML(res, renderTemplate('login', {
      user: null,
      error,
      email,
      username,
      identifier: '',
      panel: 'signup'
    }));
  }

  const d = db.get();

  const emailExists = d.get('SELECT COUNT(*) as c FROM users WHERE email = ?', [email]);
  if (emailExists && emailExists.c > 0) {
    return sendHTML(res, renderTemplate('login', {
      user: null,
      error: 'Cet e-mail est déjà utilisé',
      email,
      username,
      identifier: '',
      panel: 'signup'
    }));
  }

  const usernameExists = d.get('SELECT COUNT(*) as c FROM users WHERE username = ?', [username]);
  if (usernameExists && usernameExists.c > 0) {
    return sendHTML(res, renderTemplate('login', {
      user: null,
      error: 'Ce nom d\'utilisateur est déjà pris',
      email,
      username,
      identifier: '',
      panel: 'signup'
    }));
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const result = d.run('INSERT INTO users (email, username, password) VALUES (?, ?, ?)', [email, username, hashedPassword]);

  sessionMgr.createSession(res, result.lastInsertRowid);
  redirect(res, '/');
}

function loginPage(req, res) {
  if (sessionMgr.getUser(req)) return redirect(res, '/');

  const url = req.url || '';
  const panel = url.includes('panel=signup') ? 'signup' : '';

  sendHTML(res, renderTemplate('login', {
    user: null,
    error: '',
    identifier: '',
    email: '',
    username: '',
    panel
  }));
}

async function loginSubmit(req, res) {
  const body = await parseBody(req);
  const identifier = (body.identifier || '').trim();
  const password = body.password || '';

  if (!identifier || !password) {
    return sendHTML(res, renderTemplate('login', { user: null, error: 'Tous les champs sont obligatoires', identifier }));
  }

  const d = db.get();
  const user = d.get('SELECT id, password FROM users WHERE email = ? OR username = ?', [identifier, identifier]);

  if (!user || !await bcrypt.compare(password, user.password)) {
    return sendHTML(res, renderTemplate('login', { user: null, error: 'Identifiants invalides', identifier }));
  }

  sessionMgr.createSession(res, user.id);
  redirect(res, '/');
}

function logout(req, res) {
  sessionMgr.destroySession(req, res);
  redirect(res, '/');
}

module.exports = { registerPage, registerSubmit, loginPage, loginSubmit, logout };
