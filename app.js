'use strict';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Recipe Book';
const DATA_FILE = 'recipes.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'recipeBook.token';

const state = { token: null, user: null, folderId: null, dataFileId: null, recipes: [], images: new Map() };
let tokenClient = null;
const $app = document.getElementById('app');

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------------- auth ---------------- */
function initAuth() {
  if (!window.google?.accounts?.oauth2) return setTimeout(initAuth, 100);
  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.startsWith('YOUR_')) {
    $app.innerHTML = `<div class="login"><h1>Setup needed</h1>
      <p>Add your Google OAuth client ID to <code>config.js</code>. See README.md.</p></div>`;
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: onToken,
    error_callback: () => toast('Sign-in was cancelled.'),
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expires > Date.now() + 60000) {
      state.token = saved.token;
      return start();
    }
  } catch { /* ignore */ }
  renderLogin();
}

function onToken(resp) {
  if (resp.error) return toast('Sign-in failed: ' + resp.error);
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
    return renderLogin('Please allow access to Google Drive so your recipes can be saved.');
  }
  state.token = resp.access_token;
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: resp.access_token, expires: Date.now() + resp.expires_in * 1000 }));
  } catch { /* ignore */ }
  start();
}

function signOut(message) {
  state.token = null;
  state.user = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  state.images.forEach(url => URL.revokeObjectURL(url));
  state.images.clear();
  document.getElementById('nav').hidden = true;
  location.hash = '';
  renderLogin(message);
}

function renderLogin(message) {
  $app.innerHTML = `<div class="login">
    <h1>Recipe Book</h1>
    <p class="muted">Sign in with Google. Your recipes are saved to a <b>Recipe Book</b> folder in your Google Drive.</p>
    ${message ? `<p>${esc(message)}</p>` : ''}
    <button class="btn primary" id="signInBtn" type="button">Sign in with Google</button>
  </div>`;
  document.getElementById('signInBtn').onclick = () => tokenClient.requestAccessToken({ prompt: '' });
}

async function start() {
  $app.innerHTML = '<p class="muted center">Loading your recipes…</p>';
  try {
    const user = await (await api('https://www.googleapis.com/oauth2/v3/userinfo')).json();
    state.user = { name: user.name || user.email, email: user.email };
    document.getElementById('userName').textContent = state.user.name;
    document.getElementById('nav').hidden = false;
    await ensureStorage();
    state.recipes = (await readData()).recipes;
    route();
  } catch (e) {
    if (e.status !== 401) {
      console.error(e);
      $app.innerHTML = `<div class="login"><h1>Something went wrong</h1><p>${esc(e.message)}</p>
        <button class="btn" onclick="location.reload()">Try again</button></div>`;
    }
  }
}

/* ---------------- Google Drive ---------------- */
async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + state.token } });
  if (res.status === 401) {
    signOut('Your session expired. Please sign in again.');
    throw Object.assign(new Error('Session expired'), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Google API error ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  }
  return res;
}

async function findFile(q) {
  const url = `${DRIVE}/files?spaces=drive&fields=files(id,name)&q=${encodeURIComponent(q + ' and trashed=false')}`;
  const { files } = await (await api(url)).json();
  return files[0] || null;
}

function multipart(method, url, metadata, blob) {
  const b = 'rb' + uid();
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${b}\r\nContent-Type: ${blob.type}\r\n\r\n`, blob, `\r\n--${b}--`,
  ]);
  return api(url, { method, headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body }).then(r => r.json());
}

async function ensureStorage() {
  let folder = await findFile(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder'`);
  if (!folder) {
    folder = await (await api(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    })).json();
  }
  state.folderId = folder.id;
  let file = await findFile(`name='${DATA_FILE}' and '${folder.id}' in parents`);
  if (!file) {
    const blob = new Blob([JSON.stringify({ version: 1, recipes: [] }, null, 2)], { type: 'application/json' });
    file = await multipart('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, { name: DATA_FILE, parents: [folder.id] }, blob);
  }
  state.dataFileId = file.id;
}

async function readData() {
  const data = await (await api(`${DRIVE}/files/${state.dataFileId}?alt=media`)).json();
  if (!Array.isArray(data.recipes)) data.recipes = [];
  return data;
}

async function writeData(data) {
  await api(`${UPLOAD}/files/${state.dataFileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data, null, 2),
  });
}

/** Re-read the latest data, apply a change, write it back (reduces clobbering from other devices). */
async function mutate(fn) {
  const data = await readData();
  fn(data.recipes);
  data.version = 1;
  await writeData(data);
  state.recipes = data.recipes;
}

async function uploadImage(blob, name) {
  const file = await multipart('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`,
    { name, parents: [state.folderId] }, blob);
  return file.id;
}

async function trashFile(id) {
  try {
    await api(`${DRIVE}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  } catch (e) { console.warn('Could not trash file', id, e); }
}

async function imageUrl(id) {
  if (!state.images.has(id)) {
    const blob = await (await api(`${DRIVE}/files/${id}?alt=media`)).blob();
    state.images.set(id, URL.createObjectURL(blob));
  }
  return state.images.get(id);
}

function hydrateImages() {
  $app.querySelectorAll('img[data-img]').forEach(async img => {
    try { img.src = await imageUrl(img.dataset.img); } catch { img.alt = 'Photo unavailable'; }
  });
}

async function resizeImage(file, max = 1400) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------------- routing & views ---------------- */
function route() {
  if (!state.token || !state.user) return;
  const [, view, id] = (location.hash || '#/').split('/');
  if (view === 'r' && id) return renderRecipe(id);
  if (view === 'new') return renderForm();
  if (view === 'edit' && id) return renderForm(id);
  renderList();
}
window.addEventListener('hashchange', route);

const listFilter = { q: '', cat: '' };

function renderList() {
  const cats = [...new Set(state.recipes.map(r => r.category).filter(Boolean))].sort();
  $app.innerHTML = `
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search recipes or ingredients…" value="${esc(listFilter.q)}">
      <select id="cat"><option value="">All categories</option>
        ${cats.map(c => `<option ${c === listFilter.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div id="results"></div>`;
  const draw = () => {
    const q = listFilter.q.toLowerCase();
    const items = state.recipes
      .filter(r => !listFilter.cat || r.category === listFilter.cat)
      .filter(r => !q || [r.title, r.category, ...(r.ingredients || [])].join(' ').toLowerCase().includes(q))
      .sort(byTitle);
    const el = document.getElementById('results');
    if (!state.recipes.length) {
      el.innerHTML = `<div class="empty"><p>No recipes yet.</p><a class="btn primary" href="#/new">Add your first recipe</a></div>`;
      return;
    }
    el.innerHTML = items.length ? `<div class="grid">${items.map(r => `
      <a class="card" href="#/r/${esc(r.id)}">
        ${r.imageId ? `<img class="thumb" data-img="${esc(r.imageId)}" alt="">` : `<div class="thumb placeholder">🍽️</div>`}
        <div class="body"><h3>${esc(r.title)}</h3><div class="tag">${esc(r.category || '')}</div></div>
      </a>`).join('')}</div>` : '<p class="empty">No matching recipes.</p>';
    hydrateImages();
  };
  document.getElementById('q').oninput = e => { listFilter.q = e.target.value; draw(); };
  document.getElementById('cat').onchange = e => { listFilter.cat = e.target.value; draw(); };
  draw();
}

function renderRecipe(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) { $app.innerHTML = '<p class="empty">Recipe not found. <a href="#/">Back</a></p>'; return; }
  const meta = [
    r.category && `<span>📂 ${esc(r.category)}</span>`,
    r.servings && `<span>🍽️ Serves ${esc(r.servings)}</span>`,
    r.prepTime && `<span>⏱️ Prep ${esc(r.prepTime)}</span>`,
    r.cookTime && `<span>🔥 Cook ${esc(r.cookTime)}</span>`,
  ].filter(Boolean).join('');
  $app.innerHTML = `
    <p><a href="#/">← All recipes</a></p>
    <article class="recipe">
      <h1>${esc(r.title)}</h1>
      <div class="meta">${meta}</div>
      ${r.imageId ? `<img class="hero" data-img="${esc(r.imageId)}" alt="${esc(r.title)}">` : ''}
      <div class="cols">
        <section><h2>Ingredients</h2><ul>${(r.ingredients || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>
        <section><h2>Instructions</h2><ol>${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol></section>
      </div>
      ${r.notes ? `<section><h2>Notes</h2><p>${esc(r.notes).replace(/\n/g, '<br>')}</p></section>` : ''}
      <p class="muted">Added by ${esc(r.createdBy || 'unknown')}${r.updatedAt ? ' · updated ' + new Date(r.updatedAt).toLocaleDateString() : ''}</p>
      <div class="actions">
        <a class="btn" href="#/edit/${esc(r.id)}">Edit</a>
        <button class="btn danger" id="delBtn" type="button">Delete</button>
      </div>
    </article>`;
  hydrateImages();
  document.getElementById('delBtn').onclick = async e => {
    if (!confirm(`Delete "${r.title}"?`)) return;
    e.target.disabled = true;
    try {
      await mutate(list => { const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1); });
      if (r.imageId) await trashFile(r.imageId);
      toast('Recipe deleted.');
      location.hash = '#/';
    } catch (err) { e.target.disabled = false; toast(err.message); }
  };
}

function renderForm(id) {
  const r = id ? state.recipes.find(x => x.id === id) : null;
  if (id && !r) { $app.innerHTML = '<p class="empty">Recipe not found. <a href="#/">Back</a></p>'; return; }
  const v = r || {};
  const cats = [...new Set(['Breakfast', 'Appetizers', 'Soups', 'Salads', 'Mains', 'Sides', 'Desserts', 'Drinks',
    ...state.recipes.map(x => x.category).filter(Boolean)])].sort();
  $app.innerHTML = `
    <p><a href="${r ? '#/r/' + esc(r.id) : '#/'}">← Cancel</a></p>
    <form class="recipe-form" id="form">
      <h1>${r ? 'Edit recipe' : 'Add a recipe'}</h1>
      <label>Title <input name="title" required maxlength="120" value="${esc(v.title)}"></label>
      <div class="row">
        <label>Category <input name="category" list="cats" value="${esc(v.category)}">
          <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label>Servings <input name="servings" value="${esc(v.servings)}" placeholder="4"></label>
        <label>Prep time <input name="prepTime" value="${esc(v.prepTime)}" placeholder="15 min"></label>
        <label>Cook time <input name="cookTime" value="${esc(v.cookTime)}" placeholder="30 min"></label>
      </div>
      <label>Ingredients <span class="hint">one per line</span>
        <textarea name="ingredients" required>${esc((v.ingredients || []).join('\n'))}</textarea></label>
      <label>Instructions <span class="hint">one step per line</span>
        <textarea name="steps" required>${esc((v.steps || []).join('\n'))}</textarea></label>
      <label>Notes <span class="hint">optional</span>
        <textarea name="notes" style="min-height:80px">${esc(v.notes)}</textarea></label>
      <label>Photo <span class="hint">optional</span>
        <input name="photo" type="file" accept="image/*">
        ${v.imageId ? `<img class="preview-img" data-img="${esc(v.imageId)}" alt="">
          <span class="hint"><input type="checkbox" name="removePhoto" style="width:auto"> Remove current photo</span>` : ''}
        <img class="preview-img" id="newPreview" hidden alt="">
      </label>
      <div class="actions"><button class="btn primary" id="saveBtn">${r ? 'Save changes' : 'Add recipe'}</button></div>
    </form>`;
  hydrateImages();
  const form = document.getElementById('form');
  form.photo.onchange = () => {
    const f = form.photo.files[0];
    const p = document.getElementById('newPreview');
    p.hidden = !f;
    if (f) p.src = URL.createObjectURL(f);
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const fd = new FormData(form);
      let imageId = v.imageId || null;
      const oldImage = imageId;
      const file = form.photo.files[0];
      if (file) {
        const blob = await resizeImage(file);
        imageId = await uploadImage(blob, `${fd.get('title').trim() || 'recipe'}.jpg`);
      } else if (fd.get('removePhoto')) {
        imageId = null;
      }
      const now = new Date().toISOString();
      const rec = {
        id: v.id || uid(),
        title: fd.get('title').trim(),
        category: fd.get('category').trim(),
        servings: fd.get('servings').trim(),
        prepTime: fd.get('prepTime').trim(),
        cookTime: fd.get('cookTime').trim(),
        ingredients: lines(fd.get('ingredients')),
        steps: lines(fd.get('steps')),
        notes: fd.get('notes').trim(),
        imageId,
        createdBy: v.createdBy || state.user.email,
        createdAt: v.createdAt || now,
        updatedAt: now,
      };
      await mutate(list => {
        const i = list.findIndex(x => x.id === rec.id);
        if (i >= 0) list[i] = rec; else list.push(rec);
      });
      if (oldImage && oldImage !== imageId) await trashFile(oldImage);
      toast(r ? 'Recipe updated.' : 'Recipe added.');
      location.hash = '#/r/' + rec.id;
    } catch (err) {
      console.error(err);
      toast(err.message);
      btn.disabled = false;
      btn.textContent = r ? 'Save changes' : 'Add recipe';
    }
  };
}

/* ---------------- PDF book ---------------- */
// jsPDF's built-in fonts only cover Latin-1, so map common cooking characters.
function pdfText(s) {
  const map = { '⅓': '1/3', '⅔': '2/3', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅕': '1/5',
    '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', '•': '-', ' ': ' ' };
  return String(s || '').replace(/[^\x00-\xff]/g, c => map[c] ?? '');
}

async function imageForPdf(id) {
  const url = await imageUrl(id);
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return { data: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height };
}

async function downloadPdf() {
  if (!state.recipes.length) return toast('Add some recipes first.');
  const btn = document.getElementById('pdfBtn');
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 56;
    const CW = W - 2 * M;
    const ACCENT = [181, 83, 44];

    // Group by category, then title.
    const groups = new Map();
    [...state.recipes].sort(byTitle).forEach(r => {
      const c = r.category || 'Other';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(r);
    });
    const cats = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));

    // Cover
    doc.setFont('times', 'bold').setFontSize(40).setTextColor(...ACCENT);
    doc.text('Recipe Book', W / 2, H / 2 - 20, { align: 'center' });
    doc.setFont('times', 'normal').setFontSize(14).setTextColor(90);
    doc.text(pdfText(`${state.recipes.length} recipes`), W / 2, H / 2 + 14, { align: 'center' });
    doc.text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      W / 2, H / 2 + 34, { align: 'center' });

    // Reserve table-of-contents pages.
    const TOC_LINE = 18;
    const tocLines = cats.reduce((n, c) => n + 1.6 + groups.get(c).length, 0);
    const firstTocCap = Math.floor((H - 2 * M - 50) / TOC_LINE);
    const tocCap = Math.floor((H - 2 * M) / TOC_LINE);
    const tocPages = 1 + Math.max(0, Math.ceil((tocLines - firstTocCap) / tocCap));
    for (let i = 0; i < tocPages; i++) doc.addPage();

    // Recipes
    const pageOf = new Map();
    let y = M;
    const need = h => { if (y + h > H - M) { doc.addPage(); y = M; } };
    const para = (text, size, opts = {}) => {
      doc.setFontSize(size);
      const indent = opts.indent || 0;
      const wrapped = doc.splitTextToSize(pdfText(text), CW - indent);
      const lh = size * 1.35;
      wrapped.forEach((ln, i) => {
        need(lh);
        if (i === 0 && opts.marker) opts.marker(y);
        doc.text(ln, M + indent, y + size);
        y += lh;
      });
    };

    for (const cat of cats) {
      for (const r of groups.get(cat)) {
        doc.addPage();
        y = M;
        pageOf.set(r.id, doc.getNumberOfPages());

        doc.setFont('helvetica', 'normal').setTextColor(...ACCENT);
        para(cat.toUpperCase(), 9);
        doc.setFont('times', 'bold').setTextColor(30);
        para(r.title, 26);
        const meta = [r.servings && `Serves ${r.servings}`, r.prepTime && `Prep ${r.prepTime}`, r.cookTime && `Cook ${r.cookTime}`]
          .filter(Boolean).join('   |   ');
        if (meta) { doc.setFont('helvetica', 'normal').setTextColor(110); para(meta, 10); }
        y += 8;
        doc.setDrawColor(...ACCENT).setLineWidth(1).line(M, y, W - M, y);
        y += 14;

        if (r.imageId) {
          try {
            const im = await imageForPdf(r.imageId);
            const maxH = 250;
            let w = CW, h = (im.h / im.w) * CW;
            if (h > maxH) { h = maxH; w = (im.w / im.h) * maxH; }
            need(h + 12);
            doc.addImage(im.data, 'JPEG', M + (CW - w) / 2, y, w, h);
            y += h + 16;
          } catch (e) { console.warn('Skipping image', e); }
        }

        const heading = t => {
          y += 6;
          need(40);
          doc.setFont('times', 'bold').setTextColor(...ACCENT);
          para(t, 15);
          y += 4;
          doc.setFont('helvetica', 'normal').setTextColor(40);
        };

        heading('Ingredients');
        (r.ingredients || []).forEach(i => para(i, 11, {
          indent: 14, marker: yy => { doc.setFillColor(...ACCENT); doc.circle(M + 4, yy + 7, 1.8, 'F'); },
        }));
        heading('Instructions');
        (r.steps || []).forEach((s, n) => {
          para(s, 11, { indent: 22, marker: yy => { doc.setFont('helvetica', 'bold'); doc.text(`${n + 1}.`, M, yy + 11); doc.setFont('helvetica', 'normal'); } });
          y += 4;
        });
        if (r.notes) {
          heading('Notes');
          doc.setFont('helvetica', 'italic');
          para(r.notes, 11);
        }
      }
    }

    // Fill table of contents
    let tocPage = 2;
    doc.setPage(tocPage);
    y = M;
    doc.setFont('times', 'bold').setFontSize(28).setTextColor(30);
    doc.text('Contents', M, y + 24);
    y += 50;
    const tocNeed = h => { if (y + h > H - M) { doc.setPage(++tocPage); y = M; } };
    for (const cat of cats) {
      tocNeed(TOC_LINE * 2.6);
      y += TOC_LINE * 0.6;
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ACCENT);
      doc.text(pdfText(cat.toUpperCase()), M, y + 11);
      y += TOC_LINE;
      for (const r of groups.get(cat)) {
        tocNeed(TOC_LINE);
        const pg = pageOf.get(r.id);
        doc.setFont('times', 'normal').setFontSize(12).setTextColor(30);
        const full = pdfText(r.title);
        let title = full;
        const pgStr = String(pg);
        const pgW = doc.getTextWidth(pgStr);
        const maxTitle = CW - pgW - 40;
        while (doc.getTextWidth(title + '...') > maxTitle && title.length > 3) title = title.slice(0, -1);
        if (title !== full) title = title.trimEnd() + '...';
        const tW = doc.getTextWidth(title);
        doc.text(title, M + 12, y + 12);
        doc.text(pgStr, W - M, y + 12, { align: 'right' });
        doc.setTextColor(170);
        const dotsW = W - M - pgW - 6 - (M + 12 + tW + 6);
        const dot = doc.getTextWidth('.');
        if (dotsW > dot) doc.text('.'.repeat(Math.floor(dotsW / dot)), M + 12 + tW + 6, y + 12);
        doc.link(M, y, CW, TOC_LINE, { pageNumber: pg });
        y += TOC_LINE;
      }
    }

    // Page numbers (skip cover)
    const total = doc.getNumberOfPages();
    for (let p = 2; p <= total; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(140);
      doc.text(String(p), W / 2, H - 28, { align: 'center' });
    }

    doc.save('recipe-book.pdf');
  } catch (e) {
    console.error(e);
    toast('Could not build PDF: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download PDF';
  }
}

/* ---------------- boot ---------------- */
document.getElementById('pdfBtn').onclick = downloadPdf;
document.getElementById('signOutBtn').onclick = () => signOut();
initAuth();
