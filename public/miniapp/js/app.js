/* global window, document, Api, Ingest */
'use strict';

(() => {
  const TG = window.TG;
  const root = document.getElementById('root');
  const tabbar = document.getElementById('tabbar');

  // ------------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------------

  /**
   * Build an element. Children that are strings become text nodes, never
   * markup — a filename is data, and a library full of other people's release
   * names is exactly the place a stray `<img onerror>` would land.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function fill(node, ...children) {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // ------------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------------

  function bytes(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Math.abs(n);
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function duration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return null;
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s} sec`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function relative(value) {
    if (!value) return '—';
    const diff = Date.now() - new Date(value).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(value).toLocaleDateString();
  }

  const STATUS = {
    RECEIVED: { label: 'Received', tone: 'busy' },
    QUEUED: { label: 'Queued', tone: 'busy' },
    DOWNLOADING: { label: 'Downloading', tone: 'busy' },
    PROCESSING: { label: 'Processing', tone: 'busy' },
    ORGANIZING: { label: 'Organising', tone: 'busy' },
    JELLYFIN_SCAN: { label: 'Adding to Jellyfin', tone: 'busy' },
    COMPLETED: { label: 'Completed', tone: 'ok' },
    FAILED: { label: 'Failed', tone: 'danger' },
    CANCELLED: { label: 'Cancelled', tone: 'neutral' },
    DUPLICATE: { label: 'Already in library', tone: 'neutral' },
    NEEDS_REVIEW: { label: 'Needs review', tone: 'warn' },
  };

  function statusBadge(status) {
    const s = STATUS[status] ?? { label: status, tone: 'neutral' };
    return el('span', { class: `badge is-${s.tone}` }, s.label);
  }

  /** What the worker is doing, in words a person recognises. */
  const STAGE_WORDS = {
    RECEIVING: 'Receiving',
    QUEUED: 'Waiting in the queue',
    FETCHING: 'Fetching from Telegram',
    DOWNLOADING: 'Downloading from Telegram',
    ASSEMBLING: 'Joining the parts',
    IDENTIFYING: 'Identifying',
    TMDB: 'Looking up details',
    ORGANIZING: 'Filing into your library',
    JELLYFIN_SCAN: 'Adding to Jellyfin',
    JELLYFIN_VERIFY: 'Checking Jellyfin can see it',
  };

  const PIPELINE = [
    { key: 'DOWNLOADING', label: 'Downloaded' },
    { key: 'IDENTIFYING', label: 'Identified' },
    { key: 'ORGANIZING', label: 'Organising' },
    { key: 'JELLYFIN_SCAN', label: 'Jellyfin scan' },
  ];

  function toast(message, kind = 'info') {
    const host = document.getElementById('toasts');
    const node = el('div', { class: `toast is-${kind}` }, message);
    host.append(node);
    setTimeout(() => node.remove(), 4200);
  }

  // ------------------------------------------------------------------------
  // Shared pieces
  // ------------------------------------------------------------------------

  function loading(label = 'Loading…') {
    return el('div', { class: 'loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
  }

  function empty({ icon = '◌', title, message, action }) {
    return el(
      'div',
      { class: 'empty' },
      el('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
      el('h3', {}, title),
      message ? el('p', {}, message) : null,
      action ?? null,
    );
  }

  /**
   * A failure the reader can act on.
   *
   * Always offers a retry: nearly everything that fails here is a phone
   * changing networks, and a dead end would be the wrong answer to that.
   */
  function errorBox(err, onRetry) {
    // A credential Telegram signed once and will not sign again: retrying
    // re-sends the same expired blob, so the only useful thing to offer is
    // the way out.
    if (err?.status === 401) {
      queueMicrotask(() => expired());
      return el('div', { class: 'error-box' }, el('p', {}, 'Your sign-in has expired.'));
    }
    return el(
      'div',
      { class: 'error-box' },
      el('span', { class: 'error-icon', 'aria-hidden': 'true' }, '⚠'),
      el('h3', {}, 'Could not load this'),
      el('p', {}, err?.message ?? 'Something went wrong.'),
      onRetry ? el('button', { class: 'btn btn-primary', type: 'button', onclick: onRetry }, 'Try again') : null,
    );
  }

  function skeletonGrid(count = 6) {
    return el(
      'div',
      { class: 'grid' },
      Array.from({ length: count }, () =>
        el(
          'div',
          {},
          el('div', { class: 'skeleton skeleton-poster' }),
          el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
        ),
      ),
    );
  }

  /**
   * Live progress, or an honest absence of it.
   *
   * `byteAccurate` is the worker's own record of whether the percentage came
   * from counting bytes or from the upload's position in the pipeline. The two
   * are labelled differently and a stage estimate never gets a speed or an
   * ETA, because inventing one would be inventing a measurement.
   */
  function progressBlock(upload) {
    const p = upload.progress ?? {};
    const stage = STAGE_WORDS[p.stage] ?? STATUS[upload.status]?.label ?? upload.status;
    const known = p.percent !== null && p.percent !== undefined;
    const pct = known ? Math.max(0, Math.min(100, Number(p.percent))) : null;

    const facts = [];
    if (p.byteAccurate) {
      if (upload.bytesDownloaded > 0 && upload.fileSize > 0) {
        facts.push(`${bytes(upload.bytesDownloaded)} / ${bytes(upload.fileSize)}`);
      }
      if (p.bytesPerSecond > 0) facts.push(`${bytes(p.bytesPerSecond)}/s`);
      const eta = p.etaSeconds > 0 ? duration(p.etaSeconds) : null;
      if (eta) facts.push(`~${eta} remaining`);
    }
    if (p.partCount > 1) facts.unshift(`part ${p.part} of ${p.partCount}`);

    return el(
      'div',
      {},
      known
        ? el(
            'div',
            { class: 'progress-line', style: 'margin-bottom:6px;margin-top:0' },
            el('span', { class: 'progress-percent' }, `${pct.toFixed(0)}%`),
            el('span', {}, stage),
          )
        : el('div', { class: 'progress-line', style: 'margin-bottom:6px;margin-top:0' }, el('span', {}, stage)),
      el(
        'div',
        { class: 'progress-track' },
        known
          ? el('span', { class: 'progress-fill', style: `width:${pct}%` })
          : el('span', { class: 'progress-fill is-indeterminate' }),
      ),
      facts.length ? el('div', { class: 'progress-line' }, facts.map((f) => el('span', {}, f))) : null,
      // Only meaningful once the transfer itself is done, so it is not shown
      // beside a download that has not finished.
      p.stage && !['RECEIVING', 'QUEUED', 'DOWNLOADING', 'FETCHING'].includes(p.stage)
        ? pipelineChecklist(p.stage, upload.status)
        : null,
    );
  }

  function pipelineChecklist(currentStage, status) {
    const order = ['DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'];
    const at = order.indexOf(currentStage);
    const failed = status === 'FAILED';

    return el(
      'ul',
      { class: 'steps' },
      PIPELINE.map((step) => {
        const idx = order.indexOf(step.key);
        let state = 'pending';
        if (at >= 0 && idx < at) state = 'done';
        else if (at >= 0 && idx === at) state = failed ? 'failed' : 'current';
        if (status === 'COMPLETED') state = 'done';
        const mark = { done: '✓', current: '→', failed: '✕', pending: '○' }[state];
        return el(
          'li',
          { class: `step is-${state}` },
          el('span', { class: 'step-mark', 'aria-hidden': 'true' }, mark),
          el('span', {}, step.label),
          el('span', { class: 'sr-only' }, `: ${state}`),
        );
      }),
    );
  }

  // ------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------

  const state = {
    view: 'home',
    me: null,
    library: { type: '', offset: 0, limit: 20, items: [], total: 0, loading: false },
    history: { status: '', offset: 0, limit: 20 },
    transfer: null, // a browser upload in flight
  };

  let pollTimer = null;
  let renderToken = 0;

  /**
   * Poll only the view that needs it, and only while it is on screen.
   *
   * Matches the dashboard's rule: a hidden tab paints nothing, so a request
   * spent on it is spent on nothing — and on a phone it is spent on somebody's
   * battery and data.
   */
  function poll(fn, ms) {
    stopPolling();
    const token = renderToken;
    pollTimer = setInterval(() => {
      if (document.hidden || token !== renderToken) return;
      fn().catch((err) => {
        if (err?.status === 401 || err?.status === 403) {
          stopPolling();
          if (err.status === 401) expired();
          else show('home');
        }
      });
    }, ms);
  }

  /** The screen for a sign-in Telegram will not renew while the app stays open. */
  function expired() {
    stopPolling();
    renderToken += 1;
    fatal(
      'Please reopen the app',
      window.TG.available
        ? 'Your Telegram sign-in has expired. Close this app and open it again from the bot.'
        : 'This page only works when opened from inside Telegram.',
    );
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    // Coming back to a transfers view a minute later should not show a minute
    // old number.
    if (!document.hidden && pollTimer && state.view === 'active') void drawActive(true);
  });

  // ------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------

  const VIEWS = {
    home: drawHome,
    library: drawLibrary,
    upload: drawUpload,
    active: drawActive,
    history: drawHistory,
    account: drawAccount,
  };

  function show(view) {
    if (!VIEWS[view]) view = 'home';
    state.view = view;
    renderToken += 1;
    stopPolling();
    for (const tab of tabbar.querySelectorAll('.tab')) {
      if (tab.dataset.view === view) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    }
    // Guarded the same way the dashboard guards it: not every environment
    // implements it, and a view switch must not fail over a scroll.
    try {
      if (window.scrollY > 0) window.scrollTo({ top: 0 });
    } catch {
      /* not scrollable here */
    }
    void VIEWS[view]();
  }

  tabbar.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    TG.haptic('light');
    show(tab.dataset.view);
  });

  // --- Home ---------------------------------------------------------------

  async function drawHome() {
    const token = renderToken;
    fill(root, loading());

    let me;
    try {
      me = await Api.me();
    } catch (err) {
      if (token !== renderToken) return;
      return void fill(root, errorBox(err, () => drawHome()));
    }
    if (token !== renderToken) return;
    state.me = me;
    updateActiveBadge(me.uploads.active);
    // The server decides what this deployment is called (APP_NAME); the
    // fallback keeps the app usable against an older server that does not
    // send one.
    if (me.appName) document.title = me.appName;

    const s = me.storage;
    const unlimited = s.quotaBytes === null;
    const pct = unlimited ? 0 : Math.min(100, Number(s.percentUsed ?? 0));
    const tone = unlimited ? '' : pct >= 95 ? ' is-danger' : pct >= 80 ? ' is-warn' : '';

    // The greeting uses the name Telegram shows in its own UI; everything that
    // follows is this server's own record of the account.
    const greeting = TG.displayName() || me.account.name;

    fill(
      root,
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'brand' },
          el('span', { 'aria-hidden': 'true' }, '🎬'),
          me.appName || 'JellyGram',
        ),
        el('p', { class: 'brand-sub' }, `Welcome, ${greeting}`),
      ),

      el('p', { class: 'section-label' }, 'Storage'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'storage-figure' },
          el('span', { class: 'storage-used' }, bytes(s.usedBytes)),
          el('span', { class: 'storage-of' }, unlimited ? 'used' : `of ${bytes(s.quotaBytes)}`),
        ),
        unlimited
          ? el('p', { class: 'meter-caption' }, 'No quota set — you are limited only by the disk.')
          : el(
              'div',
              {},
              el('div', { class: `meter${tone}` }, el('span', { style: `width:${pct.toFixed(1)}%` })),
              el(
                'p',
                { class: 'meter-caption' },
                `${bytes(s.remainingBytes)} remaining${s.reservedBytes > 0 ? ` · ${bytes(s.reservedBytes)} in flight` : ''}`,
              ),
            ),
        el(
          'div',
          { class: 'stat-row', style: 'margin-top:16px' },
          statTile(s.movies, 'Movies'),
          statTile(s.episodes, 'Episodes'),
          statTile(me.uploads.completed, 'Uploads'),
        ),
      ),

      el('p', { class: 'section-label' }, 'Browse'),
      el(
        'div',
        { class: 'rows' },
        navRow('▷', 'My Library', `${s.movies + s.episodes} items`, () => show('library')),
        navRow('↥', 'Upload', 'Send a film or episode', () => show('upload')),
        navRow(
          '⇄',
          'Active Transfers',
          me.uploads.active ? `${me.uploads.active} in progress` : 'Nothing running',
          () => show('active'),
        ),
        navRow('≡', 'My Uploads', `${me.uploads.total} all time`, () => show('history')),
        navRow('◍', 'Account', me.account.jellyfinUsername, () => show('account')),
      ),

      me.uploads.failed || me.uploads.needsReview
        ? el(
            'div',
            { class: 'card' },
            el(
              'p',
              {},
              me.uploads.failed ? `${me.uploads.failed} upload${me.uploads.failed === 1 ? '' : 's'} failed. ` : '',
              me.uploads.needsReview ? `${me.uploads.needsReview} need${me.uploads.needsReview === 1 ? 's' : ''} review. ` : '',
            ),
            el(
              'button',
              { class: 'btn btn-sm', type: 'button', style: 'margin-top:12px', onclick: () => show('history') },
              'Review them',
            ),
          )
        : null,

      jellyfinButtons(me),
    );
  }

  function statTile(value, label) {
    return el(
      'div',
      {},
      el('div', { class: 'stat-value' }, String(value ?? 0)),
      el('div', { class: 'stat-label' }, label),
    );
  }

  function navRow(icon, title, sub, onClick) {
    return el(
      'button',
      { class: 'row', type: 'button', onclick: () => { TG.haptic('light'); onClick(); } },
      el('span', { class: 'row-icon', 'aria-hidden': 'true' }, icon),
      el('span', { class: 'row-body' }, el('span', { class: 'row-title' }, title), sub ? el('span', { class: 'row-sub' }, sub) : null),
      el('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
    );
  }

  /**
   * Leave the WebView to reach Jellyfin.
   *
   * Jellyfin lives on the LAN over plain HTTP while this app is served over
   * HTTPS, so it cannot be shown inside the app — a browser refuses to load
   * insecure content into a secure page. Handing the URL to the system browser
   * sidesteps that: a top-level navigation is not mixed content, so the LAN
   * address keeps working exactly as it does today.
   */
  /**
   * The doors the page can measure, in the order it should prefer them.
   *
   * The LAN door is deliberately absent: it is plain http, and this page —
   * served over HTTPS — is not allowed to fetch it (mixed content), so it can
   * be opened but never tested. Anyone on the LAN with Tailscale on is served
   * by the first entry, which on the tailnet is a direct, LAN-speed path.
   */
  function jellyfinCandidates(me) {
    const doors = me?.jellyfin ?? {};
    return [
      // Direct and private; on the tailnet it answers in a few milliseconds,
      // and from anywhere else it fails fast, so it gets a short leash.
      { name: 'Tailscale', url: doors.tailscale, timeoutMs: 1200 },
      // Relayed, so it is allowed longer — it is also the door that exists
      // from anywhere, which is why it is last and never skipped.
      { name: 'Internet', url: doors.internet, timeoutMs: 4000 },
    ].filter((c) => typeof c.url === 'string' && c.url.length > 0);
  }

  let choosingRoute = false;

  /**
   * Open Jellyfin by whichever door answers first.
   *
   * `path` is what to open once a door is chosen — empty for the front page,
   * or a deep link into one title — so the same measurement serves both.
   */
  async function openJellyfin(me, path = '') {
    if (choosingRoute) return;
    TG.haptic('light');

    const candidates = jellyfinCandidates(me);
    // A server configured with only the LAN address behaves exactly as before.
    if (candidates.length === 0) return void openJellyfinAt(me?.jellyfinUrl, path);

    choosingRoute = true;
    try {
      const { chosen, results } = await window.JellyfinRoute.choose(candidates);
      if (chosen) {
        toast(`Opening Jellyfin via ${chosen.name} · ${chosen.ms} ms`);
        openJellyfinAt(chosen.url, path);
        return;
      }
      // Nothing usable. The public door is the one that exists from anywhere,
      // so it is opened rather than opening nothing: the browser will have
      // more to say about what is wrong than a probe could. The toast says
      // which kind of nothing it was — a door that answered with a refusal
      // (the public one is fenced to Ethiopia) is a different problem from
      // one that never answered.
      const refused = (results ?? []).some((r) => r && r.status > 0);
      toast(
        refused
          ? 'Jellyfin refused this connection — opening the public address anyway.'
          : 'No route answered in time — opening the public address.',
        'warn',
      );
      openJellyfinAt(candidates[candidates.length - 1].url, path);
    } finally {
      choosingRoute = false;
    }
  }

  function openJellyfinAt(url, path = '') {
    if (!url || !TG.openExternal(`${url}${path}`)) {
      toast('Could not open Jellyfin. Try it from your browser.', 'error');
    }
  }

  /**
   * The button, plus a one-tap way through the one door that cannot be
   * measured. Shown only when there is something to measure; with the LAN
   * address alone, the main button already opens it.
   */
  function jellyfinButtons(me) {
    const doors = me?.jellyfin ?? {};
    const anyDoor = me?.jellyfinUrl || doors.tailscale || doors.internet;
    if (!anyDoor) return null;
    const measurable = jellyfinCandidates(me).length > 0;
    return el(
      'div',
      { class: 'jellyfin-open' },
      el(
        'button',
        { class: 'btn btn-primary btn-block', type: 'button', style: 'margin-top:8px', onclick: () => void openJellyfin(me) },
        'Open Jellyfin',
      ),
      doors.lan && measurable
        ? el(
            'button',
            { class: 'btn btn-sm btn-block', type: 'button', style: 'margin-top:6px', onclick: () => openJellyfinAt(doors.lan) },
            'On home Wi-Fi? Open directly',
          )
        : null,
    );
  }

  // --- Library ------------------------------------------------------------

  async function drawLibrary(preserve = false) {
    const token = renderToken;
    if (!preserve) {
      state.library.offset = 0;
      state.library.items = [];
    }

    const head = el(
      'header',
      { class: 'view-head' },
      el('h1', {}, 'My Library'),
      el('p', {}, 'Everything filed into your own Jellyfin libraries.'),
    );

    const chips = el(
      'div',
      { class: 'chips' },
      chip('All', state.library.type === '', () => setLibraryType('')),
      chip('Movies', state.library.type === 'movie', () => setLibraryType('movie')),
      chip('TV', state.library.type === 'tv', () => setLibraryType('tv')),
    );

    // Paging appends to the grid already on screen; only a fresh load — a
    // filter change, a retry — rebuilds the view. Rebuilding for "Load more"
    // replaced the whole document with a six-tile skeleton, threw the reader
    // back to the top and fetched every poster again.
    const appending = preserve && state.library.grid && state.library.grid.isConnected;
    const body = appending ? state.library.body : el('div', {});
    if (!appending) {
      fill(root, head, chips, body);
      fill(body, skeletonGrid());
    }

    let data;
    try {
      data = await Api.library({
        type: state.library.type || undefined,
        limit: state.library.limit,
        offset: state.library.offset,
      });
    } catch (err) {
      if (token !== renderToken) return;
      return void fill(body, errorBox(err, () => drawLibrary(true)));
    }
    if (token !== renderToken) return;

    state.library.items = state.library.offset === 0 ? data.items : [...state.library.items, ...data.items];
    state.library.total = data.total;

    if (state.library.items.length === 0) {
      return void fill(
        body,
        empty({
          icon: '▷',
          title: 'Nothing here yet',
          message: 'Send a film or an episode to the bot, or upload one from this app. It will appear here once it is filed.',
          action: el('button', { class: 'btn btn-primary', type: 'button', onclick: () => show('upload') }, 'Upload something'),
        }),
      );
    }

    const grid = appending ? state.library.grid : el('div', { class: 'grid' });
    const fresh = appending ? data.items : state.library.items;
    for (const item of fresh) grid.append(posterCard(item));
    const more =
      state.library.items.length < state.library.total
        ? el(
            'button',
            {
              class: 'btn btn-block',
              type: 'button',
              style: 'margin-top:16px',
              onclick: (event) => {
                event.target.disabled = true;
                event.target.textContent = 'Loading…';
                state.library.offset += state.library.limit;
                void drawLibrary(true);
              },
            },
            `Load more (${state.library.total - state.library.items.length} left)`,
          )
        : null;

    state.library.body = body;
    state.library.grid = grid;
    if (appending) {
      state.library.more?.remove();
      if (more) body.append(more);
    } else {
      fill(body, grid, more);
    }
    state.library.more = more;
  }

  function setLibraryType(type) {
    state.library.type = type;
    state.library.offset = 0;
    void drawLibrary();
  }

  function chip(label, pressed, onClick) {
    return el('button', { class: 'chip', type: 'button', 'aria-pressed': String(pressed), onclick: onClick }, label);
  }

  /**
   * Load a poster through the authenticated proxy.
   *
   * An `<img src>` is a plain browser request: it carries no `Authorization`
   * header, so pointing one straight at the proxy produced a 401 and a
   * placeholder every time. The bytes are fetched with the credential instead
   * and handed to the element as a blob, which is also the only way to keep
   * the credential in a header rather than putting it in a URL that would
   * reach the access log, the history and the Referer.
   */
  async function loadPoster(art, mediaId, fallbackGlyph) {
    let objectUrl = null;
    try {
      const res = await fetch(Api.posterUrl(mediaId), {
        headers: { Authorization: `tma ${TG.initData()}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);

      const img = el('img', { src: objectUrl, alt: '', decoding: 'async' });
      // Released once the bytes are decoded; the element keeps its pixels.
      img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
      img.addEventListener(
        'error',
        () => {
          URL.revokeObjectURL(objectUrl);
          fill(art, el('span', { class: 'poster-fallback', 'aria-hidden': 'true' }, fallbackGlyph));
        },
        { once: true },
      );
      fill(art, img);
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // A missing poster is not an error worth interrupting anyone for.
      fill(art, el('span', { class: 'poster-fallback', 'aria-hidden': 'true' }, fallbackGlyph));
    }
  }

  function posterCard(item) {
    const art = el('div', { class: 'poster-art' });
    const glyph = item.type === 'tv' ? '▤' : '▷';
    // The placeholder is rendered first so the grid has its shape immediately
    // and does not reflow as each poster arrives.
    art.append(el('span', { class: 'poster-fallback', 'aria-hidden': 'true' }, glyph));
    if (item.hasPoster) void loadPoster(art, item.id, glyph);
    if (!item.jellyfinVerified) art.append(el('span', { class: 'poster-badge' }, 'Pending'));

    const subtitle =
      item.type === 'tv'
        ? `S${String(item.season ?? 0).padStart(2, '0')}E${String(item.episode ?? 0).padStart(2, '0')} · ${bytes(item.fileSize)}`
        : `${item.year ?? '—'} · ${bytes(item.fileSize)}`;

    return el(
      'button',
      { class: 'poster', type: 'button', onclick: () => watch(item) },
      art,
      el('span', { class: 'poster-title' }, item.title),
      el('span', { class: 'poster-sub' }, subtitle),
    );
  }

  function watch(item) {
    // Any door at all means Jellyfin is configured; which one is chosen later.
    const doors = state.me?.jellyfin ?? {};
    if (!(state.me?.jellyfinUrl || doors.tailscale || doors.internet)) {
      return void toast('Jellyfin is not configured.', 'warn');
    }
    if (!item.jellyfinVerified || !item.jellyfinItemId) {
      return void toast('Jellyfin has not indexed this yet. Try again shortly.', 'warn');
    }
    // Jellyfin's own web client route for a single item. The server id is not
    // needed for a same-server link.
    // Verified against the installed bundle: Jellyfin 10.11's web client is a
    // hash router registering `path:"details"`, so `#/details`. The `#!/` form
    // is pre-10.9 Emby and silently opens an empty page.
    void openJellyfin(state.me, `/web/#/details?id=${encodeURIComponent(item.jellyfinItemId)}`);
  }

  // --- Upload -------------------------------------------------------------

  async function drawUpload() {
    const token = renderToken;
    const cfg = state.config ?? {};
    const formats = (cfg.formats ?? ['MP4', 'MKV', 'AVI', 'MOV']).join(', ');

    if (state.me && !state.me.account.uploadEnabled) {
      return void fill(
        root,
        el('header', { class: 'view-head' }, el('h1', {}, 'Upload')),
        empty({ icon: '⊘', title: 'Uploading is disabled', message: 'Your account cannot upload right now. Ask the administrator.' }),
      );
    }

    const input = el('input', {
      type: 'file',
      accept: '.mp4,.mkv,.avi,.mov,video/*',
      style: 'display:none',
      onchange: (event) => {
        const file = event.target.files?.[0];
        // Cleared so the same file can be chosen again after a failure: a
        // browser fires no change event when the selection has not changed.
        event.target.value = '';
        if (file) void startTransfer(file);
      },
    });

    const zone = el(
      'label',
      { class: 'dropzone' },
      el('span', { class: 'dropzone-icon', 'aria-hidden': 'true' }, '↥'),
      el('strong', {}, 'Choose a file'),
      el('p', { class: 'dropzone-hint' }, `${formats} · up to ${bytes(cfg.maxFileBytes ?? 0)}`),
      input,
    );

    if (token !== renderToken) return;
    fill(
      root,
      el(
        'header',
        { class: 'view-head' },
        el('h1', {}, 'Upload'),
        el('p', {}, 'Sent straight to the server, then identified and filed automatically.'),
      ),
      zone,
      el('div', { id: 'transfer-slot' }),
      el(
        'div',
        { class: 'card', style: 'margin-top:16px' },
        el('p', { class: 'row-sub', style: 'font-size:0.85rem' },
          'Large files are split and sent in parts, and an interrupted upload resumes where it stopped. You can also forward a video to the bot in Telegram.'),
      ),
    );

    if (state.transfer) renderTransfer();
  }

  /**
   * Send one file, reporting only what is actually known.
   *
   * The percentage below comes from the browser's own count of bytes written
   * to the socket. Nothing here estimates.
   */
  async function startTransfer(file) {
    // One at a time. A second pick while one ran used to start a second
    // upload whose progress wrote over the first's card, and left the first
    // with no Cancel that reached it.
    if (state.transfer && !state.transfer.done) {
      toast('An upload is already running. Wait for it, or cancel it first.', 'warn');
      return;
    }
    const controller = new AbortController();
    state.transfer = {
      name: file.name,
      size: file.size,
      sent: 0,
      stage: 'planning',
      controller,
      error: null,
      done: false,
    };
    renderTransfer();

    try {
      await Ingest.send(file, {
        signal: controller.signal,
        onStage: (stage) => {
          if (!state.transfer) return;
          state.transfer.stage = stage;
          renderTransfer();
        },
        onProgress: (sent) => {
          if (!state.transfer) return;
          state.transfer.sent = sent;
          renderTransfer();
        },
      });
      if (!state.transfer) return;
      state.transfer.done = true;
      state.transfer.stage = 'queued';
      TG.haptic('success');
      toast('Upload complete — it is being processed now.', 'ok');
      renderTransfer();
      // The pipeline picks it up from here; the transfers view is where the
      // rest of the story is told.
      setTimeout(() => {
        if (state.view === 'upload') show('active');
      }, 1200);
    } catch (err) {
      if (!state.transfer) return;
      state.transfer.error = err?.cancelled ? 'Cancelled.' : (err?.message ?? 'The upload failed.');
      state.transfer.done = true;
      if (!err?.cancelled) TG.haptic('error');
      renderTransfer();
    }
  }

  const TRANSFER_STAGE = {
    planning: 'Preparing',
    uploading: 'Uploading',
    assembling: 'Joining the parts',
    queued: 'Queued for processing',
  };

  function renderTransfer() {
    const slot = document.getElementById('transfer-slot');
    if (!slot) return;
    const t = state.transfer;
    if (!t) return void fill(slot);

    const pct = t.size > 0 ? Math.min(100, (t.sent / t.size) * 100) : 0;

    fill(
      slot,
      el(
        'div',
        { class: 'card transfer', style: 'margin-top:16px' },
        el(
          'div',
          { class: 'transfer-head' },
          el('div', { class: 'transfer-name' }, t.name),
          t.error ? el('span', { class: 'badge is-danger' }, 'Failed') : t.done ? el('span', { class: 'badge is-ok' }, 'Sent') : null,
        ),
        t.error
          ? el('p', { class: 'row-sub' }, t.error)
          : el(
              'div',
              {},
              el(
                'div',
                { class: 'progress-line', style: 'margin:0 0 6px' },
                el('span', { class: 'progress-percent' }, `${pct.toFixed(0)}%`),
                el('span', {}, TRANSFER_STAGE[t.stage] ?? t.stage),
              ),
              el(
                'div',
                { class: 'progress-track' },
                t.stage === 'uploading'
                  ? el('span', { class: 'progress-fill', style: `width:${pct}%` })
                  : el('span', { class: 'progress-fill is-indeterminate' }),
              ),
              el(
                'div',
                { class: 'progress-line' },
                el('span', {}, `${bytes(t.sent)} / ${bytes(t.size)}`),
              ),
            ),
        el(
          'div',
          { class: 'btn-row', style: 'margin-top:16px' },
          t.done
            ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.transfer = null; renderTransfer(); } }, 'Dismiss')
            : el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => t.controller.abort() }, 'Cancel'),
        ),
      ),
    );
  }

  // --- Active transfers ---------------------------------------------------

  async function drawActive(quiet = false) {
    const token = renderToken;
    if (!quiet) fill(root, el('header', { class: 'view-head' }, el('h1', {}, 'Active Transfers')), loading());

    let data;
    try {
      data = await Api.active();
    } catch (err) {
      if (token !== renderToken) return;
      // A quiet refresh keeps the last good list on screen through a blip —
      // but an expired or revoked credential is not a blip, and swallowing it
      // here left the poller re-sending a dead credential every four seconds.
      if (quiet && err?.status !== 401 && err?.status !== 403) return;
      if (quiet) throw err;
      return void fill(root, el('header', { class: 'view-head' }, el('h1', {}, 'Active Transfers')), errorBox(err, () => drawActive()));
    }
    if (token !== renderToken) return;
    updateActiveBadge(data.total);

    const head = el(
      'header',
      { class: 'view-head' },
      el('h1', {}, 'Active Transfers'),
      el('p', {}, data.total ? `${data.total} in progress` : 'Nothing running right now.'),
    );

    if (data.items.length === 0) {
      fill(
        root,
        head,
        empty({
          icon: '⇄',
          title: 'Nothing in progress',
          message: 'Uploads you send from here or forward to the bot will appear while they run.',
          action: el('button', { class: 'btn btn-primary', type: 'button', onclick: () => show('upload') }, 'Upload a file'),
        }),
      );
      stopPolling();
      return;
    }

    fill(root, head, ...data.items.map(transferCard));
    // Frequent enough to feel live, rare enough not to drain a phone. Stops
    // by itself the moment nothing is running.
    poll(() => drawActive(true), 4000);
  }

  function transferCard(upload) {
    return el(
      'div',
      { class: 'card transfer' },
      el(
        'div',
        { class: 'transfer-head' },
        el(
          'div',
          {},
          el('div', { class: 'transfer-name' }, upload.title || upload.filename),
          upload.title ? el('div', { class: 'row-sub' }, upload.filename) : null,
        ),
        statusBadge(upload.status),
      ),
      progressBlock(upload),
      el(
        'div',
        { class: 'btn-row', style: 'margin-top:16px' },
        el(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            onclick: async (event) => {
              const ok = await TG.confirm(`Cancel "${upload.filename}"? Any progress will be discarded.`);
              if (!ok) return;
              event.target.disabled = true;
              try {
                await Api.cancelUpload(upload.id);
                TG.haptic('success');
                toast('Cancelled', 'ok');
                void drawActive(true);
              } catch (err) {
                event.target.disabled = false;
                toast(err.message, 'error');
              }
            },
          },
          'Cancel',
        ),
      ),
    );
  }

  function updateActiveBadge(count) {
    const badge = document.getElementById('tab-badge-active');
    if (!badge) return;
    badge.hidden = !count;
    badge.textContent = count > 9 ? '9+' : String(count ?? 0);
  }

  // --- History ------------------------------------------------------------

  const HISTORY_FILTERS = [
    { value: '', label: 'All' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'FAILED', label: 'Failed' },
    { value: 'NEEDS_REVIEW', label: 'Needs review' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];

  async function drawHistory() {
    const token = renderToken;

    const chips = el(
      'div',
      { class: 'chips' },
      HISTORY_FILTERS.map((f) =>
        chip(f.label, state.history.status === f.value, () => {
          state.history.status = f.value;
          state.history.offset = 0;
          void drawHistory();
        }),
      ),
    );

    const head = el(
      'header',
      { class: 'view-head' },
      el('h1', {}, 'My Uploads'),
      el('p', {}, 'Everything you have sent, newest first.'),
    );
    const body = el('div', {}, loading());
    fill(root, head, chips, body);

    let data;
    try {
      // Server-side filtering and paging: a phone never downloads a whole
      // history to show twenty rows of it.
      data = await Api.uploads({
        status: state.history.status || undefined,
        limit: state.history.limit,
        offset: state.history.offset,
      });
    } catch (err) {
      if (token !== renderToken) return;
      return void fill(body, errorBox(err, () => drawHistory()));
    }
    if (token !== renderToken) return;

    if (data.items.length === 0) {
      return void fill(
        body,
        empty({
          icon: '≡',
          title: state.history.status ? 'Nothing matches that filter' : 'No uploads yet',
          message: state.history.status
            ? 'Try a different filter.'
            : 'Forward a video to the bot, or upload one from this app.',
          action: state.history.status
            ? null
            : el('button', { class: 'btn btn-primary', type: 'button', onclick: () => show('upload') }, 'Upload a file'),
        }),
      );
    }

    fill(
      body,
      ...data.items.map(historyCard),
      pager(data, () => drawHistory()),
    );
  }

  function historyCard(upload) {
    // NEEDS_REVIEW is deliberately absent: the server refuses to retry one
    // (its file is in quarantine, and re-queueing it is a different operation)
    // so the button could only ever fail. The card says what to do instead.
    const canRetry = ['FAILED', 'CANCELLED'].includes(upload.status);
    const active = ['RECEIVED', 'QUEUED', 'DOWNLOADING', 'PROCESSING', 'ORGANIZING', 'JELLYFIN_SCAN'].includes(
      upload.status,
    );

    return el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'transfer-head' },
        el(
          'div',
          {},
          el('div', { class: 'transfer-name' }, upload.title || upload.filename),
          el('div', { class: 'row-sub' }, `${bytes(upload.fileSize)} · ${relative(upload.createdAt)}`),
        ),
        statusBadge(upload.status),
      ),
      active ? progressBlock(upload) : null,
      // Safe for the owner to see: which stage stopped and whether trying
      // again could plausibly help.
      upload.failure
        ? el(
            'p',
            { class: 'row-sub', style: 'margin-top:8px' },
            upload.failure.message ?? 'It failed.',
            upload.failure.retryable === false ? ' Retrying will not help until the cause is fixed.' : '',
          )
        : null,
      upload.status === 'COMPLETED' && upload.jellyfinVerified === false
        ? el('p', { class: 'row-sub', style: 'margin-top:8px' }, 'Filed, but Jellyfin has not indexed it yet.')
        : null,
      upload.status === 'NEEDS_REVIEW'
        ? el(
            'p',
            { class: 'row-sub', style: 'margin-top:8px' },
            'This one could not be identified from its name, so it was kept aside rather than guessed at. Rename the file closer to its release title and send it again.',
          )
        : null,
      canRetry
        ? el(
            'div',
            { class: 'btn-row', style: 'margin-top:12px' },
            el(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onclick: async (event) => {
                  event.target.disabled = true;
                  event.target.textContent = 'Queueing…';
                  try {
                    await Api.retryUpload(upload.id);
                    TG.haptic('success');
                    toast('Queued for another attempt', 'ok');
                    void drawHistory();
                  } catch (err) {
                    event.target.disabled = false;
                    event.target.textContent = 'Try again';
                    toast(err.message, 'error');
                  }
                },
              },
              'Try again',
            ),
          )
        : null,
    );
  }

  function pager(data, redraw) {
    const from = data.total === 0 ? 0 : data.offset + 1;
    const to = Math.min(data.offset + data.limit, data.total);
    if (data.total <= data.limit) return null;

    return el(
      'div',
      { class: 'btn-row', style: 'margin-top:16px;justify-content:space-between' },
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          ...(data.offset === 0 ? { disabled: true } : {}),
          onclick: () => {
            state.history.offset = Math.max(0, state.history.offset - state.history.limit);
            redraw();
          },
        },
        'Newer',
      ),
      el('span', { class: 'row-sub', style: 'align-self:center' }, `${from}–${to} of ${data.total}`),
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          ...(to >= data.total ? { disabled: true } : {}),
          onclick: () => {
            state.history.offset += state.history.limit;
            redraw();
          },
        },
        'Older',
      ),
    );
  }

  // --- Account ------------------------------------------------------------

  async function drawAccount() {
    const token = renderToken;
    fill(root, el('header', { class: 'view-head' }, el('h1', {}, 'Account')), loading());

    let me;
    try {
      me = await Api.me();
    } catch (err) {
      if (token !== renderToken) return;
      return void fill(root, el('header', { class: 'view-head' }, el('h1', {}, 'Account')), errorBox(err, () => drawAccount()));
    }
    if (token !== renderToken) return;
    state.me = me;

    const s = me.storage;
    fill(
      root,
      el('header', { class: 'view-head' }, el('h1', {}, 'Account')),

      el('p', { class: 'section-label' }, 'Telegram'),
      el(
        'div',
        { class: 'card' },
        kv('Name', me.telegram.firstName || '—'),
        me.telegram.username ? kv('Username', `@${me.telegram.username}`) : null,
        kv('Status', el('span', { class: 'badge is-ok' }, 'Linked')),
      ),

      el('p', { class: 'section-label' }, 'Jellyfin'),
      el(
        'div',
        { class: 'card' },
        kv('Account', me.account.jellyfinUsername),
        kv('Libraries', `${me.account.libraries} private to you`),
        kv('Member since', new Date(me.account.memberSince).toLocaleDateString()),
      ),

      el('p', { class: 'section-label' }, 'Storage'),
      el(
        'div',
        { class: 'card' },
        kv('Used', bytes(s.usedBytes)),
        kv('Quota', s.quotaBytes === null ? 'Unlimited' : bytes(s.quotaBytes)),
        kv('Remaining', s.quotaBytes === null ? '—' : bytes(s.remainingBytes)),
        kv('Movies', String(s.movies)),
        kv('Episodes', String(s.episodes)),
        kv('Uploads', String(me.uploads.total)),
      ),

      jellyfinButtons(me),
    );
  }

  function kv(label, value) {
    return el('dl', { class: 'kv' }, el('dt', {}, label), el('dd', {}, value));
  }

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------

  function fatal(title, message, retry) {
    tabbar.hidden = true;
    fill(
      root,
      el(
        'div',
        { class: 'boot' },
        el('span', { class: 'error-icon', style: 'font-size:2rem', 'aria-hidden': 'true' }, '⚠'),
        el('h3', { style: 'color:var(--text)' }, title),
        el('p', { style: 'text-align:center;max-width:34ch' }, message),
        retry ? el('button', { class: 'btn btn-primary', style: 'margin-top:16px', type: 'button', onclick: retry }, 'Try again') : null,
      ),
    );
  }

  async function boot() {
    TG.ready();

    try {
      state.config = await Api.config();
    } catch (err) {
      // The server answers a disabled app with a 503 carrying `DISABLED`;
      // that is not a connection problem and no retry will change it.
      if (err?.status === 503 || err?.code === 'DISABLED') {
        return void fatal('Unavailable', 'This app is switched off at the moment.');
      }
      state.config = {};
    }

    if (state.config.enabled === false) {
      return void fatal('Unavailable', 'This app is switched off at the moment.');
    }

    // One call decides everything: it authenticates, and it is also the data
    // the first screen needs.
    try {
      state.me = await Api.me();
    } catch (err) {
      if (err.status === 403) {
        return void fatal(
          'Not registered',
          err.code === 'DEACTIVATED'
            ? 'This account has been deactivated. Ask the administrator to restore it.'
            : 'This Telegram account is not registered. Ask the administrator to add you, then reopen the app.',
        );
      }
      if (err.status === 401) {
        return void fatal(
          'Please reopen the app',
          window.TG.available
            ? 'Your Telegram sign-in has expired. Close this app and open it again from the bot.'
            : 'This page only works when opened from inside Telegram.',
          () => void boot(),
        );
      }
      return void fatal('Could not connect', err.message ?? 'The server could not be reached.', () => void boot());
    }

    tabbar.hidden = false;
    document.getElementById('boot')?.remove();
    updateActiveBadge(state.me.uploads.active);
    show('home');
  }

  void boot();
})();
