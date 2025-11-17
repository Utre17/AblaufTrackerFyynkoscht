(() => {
  const cfg = window.APP_CONFIG || {};
  const tz = cfg.TIMEZONE || 'Europe/Zurich';
  const supabase = (cfg.SUPABASE_URL && cfg.ANON_KEY)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.ANON_KEY)
    : null;
  let productsCache = [];
  let activeAllQuery = '';
  let minSearchQuery = '';

  // UI elements
  const navButtons = document.querySelectorAll('nav button[data-view]');
  const views = {
    auth: document.getElementById('view-auth'),
    new: document.getElementById('view-new'),
    soon: document.getElementById('view-soon'),
    all: document.getElementById('view-all'),
    min: document.getElementById('view-min'),
  };

  const el = {
    productSelect: document.getElementById('productSelect'),
    productSearch: document.getElementById('productSearch'),
    newProductName: document.getElementById('newProductName'),
    btnAddProduct: document.getElementById('btnAddProduct'),
    receivedOn: document.getElementById('receivedOn'),
    expiry: document.getElementById('expiry'),
    qty: document.getElementById('qty'),
    btnSave: document.getElementById('btnSave'),
    saveMsg: document.getElementById('saveMsg'),
    toast: document.getElementById('toast'),
    listSoon: document.getElementById('listSoon'),
    listAll: document.getElementById('listAll'),
    allSearch: document.getElementById('allSearch'),
    btnClearAllSearch: document.getElementById('btnClearAllSearch'),
    minTable: document.getElementById('minTable'),
    producerFilter: document.getElementById('producerFilter'),
    chips: document.querySelectorAll('.chip[data-add-days]'),
    authEmail: document.getElementById('authEmail'),
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    btnLogin: document.getElementById('btnLogin'),
    btnNavLogin: document.getElementById('btnNavLogin'),
    btnNavLogout: document.getElementById('btnNavLogout'),
    // Import/Export
    productCSV: document.getElementById('productCSV'),
    btnImportCSV: document.getElementById('btnImportCSV'),
    btnExportCSV: document.getElementById('btnExportCSV'),
    importMsg: document.getElementById('importMsg'),
    btnClearSearch: document.getElementById('btnClearSearch'),
    minSearch: document.getElementById('minSearch'),
    btnClearMinSearch: document.getElementById('btnClearMinSearch'),
  };

  // Helpers
  let _toastTimer = null;
  function showToast(message, durationMs) {
    try {
      const ms = typeof durationMs === 'number' ? durationMs : 1600;
      if (!el.toast) return;
      el.toast.textContent = String(message || '');
      el.toast.classList.add('show');
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => { el.toast.classList.remove('show'); }, ms);
    } catch (_) {}
  }

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  function filterProductOptions(query) {
    const q = normalizeName(query || '');
    const opts = el.productSelect ? el.productSelect.querySelectorAll('option') : [];
    if (!opts || opts.length === 0) return;
    const visible = [];
    opts.forEach((opt, idx) => {
      if (idx === 0) { opt.hidden = false; opt.style.display = ''; return; }
      const label = normalizeName(opt.textContent || '');
      let show = !q || label.includes(q);
      if (!show && q) {
        // Also match by producer (without changing the option label)
        const pid = opt.value;
        const p = (productsCache || []).find(pp => String(pp.id) === String(pid));
        const prod = p && p.producer ? normalizeName(p.producer) : '';
        if (prod && prod.includes(q)) show = true;
      }
      opt.hidden = !show;
      opt.style.display = show ? '' : 'none';
      if (show) visible.push(opt);
    });
    // Convenience: auto-select first visible option; if none, prepare new product name field
    if (visible.length > 0) {
      el.productSelect.value = visible[0].value;
      if (el.newProductName) el.newProductName.value = '';
    } else {
      el.productSelect.value = '';
      if (el.newProductName) el.newProductName.value = (query || '').trim();
    }
  }

  const toLocalDateStr = (d) => {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var pad2 = function(n){ n = String(n); return n.length < 2 ? ('0' + n) : n; };
    return y + '-' + pad2(m) + '-' + pad2(day);
  };

  const todayLocal = () => {
    const now = new Date();
    // Keep it simple: use local browser date
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  };

  const addDays = (base, days) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };

  const fmtDate = (d) => {
    try { return new Date(d).toLocaleDateString('de-CH'); } catch { return d; }
  };

  const daysBetween = (from, to) => {
    const ms = (to - from) / (1000*60*60*24);
    return Math.round(ms);
  };

  const computeDaysToExpiry = (expiry) => {
    const t = todayLocal();
    const e = new Date(expiry);
    const diff = daysBetween(t, e);
    return diff;
  };

  function badgeForDays(days) {
    if (days <= 0) return `<span class="badge red">Heute/Überfällig</span>`;
    if (days <= 1) return `<span class="badge red">1 Tag</span>`;
    if (days <= 7) return `<span class="badge orange">≤ 7 Tage</span>`;
    if (days <= 14) return `<span class="badge">≤ 14 Tage</span>`;
    return `<span class="badge green">OK</span>`;
  }

  function setActiveView(name) {
    Object.keys(views).forEach((k) => views[k].classList.remove('active'));
    views[name].classList.add('active');
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'all' && el.allSearch) {
      try { el.allSearch.focus(); } catch (_) {}
    }
  }

  // Product name normalization and lookup (case/whitespace-insensitive)
  const normalizeName = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const findProductByName = (name) => {
    const norm = normalizeName(name);
    return productsCache.find(p => normalizeName(p.name) === norm) || null;
  };
  // Simple Levenshtein distance for fuzzy matching and a helper to find a similar product
  function lev(a, b) {
    a = normalizeName(a); b = normalizeName(b);
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        dp[j] = Math.min(
          dp[j] + 1,
          dp[j - 1] + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        prev = temp;
      }
    }
    return dp[n];
  }
  const findSimilarProduct = (name) => {
    const norm = normalizeName(name);
    if (!norm) return null;
    let best = null;
    let bestScore = Infinity;
    productsCache.forEach((p) => {
      if (p.active === false) return; // ignore inactive
      const pn = normalizeName(p.name);
      if (!pn) return;
      if (pn.includes(norm) || norm.includes(pn)) {
        const score = Math.abs(pn.length - norm.length);
        if (score < bestScore) { best = p; bestScore = score; }
        return;
      }
      const d = lev(norm, pn);
      const threshold = pn.length <= 4 ? 1 : pn.length <= 8 ? 2 : 3;
      if (d <= threshold && d < bestScore) { best = p; bestScore = d; }
    });
    return best;
  };

  // Compat versions with clean UTF-8 strings for older Safari
  function badgeForDaysCompat(days) {
    if (days <= 0) return '<span class="badge red">Heute/Überfällig</span>';
    if (days <= 1) return '<span class="badge red">1 Tag</span>';
    if (days <= 7) return '<span class="badge orange">≤ 7 Tage</span>';
    if (days <= 14) return '<span class="badge">≤ 14 Tage</span>';
    return '<span class="badge green">OK</span>';
  }

  function renderProductOptionsCompat(products) {
    el.productSelect.innerHTML = '';
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '– Produkt wählen –';
    el.productSelect.appendChild(opt);
    (products || []).filter(function(p){ return p.active !== false; }).forEach(function(p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      el.productSelect.appendChild(o);
    });
  }

  function itemRowTemplateCompat(r) {
    var qty = (r.qty != null) ? (' – Menge ' + r.qty) : '';
    var days = (typeof r.days_to_expiry === 'number') ? r.days_to_expiry : computeDaysToExpiry(r.expiry);
    var badge = badgeForDaysCompat(days);
    var todayBadge = (days === 0) ? ' <span class="badge red">Heute</span>' : '';
    return (
      '<div class="item">' +
        '<div>' +
          '<div><strong>' + (r.product_name || (r.products && r.products.name) || '') + '</strong> ' + badge + ' ' + todayBadge + '</div>' +
          '<div class="small">Eingang ' + fmtDate(r.received_on) + ' – Ablauf ' + fmtDate(r.expiry) + ' (in ' + Math.max(days,0) + ' Tagen)' + qty + '</div>' +
        '</div>' +
        '<div>' +
          '<button class="btn" data-archive="' + r.id + '">Charge erledigt/archivieren</button>' +
        '</div>' +
      '</div>'
    );
  }

  async function ensureClient() {
    if (!supabase) throw new Error('Supabase nicht konfiguriert. Bitte SUPABASE_URL & ANON_KEY in config.js setzen.');
    return supabase;
  }

  // Tiny CSV parser supporting comma/semicolon/tab delimiters and quotes
  function parseCSV(text) {
    if (!text) return [];
    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length === 0) return [];
    // Detect delimiter
    const first = lines[0];
    let delim = ',';
    if ((first.match(/;/g) || []).length > (first.match(/,/g) || []).length) delim = ';';
    if ((first.match(/\t/g) || []).length > (first.match(new RegExp('\\' + delim, 'g')) || []).length) delim = '\t';
    function splitLine(line) {
      const out = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
          else { inQ = !inQ; }
        } else if (!inQ && ch === delim) {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      out.push(cur);
      return out.map(s => s.trim());
    }
    const header = splitLine(lines[0]).map(h => h.toLowerCase());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = splitLine(lines[i]);
      const obj = {};
      header.forEach((h, idx) => { obj[h] = cols[idx] !== undefined ? cols[idx] : ''; });
      rows.push(obj);
    }
    return rows;
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v || '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'ja' || s === 'y' || s === 'wahr';
  }

  async function upsertProducts(rows) {
    await ensureClient();
    // map to expected fields
    const payload = rows
      .map(r => {
        const base = {
          name: (r.name || r.product || '').trim().replace(/\s+/g, ' '),
          // Default min_required to 0 when missing to satisfy NOT NULL
          min_required: r.min_required != null && r.min_required !== '' ? Number(r.min_required) : 0,
          // Default flags to sane values if missing to avoid NULL upserts
          below_manual: r.below_manual != null && r.below_manual !== '' ? toBool(r.below_manual) : false,
          active: r.active != null && r.active !== '' ? toBool(r.active) : true,
        };
        // Optional producer/brand string (only set if provided in CSV)
        if (r.producer != null && r.producer !== '') {
          base.producer = String(r.producer).trim();
        }
        return base;
      })
      .filter(p => p.name);
    if (payload.length === 0) return { inserted: 0 };
    // Supabase upsert on unique name
    // Batch in chunks to avoid payload limits
    const chunkSize = 100;
    let inserted = 0;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from('products')
        .upsert(chunk, { onConflict: 'name' })
        .select();
      if (error) throw error;
      inserted += (data || []).length;
    }
    // refresh cache
    await fetchProducts();
    return { inserted };
  }

  // Auth
  async function refreshAuthUI() {
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      el.btnNavLogin.style.display = 'none';
      el.btnNavLogout.style.display = '';
      el.authEmail.style.display = '';
      el.authEmail.textContent = `Angemeldet: ${user.email || ''}`;
      // If currently on auth view, switch to main
      if (views.auth.classList.contains('active')) setActiveView('new');
    } else {
      el.btnNavLogin.style.display = '';
      el.btnNavLogout.style.display = 'none';
      el.authEmail.style.display = 'none';
      el.authEmail.textContent = '';
    }
  }

  async function signIn() {
    try {
      await ensureClient();
      const email = el.loginEmail.value.trim();
      const password = el.loginPassword.value;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await refreshAuthUI();
      await loadAll();
      setActiveView('new');
    } catch (e) {
      alert('Anmeldung fehlgeschlagen: ' + e.message);
    }
  }

  async function signOut() {
    try {
      await ensureClient();
      await supabase.auth.signOut();
      await refreshAuthUI();
      await loadAll();
    } catch (e) {
      alert('Abmelden fehlgeschlagen: ' + e.message);
    }
  }

  // Data access
  async function fetchProducts() {
    await ensureClient();
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    productsCache = data || [];
    return productsCache;
  }

  async function insertProduct(name) {
    await ensureClient();
    const { data, error } = await supabase
      .from('products')
      .insert({ name })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function hasExistingActiveItem(product_id, expiry) {
    await ensureClient();
    const { data, error } = await supabase
      .from('items')
      .select('id')
      .eq('product_id', product_id)
      .eq('expiry', expiry)
      .eq('status', 'Aktiv')
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  async function saveItem({ product_id, received_on, expiry, qty }) {
    await ensureClient();
    const payload = {
      product_id,
      received_on,
      expiry,
      qty: qty ? Number(qty) : null,
      status: 'Aktiv',
      notice_level: 'Keine',
    };
    const { error } = await supabase.from('items').insert(payload);
    if (error) throw error;
  }

  async function archiveItem(id) {
    await ensureClient();
    const { error } = await supabase
      .from('items')
      .update({ status: 'Archiviert' })
      .eq('id', id);
    if (error) throw error;
  }

  async function fetchActiveSoon() {
    await ensureClient();
    // Prefer view v_items; fallback to client compute if view missing
    let rows = [];
    const { data, error } = await supabase
      .from('v_items')
      .select('*')
      .lte('days_to_expiry', 14)
      .eq('status', 'Aktiv')
      .order('expiry', { ascending: true });
    if (!error && data) {
      rows = data;
    } else {
      // fallback from base tables
      const { data: items, error: e2 } = await supabase
        .from('items')
        .select('*, products(name)')
        .eq('status', 'Aktiv');
      if (e2) throw e2;
      rows = (items || []).map(function(r){
        var o = Object.assign ? Object.assign({}, r) : (function(){ var t = {}; for (var k in r) if (Object.prototype.hasOwnProperty.call(r,k)) t[k]=r[k]; return t; })();
        o.product_name = (r.products && r.products.name) ? r.products.name : undefined;
        o.days_to_expiry = computeDaysToExpiry(r.expiry);
        return o;
      }).filter(function(r){ return r.days_to_expiry <= 14; })
        .sort((a,b) => new Date(a.expiry) - new Date(b.expiry));
    }
    return rows;
  }

  async function fetchActiveAll() {
    await ensureClient();
    let rows = [];
    const { data, error } = await supabase
      .from('v_items')
      .select('*')
      .eq('status', 'Aktiv')
      .order('expiry', { ascending: true });
    if (!error && data) {
      rows = data;
    } else {
      const { data: items, error: e2 } = await supabase
        .from('items')
        .select('*, products(name)')
        .eq('status', 'Aktiv')
        .order('expiry', { ascending: true });
      if (e2) throw e2;
      rows = (items || []).map(function(r){
        var o = Object.assign ? Object.assign({}, r) : (function(){ var t = {}; for (var k in r) if (Object.prototype.hasOwnProperty.call(r,k)) t[k]=r[k]; return t; })();
        o.product_name = (r.products && r.products.name) ? r.products.name : undefined;
        o.days_to_expiry = computeDaysToExpiry(r.expiry);
        return o;
      });
    }
    return rows;
  }

  function updateProductCacheEntry(id, patch) {
    if (!Array.isArray(productsCache)) return;
    const idx = productsCache.findIndex((p) => String(p.id) === String(id));
    if (idx >= 0) {
      productsCache[idx] = Object.assign({}, productsCache[idx], patch);
    }
  }

  async function updateProductMeta(id, patch) {
    await ensureClient();
    const { error } = await supabase.from('products').update(patch).eq('id', id);
    if (error) throw error;
  }

  // Rendering
  function renderProductOptions(products) {
    el.productSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— Produkt wählen —';
    el.productSelect.appendChild(opt);
    products.filter(p => p.active !== false).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      el.productSelect.appendChild(o);
    });
  }

  function itemRowTemplate(r) {
    const qty = r.qty != null ? ` — Menge ${r.qty}` : '';
    const days = (typeof r.days_to_expiry === 'number') ? r.days_to_expiry : computeDaysToExpiry(r.expiry);
    const badge = badgeForDays(days);
    const todayBadge = (days === 0) ? ' <span class="badge red">Heute</span>' : '';
    return `
      <div class="item">
        <div>
          <div><strong>${r.product_name || (r.products && r.products.name) || ''}</strong> ${badge} ${todayBadge}</div>
          <div class="small">Eingang ${fmtDate(r.received_on)} — Ablauf ${fmtDate(r.expiry)} (in ${Math.max(days,0)} Tagen)${qty}</div>
        </div>
        <div>
          <button class="btn" data-archive="${r.id}">Charge erledigt/archivieren</button>
        </div>
      </div>
    `;
  }

  async function renderLists() {
    try {
      const [soon, all] = await Promise.all([fetchActiveSoon(), fetchActiveAll()]);
      el.listSoon.innerHTML = soon.map(itemRowTemplateCompat).join('') || '<div class="small">Keine Einträge ≤14 Tage.</div>';
      el.listAll.innerHTML = all.map(itemRowTemplateCompat).join('') || '<div class="small">Keine aktiven Einträge.</div>';
      attachArchiveHandlers();
      applyAllSearchFilter();
    } catch (e) {
      el.listSoon.innerHTML = `<div class="small">Fehler: ${e.message}</div>`;
      el.listAll.innerHTML = `<div class="small">Fehler: ${e.message}</div>`;
    }
  }

  function applyAllSearchFilter() {
    if (!el.listAll) return;
    const items = Array.from(el.listAll.querySelectorAll('.item'));
    if (items.length === 0) return;
    const query = (activeAllQuery || '').trim().toLowerCase();
    let visibleCount = 0;
    items.forEach((item) => {
      const textContent = (item.textContent || '').toLowerCase();
      const show = !query || textContent.includes(query);
      item.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });
    let message = el.listAll.querySelector('.all-search-empty');
    if (visibleCount === 0) {
      if (!message) {
        message = document.createElement('div');
        message.className = 'small all-search-empty';
        el.listAll.appendChild(message);
      }
      if (query) {
        message.textContent = 'Keine Treffer für "' + activeAllQuery + '".';
      } else {
        message.textContent = 'Keine aktiven Einträge.';
      }
    } else if (message) {
      message.remove();
    }
  }

  function attachArchiveHandlers() {
    document.querySelectorAll('[data-archive]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-archive');
        if (!confirm('Charge wirklich archivieren?')) return;
        try {
          await archiveItem(id);
          await renderLists();
        } catch (e) {
          alert('Archivieren fehlgeschlagen: ' + e.message);
        }
      });
    });
  }

  function renderMinTable(products) {
    let list = Array.isArray(products) ? products.slice() : [];
    if (el.producerFilter && el.producerFilter.value !== undefined) {
      const f = el.producerFilter.value;
      if (f) {
        const fn = normalizeName(f);
        list = list.filter((p) => normalizeName(p.producer || '') === fn);
      }
    }

    const search = (minSearchQuery || '').trim();
    if (search) {
      const tokens = normalizeName(search).split(' ').filter(Boolean);
      if (tokens.length > 0) {
        list = list.filter((p) => {
          const haystack = [normalizeName(p.name || ''), normalizeName(p.producer || '')].join(' ');
          return tokens.every((token) => haystack.includes(token));
        });
      }
    }

    const rows = list.map((p) => {
      const ok = !p.below_manual;
      const nameValue = escapeHtml(p.name || '');
      const producerValue = escapeHtml(p.producer || '');
      const minValue = p.min_required != null ? p.min_required : 0;
      return `
        <tr class="min-row">
          <td>
            <div class="input-edit-wrap">
              <input type="text" value="${nameValue}" data-name="${p.id}" data-original-value="${nameValue}" placeholder="Produktname" style="width:100%;" readonly />
              <button type="button" class="edit-btn" data-edit-name="${p.id}" aria-label="Produkt bearbeiten">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.7 2.3a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4l-9.2 9.2a1 1 0 0 1-.46.26l-4.2 1a1 1 0 0 1-1.21-1.21l1-4.2a1 1 0 0 1 .26-.46l9.2-9.19Zm-9.9 9.19-.56 2.35 2.35-.55 8.84-8.84-1.8-1.8-8.83 8.84Zm11.4-10.2-1.08 1.07 1.8 1.8 1.07-1.07-1.8-1.8Z"></path></svg>
              </button>
            </div>
          </td>
          <td>
            <div class="input-edit-wrap">
              <input type="text" value="${producerValue}" data-producer="${p.id}" data-original-value="${producerValue}" placeholder="Produzent" style="width:100%;" readonly />
              <button type="button" class="edit-btn" data-edit-producer="${p.id}" aria-label="Produzent bearbeiten">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.7 2.3a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4l-9.2 9.2a1 1 0 0 1-.46.26l-4.2 1a1 1 0 0 1-1.21-1.21l1-4.2a1 1 0 0 1 .26-.46l9.2-9.19Zm-9.9 9.19-.56 2.35 2.35-.55 8.84-8.84-1.8-1.8-8.83 8.84Zm11.4-10.2-1.08 1.07 1.8 1.8 1.07-1.07-1.8-1.8Z"></path></svg>
              </button>
            </div>
          </td>
          <td>
            <input type="number" min="0" step="1" value="${minValue}" data-min="${p.id}" />
          </td>
          <td>
            <span class="status-dot" style="background:${ok ? 'var(--green)' : 'var(--red)'}"></span>
            <label style="font-weight:400;">
              <input type="checkbox" ${p.below_manual ? 'checked' : ''} data-below="${p.id}" />
              Unter Mindestbestand
            </label>
          </td>
          <td>
            <label style="font-weight:400;">
              <input type="checkbox" ${p.active !== false ? 'checked' : ''} data-active="${p.id}" />
              Aktiv
            </label>
          </td>
        </tr>
      `;
    });

    if (rows.length > 0) {
      el.minTable.innerHTML = rows.join('');
    } else {
      el.minTable.innerHTML = '<tr><td colspan="5" class="small">Keine Ergebnisse.</td></tr>';
    }

    const lockRow = (input) => {
      const row = input.closest('tr');
      if (!row) return;
      row.querySelectorAll('input[data-name], input[data-producer]').forEach((inp) => {
        inp.readOnly = true;
        inp.classList.remove('editing');
      });
    };

    const enableEditing = (btnSelector, inputSelector) => {
      el.minTable.querySelectorAll(btnSelector).forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('tr');
          if (!row) return;
          const input = row.querySelector(inputSelector);
          if (!input) return;
          input.readOnly = false;
          input.classList.add('editing');
          input.focus();
          input.select();
        });
      });
    };

    enableEditing('button[data-edit-name]', 'input[data-name]');
    enableEditing('button[data-edit-producer]', 'input[data-producer]');

    const bindTextInput = (selector, field) => {
      const attribute = selector === 'input[data-name]' ? 'data-name' : 'data-producer';
      el.minTable.querySelectorAll(selector).forEach((input) => {
        const id = input.getAttribute(attribute);
        const getOriginal = () => input.getAttribute('data-original-value') || '';
        const commit = async () => {
          const original = getOriginal();
          const next = input.value.trim();
          if (field === 'name' && !next) {
            alert('Produktname darf nicht leer sein.');
            input.value = original;
            input.focus();
            return;
          }
          if (next === original) {
            lockRow(input);
            return;
          }
          try {
            const patch = {};
            patch[field] = next || null;
            await updateProductMeta(id, patch);
            updateProductCacheEntry(id, patch);
            input.setAttribute('data-original-value', next);
            if (field === 'producer') {
              renderProducerFilter(productsCache);
            }
            renderMinTable(productsCache);
          } catch (e) {
            alert('Speichern fehlgeschlagen: ' + e.message);
            input.value = original;
            lockRow(input);
            return;
          }
          lockRow(input);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
          const key = ev.key != null ? ev.key : ev.keyCode;
          if (key === 'Enter' || key === 13) {
            ev.preventDefault();
            input.blur();
          } else if (key === 'Escape' || key === 27) {
            ev.preventDefault();
            input.value = getOriginal();
            input.blur();
          }
        });
      });
    };

    bindTextInput('input[data-name]', 'name');
    bindTextInput('input[data-producer]', 'producer');

    el.minTable.querySelectorAll('input[data-min]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-min');
        const val = Number(input.value || 0);
        try {
          await updateProductMeta(id, { min_required: val });
          updateProductCacheEntry(id, { min_required: val });
        } catch (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        }
      });
    });
    el.minTable.querySelectorAll('input[data-below]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-below');
        const val = !!input.checked;
        try {
          await updateProductMeta(id, { below_manual: val });
          updateProductCacheEntry(id, { below_manual: val });
          renderMinTable(productsCache);
        } catch (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        }
      });
    });
    el.minTable.querySelectorAll('input[data-active]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-active');
        const val = !!input.checked;
        try {
          await updateProductMeta(id, { active: val });
          updateProductCacheEntry(id, { active: val });
          renderMinTable(productsCache);
          await loadProducts();
        } catch (e) {
          alert('Speichern fehlgeschlagen: ' + e.message);
        }
      });
    });
  }

  function renderProducerFilter(products) {
    if (!el.producerFilter) return;
    const set = new Set();
    (products || []).forEach((p) => {
      const v = (p.producer || '').trim();
      if (v) set.add(v);
    });
    // Restore previously selected value from localStorage (if any)
    const stored = (function(){ try { return localStorage.getItem('producerFilter') || ''; } catch(_) { return ''; }})();
    const current = stored || el.producerFilter.value || '';
    const values = Array.from(set).sort((a,b) => a.localeCompare(b, 'de'));
    el.producerFilter.innerHTML = '<option value="">Alle Produzenten</option>' + values.map(v => `
      <option value="${String(v).replace(/"/g,'&quot;')}">${v}</option>
    `).join('');
    // Restore previous selection if still present
    if (current && !values.includes(current)) {
      el.producerFilter.value = '';
    } else {
      el.producerFilter.value = current;
    }
  }

  // Loaders
  async function loadProducts() {
    const products = await fetchProducts();
    // De-duplicate by normalized name to avoid visual duplicates
    const seen = new Set();
    const unique = [];
    (products || []).filter(p => p.active !== false).forEach((p) => {
      const key = normalizeName(p.name);
      if (key && !seen.has(key)) { seen.add(key); unique.push(p); }
    });
    renderProductOptionsCompat(unique);
    if (el.productSearch && el.productSearch.value) {
      filterProductOptions(el.productSearch.value);
    }
    return products;
  }

  async function loadMin() {
    const products = await fetchProducts();
    renderProducerFilter(products);
    renderMinTable(products);
    if (el.minSearch) {
      el.minSearch.value = minSearchQuery || '';
      if (el.btnClearMinSearch) {
        el.btnClearMinSearch.style.display = minSearchQuery ? '' : 'none';
      }
    }
  }

  async function loadAll() {
    await Promise.all([loadProducts(), renderLists(), loadMin()]);
  }

  // Events
  navButtons.forEach((b) => b.addEventListener('click', () => setActiveView(b.dataset.view)));

  if (el.producerFilter) {
    el.producerFilter.addEventListener('change', () => {
      // Persist selection
      try { localStorage.setItem('producerFilter', el.producerFilter.value || ''); } catch (_) {}
      // Re-render min table with current productsCache (already fetched)
      renderMinTable(productsCache);
    });
  }

  // Import CSV
  if (el.btnImportCSV) {
    el.btnImportCSV.addEventListener('click', async () => {
      try {
        await ensureClient();
        // Require authenticated session for inserts/updates due to RLS
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { alert('Bitte zuerst anmelden (oben rechts), bevor CSV importiert wird.'); return; }
      } catch (e) {
        alert(e.message);
        return;
      }
      const file = el.productCSV && el.productCSV.files && el.productCSV.files[0];
      if (!file) { alert('Bitte CSV-Datei auswählen.'); return; }
      el.importMsg.textContent = 'Import läuft...';
      try {
        const text = await file.text();
        const rows = parseCSV(text);
        if (rows.length === 0) { el.importMsg.textContent = 'Keine Zeilen gefunden.'; return; }
        const { inserted } = await upsertProducts(rows);
        el.importMsg.textContent = `Import OK. ${inserted} Einträge verarbeitet.`;
        await loadProducts();
        await loadMin();
      } catch (e) {
        el.importMsg.textContent = 'Import fehlgeschlagen: ' + (e.message || e);
      }
    });
  }

  // Export CSV
  if (el.btnExportCSV) {
    el.btnExportCSV.addEventListener('click', async () => {
      try {
        const products = await fetchProducts();
        const header = ['name','producer','min_required','below_manual','active'];
        const lines = [header.join(',')].concat((products || []).map(p => [
          '"' + String(p.name || '').replace(/"/g,'""') + '"',
          '"' + String(p.producer || '').replace(/"/g,'""') + '"',
          p.min_required != null ? p.min_required : '',
          p.below_manual ? 'true' : 'false',
          (p.active === false) ? 'false' : 'true',
        ].join(',')));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'produkte.csv'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Export fehlgeschlagen: ' + (e.message || e));
      }
    });
  }

  el.btnAddProduct.addEventListener('click', async () => {
    const nameRaw = el.newProductName.value || '';
    const name = nameRaw.trim().replace(/\s+/g, ' ');
    if (!name) return;
    // If a product with same normalized name exists, reuse it instead of inserting
    const existing = findProductByName(name);
    if (existing) {
      el.productSelect.value = existing.id;
      el.newProductName.value = '';
      return;
    }
    // Offer to reuse a similar product if we find one
    const similar = findSimilarProduct(name);
    if (similar) {
      const ok = confirm(`Ähnliches Produkt gefunden: "${similar.name}". Stattdessen verwenden?`);
      if (ok) {
        el.productSelect.value = similar.id;
        el.newProductName.value = '';
        return;
      }
    }
    try {
      const prod = await insertProduct(name);
      el.newProductName.value = '';
      await loadProducts();
      el.productSelect.value = prod.id;
    } catch (e) {
      // If DB has a unique constraint, a duplicate may throw: try to select existing
      try {
        await loadProducts();
        const reuse = findProductByName(name);
        if (reuse) {
          el.productSelect.value = reuse.id;
          el.newProductName.value = '';
          return;
        }
      } catch (_) {}
      alert('Produkt anlegen fehlgeschlagen: ' + (e.message || e));
    }
  });

  // Default dates
  const today = todayLocal();
  el.receivedOn.value = toLocalDateStr(today);

  el.chips.forEach((chip) => chip.addEventListener('click', () => {
    const add = Number(chip.getAttribute('data-add-days'));
    const base = el.receivedOn.value ? new Date(el.receivedOn.value) : todayLocal();
    el.expiry.value = toLocalDateStr(addDays(base, add));
  }));

  if (el.productSearch) {
    let _filterTimer = null;
    el.productSearch.addEventListener('input', () => {
      if (_filterTimer) clearTimeout(_filterTimer);
      const val = el.productSearch.value;
      _filterTimer = setTimeout(() => filterProductOptions(val), 60);
      if (el.btnClearSearch) {
        el.btnClearSearch.style.display = val && val.length ? '' : 'none';
      }
    });
    // Enter key: select first match or prime new product from query
    el.productSearch.addEventListener('keydown', (ev) => {
      if ((ev.key || ev.keyCode) === 'Enter' || ev.keyCode === 13) {
        ev.preventDefault();
        const val = el.productSearch.value;
        filterProductOptions(val);
        if (el.productSelect && el.productSelect.value) {
          // Move focus to expiry for faster entry
          if (el.expiry && typeof el.expiry.focus === 'function') el.expiry.focus();
        } else if (el.newProductName) {
          el.newProductName.value = (val || '').trim();
          if (el.btnAddProduct && typeof el.btnAddProduct.focus === 'function') el.btnAddProduct.focus();
        }
      }
    });
    // Initialize clear button visibility
    if (el.btnClearSearch) {
      el.btnClearSearch.style.display = el.productSearch.value ? '' : 'none';
    }
  }

  if (el.btnClearSearch && el.productSearch) {
    el.btnClearSearch.addEventListener('click', () => {
      el.productSearch.value = '';
      if (el.btnClearSearch) el.btnClearSearch.style.display = 'none';
      filterProductOptions('');
      try { el.productSearch.focus(); } catch (_) {}
    });
  }

  if (el.allSearch) {
    let _allSearchTimer = null;
    const updateQuery = () => {
      activeAllQuery = (el.allSearch.value || '').trim();
      applyAllSearchFilter();
      if (el.btnClearAllSearch) {
        el.btnClearAllSearch.style.display = activeAllQuery ? '' : 'none';
      }
    };
    el.allSearch.addEventListener('input', () => {
      if (_allSearchTimer) clearTimeout(_allSearchTimer);
      _allSearchTimer = setTimeout(updateQuery, 80);
    });
    el.allSearch.addEventListener('keydown', (ev) => {
      const key = ev.key != null ? ev.key : ev.keyCode;
      if (key === 'Enter' || key === 13) {
        if (_allSearchTimer) clearTimeout(_allSearchTimer);
        updateQuery();
      } else if (key === 'Escape' || key === 27) {
        if (el.allSearch.value) {
          el.allSearch.value = '';
          updateQuery();
          try { el.allSearch.focus(); } catch (_) {}
        }
      }
    });
    if (el.btnClearAllSearch) {
      el.btnClearAllSearch.style.display = el.allSearch.value ? '' : 'none';
    }
  }

  if (el.btnClearAllSearch && el.allSearch) {
    el.btnClearAllSearch.addEventListener('click', () => {
      el.allSearch.value = '';
      activeAllQuery = '';
      applyAllSearchFilter();
      el.btnClearAllSearch.style.display = 'none';
      try { el.allSearch.focus(); } catch (_) {}
    });
  }

  if (el.minSearch) {
    let _minSearchTimer = null;
    const applyMinSearch = () => {
      minSearchQuery = (el.minSearch.value || '').trim();
      renderMinTable(productsCache);
      if (el.btnClearMinSearch) {
        el.btnClearMinSearch.style.display = minSearchQuery ? '' : 'none';
      }
    };
    el.minSearch.addEventListener('input', () => {
      if (_minSearchTimer) clearTimeout(_minSearchTimer);
      _minSearchTimer = setTimeout(applyMinSearch, 80);
    });
    el.minSearch.addEventListener('keydown', (ev) => {
      const key = ev.key != null ? ev.key : ev.keyCode;
      if (key === 'Enter' || key === 13) {
        if (_minSearchTimer) clearTimeout(_minSearchTimer);
        applyMinSearch();
      } else if (key === 'Escape' || key === 27) {
        if (el.minSearch.value) {
          el.minSearch.value = '';
          applyMinSearch();
          try { el.minSearch.focus(); } catch (_) {}
        }
      }
    });
    if (el.btnClearMinSearch) {
      el.btnClearMinSearch.style.display = el.minSearch.value ? '' : 'none';
    }
  }

  if (el.btnClearMinSearch && el.minSearch) {
    el.btnClearMinSearch.addEventListener('click', () => {
      el.minSearch.value = '';
      minSearchQuery = '';
      renderMinTable(productsCache);
      el.btnClearMinSearch.style.display = 'none';
      try { el.minSearch.focus(); } catch (_) {}
    });
  }

  el.btnSave.addEventListener('click', async () => {
    const product_id = el.productSelect.value;
    const received_on = el.receivedOn.value;
    const expiry = el.expiry.value;
    const qty = el.qty.value ? Number(el.qty.value) : null;
    if (!product_id) { alert('Bitte Produkt wählen.'); return; }
    if (!expiry) { alert('Bitte Ablaufdatum wählen.'); return; }
    try {
      const exists = await hasExistingActiveItem(product_id, expiry);
      if (exists) {
        const msg = 'Eintrag existiert bereits für dieses Ablaufdatum.';
        el.saveMsg.textContent = msg;
        showToast(msg, 2200);
        return;
      }
      await saveItem({ product_id, received_on, expiry, qty });
      el.saveMsg.textContent = 'Gespeichert.';
      showToast('gespeichert');
      el.qty.value = '';
      el.expiry.value = '';
      await renderLists();
    } catch (e) {
      el.saveMsg.textContent = 'Fehler: ' + e.message;
    }
  });

  el.btnLogin.addEventListener('click', signIn);
  el.btnNavLogin.addEventListener('click', () => setActiveView('auth'));
  el.btnNavLogout.addEventListener('click', signOut);

  // Init
  (async function init() {
    if (supabase) {
      supabase.auth.onAuthStateChange(() => { refreshAuthUI(); });
      await refreshAuthUI();
    }
    await loadAll();
  })();
})();
