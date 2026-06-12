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

function enrichComment(comment, userId, postAuthorId) {
  const votes = getVoteCounts(comment.id, 'comment');
  comment.likes = votes.likes;
  comment.dislikes = votes.dislikes;
  comment.userVote = getUserVote(userId, comment.id, 'comment');
  comment.isOwner = userId && comment.user_id === userId;
  comment.timeAgo = timeAgo(comment.created_at);

  const reply = db.get().get(`
    SELECT r.content, r.created_at, u.username
    FROM comment_replies r
    JOIN users u ON r.user_id = u.id
    WHERE r.comment_id = ?
  `, [comment.id]);
  comment.reply = reply || null;
  comment.hasReply = !!reply;
  if (reply) comment.reply.timeAgo = timeAgo(reply.created_at);

  comment.canReply = !!(userId && postAuthorId && userId === postAuthorId && !reply);

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

function createPostPage(req, res) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');
  const categories = getCategories();
  const html = renderTemplate('create-post', { user, categories, error: '' });
  sendHTML(res, html);
}

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
    const categories = getCategories().map(c => ({ ...c, selected: categoryIds && categoryIds.includes(String(c.id)) }));
    return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Le titre et le contenu sont obligatoires', title, content }));
  }

  if (!categoryIds || categoryIds.length === 0) {
    const categories = getCategories().map(c => ({ ...c, selected: categoryIds && categoryIds.includes(String(c.id)) }));
    return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Sélectionnez au moins une catégorie', title, content }));
  }

  let imagePath = '';
  if (imageFile && imageFile.data && imageFile.data.length > 0) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(imageFile.contentType)) {
      const categories = getCategories().map(c => ({ ...c, selected: categoryIds && categoryIds.includes(String(c.id)) }));
      return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'Format d\'image non supporté (JPEG, PNG, GIF, WebP)', title, content }));
    }
    if (imageFile.data.length > 20 * 1024 * 1024) {
      const categories = getCategories().map(c => ({ ...c, selected: categoryIds && categoryIds.includes(String(c.id)) }));
      return sendHTML(res, renderTemplate('create-post', { user, categories, error: 'L\'image ne doit pas dépasser 20 Mo', title, content }));
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

  comments = comments.map(c => enrichComment(c, user ? user.id : null, post.user_id));
  post.comments = comments;
  post.hasComments = comments.length > 0;
  post.hasImage = !!post.image_path;
  post.contentHtml = escapeHtml(post.content).replace(/\n/g, '<br>');

  sendHTML(res, renderTemplate('post', { user, post }));
}

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
    post.categories = getPostCategories(post.id);
    const postCatIds = post.categories.map(c => c.id);
    const categories = getCategories().map(c => ({ ...c, selected: postCatIds.includes(c.id) }));
    return sendHTML(res, renderTemplate('edit-post', { user, post: { ...post, title, content }, categories, error: 'Le titre et le contenu sont obligatoires' }));
  }

  let imagePath = post.image_path;
  if (imageFile && imageFile.data && imageFile.data.length > 0) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(imageFile.contentType)) {
      post.categories = getPostCategories(post.id);
      const postCatIds = post.categories.map(c => c.id);
      const categories = getCategories().map(c => ({ ...c, selected: postCatIds.includes(c.id) }));
      return sendHTML(res, renderTemplate('edit-post', { user, post: { ...post, title, content }, categories, error: 'Format d\'image non supporté' }));
    }
    if (imageFile.data.length > 20 * 1024 * 1024) {
      post.categories = getPostCategories(post.id);
      const postCatIds = post.categories.map(c => c.id);
      const categories = getCategories().map(c => ({ ...c, selected: postCatIds.includes(c.id) }));
      return sendHTML(res, renderTemplate('edit-post', { user, post: { ...post, title, content }, categories, error: 'Image trop volumineuse (max 20 Mo)' }));
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

async function editComment(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const content = (body.content || '').trim();

  const d = db.get();
  const comment = d.get('SELECT * FROM comments WHERE id = ? AND user_id = ?', [parseInt(params.id), user.id]);
  if (!comment) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Accès refusé' } }), 403);
  }

  if (!content) return redirect(res, `/post/${comment.post_id}#comments`);

  d.run('UPDATE comments SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [content, parseInt(params.id)]);
  redirect(res, `/post/${comment.post_id}#comments`);
}

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

async function replyComment(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const content = (body.content || '').trim();
  if (!content) return redirect(res, `/post/${params.postId}#comments`);

  const d = db.get();
  const comment = d.get('SELECT * FROM comments WHERE id = ?', [parseInt(params.commentId)]);
  if (!comment) return redirect(res, '/');

  const post = d.get('SELECT user_id FROM posts WHERE id = ?', [comment.post_id]);

  if (!post || post.user_id !== user.id) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 403, message: 'Seul l\'auteur du post peut répondre' } }), 403);
  }

  const existing = d.get('SELECT id FROM comment_replies WHERE comment_id = ?', [comment.id]);
  if (existing) return redirect(res, `/post/${comment.post_id}#comments`);

  d.run('INSERT INTO comment_replies (comment_id, user_id, content) VALUES (?, ?, ?)', [comment.id, user.id, content]);
  redirect(res, `/post/${comment.post_id}#comments`);
}

function inboxPage(req, res) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const d = db.get();

  const conversations = d.all(`
    SELECT
      CASE WHEN pm.sender_id = ? THEN pm.receiver_id ELSE pm.sender_id END AS other_id,
      u.username AS other_username,
      MAX(pm.created_at) AS last_at,
      SUM(CASE WHEN pm.receiver_id = ? AND pm.read_at IS NULL THEN 1 ELSE 0 END) AS unread
    FROM private_messages pm
    JOIN users u ON u.id = CASE WHEN pm.sender_id = ? THEN pm.receiver_id ELSE pm.sender_id END
    WHERE pm.sender_id = ? OR pm.receiver_id = ?
    GROUP BY other_id
    ORDER BY last_at DESC
  `, [user.id, user.id, user.id, user.id, user.id]);

  conversations.forEach(function(c) { c.timeAgo = timeAgo(c.last_at); });

  sendHTML(res, renderTemplate('messages', { user, conversations, hasConversations: conversations.length > 0 }));
}

function conversationPage(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const otherId = parseInt(params.userId);
  const d = db.get();

  const other = d.get('SELECT id, username FROM users WHERE id = ?', [otherId]);
  if (!other) {
    return sendHTML(res, renderTemplate('error', { user, error: { code: 404, message: 'Utilisateur introuvable' } }), 404);
  }

  d.run('UPDATE private_messages SET read_at = CURRENT_TIMESTAMP WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL', [user.id, otherId]);

  const messages = d.all(`
    SELECT pm.*, u.username AS sender_username
    FROM private_messages pm
    JOIN users u ON u.id = pm.sender_id
    WHERE (pm.sender_id = ? AND pm.receiver_id = ?) OR (pm.sender_id = ? AND pm.receiver_id = ?)
    ORDER BY pm.created_at ASC
  `, [user.id, otherId, otherId, user.id]);

  messages.forEach(function(m) {
    m.isMine = m.sender_id === user.id;
    m.timeAgo = timeAgo(m.created_at);
  });

  sendHTML(res, renderTemplate('messages', { user, other, messages, hasMessages: messages.length > 0, isConversation: true }));
}

async function sendMessage(req, res, params) {
  const user = sessionMgr.getUser(req);
  if (!user) return redirect(res, '/login');

  const body = await parseBody(req);
  const content = (body.content || '').trim();
  const receiverId = parseInt(params.userId);

  if (!content) return redirect(res, `/messages/${receiverId}`);
  if (receiverId === user.id) return redirect(res, '/messages');

  const d = db.get();
  const receiver = d.get('SELECT id FROM users WHERE id = ?', [receiverId]);
  if (!receiver) return redirect(res, '/messages');

  d.run('INSERT INTO private_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [user.id, receiverId, content]);
  redirect(res, `/messages/${receiverId}`);
}

module.exports = {
  homePage, createPostPage, createPostSubmit,
  viewPost, editPostPage, editPostSubmit, deletePost,
  addComment, editComment, deleteComment, vote,
  replyComment, inboxPage, conversationPage, sendMessage,
};
