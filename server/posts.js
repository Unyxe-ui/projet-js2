const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const sessionMgr = require('./session');
const { parseBody, parseMultipart, renderTemplate, sendHTML, redirect, parseQuery, escapeHtml } = require('./utils');

function getCategories() {
  return db.get().all('SELECT id, name FROM categories ORDER BY name');
}

function getPostCategories(postId) {
  return db.get().all(`
    SELECT c.id, c.name FROM categories c
    JOIN post_categories pc ON c.id = pc.category_id
    WHERE pc.post_id = ?
  `, [postId]);
}

function getVoteCounts(targetId, type) {
  const d = db.get();
  const table = type === 'post' ? 'post_votes' : 'comment_votes';
  const col = type === 'post' ? 'post_id' : 'comment_id';
  const likes = d.get(`SELECT COUNT(*) as c FROM ${table} WHERE ${col} = ? AND value = 1`, [targetId]);
  const dislikes = d.get(`SELECT COUNT(*) as c FROM ${table} WHERE ${col} = ? AND value = -1`, [targetId]);
  return { likes: likes ? likes.c : 0, dislikes: dislikes ? dislikes.c : 0 };
}

function getUserVote(userId, targetId, type) {
  if (!userId) return 0;
  const d = db.get();
  const table = type === 'post' ? 'post_votes' : 'comment_votes';
  const col = type === 'post' ? 'post_id' : 'comment_id';
  const row = d.get(`SELECT value FROM ${table} WHERE user_id = ? AND ${col} = ?`, [userId, targetId]);
  return row ? row.value : 0;
}

function enrichPost(post, userId) {
  const votes = getVoteCounts(post.id, 'post');
  post.categories = getPostCategories(post.id);
  post.likes = votes.likes;
  post.dislikes = votes.dislikes;
  post.userVote = getUserVote(userId, post.id, 'post');
  post.isOwner = userId && post.user_id === userId;
  const cc = db.get().get('SELECT COUNT(*) as c FROM comments WHERE post_id = ?', [post.id]);
  post.commentCount = cc ? cc.c : 0;
  post.timeAgo = timeAgo(post.created_at);
  return post;
}

function enrichComment(comment, userId) {
  const votes = getVoteCounts(comment.id, 'comment');
  comment.likes = votes.likes;
  comment.dislikes = votes.dislikes;
  comment.userVote = getUserVote(userId, comment.id, 'comment');
  comment.isOwner = userId && comment.user_id === userId;
  comment.timeAgo = timeAgo(comment.created_at);
  return comment;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z')).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString('fr-FR');
}

// ── Home / List posts ──
function homePage(req, res) {
  const user = sessionMgr.getUser(req);

  if (!user) {
    return sendHTML(res, renderTemplate('landing', { user: null }));
  }

  const query = parseQuery(req.url);
  const d = db.get();
  const categories = getCategories();

  let sql, params = [];

  if (query.filter === 'liked' && user) {
    sql = `
      SELECT p.*, u.username FROM posts p
      JOIN users u ON p.user_id = u.id
      JOIN post_votes pv ON p.id = pv.post_id
      WHERE pv.user_id = ? AND pv.value = 1
      ORDER BY p.created_at DESC
    `;
    params = [user.id];
  } else if (query.category) {
    sql = `
      SELECT p.*, u.username FROM posts p
      JOIN users u ON p.user_id = u.id
      JOIN post_categories pc ON p.id = pc.post_id
      WHERE pc.category_id = ?
      ORDER BY p.created_at DESC
    `;
    params = [parseInt(query.category)];
  } else if (query.filter === 'mine' && user) {
    sql = `
      SELECT p.*, u.username FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `;
    params = [user.id];
  } else {
    sql = `
      SELECT p.*, u.username FROM posts p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `;
  }

  let posts = d.all(sql, params);
  posts = posts.map(p => enrichPost(p, user ? user.id : null));

  const html = renderTemplate('home', {
    user,
    posts,
    categories,
    activeCategory: query.category ? parseInt(query.category) : null,
    activeFilter: query.filter || '',
    hasPosts: posts.length > 0,
  });
  sendHTML(res, html);
}

// ── Create post page ──
function createPostPage(req, res) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');
  const categories = getCategories();
  const html = renderTemplate('create-post', { user, categories, error: '' });
  sendHTML(res, html);
}

// ── Create post submit ──
async function createPostSubmit(req, res) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const ct = req.headers['content-type'] || '';
  let title, content, categoryIds, imageFile;

  if (ct.includes('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    title = (parsed.fields.title || '').trim();
    content = (parsed.fields.content || '').trim();
    categoryIds = parsed.fields.categories;
    if (categoryIds && !Array.isArray(categoryIds)) categoryIds = [categoryIds];
    imageFile = parsed.files.image;
  } else {
    const body = await parseBody(req);
    title = (body.title || '').trim();
    content = (body.content || '').trim();
    categoryIds = body.categories;
    if (categoryIds && !Array.isArray(categoryIds)) categoryIds = [categoryIds];
  }

  if (!title || !content) {
    const categories = getCategories();
    return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Le titre et le contenu sont obligatoires' }));
  }

  if (!categoryIds || categoryIds.length === 0) {
    const categories = getCategories();
    return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Sélectionnez au moins une catégorie' }));
  }

  let imagePath = '';
  if (imageFile && imageFile.data && imageFile.data.length > 0) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(imageFile.contentType)) {
      const categories = getCategories();
      return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Format d\'image non supporté (JPEG, PNG, GIF, WebP)' }));
    }
    if (imageFile.data.length > 20 * 1024 * 1024) {
      const categories = getCategories();
      return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'L\'image ne doit pas dépasser 20 Mo' }));
    }
    const ext = path.extname(imageFile.filename) || '.jpg';
    const fileName = uuidv4() + ext;
    const uploadDir = path.join(__dirname, '..', 'static', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, fileName), imageFile.data);
    imagePath = '/static/uploads/' + fileName;
  }

  const d = db.get();
  const result = d.run('INSERT INTO posts (user_id, title, content, image_path) VALUES (?, ?, ?, ?)', [user.id, title, content, imagePath]);
  const postId = result.lastInsertRowid;

  for (const catId of categoryIds) {
    try { d.run('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)', [postId, parseInt(catId)]); } catch {}
  }

  redirect(res, `/post/${postId}`);
}

// ── View post ──
function viewPost(req, res, params) {
  const user = sessionMgr.getUser(req);
  const d = db.get();

  const post = d.get(`
    SELECT p.*, u.username FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `, [parseInt(params.id)]);

  if (!post) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 404, message: 'Post introuvable' } }), 404);
  }

  enrichPost(post, user ? user.id : null);

  let comments = d.all(`
    SELECT c.*, u.username FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `, [parseInt(params.id)]);

  comments = comments.map(c => enrichComment(c, user ? user.id : null));
  post.comments = comments;
  post.hasComments = comments.length > 0;
  post.hasImage = !!post.image_path;
  post.contentHtml = escapeHtml(post.content).replace(/\n/g, '<br>');

  sendHTML(res, renderTemplate('post', { user, post }));
}

// ── Edit post page ──
function editPostPage(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const d = db.get();
  const post = d.get('SELECT * FROM posts WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!post) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  post.categories = getPostCategories(post.id);
  const postCatIds = post.categories.map(c => c.id);
  const categories = getCategories().map(c => ({ ...c, selected: postCatIds.includes(c.id) }));

  sendHTML(res, renderTemplate('edit-post', { user, post, categories, error: '' }));
}

// ── Edit post submit ──
async function editPostSubmit(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const d = db.get();
  const post = d.get('SELECT * FROM posts WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!post) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  const ct = req.headers['content-type'] || '';
  let title, content, categoryIds, imageFile;

  if (ct.includes('multipart/form-data')) {
    const parsed = await parseMultipart(req);
    title = (parsed.fields.title || '').trim();
    content = (parsed.fields.content || '').trim();
    categoryIds = parsed.fields.categories;
    if (categoryIds && !Array.isArray(categoryIds)) categoryIds = [categoryIds];
    imageFile = parsed.files.image;
  } else {
    const body = await parseBody(req);
    title = (body.title || '').trim();
    content = (body.content || '').trim();
    categoryIds = body.categories;
    if (categoryIds && !Array.isArray(categoryIds)) categoryIds = [categoryIds];
  }

  if (!title || !content) {
    const categories = getCategories();
    return sendHTML(res, renderTemplate('edit-post', { user, post, categories, error: 'Le titre et le contenu sont obligatoires' }));
  }

  let imagePath = post.image_path;
  if (imageFile && imageFile.data && imageFile.data.length > 0) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(imageFile.contentType)) {
      const categories = getCategories();
      return sendHTML(res, renderTemplate('edit-post', { user, post, categories, error: 'Format d\'image non supporté' }));
    }
    if (imageFile.data.length > 20 * 1024 * 1024) {
      const categories = getCategories();
      return sendHTML(res, renderTemplate('edit-post', { user, post, categories, error: 'Image trop volumineuse (max 20 Mo)' }));
    }
    const ext = path.extname(imageFile.filename) || '.jpg';
    const fileName = uuidv4() + ext;
    const uploadDir = path.join(__dirname, '..', 'static', 'uploads');
    fs.writeFileSync(path.join(uploadDir, fileName), imageFile.data);
    imagePath = '/static/uploads/' + fileName;
  }

  d.run('UPDATE posts SET title = ?, content = ?, image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, content, imagePath, parseInt(params.id)]);

  d.run('DELETE FROM post_categories WHERE post_id = ?', [parseInt(params.id)]);
  if (categoryIds) {
    for (const catId of categoryIds) {
      try { d.run('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)', [parseInt(params.id), parseInt(catId)]); } catch {}
    }
  }

  redirect(res, `/post/${params.id}`);
}

// ── Delete post ──
async function deletePost(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const d = db.get();
  const post = d.get('SELECT * FROM posts WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!post) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  if (post.image_path) {
    const filePath = path.join(__dirname, '..', post.image_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  d.run('DELETE FROM posts WHERE id = ?', [parseInt(params.id)]);
  redirect(res, '/');
}

// ── Add comment ──
async function addComment(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const content = (body.content || '').trim();
  if (!content) return redirect(res, `/post/${params.id}`);

  const d = db.get();
  const post = d.get('SELECT id FROM posts WHERE id = ?', [parseInt(params.id)]);
  if (!post) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 404, message: 'Post introuvable' } }), 404);
  }

  d.run('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)', [parseInt(params.id), user.id, content]);
  redirect(res, `/post/${params.id}#comments`);
}

// ── Edit comment ──
async function editComment(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const content = (body.content || '').trim();
  if (!content) return redirect(res, '/');

  const d = db.get();
  const comment = d.get('SELECT * FROM comments WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!comment) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  d.run('UPDATE comments SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [content, parseInt(params.id)]);
  redirect(res, `/post/${comment.post_id}#comments`);
}

// ── Delete comment ──
async function deleteComment(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const d = db.get();
  const comment = d.get('SELECT * FROM comments WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!comment) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  d.run('DELETE FROM comments WHERE id = ?', [parseInt(params.id)]);
  redirect(res, `/post/${comment.post_id}#comments`);
}

// ── Vote ──
async function vote(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const value = parseInt(body.value);
  const type = params.type;
  const targetId = parseInt(params.id);

  if (![1, -1].includes(value)) return redirect(res, '/');

  const d = db.get();
  const table = type === 'post' ? 'post_votes' : 'comment_votes';
  const col = type === 'post' ? 'post_id' : 'comment_id';

  const existing = d.get(`SELECT value FROM ${table} WHERE user_id = ? AND ${col} = ?`, [user.id, targetId]);

  if (existing) {
    if (existing.value === value) {
      d.run(`DELETE FROM ${table} WHERE user_id = ? AND ${col} = ?`, [user.id, targetId]);
    } else {
      d.run(`UPDATE ${table} SET value = ? WHERE user_id = ? AND ${col} = ?`, [value, user.id, targetId]);
    }
  } else {
    d.run(`INSERT INTO ${table} (user_id, ${col}, value) VALUES (?, ?, ?)`, [user.id, targetId, value]);
  }

  const referer = req.headers.referer || '/';
  redirect(res, referer);
}

module.exports = {
  homePage, createPostPage, createPostSubmit,
  viewPost, editPostPage, editPostSubmit, deletePost,
  addComment, editComment, deleteComment, vote,
};
