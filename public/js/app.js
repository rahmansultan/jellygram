/* global window, document, Api, UI */
'use strict';

(() => {
  const {
    el,
    clear,
    fill,
    bytes,
    number,
    dateTime,
    relative,
    when,
    duration,
    badge,
    statusBadge,
    statusLabel,
    pageHead,
    card,
    metric,
    meter,
    emptyState,
    skeleton,
    loading,
    toolbar,
    field,
    definitionList,
    actionButton,
    menu,
    copyButton,
    toast,
    openModal,
    confirmDialog,
    table,
  } = UI;

  const main = document.getElementById('main');
  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');

  let refreshTimer = null;
  /** The current page's redraw, so a returning tab can refresh in place. */
  let currentDraw = null;

  /**
   * Which page's data is allowed to reach the screen.
   *
   * Every render is asynchronous, so a slow response belonging to the page the
   * reader has already left would otherwise paint over the page they are on.
   * The token is bumped on every navigation; a draw that no longer holds the
   * current one simply discards its work.
   */
  let renderToken = 0;

  function mount(token, ...nodes) {
    if (token !== renderToken) return false;
    clear(main).append(...nodes.flat().filter(Boolean));
    return true;
  }

  // ------------------------------------------------------------------------
  // Request cache
  // ------------------------------------------------------------------------

  /**
   * The user list, fetched once for the several pages that only need it to
   * label rows and fill a filter.
   *
   * Four pages poll every few seconds and each was re-fetching every user,
   * their libraries and their storage totals alongside the data it actually
   * came for. The list changes when an administrator changes it, which is
   * exactly when the cache is dropped.
   */
  const usersCache = { at: 0, value: null, inflight: null };

  async function cachedUsers(maxAgeMs = 30_000) {
    if (usersCache.value && Date.now() - usersCache.at < maxAgeMs) return usersCache.value;
    if (usersCache.inflight) return usersCache.inflight;
    usersCache.inflight = Api.users()
      .then((data) => {
        usersCache.value = data;
        usersCache.at = Date.now();
        usersCache.inflight = null;
        return data;
      })
      .catch((err) => {
        usersCache.inflight = null;
        throw err;
      });
    return usersCache.inflight;
  }

  function forgetUsers() {
    usersCache.value = null;
    usersCache.at = 0;
  }

  // ------------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.getElementById('theme-icon').textContent =
      theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';
    document.getElementById('theme-toggle').setAttribute(
      'aria-label',
      `Colour theme: ${theme}. Activate to change.`,
    );
    try {
      window.localStorage.setItem('jellygram-theme', theme);
    } catch {
      // Private browsing or blocked storage: the theme simply resets on reload.
    }
  }

  function initTheme() {
    let stored = 'auto';
    try {
      stored = window.localStorage.getItem('jellygram-theme') ?? 'auto';
    } catch {
      /* not available */
    }
    applyTheme(stored);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length];
      applyTheme(next);
    });
  }

  // ------------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------------

  const routes = {
    dashboard: renderDashboard,
    users: renderUsers,
    user: renderUserDetail,
    uploads: renderUploads,
    upload: renderUploadDetail,
    multipart: renderMultipart,
    mtproto: renderMtproto,
    media: renderMedia,
    storage: renderStorage,
    health: renderHealth,
    privacy: renderPrivacy,
    settings: renderSettings,
    logs: renderLogs,
    notFound: renderNotFound,
  };

  /** `#/upload/42` -> "42". Empty for routes that take no argument. */
  function routeArg() {
    const raw = (window.location.hash || '').replace(/^#\//, '').split('?')[0];
    return raw.split('/')[1] ?? '';
  }

  function currentRoute() {
    const name = (window.location.hash || '#/dashboard').replace(/^#\//, '').split('?')[0].split('/')[0];
    // An unknown route used to render the Dashboard while the address bar
    // still showed the bad hash and no nav item was current, which reads as a
    // broken page rather than a wrong address.
    return routes[name] ? name : name === '' ? 'dashboard' : 'notFound';
  }

  function renderNotFound() {
    const name = (window.location.hash || '').replace(/^#\//, '');
    mount(
      renderToken,
      pageHead({ title: 'Page not found' }),
      card({
        children: emptyState({
          icon: '◈',
          title: `Nothing lives at “${name || '/'}”`,
          message:
            'The address may be mistyped, or the page may have been renamed. Everything is reachable from the sidebar.',
          action: el('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Go to the dashboard'),
        }),
      }),
    );
  }

  /**
   * Sections whose sidebar badge is worth keeping current.
   *
   * The dashboard aggregate is eight queries; running it on every navigation
   * purely to draw two small numbers cost more than the page being navigated
   * to. The dashboard hands over the data it already has, and any other page
   * refreshes the counts at most once a minute.
   */
  const navCounts = { at: 0 };

  async function refreshNavCounts(known) {
    let data = known;
    if (!data) {
      if (Date.now() - navCounts.at < 60_000) return;
      try {
        data = await Api.dashboard();
      } catch {
        return;
      }
    }
    navCounts.at = Date.now();
    const set = (route, count, tone) => {
      const link = document.querySelector(`.sidebar a[data-route="${route}"]`);
      if (!link) return;
      link.querySelector('.nav-count')?.remove();
      if (!count) return;
      link.append(el('span', { class: `nav-count${tone ? ` is-${tone}` : ''}` }, number(count)));
    };
    const attention = (data.uploads.failed ?? 0) + (data.uploads.needsReview ?? 0);
    set('uploads', attention, (data.uploads.failed ?? 0) ? 'danger' : 'warn');
    set('multipart', data.multipart?.active ?? 0, null);
  }

  async function navigate() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    currentDraw = null;
    for (const open of document.querySelectorAll('details.menu[open]')) open.open = false;

    const token = ++renderToken;
    const route = currentRoute();
    for (const link of document.querySelectorAll('.sidebar a')) {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    closeSidebar();

    clear(main).append(loading());
    // Arriving at a new page part-way down the previous one reads as a broken
    // render. Guarded because not every environment implements it.
    try {
      if (window.scrollY > 0) window.scrollTo({ top: 0 });
    } catch {
      /* not scrollable here */
    }

    try {
      await routes[route]();
    } catch (err) {
      if (err.status === 401) return void showLogin();
      mount(
        token,
        pageHead({ title: 'Could not load this page' }),
        card({
          tone: 'danger',
          children: [
            el('p', {}, err.message),
            el(
              'div',
              { class: 'row-actions', style: 'margin-top:1rem' },
              el('button', { class: 'btn btn-primary', onclick: () => navigate() }, 'Try again'),
              el('a', { class: 'btn', href: '#/dashboard' }, 'Dashboard'),
            ),
          ],
        }),
      );
    }
    refreshNavCounts();
  }

  function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-scrim').hidden = false;
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'true');
    document.querySelector('.sidebar a')?.focus();
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-scrim').hidden = true;
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  }

  /**
   * Poll while a page shows live state, without stacking timers.
   *
   * A hidden tab is skipped rather than throttled: the browser will not paint
   * it, so the request would be spent on nothing. Becoming visible again
   * refreshes immediately, so returning to the tab never shows stale numbers
   * for a whole interval.
   */
  function autoRefresh(fn, ms = 5000) {
    if (refreshTimer) clearInterval(refreshTimer);
    currentDraw = fn;
    const token = renderToken;
    const tick = () => {
      if (document.hidden || token !== renderToken || interacting()) return;
      fn().catch(pollFailed);
    };
    refreshTimer = setInterval(tick, ms);
  }

  /**
   * What a failed background refresh means.
   *
   * Everything was swallowed here, including the one failure that will never
   * fix itself: once the session expires every poll returns 401, and a tab
   * left open kept asking every few seconds for as long as it stayed open —
   * hundreds of pointless requests — while showing stale data and no hint that
   * anyone was signed out. An expired session ends the loop and says so.
   * Anything else stays silent, because a refresh that fails once during a
   * blip must not throw the reader back to a login screen.
   */
  function pollFailed(err) {
    if (err?.status !== 401) return;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    currentDraw = null;
    showLogin();
    toast('Your session expired. Please sign in again.', 'warn');
  }

  /**
   * Whether the reader is in the middle of something a redraw would destroy.
   *
   * A poll rebuilds the whole page, so a five-second interval used to take the
   * focus out of the search box mid-word, and close an open row menu while it
   * was being read. Live numbers matter less than not fighting the person
   * using them; the next tick picks up whatever changed.
   */
  function interacting() {
    if (document.querySelector('dialog[open]')) return true;
    if (document.querySelector('details.menu[open]')) return true;
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return Boolean(active.closest('#main input, #main select, #main textarea, #main details[open]'));
  }

  document.addEventListener('visibilitychange', () => {
    // Ticks were skipped while the tab was in the background, so what is on
    // screen is stale. Redrawing in place rather than re-navigating: a full
    // navigation would flash "Loading…" and reset the scroll position for
    // nothing, since the page identity has not changed.
    if (document.hidden || !refreshTimer || !currentDraw || interacting()) return;
    currentDraw().catch(pollFailed);
  });

  // ------------------------------------------------------------------------
  // Shared widgets
  // ------------------------------------------------------------------------

  function selectField(label, options, value, onChange, { search = false } = {}) {
    const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    const control = el(
      'select',
      { onchange: (e) => onChange(e.target.value) },
      options.map((o) =>
        el('option', { value: o.value, ...(String(o.value) === String(value) ? { selected: true } : {}) }, o.label),
      ),
    );
    control.value = value;
    const node = field({ label, control, id });
    if (search) node.classList.add('field-search');
    return node;
  }

  function searchField(label, placeholder, value, onInput) {
    const id = `f-search-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    const node = field({
      label,
      id,
      control: el('input', {
        type: 'search',
        placeholder,
        value,
        oninput: debounce((e) => onInput(e.target.value), 350),
      }),
    });
    node.classList.add('field-search');
    return node;
  }

  const PAGE_SIZES = [25, 50, 100];

  function pager(total, state, redraw) {
    // A list that shrank under auto-refresh can leave the offset past the end
    // — "51–30 of 30", no rows. Step back to the last page that exists.
    if (total > 0 && state.offset >= total) {
      state.offset = Math.floor((total - 1) / state.limit) * state.limit;
      queueMicrotask(() => redraw());
    }
    const from = total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, total);
    const page = Math.floor(state.offset / state.limit) + 1;
    const pages = Math.max(1, Math.ceil(total / state.limit));

    return el(
      'div',
      { class: 'pager' },
      el(
        'span',
        {},
        total === 0 ? 'Nothing to show' : `${number(from)}–${number(to)} of ${number(total)}`,
        total > state.limit ? ` · page ${page} of ${pages}` : null,
      ),
      el(
        'div',
        { class: 'pager-buttons' },
        el(
          'select',
          {
            class: 'input-sm',
            'aria-label': 'Rows per page',
            onchange: (e) => {
              state.limit = Number(e.target.value);
              state.offset = 0;
              redraw();
            },
          },
          PAGE_SIZES.map((n) =>
            el('option', { value: String(n), ...(n === state.limit ? { selected: true } : {}) }, `${n} per page`),
          ),
        ),
        el(
          'button',
          {
            class: 'btn btn-sm',
            ...(state.offset === 0 ? { disabled: true } : {}),
            onclick: () => {
              state.offset = Math.max(0, state.offset - state.limit);
              redraw();
            },
          },
          'Previous',
        ),
        el(
          'button',
          {
            class: 'btn btn-sm',
            ...(to >= total ? { disabled: true } : {}),
            onclick: () => {
              state.offset += state.limit;
              redraw();
            },
          },
          'Next',
        ),
      ),
    );
  }

  function debounce(fn, ms) {
    let handle;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  }

  function userOptions(users, allLabel = 'All users') {
    return [{ value: '', label: allLabel }, ...users.map((u) => ({ value: String(u.id), label: u.name }))];
  }

  function statusOptions(statuses) {
    return [{ value: '', label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: statusLabel(s) }))];
  }

  /** Two lines in one cell: the thing, and what qualifies it. */
  function titleCell(title, ...subs) {
    return el(
      'div',
      {},
      el('div', { class: 'cell-title' }, title),
      ...subs.filter(Boolean).map((s) => el('div', { class: 'cell-sub' }, s)),
    );
  }

  const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'DUPLICATE'];

  const MEDIA_LIBRARY_LABEL = { movie: 'Movies', tv: 'TV shows' };

  // ------------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------------

  /**
   * The health panel.
   *
   * Distinct from "Services", which says whether each dependency answered.
   * This says whether anything is *wrong*, worst first, with what to do about
   * it — the question someone opening the dashboard is actually asking.
   */
  const HEALTH_GLYPH = { ok: '✓', warn: '!', down: '✕', unknown: '?' };
  const HEALTH_WORD = { ok: 'Healthy', warn: 'Warning', down: 'Down', unknown: 'Unknown' };

  function healthList(health, { limit } = {}) {
    const checks = limit ? health.checks.slice(0, limit) : health.checks;
    return el(
      'ul',
      { class: 'health-list' },
      checks.map((c) =>
        el(
          'li',
          { class: `health-item is-${c.state}` },
          el('span', { class: 'health-dot', 'aria-hidden': 'true' }, HEALTH_GLYPH[c.state] ?? '?'),
          el(
            'div',
            {},
            el('div', { class: 'health-label' }, c.label, ' ', badge(HEALTH_WORD[c.state] ?? c.state, toneForHealth(c.state))),
            el('div', { class: 'hint' }, c.detail),
            c.action ? el('div', { class: 'hint health-action' }, c.action) : null,
          ),
        ),
      ),
    );
  }

  function toneForHealth(state) {
    return state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'down' ? 'danger' : 'neutral';
  }

  function healthCard(health) {
    if (!health || !health.checks?.length) return null;
    const bad = health.checks.filter((c) => c.state !== 'ok');
    return card({
      tone: health.state === 'ok' ? null : health.state === 'warn' ? 'warn' : 'danger',
      title: 'System health',
      subtitle:
        health.state === 'ok'
          ? 'Every check passed.'
          : `${bad.length} of ${health.checks.length} checks need attention.`,
      actions: [el('a', { class: 'btn btn-sm', href: '#/health' }, 'All checks')],
      children:
        health.state === 'ok'
          ? el('p', { class: 'hint' }, `Last checked ${relative(health.checkedAt)}.`)
          : healthList({ ...health, checks: bad }),
    });
  }

  async function renderDashboard() {
    const token = renderToken;
    const draw = async () => {
      // Health is fetched alongside, and a failure of it must not blank the
      // whole dashboard — a health panel that takes the page down with it
      // would be worse than no health panel.
      const [data, status, health] = await Promise.all([
        Api.dashboard(),
        Api.systemStatus(),
        Api.systemHealth().catch(() => null),
      ]);

      const usedPct = data.storage.totalBytes
        ? (data.storage.usedBytes / data.storage.totalBytes) * 100
        : 0;
      const lowSpace = data.storage.freeBytes < data.storage.minFreeBytes;
      const diskTone = lowSpace ? 'danger' : usedPct > 85 ? 'warn' : 'ok';

      const headline = el(
        'div',
        { class: 'metrics' },
        metric({
          label: 'Active now',
          value: number(data.uploads.active),
          sub: data.uploads.active ? 'uploads in flight' : 'nothing running',
          tone: data.uploads.active ? 'busy' : null,
          href: '#/uploads',
        }),
        metric({
          label: 'Queued',
          value: number(data.jobs.pending ?? 0),
          sub: `${number(data.jobs.active ?? 0)} being worked`,
          href: '#/uploads',
        }),
        metric({
          label: 'Completed',
          value: number(data.uploads.completed),
          sub: `${number(data.uploads.total)} uploads all time`,
          tone: 'ok',
          href: '#/uploads',
        }),
        metric({
          label: 'Failed',
          value: number(data.uploads.failed),
          sub: data.uploads.failed ? 'needs attention' : 'none',
          tone: data.uploads.failed ? 'danger' : null,
          href: '#/uploads',
        }),
        // A separate tile because these are not failures: the system declined
        // to guess and is waiting for a decision.
        data.uploads.needsReview
          ? metric({
              label: 'Awaiting review',
              value: number(data.uploads.needsReview),
              sub: 'could not be identified',
              tone: 'warn',
              href: '#/uploads',
            })
          : null,
        metric({
          label: 'Disk free',
          value: bytes(data.storage.freeBytes),
          sub: `of ${bytes(data.storage.totalBytes)}`,
          tone: diskTone === 'ok' ? null : diskTone,
          href: '#/storage',
        }),
      );

      const library = card({
        title: 'Library',
        subtitle: `${number(data.users.total)} user${data.users.total === 1 ? '' : 's'}, ${number(data.users.active)} active.`,
        actions: [el('a', { class: 'btn btn-sm', href: '#/media' }, 'Browse media')],
        children: el(
          'div',
          { class: 'metrics' },
          metric({ label: 'Movies', value: number(data.media.movies) }),
          metric({ label: 'Episodes', value: number(data.media.episodes), sub: `${number(data.media.shows)} shows` }),
          metric({ label: 'Stored', value: bytes(data.media.bytes) }),
        ),
      });

      // Everything here comes from the figures already fetched: what the disk
      // holds, split into the part this system put there and the part it did
      // not, and how much room is left before uploads start being refused.
      const otherBytes = Math.max(0, data.storage.usedBytes - data.storage.mediaBytes);
      const headroom = data.storage.freeBytes - data.storage.minFreeBytes;

      const storage = card({
        title: 'Storage',
        actions: [el('a', { class: 'btn btn-sm', href: '#/storage' }, 'Details')],
        children: [
          meter({
            value: data.storage.usedBytes,
            max: data.storage.totalBytes,
            tone: diskTone,
            label: 'Disk used',
            caption: `${bytes(data.storage.usedBytes)} used of ${bytes(data.storage.totalBytes)} · ${usedPct.toFixed(
              0,
            )}%`,
          }),
          definitionList([
            ['Media library', `${bytes(data.storage.mediaBytes)} · ${number(data.media.movies + data.media.episodes)} files`],
            ['Everything else', bytes(otherBytes)],
            ['Free', bytes(data.storage.freeBytes)],
            [
              'Room for uploads',
              headroom > 0
                ? el('span', {}, `${bytes(headroom)} before the ${bytes(data.storage.minFreeBytes)} floor`)
                : el('span', { class: 'text-danger' }, 'none — uploads are being refused'),
            ],
          ]),
          lowSpace
            ? el(
                'p',
                { class: 'hint text-danger', style: 'margin-top:.5rem' },
                `Below the ${bytes(data.storage.minFreeBytes)} floor — new uploads are being refused.`,
              )
            : null,
        ],
      });

      const services = card({
        title: 'Services',
        subtitle: 'What each dependency reported on the last check.',
        children: definitionList([
          ['Database', el('span', {}, dot(status.database.ok), status.database.ok ? 'Connected' : 'Unavailable')],
          [
            'Jellyfin',
            el(
              'span',
              {},
              dot(status.jellyfin.authenticated, status.jellyfin.reachable),
              `${status.jellyfin.message}${status.jellyfin.version ? ` (v${status.jellyfin.version})` : ''}`,
            ),
          ],
          ['TMDB', el('span', {}, dot(status.tmdb.ok), status.tmdb.message)],
          [
            'Telegram',
            el(
              'span',
              {},
              dot(true),
              `${status.telegram.localMode ? 'Local Bot API' : 'Public Bot API'} · up to ${bytes(
                status.telegram.maxDownloadBytes,
              )} per file`,
            ),
          ],
          [
            'Telegram fetch',
            el(
              'span',
              {},
              dot(status.mtproto?.authorized, status.mtproto?.enabled),
              status.mtproto?.authorized
                ? `linked${status.mtproto.accountUsername ? ` as @${status.mtproto.accountUsername}` : ''} · up to ${bytes(
                    status.mtproto.maxFileBytes,
                  )}`
                : (status.mtproto?.message ?? 'not configured'),
            ),
          ],
          [
            'Queue',
            el(
              'span',
              {},
              `${number(status.jobs.pending ?? 0)} waiting · ${number(status.jobs.active ?? 0)} running · ${number(
                status.jobs.failed ?? 0,
              )} failed`,
              status.jobs.deferred
                ? el(
                    'span',
                    { class: 'cell-sub' },
                    `${number(status.jobs.deferred)} deferred — backing off or paused, not waiting for a worker`,
                  )
                : null,
            ),
          ],
        ]),
      });

      const recent = card({
        title: 'Recent uploads',
        actions: [el('a', { class: 'btn btn-sm', href: '#/uploads' }, 'View all')],
        children: table(
          [
            {
              label: 'File',
              wrap: true,
              render: (r) =>
                el(
                  'a',
                  { href: `#/upload/${r.id}`, class: 'cell-title' },
                  r.detected_title || r.original_filename,
                ),
            },
            { label: 'User', secondary: true, render: (r) => r.user_name },
            { label: 'Size', numeric: true, render: (r) => bytes(r.file_size) },
            { label: 'Status', render: (r) => statusBadge(r.status) },
            { label: 'When', render: (r) => when(r.created_at) },
          ],
          data.recentUploads,
          emptyState({
            icon: '▤',
            title: 'No uploads yet',
            message: 'Send a video to the Telegram bot and it will appear here within seconds.',
          }),
          'Most recent uploads',
        ),
      });

      refreshNavCounts(data);

      mount(
        token,
        pageHead({
          title: 'Dashboard',
          description: 'What the system is doing right now, and anything that needs a decision.',
          actions: [el('a', { class: 'btn btn-sm', href: '#/health' }, 'Health'), el('a', { class: 'btn btn-sm', href: '#/logs' }, 'Activity')],
        }),
        headline,
        healthCard(health),
        el('div', { class: 'grid grid-2' }, storage, library),
        services,
        recent,
      );
    };

    await draw();
    autoRefresh(draw, 8000);
  }

  function dot(ok, partial = false) {
    return el('span', { class: `dot ${ok ? 'ok' : partial ? 'warn' : 'danger'}` });
  }

  // ------------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------------

  async function renderUsers() {
    const token = renderToken;
    const draw = async () => {
      forgetUsers();
      const { users } = await cachedUsers(0);

      const rows = table(
        [
          {
            label: 'User',
            wrap: true,
            render: (u) =>
              el(
                'a',
                { href: `#/user/${u.id}`, class: 'cell-title' },
                u.name,
              ),
          },
          {
            label: 'Status',
            render: (u) =>
              el(
                'span',
                { class: 'inline-list' },
                badge(u.active ? 'Active' : 'Inactive', u.active ? 'ok' : 'danger'),
                u.upload_enabled ? null : badge('Uploads off', 'warn'),
              ),
          },
          {
            label: 'Jellyfin',
            secondary: true,
            render: (u) =>
              titleCell(
                u.jellyfin_username,
                u.libraries.length ? `${u.libraries.length} libraries linked` : 'not provisioned',
              ),
          },
          {
            label: 'Storage',
            numeric: true,
            render: (u) => titleCell(bytes(u.storage_bytes), `${number(u.media_items)} items`),
          },
          {
            label: 'Upload token',
            secondary: true,
            render: (u) => (u.has_upload_token ? badge('Issued', 'ok') : badge('None', 'neutral')),
          },
          {
            label: 'Actions',
            render: (u) =>
              el(
                'div',
                { class: 'row-actions' },
                el('a', { class: 'btn btn-sm', href: `#/user/${u.id}` }, 'Open'),
                menu({
                  label: `Actions for ${u.name}`,
                  items: [
                    { label: 'Edit details', onClick: () => editUser(u) },
                    { label: 'Provision Jellyfin', onClick: () => provisionUser(u) },
                    { label: 'View uploads', onClick: () => goToUserUploads(u) },
                    {
                      label: u.has_upload_token ? 'Replace upload token' : 'Generate upload token',
                      onClick: () => issueToken(u, draw),
                    },
                    u.has_upload_token
                      ? { label: 'Revoke upload token', danger: true, onClick: () => revokeToken(u, draw) }
                      : null,
                    { label: 'Delete user', danger: true, onClick: () => removeUser(u) },
                  ],
                }),
              ),
          },
        ],
        users,
        emptyState({
          icon: '◍',
          title: 'No users yet',
          message:
            'A user links a Telegram account to a Jellyfin account. Create the Jellyfin account first, then add it here.',
          action: el('button', { class: 'btn btn-primary', onclick: addUser }, 'Add the first user'),
        }),
        'Users',
      );

      mount(
        token,
        pageHead({
          title: 'Users',
          description:
            'Each user links one Telegram account to one Jellyfin account, with their own libraries and their own folders on disk.',
          actions: [el('button', { class: 'btn btn-primary', onclick: addUser }, 'Add user')],
        }),
        rows,
      );
    };

    await draw();
  }

  const userFields = (u) => [
    { name: 'name', label: 'Display name', value: u?.name ?? '', required: true },
    {
      name: 'telegram_chat_id',
      label: 'Telegram chat ID',
      type: 'number',
      value: u?.telegram_chat_id ?? '',
      required: true,
      hint: 'The user can get this by sending /start to the bot.',
    },
    {
      name: 'jellyfin_username',
      label: 'Jellyfin username',
      value: u?.jellyfin_username ?? '',
      required: true,
      hint: 'Must already exist in Jellyfin.',
    },
    {
      name: 'quota_bytes',
      label: 'Storage quota (GiB)',
      type: 'number',
      min: 0,
      value: u?.quota_bytes ? Math.round(u.quota_bytes / 1024 ** 3) : '',
      hint: 'Leave empty for unlimited. Enforced when an upload is accepted.',
    },
    { name: 'active', label: 'Account active', type: 'checkbox', value: u ? u.active : true },
    {
      name: 'upload_enabled',
      label: 'Uploading enabled',
      type: 'checkbox',
      value: u ? u.upload_enabled : true,
    },
  ];

  /** GiB in the form, bytes on the wire. Empty means unlimited, not zero. */
  function quotaFromForm(value) {
    if (value === '' || value === null || value === undefined) return null;
    const gib = Number(value);
    if (!Number.isFinite(gib) || gib <= 0) return null;
    return Math.round(gib * 1024 ** 3);
  }

  async function addUser() {
    const result = await openModal({
      title: 'Add user',
      submitLabel: 'Create user',
      description:
        'This links an existing Jellyfin account to a Telegram ID and restricts it to its own libraries.',
      fields: userFields(null),
      onSubmit: async (data) => {
        const response = await Api.createUser({
          name: data.name,
          telegram_chat_id: Number(data.telegram_chat_id),
          jellyfin_username: data.jellyfin_username,
          quota_bytes: quotaFromForm(data.quota_bytes),
          active: data.active,
          upload_enabled: data.upload_enabled,
        });
        if (response.provision?.warnings?.length) {
          for (const w of response.provision.warnings) toast(w, 'warn');
        }
      },
    });
    if (result) {
      forgetUsers();
      toast('User created', 'ok');
      navigate();
    }
  }

  async function editUser(u) {
    const result = await openModal({
      title: `Edit ${u.name}`,
      submitLabel: 'Save changes',
      fields: [
        ...userFields(u),
        { type: 'static', label: 'Movies folder', value: u.movies_path, mono: true },
        { type: 'static', label: 'TV folder', value: u.tv_path, mono: true },
      ],
      onSubmit: (data) =>
        Api.updateUser(u.id, {
          name: data.name,
          telegram_chat_id: Number(data.telegram_chat_id),
          jellyfin_username: data.jellyfin_username,
          quota_bytes: quotaFromForm(data.quota_bytes),
          active: data.active,
          upload_enabled: data.upload_enabled,
        }),
    });
    if (result) {
      forgetUsers();
      toast('User updated', 'ok');
      navigate();
    }
  }

  async function provisionUser(u) {
    try {
      const result = await Api.provisionUser(u.id);
      for (const step of result.steps) toast(step, 'ok');
      for (const warning of result.warnings) toast(warning, 'warn');
      if (!result.steps.length && !result.warnings.length) toast('Jellyfin is already up to date', 'ok');
      forgetUsers();
      navigate();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeUser(u) {
    const ok = await confirmDialog({
      title: `Delete ${u.name}?`,
      message:
        'This removes the user, their upload history and their Jellyfin libraries.',
      detail: 'Their media files stay on disk and must be deleted manually.',
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await Api.deleteUser(u.id);
      forgetUsers();
      toast('User deleted', 'ok');
      for (const note of result.notes ?? []) toast(note);
      window.location.hash = '#/users';
      navigate();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function goToUserUploads(u) {
    window.location.hash = `#/uploads?userId=${u.id}`;
  }

  async function revokeToken(user, redraw) {
    const ok = await confirmDialog({
      title: 'Revoke the upload token?',
      message: `${user.name} will no longer be able to use the command-line uploader.`,
      detail: 'A new token can be generated at any time.',
      confirmLabel: 'Revoke token',
      danger: true,
    });
    if (!ok) return;
    try {
      await Api.revokeToken(user.id);
      forgetUsers();
      toast('Upload token revoked', 'ok');
      await redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /**
   * Issue an upload token and show it once.
   *
   * The plaintext exists only in this response: the server stores a SHA-256 of
   * it and cannot show it again, so the dialog says so rather than letting an
   * administrator assume they can come back for it.
   */
  async function issueToken(user, redraw) {
    const ok = await confirmDialog({
      title: user.has_upload_token ? 'Replace the upload token?' : 'Generate an upload token?',
      message: user.has_upload_token
        ? `${user.name} already has a token. Generating a new one immediately stops the old one working.`
        : `This lets ${user.name} upload with the command-line uploader.`,
      detail: 'The token is shown once and cannot be recovered afterwards.',
      confirmLabel: user.has_upload_token ? 'Replace token' : 'Generate token',
      danger: Boolean(user.has_upload_token),
    });
    if (!ok) return;

    let result;
    try {
      result = await Api.issueToken(user.id);
    } catch (err) {
      return void toast(err.message, 'error');
    }

    forgetUsers();
    await openModal({
      title: 'Upload token',
      submitLabel: 'Done',
      hideCancel: true,
      description: result.warning,
      fields: [
        { type: 'static', label: 'User', value: user.name },
        { type: 'static', label: 'Token', value: result.token, mono: true, copy: true },
      ],
    });
    await redraw();
  }

  // ------------------------------------------------------------------------
  // User detail
  // ------------------------------------------------------------------------

  const userUploadState = { status: '', q: '', offset: 0, limit: 10 };
  // Filter and page belong to one user's page; carried to the next user's
  // they showed "No uploads match this filter" for a filter nobody applied.
  let userUploadStateOwner = null;

  /**
   * A Telegram chat id, shown deliberately rather than by default.
   *
   * It identifies a real person's account, and this page is frequently open on
   * a shared screen. The administrator owns the value and can reveal it, but
   * it is not sitting in the open for a passing glance or a screenshot.
   */
  function maskedId(value, redraw) {
    const text = String(value ?? '');
    const tail = text.slice(-3);
    let revealed = false;
    const node = el('span', { class: 'secret-value' });
    const paint = () => {
      fill(
        node,
        el('code', {}, revealed ? text : `••••••${tail}`),
        el(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            onclick: () => {
              revealed = !revealed;
              paint();
            },
          },
          revealed ? 'Hide' : 'Reveal',
        ),
        revealed ? copyButton(text) : null,
      );
    };
    paint();
    return node;
  }

  async function renderUserDetail() {
    const id = routeArg();
    const token = renderToken;
    if (userUploadStateOwner !== id) {
      userUploadStateOwner = id;
      Object.assign(userUploadState, { status: '', q: '', offset: 0 });
    }

    const draw = async () => {
      const data = await Api.user(id);
      const u = data.user;
      const s = data.storage;
      const initial = (u.name || '?').trim().charAt(0);

      const header = card({
        className: 'profile-card',
        children: el(
          'div',
          { class: 'profile-head' },
          el('div', { class: `avatar${u.active ? '' : ' is-inactive'}`, 'aria-hidden': 'true' }, initial),
          el(
            'div',
            { class: 'page-head-main' },
            el(
              'div',
              { class: 'page-title-row' },
              el('h2', {}, u.name),
              badge(u.active ? 'Active' : 'Inactive', u.active ? 'ok' : 'danger'),
              u.upload_enabled ? null : badge('Uploads disabled', 'warn'),
            ),
            el(
              'div',
              { class: 'profile-meta' },
              el('span', {}, `Added ${dateTime(u.created_at)}`),
              el('span', {}, data.uploads.lastAt ? `Last upload ${relative(data.uploads.lastAt)}` : 'No uploads yet'),
              el('span', {}, `Jellyfin: ${u.jellyfin_username}`),
            ),
          ),
          el(
            'div',
            { class: 'page-actions' },
            el('button', { class: 'btn', onclick: () => editUser(u) }, 'Edit'),
            actionButton({
              label: u.active ? 'Deactivate' : 'Reactivate',
              busyLabel: 'Saving…',
              confirm: u.active
                ? {
                    title: `Deactivate ${u.name}?`,
                    message: 'They will stop being able to send files to the bot.',
                    detail: 'Their media and history are untouched, and they can be reactivated at any time.',
                    confirmLabel: 'Deactivate',
                    danger: true,
                  }
                : null,
              onClick: async () => {
                await Api.updateUser(u.id, { active: !u.active });
                forgetUsers();
                toast(u.active ? 'User deactivated' : 'User reactivated', 'ok');
                await draw();
              },
            }),
            menu({
              label: `More actions for ${u.name}`,
              items: [
                { label: 'Provision Jellyfin', onClick: () => provisionUser(u) },
                {
                  label: u.has_upload_token ? 'Replace upload token' : 'Generate upload token',
                  onClick: () => issueToken(u, draw),
                },
                u.has_upload_token
                  ? { label: 'Revoke upload token', danger: true, onClick: () => revokeToken(u, draw) }
                  : null,
                { label: 'Delete user', danger: true, onClick: () => removeUser(u) },
              ],
            }),
          ),
        ),
      });

      const overview = el(
        'div',
        { class: 'metrics' },
        metric({ label: 'Uploads', value: number(data.uploads.total), sub: 'all time' }),
        metric({ label: 'Completed', value: number(data.uploads.completed), tone: 'ok' }),
        metric({
          label: 'Failed',
          value: number(data.uploads.failed),
          tone: data.uploads.failed ? 'danger' : null,
          sub: data.uploads.failed ? 'needs attention' : 'none',
        }),
        metric({
          label: 'Active',
          value: number(data.uploads.active),
          tone: data.uploads.active ? 'busy' : null,
          sub: data.uploads.active ? 'in flight' : 'nothing running',
        }),
        data.uploads.needsReview
          ? metric({ label: 'Awaiting review', value: number(data.uploads.needsReview), tone: 'warn' })
          : null,
        metric({
          label: 'Typical time',
          value: data.uploads.medianDurationMs ? duration(data.uploads.medianDurationMs) : '—',
          sub: 'median, completed only',
        }),
      );

      const unlimited = s.quotaBytes === null;
      const pct = s.percentUsed ?? 0;
      const quotaTone = unlimited ? null : pct >= 100 ? 'danger' : pct >= 85 ? 'warn' : 'ok';

      const storageCard = card({
        title: 'Storage',
        subtitle: unlimited
          ? 'No quota is set, so this user may use whatever the disk has.'
          : `${pct.toFixed(0)}% of their quota is committed.`,
        actions: [el('button', { class: 'btn btn-sm', onclick: () => editUser(u) }, 'Change quota')],
        children: [
          el(
            'div',
            { class: 'metrics' },
            metric({ label: 'Used', value: bytes(s.usedBytes), sub: `${number(s.movies + s.episodes)} items` }),
            metric({
              label: 'In flight',
              value: bytes(s.reservedBytes),
              sub: s.reservedBytes ? 'accepted, not yet filed' : 'nothing pending',
            }),
            metric({ label: 'Quota', value: unlimited ? 'Unlimited' : bytes(s.quotaBytes) }),
            metric({
              label: 'Remaining',
              value: unlimited ? '—' : bytes(s.remainingBytes),
              tone: quotaTone === 'ok' ? null : quotaTone,
            }),
          ),
          unlimited
            ? el(
                'p',
                { class: 'hint' },
                'Uploads are still refused when the disk itself approaches its minimum free space.',
              )
            : meter({
                value: s.usedBytes + s.reservedBytes,
                max: s.quotaBytes,
                tone: quotaTone,
                label: `Quota used by ${u.name}`,
                caption: `${bytes(s.usedBytes + s.reservedBytes)} of ${bytes(s.quotaBytes)} committed · ${bytes(
                  s.remainingBytes,
                )} left`,
              }),
        ],
      });

      const telegramCard = card({
        title: 'Telegram',
        children: definitionList([
          ['Connection', u.telegram_chat_id ? badge('Linked', 'ok') : badge('Not linked', 'warn')],
          ['Chat ID', maskedId(u.telegram_chat_id)],
          ['Uploads sent', number(data.uploads.total)],
          ['First upload', data.uploads.firstAt ? dateTime(data.uploads.firstAt) : 'never'],
          ['Last activity', data.uploads.lastAt ? when(data.uploads.lastAt) : 'never'],
        ]),
      });

      const provisioned = data.jellyfin.linked && data.jellyfin.libraries >= data.jellyfin.expected;
      const jellyfinCard = card({
        title: 'Jellyfin',
        actions: [
          el('a', { class: 'btn btn-sm', href: '#/privacy' }, 'Check isolation'),
          el('button', { class: 'btn btn-sm', onclick: () => provisionUser(u) }, 'Provision'),
        ],
        children: [
          definitionList([
            ['Account', el('code', {}, u.jellyfin_username)],
            ['Linked', data.jellyfin.linked ? badge('Yes', 'ok') : badge('Not linked', 'danger')],
            [
              'Libraries',
              data.libraries.length
                ? el(
                    'span',
                    { class: 'inline-list' },
                    data.libraries.map((l) =>
                      badge(l.library_name ?? MEDIA_LIBRARY_LABEL[l.media_type] ?? l.media_type, 'neutral', {
                        glyph: false,
                      }),
                    ),
                  )
                : badge('Not provisioned', 'warn'),
            ],
            [
              'Isolation',
              provisioned
                ? badge('Own libraries only', 'ok')
                : badge('Incomplete — provision this user', 'warn'),
            ],
            ['Movies folder', el('code', {}, u.movies_path)],
            ['TV folder', el('code', {}, u.tv_path)],
          ]),
          el(
            'p',
            { class: 'hint', style: 'margin-top:.75rem' },
            provisioned
              ? 'This user has their own pair of libraries and no access to anyone else’s. Privacy re-derives that from Jellyfin itself.'
              : 'Until both libraries exist in Jellyfin, this account cannot see its own media.',
          ),
        ],
      });

      const uploadsCard = card({
        title: 'Uploads',
        subtitle: 'Only this user’s uploads.',
        actions: [
          el('a', { class: 'btn btn-sm', href: `#/uploads?userId=${u.id}` }, 'Open in Uploads'),
        ],
        children: [
          toolbar(
            selectField(
              'Status',
              statusOptions(UPLOAD_STATUSES),
              userUploadState.status,
              (v) => {
                userUploadState.status = v;
                userUploadState.offset = 0;
                drawUploads();
              },
            ),
            searchField('Search', 'Filename or title', userUploadState.q, (v) => {
              userUploadState.q = v;
              userUploadState.offset = 0;
              drawUploads();
            }),
          ),
          el('div', { id: 'user-uploads' }, loading('Loading uploads…')),
        ],
      });

      const activityCard = card({
        title: 'Account activity',
        subtitle: 'Administrative changes to this account.',
        children: data.activity.length
          ? table(
              [
                { label: 'When', render: (r) => when(r.created_at) },
                { label: 'Action', render: (r) => el('code', {}, r.action) },
                { label: 'By', secondary: true, render: (r) => r.actor_id ?? r.actor_type },
                {
                  label: 'Detail',
                  wrap: true,
                  secondary: true,
                  render: (r) => {
                    const detail = r.detail && Object.keys(r.detail).length ? r.detail : null;
                    return detail ? el('code', {}, JSON.stringify(detail).slice(0, 120)) : '—';
                  },
                },
              ],
              data.activity,
              'Nothing recorded.',
              `Account activity for ${u.name}`,
            )
          : emptyState({
              icon: '≡',
              title: 'No account changes recorded',
              message: 'Edits, provisioning and token changes for this user will be listed here.',
            }),
      });

      const ok = mount(
        token,
        pageHead({
          title: u.name,
          back: { href: '#/users', label: 'Users' },
          description: 'Everything this account has, has sent, and can reach.',
        }),
        header,
        overview,
        el('div', { class: 'grid grid-2' }, storageCard, telegramCard),
        jellyfinCard,
        uploadsCard,
        activityCard,
      );
      if (ok) await drawUploads();
    };

    /** The uploads list refreshes on its own, without redrawing the profile. */
    const drawUploads = async () => {
      const host = document.getElementById('user-uploads');
      if (!host) return;
      let data;
      try {
        data = await Api.userUploads(id, {
          status: userUploadState.status || undefined,
          q: userUploadState.q || undefined,
          limit: userUploadState.limit,
          offset: userUploadState.offset,
        });
      } catch (err) {
        clear(host).append(el('p', { class: 'hint text-danger' }, err.message));
        return;
      }

      clear(host).append(
        table(
          [
            {
              label: 'File',
              wrap: true,
              render: (r) =>
                el(
                  'a',
                  { href: `#/upload/${r.id}`, class: 'cell-title' },
                  r.detected_title || r.original_filename,
                ),
            },
            { label: 'Status', render: (r) => statusBadge(r.status) },
            { label: 'Size', numeric: true, render: (r) => bytes(r.file_size) },
            { label: 'Took', numeric: true, secondary: true, render: (r) => duration(r.duration_ms) },
            {
              label: 'In Jellyfin',
              render: (r) =>
                r.status !== 'COMPLETED'
                  ? '—'
                  : r.jellyfin_verified
                    ? badge('Verified', 'ok')
                    : badge('Pending', 'warn'),
            },
            { label: 'When', render: (r) => when(r.created_at) },
          ],
          data.uploads,
          userUploadState.status || userUploadState.q
            ? 'No uploads match this filter.'
            : 'This user has not uploaded anything yet.',
          'Uploads by this user',
        ),
        pager(data.total, userUploadState, drawUploads),
      );
    };

    await draw();
  }

  // ------------------------------------------------------------------------
  // Uploads
  // ------------------------------------------------------------------------

  const UPLOAD_STATUSES = [
    'RECEIVED',
    'QUEUED',
    'DOWNLOADING',
    'PROCESSING',
    'ORGANIZING',
    'JELLYFIN_SCAN',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'DUPLICATE',
    'NEEDS_REVIEW',
  ];

  const SOURCE_LABELS = {
    telegram: 'Telegram',
    mtproto: 'Telegram account',
    direct: 'Direct upload',
    multipart: 'Multipart',
  };

  const uploadState = { userId: '', status: '', mediaType: '', q: '', offset: 0, limit: 25 };

  /**
   * The same live progress the Telegram message shows.
   *
   * `progress_byte_accurate` says whether the percentage came from a byte
   * count or from the upload's position in the pipeline; the two are labelled
   * differently so a stage percentage is never read as a transfer percentage.
   */
  function renderLiveProgress(r) {
    if (TERMINAL.includes(r.status)) return '—';

    const stage = statusLabel(r.progress_stage ?? r.status);
    if (r.progress_percent === null || r.progress_percent === undefined) {
      return el(
        'div',
        { class: 'progress-cell' },
        el(
          'div',
          { class: 'progress-track' },
          el('div', { class: 'progress-fill is-indeterminate' }),
        ),
        el('div', { class: 'progress-meta' }, el('span', {}, stage)),
      );
    }

    const pct = Number(r.progress_percent);
    const detail = [];
    if (r.progress_byte_accurate) {
      if (r.bytes_downloaded && r.file_size) {
        detail.push(`${bytes(r.bytes_downloaded)} / ${bytes(r.file_size)}`);
      }
      if (r.progress_bytes_per_sec > 0) detail.push(`${bytes(r.progress_bytes_per_sec)}/s`);
      if (r.progress_eta_sec > 0) detail.push(`${duration(r.progress_eta_sec * 1000)} left`);
    } else {
      detail.push('pipeline position');
    }
    if (r.progress_part_count > 1) detail.unshift(`part ${r.progress_part}/${r.progress_part_count}`);

    return el(
      'div',
      { class: 'progress-cell' },
      el(
        'div',
        { class: 'progress-track' },
        el('div', { class: 'progress-fill', style: `width:${Math.max(0, Math.min(100, pct))}%` }),
      ),
      el(
        'div',
        { class: 'progress-meta' },
        el('span', {}, `${pct.toFixed(0)}% · ${stage}`),
        detail.length ? el('span', {}, detail.join(' · ')) : null,
      ),
    );
  }

  /** What an upload's row should say about where it stands. */
  function uploadStanding(r) {
    if (r.status === 'QUEUED') {
      return el('span', { class: 'hint' }, `Waiting ${relative(r.created_at).replace(' ago', '')}`);
    }
    if (r.status === 'FAILED') {
      return el(
        'span',
        { class: 'hint text-danger' },
        r.error_retryable === false ? 'Will fail the same way' : 'A retry may succeed',
      );
    }
    if (r.status === 'COMPLETED') {
      return r.jellyfin_verified
        ? badge('In Jellyfin', 'ok')
        : badge('Not yet in Jellyfin', 'warn');
    }
    if (r.status === 'NEEDS_REVIEW') return el('span', { class: 'hint' }, 'Waiting for a decision');
    return null;
  }

  async function renderUploads() {
    const token = renderToken;
    const hashQuery = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (hashQuery.get('userId')) uploadState.userId = hashQuery.get('userId');
    if (hashQuery.get('status')) uploadState.status = hashQuery.get('status');

    const draw = async () => {
      const [{ users }, data] = await Promise.all([
        cachedUsers(),
        Api.uploads({
          userId: uploadState.userId || undefined,
          status: uploadState.status || undefined,
          mediaType: uploadState.mediaType || undefined,
          q: uploadState.q || undefined,
          limit: uploadState.limit,
          offset: uploadState.offset,
        }),
      ]);

      const filtered = Boolean(
        uploadState.userId || uploadState.status || uploadState.mediaType || uploadState.q,
      );

      const filters = toolbar(
        selectField('User', userOptions(users), uploadState.userId, (v) => {
          uploadState.userId = v;
          uploadState.offset = 0;
          draw();
        }),
        selectField('Status', statusOptions(UPLOAD_STATUSES), uploadState.status, (v) => {
          uploadState.status = v;
          uploadState.offset = 0;
          draw();
        }),
        selectField(
          'Type',
          [
            { value: '', label: 'All types' },
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'TV' },
            { value: 'unknown', label: 'Unidentified' },
          ],
          uploadState.mediaType,
          (v) => {
            uploadState.mediaType = v;
            uploadState.offset = 0;
            draw();
          },
        ),
        searchField('Search', 'Filename or detected title', uploadState.q, (v) => {
          uploadState.q = v;
          uploadState.offset = 0;
          draw();
        }),
        filtered
          ? el(
              'div',
              { class: 'toolbar-end' },
              el(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: () => {
                    Object.assign(uploadState, { userId: '', status: '', mediaType: '', q: '', offset: 0 });
                    window.location.hash = '#/uploads';
                    draw();
                  },
                },
                'Clear filters',
              ),
            )
          : null,
      );

      const rows = table(
        [
          {
            label: 'File',
            wrap: true,
            render: (r) =>
              el(
                'div',
                {},
                el(
                  'a',
                  { href: `#/upload/${r.id}`, class: 'cell-title' },
                  r.detected_title || r.original_filename,
                ),
                r.detected_title ? el('div', { class: 'cell-sub mono' }, r.original_filename) : null,
                el(
                  'div',
                  { class: 'cell-sub' },
                  r.user_name,
                  ' · ',
                  SOURCE_LABELS[r.session_id ? 'multipart' : r.source] ?? r.source ?? 'unknown source',
                ),
                r.media_type === 'tv' && r.detected_season !== null
                  ? el(
                      'div',
                      { class: 'cell-sub' },
                      `S${String(r.detected_season).padStart(2, '0')}E${String(r.detected_episode ?? 0).padStart(2, '0')}`,
                    )
                  : null,
              ),
          },
          { label: 'Size', numeric: true, render: (r) => bytes(r.file_size) },
          { label: 'Progress', render: (r) => renderLiveProgress(r) },
          {
            label: 'Status',
            render: (r) => el('div', {}, statusBadge(r.status), el('div', { class: 'cell-sub' }, uploadStanding(r))),
          },
          {
            label: 'Started',
            render: (r) =>
              el(
                'div',
                {},
                when(r.created_at),
                r.duration_ms ? el('div', { class: 'cell-sub' }, `took ${duration(r.duration_ms)}`) : null,
              ),
          },
          {
            label: 'Actions',
            render: (r) =>
              el(
                'div',
                { class: 'row-actions' },
                el('a', { class: 'btn btn-sm', href: `#/upload/${r.id}` }, 'Details'),
                menu({
                  label: `Actions for ${r.original_filename}`,
                  items: [
                    r.error_message ? { label: 'Show the error', onClick: () => showError(r) } : null,
                    ['FAILED', 'CANCELLED'].includes(r.status)
                      ? {
                          label: 'Retry',
                          onClick: async () => {
                            try {
                              await Api.retryUpload(r.id);
                              toast('Queued for another attempt', 'ok');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        }
                      : null,
                    !TERMINAL.includes(r.status)
                      ? {
                          label: 'Cancel',
                          danger: true,
                          onClick: () => cancelUpload(r, draw),
                        }
                      : null,
                  ],
                }),
              ),
          },
        ],
        data.uploads,
        filtered
          ? emptyState({
              icon: '⊘',
              title: 'No uploads match these filters',
              message: 'Try widening the status or clearing the search.',
              action: el(
                'button',
                {
                  class: 'btn',
                  onclick: () => {
                    Object.assign(uploadState, { userId: '', status: '', mediaType: '', q: '', offset: 0 });
                    window.location.hash = '#/uploads';
                    draw();
                  },
                },
                'Clear filters',
              ),
            })
          : emptyState({
              icon: '▤',
              title: 'No uploads yet',
              message:
                'Send a video to the Telegram bot, or use the command-line uploader with an upload token. Anything that arrives shows up here immediately.',
              action: el('a', { class: 'btn', href: '#/users' }, 'Manage upload tokens'),
            }),
        'All uploads',
      );

      mount(
        token,
        pageHead({
          title: 'Uploads',
          description: 'Every file the system has been asked to take, and exactly where each one stands.',
        }),
        filters,
        rows,
        pager(data.total, uploadState, draw),
      );
    };

    await draw();
    autoRefresh(draw, 5000);
  }

  async function cancelUpload(r, redraw) {
    // Cancelling discards an in-flight transfer that may have been running for
    // hours; a row action is far too easy to hit by accident for that to be
    // silent.
    const ok = await confirmDialog({
      title: 'Cancel this upload?',
      message: `“${r.original_filename}” will stop and any progress will be discarded.`,
      detail: 'The sender can send the file again afterwards.',
      confirmLabel: 'Cancel upload',
      danger: true,
    });
    if (!ok) return;
    try {
      await Api.cancelUpload(r.id);
      toast('Cancellation requested', 'ok');
      await redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showError(upload) {
    openModal({
      title: 'Why this upload failed',
      submitLabel: 'Close',
      hideCancel: true,
      // The person who sent the file gets a deliberately generic message; the
      // administrator needs the stage, the code and whether a retry can help.
      fields: [
        { type: 'static', label: 'File', value: upload.original_filename, mono: true },
        { type: 'static', label: 'Status', value: statusLabel(upload.status) },
        { type: 'static', label: 'Failed at stage', value: upload.error_stage ?? '—' },
        { type: 'static', label: 'Error code', value: upload.error_code ?? '—', mono: true },
        {
          type: 'static',
          label: 'Retryable',
          value:
            upload.error_retryable === null || upload.error_retryable === undefined
              ? '—'
              : upload.error_retryable
                ? 'Yes — a retry may succeed'
                : 'No — it will fail the same way',
        },
        { type: 'static', label: 'Attempts', value: upload.attempts ?? '—' },
        { type: 'static', label: 'Message', value: upload.error_message ?? '—' },
        { type: 'static', label: 'Stored path', value: upload.stored_path ?? '—', mono: true },
        {
          type: 'static',
          label: 'Diagnose on the server',
          value: `npm run upload:diagnose -- --upload-id ${upload.id}`,
          mono: true,
          copy: true,
        },
      ],
    });
  }

  // ------------------------------------------------------------------------
  // Upload detail
  // ------------------------------------------------------------------------

  /**
   * The stages an upload passes through, in order, per ingestion route.
   *
   * Mirrors the worker's own model. A route only lists the steps it actually
   * performs — a multi-part upload is never fetched from Telegram, and a
   * direct upload never assembles parts — because showing a step that will not
   * run misdescribes the work as surely as a wrong percentage would.
   */
  const ROUTE_STEPS = {
    'telegram-local': ['RECEIVING', 'QUEUED', 'FETCHING', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
    'telegram-cloud': ['RECEIVING', 'QUEUED', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
    mtproto: ['RECEIVING', 'QUEUED', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
    multipart: ['RECEIVING', 'QUEUED', 'ASSEMBLING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
    direct: ['RECEIVING', 'QUEUED', 'ASSEMBLING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
  };

  const STEP_LABELS = {
    RECEIVING: 'Received',
    QUEUED: 'Queued',
    FETCHING: 'Fetched from Telegram',
    DOWNLOADING: 'Downloaded',
    ASSEMBLING: 'Assembled from parts',
    IDENTIFYING: 'Identified',
    TMDB: 'Metadata looked up',
    ORGANIZING: 'Filed into the library',
    JELLYFIN_SCAN: 'Jellyfin scanned',
    JELLYFIN_VERIFY: 'Verified in Jellyfin',
  };

  const STEP_NOTES = {
    RECEIVING: 'The file was accepted and recorded.',
    QUEUED: 'Waiting for a worker slot.',
    FETCHING: 'Asking Telegram to make the file downloadable.',
    DOWNLOADING: 'Transferring the bytes to this server.',
    ASSEMBLING: 'Joining the received parts back into one file.',
    IDENTIFYING: 'Reading the filename to work out what this is.',
    TMDB: 'Looking the title up for the correct name and year.',
    ORGANIZING: 'Moving it into the library folder Jellyfin watches.',
    JELLYFIN_SCAN: 'Asking Jellyfin to index the new file.',
    JELLYFIN_VERIFY: 'Confirming Jellyfin can actually see it.',
  };

  function routeOf(upload) {
    if (upload.source === 'mtproto') return 'mtproto';
    if (upload.source === 'direct') return 'direct';
    if (upload.session_id) return 'multipart';
    return 'telegram-local';
  }

  /**
   * The timeline.
   *
   * A completed upload shows every step done. A live one marks the current
   * stage and leaves the rest pending. A failed one stops at the stage it
   * reached and marks that one failed — which is the whole point of the view:
   * where it got to, and why it stopped.
   */
  function timeline(upload) {
    const steps = ROUTE_STEPS[routeOf(upload)] ?? ROUTE_STEPS['telegram-local'];
    const done = upload.status === 'COMPLETED';
    const failedAt = upload.status === 'FAILED' ? (upload.progress_stage ?? null) : null;
    const current = upload.progress_stage ?? null;
    const at = current ? steps.indexOf(current) : done ? steps.length : 0;

    return el(
      'ol',
      { class: 'timeline' },
      steps.map((step, i) => {
        let state = 'pending';
        if (done || (at >= 0 && i < at)) state = 'done';
        if (!done && failedAt === step) state = 'failed';
        else if (!done && !failedAt && i === at) state = 'current';

        const mark = { done: '✓', current: '●', failed: '✕', pending: '○' }[state];
        return el(
          'li',
          { class: `timeline-step is-${state}` },
          el('span', { class: 'timeline-mark', 'aria-hidden': 'true' }, mark),
          el(
            'div',
            { class: 'timeline-body' },
            el('span', {}, STEP_LABELS[step] ?? step),
            state === 'current' || state === 'failed'
              ? el('div', { class: 'timeline-note' }, state === 'failed' ? 'Stopped here.' : STEP_NOTES[step])
              : null,
          ),
          el('span', { class: 'sr-only' }, `: ${state}`),
        );
      }),
      upload.status === 'DUPLICATE'
        ? el(
            'li',
            { class: 'timeline-step is-done' },
            el('span', { class: 'timeline-mark', 'aria-hidden': 'true' }, '='),
            el('div', { class: 'timeline-body' }, el('span', {}, 'Already in the library')),
          )
        : null,
      upload.status === 'CANCELLED'
        ? el(
            'li',
            { class: 'timeline-step is-failed' },
            el('span', { class: 'timeline-mark', 'aria-hidden': 'true' }, '✕'),
            el('div', { class: 'timeline-body' }, el('span', {}, 'Cancelled')),
          )
        : null,
      upload.status === 'NEEDS_REVIEW'
        ? el(
            'li',
            { class: 'timeline-step is-failed' },
            el('span', { class: 'timeline-mark', 'aria-hidden': 'true' }, '?'),
            el(
              'div',
              { class: 'timeline-body' },
              el('span', {}, 'Waiting for a decision'),
              el('div', { class: 'timeline-note' }, 'The title could not be identified confidently enough to file it.'),
            ),
          )
        : null,
    );
  }

  async function renderUploadDetail() {
    const id = routeArg();
    const token = renderToken;
    let polling = false;

    const draw = async () => {
      const data = await Api.upload(id);
      const u = data.upload;
      const terminal = TERMINAL.includes(u.status);

      const live = !terminal
        ? card({
            title: 'Progress',
            children: [
              u.progress_percent !== null && u.progress_percent !== undefined
                ? el(
                    'div',
                    { class: 'progress-big' },
                    el('span', { class: 'progress-percent' }, `${Number(u.progress_percent).toFixed(0)}%`),
                    el('span', { class: 'progress-stage' }, statusLabel(u.progress_stage ?? u.status)),
                  )
                : el('p', { class: 'progress-stage' }, statusLabel(u.progress_stage ?? u.status)),
              renderLiveProgress(u) === '—' ? el('p', { class: 'hint' }, 'Waiting to start.') : renderLiveProgress(u),
              data.queue
                ? el(
                    'p',
                    { class: 'hint', style: 'margin-top:.5rem' },
                    data.queue.ahead === 0
                      ? `Next in line · ${data.queue.active} running.`
                      : `Position ${data.queue.ahead + 1} in the queue · ${data.queue.active} running.`,
                  )
                : null,
            ],
          })
        : null;

      const failure =
        u.status === 'FAILED'
          ? card({
              tone: 'danger',
              title: 'Failure',
              subtitle:
                u.error_retryable === false
                  ? 'A retry would fail the same way. Fix the cause first.'
                  : 'This looks transient — a retry may succeed.',
              actions: [
                actionButton({
                  label: 'Retry now',
                  busyLabel: 'Queueing…',
                  className: 'btn btn-sm btn-primary',
                  onClick: async () => {
                    await Api.retryUpload(u.id);
                    toast('Queued for another attempt', 'ok');
                    await draw();
                  },
                }),
              ],
              children: [
                definitionList([
                  ['Stage', u.error_stage],
                  ['Code', u.error_code ? el('code', {}, u.error_code) : null],
                  ['Attempts', u.attempts],
                  ['Failed at', u.error_at ? dateTime(u.error_at) : null],
                ]),
                el('pre', { class: 'log-detail' }, u.error_message ?? 'No message recorded.'),
                el(
                  'p',
                  { class: 'hint' },
                  'On the server: ',
                  el('code', {}, `npm run upload:diagnose -- --upload-id ${u.id}`),
                ),
              ],
            })
          : null;

      const review =
        u.status === 'NEEDS_REVIEW'
          ? card({
              tone: 'warn',
              title: 'Waiting for a decision',
              children: el(
                'p',
                { class: 'hint' },
                'The filename did not give enough confidence to file this automatically, so nothing was deleted: the file is in the quarantine folder under its original name. Rename it closer to its release title and send it again.',
              ),
            })
          : null;

      const ok = mount(
        token,
        pageHead({
          title: u.detected_title || u.original_filename,
          back: { href: '#/uploads', label: 'Uploads' },
          badge: statusBadge(u.status),
          description: `${SOURCE_LABELS[u.session_id ? 'multipart' : u.source] ?? u.source} · ${bytes(u.file_size)} · sent ${relative(
            u.created_at,
          )}`,
          actions: [
            ['FAILED', 'CANCELLED'].includes(u.status)
              ? actionButton({
                  label: 'Retry',
                  busyLabel: 'Queueing…',
                  className: 'btn btn-primary',
                  onClick: async () => {
                    await Api.retryUpload(u.id);
                    toast('Queued for another attempt', 'ok');
                    await draw();
                  },
                })
              : null,
            !terminal
              ? el('button', { class: 'btn btn-danger', onclick: () => cancelUpload(u, draw) }, 'Cancel')
              : null,
            data.media && !data.media.jellyfin_verified
              ? actionButton({
                  label: 'Retry Jellyfin',
                  busyLabel: 'Checking…',
                  onClick: async () => {
                    const r = await Api.verifyMedia(data.media.id);
                    toast(r.message, r.outcome === 'verified' ? 'ok' : 'warn');
                    await draw();
                  },
                })
              : null,
          ],
        }),
        live,
        failure,
        review,
        card({ title: 'Timeline', children: timeline(u) }),
        el(
          'div',
          { class: 'grid grid-2' },
          card({
            title: 'File',
            children: definitionList([
              ['Filename', el('code', {}, u.original_filename)],
              ['Size', bytes(u.file_size)],
              ['Source', SOURCE_LABELS[u.session_id ? 'multipart' : u.source] ?? u.source],
              ['Type', u.media_type ? statusLabel(u.media_type) : 'not identified'],
              ['Title', u.detected_title],
              ['Year', u.detected_year],
              u.detected_season ? ['Episode', `S${u.detected_season}E${u.detected_episode ?? 0}`] : null,
              ['Stored at', u.stored_path ? el('code', {}, u.stored_path) : null],
              ['Checksum', u.checksum_sha256 ? el('code', {}, `${u.checksum_sha256.slice(0, 16)}…`) : null],
            ]),
          }),
          card({
            title: 'Timing',
            children: definitionList([
              [
                'Uploader',
                data.user
                  ? el('a', { href: `#/user/${data.user.id}` }, data.user.name)
                  : `user ${u.user_id}`,
              ],
              ['Created', dateTime(u.created_at)],
              ['Updated', dateTime(u.updated_at)],
              ['Completed', u.completed_at ? dateTime(u.completed_at) : null],
              ['Duration', duration(u.duration_ms)],
            ]),
          }),
        ),
        card({
          title: 'Jellyfin',
          children: data.media
            ? [
                definitionList([
                  ['Library path', el('code', {}, data.media.path)],
                  [
                    'Visible in Jellyfin',
                    data.media.jellyfin_verified ? badge('Verified', 'ok') : badge('Not yet indexed', 'warn'),
                  ],
                  ['Item id', data.media.jellyfin_item_id ? el('code', {}, data.media.jellyfin_item_id) : null],
                ]),
                data.media.jellyfin_verified
                  ? null
                  : el(
                      'p',
                      { class: 'hint', style: 'margin-top:.5rem' },
                      'Jellyfin indexes on its own schedule. “Retry Jellyfin” asks it to scan now and then confirms the file is actually there.',
                    ),
              ]
            : el('p', { class: 'hint' }, 'No media record — this upload never reached the filing stage.'),
        }),
        card({
          title: 'Jobs',
          subtitle: 'Every attempt the worker made on this upload.',
          children: table(
            [
              { label: 'Job', render: (j) => `#${j.id}` },
              { label: 'Type', render: (j) => j.type },
              { label: 'Status', render: (j) => statusBadge(j.status) },
              { label: 'Attempts', numeric: true, render: (j) => `${j.attempts}/${j.max_attempts}` },
              {
                label: 'Error',
                wrap: true,
                secondary: true,
                render: (j) => (j.last_error ? j.last_error.slice(0, 160) : '—'),
              },
            ],
            data.jobs,
            'No jobs recorded.',
            'Job history for this upload',
          ),
        }),
      );

      // Poll only while there is something to watch, and stop the moment it
      // reaches a terminal status — the previous version issued a second
      // request on every page load purely to make this decision.
      if (!ok) return;
      if (!terminal && !polling) {
        polling = true;
        autoRefresh(draw, 3000);
      } else if (terminal && polling) {
        polling = false;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
      }
    };

    await draw();
  }

  // ------------------------------------------------------------------------
  // Multipart
  // ------------------------------------------------------------------------

  const multipartState = { userId: '', status: '', q: '', offset: 0, limit: 25 };

  const SESSION_STATUSES = [
    'COLLECTING', 'READY', 'ASSEMBLING', 'VERIFYING', 'HANDOFF',
    'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED',
  ];

  const SESSION_ACTIVE = ['COLLECTING', 'READY', 'ASSEMBLING', 'VERIFYING', 'HANDOFF'];

  async function renderMultipart() {
    const token = renderToken;
    const draw = async () => {
      const [{ users }, data] = await Promise.all([
        cachedUsers(),
        Api.sessions({
          userId: multipartState.userId || undefined,
          status: multipartState.status || undefined,
          q: multipartState.q || undefined,
          limit: multipartState.limit,
          offset: multipartState.offset,
        }),
      ]);

      const limits = data.limits ?? {};
      const counts = data.counts ?? {};

      const stats = el(
        'div',
        { class: 'metrics' },
        metric({
          label: 'Active',
          value: number(SESSION_ACTIVE.reduce((sum, k) => sum + (counts[k] ?? 0), 0)),
          tone: 'busy',
        }),
        metric({ label: 'Completed', value: number(counts.COMPLETED ?? 0), tone: 'ok' }),
        metric({
          label: 'Failed',
          value: number(counts.FAILED ?? 0),
          tone: (counts.FAILED ?? 0) ? 'danger' : null,
          sub: (counts.FAILED ?? 0) ? 'parts kept for retry' : 'none',
        }),
        metric({ label: 'Expired', value: number(counts.EXPIRED ?? 0), sub: 'parts removed' }),
        metric({
          label: 'Largest accepted',
          value: bytes(limits.maxAssembledBytes ?? 0),
          sub: `${bytes(limits.maxPartBytes ?? 0)} per part`,
        }),
      );

      const filters = toolbar(
        selectField('User', userOptions(users), multipartState.userId, (v) => {
          multipartState.userId = v;
          multipartState.offset = 0;
          draw();
        }),
        selectField('Status', statusOptions(SESSION_STATUSES), multipartState.status, (v) => {
          multipartState.status = v;
          multipartState.offset = 0;
          draw();
        }),
        searchField('Search', 'Filename', multipartState.q, (v) => {
          multipartState.q = v;
          multipartState.offset = 0;
          draw();
        }),
      );

      const rows = table(
        [
          {
            label: 'File',
            wrap: true,
            render: (s) =>
              titleCell(
                s.base_filename,
                s.user_name,
                s.missing_parts?.length ? `waiting for part ${s.missing_parts.slice(0, 6).join(', ')}` : null,
                s.error_message ? s.error_message.slice(0, 120) : null,
              ),
          },
          {
            label: 'Parts',
            render: (s) =>
              el(
                'span',
                { class: 'inline-list' },
                `${s.parts_ready}${s.expected_parts_effective ? `/${s.expected_parts_effective}` : ''}`,
                s.parts_failed ? badge(`${s.parts_failed} failed`, 'danger') : null,
              ),
          },
          { label: 'Size', numeric: true, render: (s) => bytes(s.assembled_size ?? s.total_bytes) },
          {
            label: 'Progress',
            wrap: true,
            render: (s) => {
              const total = s.expected_parts_effective || s.parts_total || 1;
              const pct = Math.min(100, (s.parts_ready / total) * 100);
              return el(
                'div',
                { class: 'progress-cell' },
                el(
                  'div',
                  { class: 'progress-track' },
                  el('div', {
                    class: `progress-fill${s.parts_failed ? ' is-failed' : ''}`,
                    style: `width:${pct.toFixed(1)}%`,
                  }),
                ),
                el('div', { class: 'progress-meta' }, el('span', {}, `${pct.toFixed(0)}%`)),
              );
            },
          },
          { label: 'Status', render: (s) => statusBadge(s.status) },
          { label: 'Started', render: (s) => when(s.created_at) },
          {
            label: 'Actions',
            render: (s) =>
              el(
                'div',
                { class: 'row-actions' },
                el('button', { class: 'btn btn-sm', onclick: () => showSession(s) }, 'Parts'),
                menu({
                  label: `Actions for ${s.base_filename}`,
                  items: [
                    ['FAILED', 'EXPIRED', 'READY', 'COLLECTING'].includes(s.status)
                      ? {
                          label: 'Retry',
                          onClick: async () => {
                            try {
                              const r = await Api.retrySession(s.id);
                              toast(r.requeued ? `Requeued ${r.requeued} part(s)` : 'Retrying', 'ok');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        }
                      : null,
                    SESSION_ACTIVE.includes(s.status)
                      ? {
                          label: 'Cancel',
                          danger: true,
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: `Cancel “${s.base_filename}”?`,
                              message: 'The parts received so far will be deleted from the server.',
                              confirmLabel: 'Cancel upload',
                              danger: true,
                            });
                            if (!ok) return;
                            try {
                              await Api.cancelSession(s.id);
                              toast('Upload cancelled', 'ok');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        }
                      : null,
                  ],
                }),
              ),
          },
        ],
        data.sessions,
        emptyState({
          icon: '◫',
          title: 'No multi-part uploads yet',
          message: `Files above ${bytes(limits.maxPartBytes ?? 0)} are split by the sender and reassembled here.`,
        }),
        'Multi-part upload sessions',
      );

      const explain = card({
        title: 'How this works',
        children: el(
          'p',
          { class: 'hint' },
          `Telegram cannot deliver one file above ${bytes(limits.maxPartBytes ?? 0)}. A sender splits the file locally and sends the pieces named Movie.mkv.part1, Movie.mkv.part2 and so on. The server collects them, reassembles the original bytes, verifies the size, then hands the result to the ordinary pipeline — identification, deduplication, the Jellyfin layout and the library scan all run unchanged. Assembled files may be up to ${bytes(limits.maxAssembledBytes ?? 0)}. A session with no new parts for ${limits.idleMinutes ?? 30} minutes is assembled if complete, or expired and its parts removed if not.`,
        ),
      });

      mount(
        token,
        pageHead({
          title: 'Multipart uploads',
          description: 'Large files that arrive in pieces and are reassembled before the ordinary pipeline runs.',
        }),
        stats,
        filters,
        rows,
        pager(data.total, multipartState, draw),
        explain,
      );
    };

    await draw();
    autoRefresh(draw, 5000);
  }

  function showSession(session) {
    const partRows = table(
      [
        { label: 'Part', numeric: true, render: (p) => String(p.part_number) },
        { label: 'File', wrap: true, render: (p) => p.original_filename },
        { label: 'Size', numeric: true, render: (p) => bytes(p.file_size) },
        {
          label: 'Received',
          numeric: true,
          render: (p) => (p.status === 'READY' ? bytes(p.file_size) : bytes(p.bytes_downloaded)),
        },
        { label: 'Status', render: (p) => statusBadge(p.status) },
        {
          label: 'Error',
          wrap: true,
          secondary: true,
          render: (p) => (p.error_message ? p.error_message.slice(0, 160) : '—'),
        },
      ],
      session.parts ?? [],
      'No parts recorded.',
      'Parts in this session',
    );

    const dialog = document.getElementById('modal');
    const form = document.getElementById('modal-form');
    const body = clear(document.getElementById('modal-body'));
    const cancelBtn = dialog.querySelector('[data-close]');
    document.getElementById('modal-title').textContent = session.base_filename;
    document.getElementById('modal-error').hidden = true;
    document.getElementById('modal-submit').textContent = 'Close';
    cancelBtn.hidden = true;

    body.append(
      definitionList([
        ['Owner', session.user_name],
        ['Status', statusBadge(session.status)],
        ['Parts', `${session.parts_ready} ready of ${session.expected_parts_effective ?? '?'}`],
        ['Total size', bytes(session.assembled_size ?? session.total_bytes)],
        ['Missing', session.missing_parts?.length ? session.missing_parts.join(', ') : 'none'],
        ['Assembled SHA-256', el('code', {}, session.assembled_sha256 ?? '—')],
        ['Upload id', session.upload_id ? String(session.upload_id) : '—'],
      ]),
      el('div', { style: 'height:.75rem' }),
      partRows,
    );

    const close = () => {
      form.onsubmit = null;
      dialog.oncancel = null;
      dialog.onclose = null;
      cancelBtn.hidden = false;
      dialog.close();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      close();
    };
    dialog.oncancel = close;
    cancelBtn.onclick = close;
    dialog.showModal();
  }

  // ------------------------------------------------------------------------
  // Telegram fetch (MTProto)
  // ------------------------------------------------------------------------

  const mtprotoState = { userId: '', status: '', q: '', offset: 0, limit: 25 };

  const MTPROTO_STATUSES = [
    'PENDING', 'LOCATING', 'DOWNLOADING', 'VERIFYING', 'HANDOFF',
    'COMPLETED', 'FAILED', 'CANCELLED', 'UNAVAILABLE',
  ];

  const MTPROTO_ACTIVE = ['PENDING', 'LOCATING', 'DOWNLOADING', 'VERIFYING', 'HANDOFF'];

  function etaText(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  async function renderMtproto() {
    const token = renderToken;
    const draw = async () => {
      const [{ users }, data] = await Promise.all([
        cachedUsers(),
        Api.mtproto({
          userId: mtprotoState.userId || undefined,
          status: mtprotoState.status || undefined,
          q: mtprotoState.q || undefined,
          limit: mtprotoState.limit,
          offset: mtprotoState.offset,
        }),
      ]);

      const t = data.transport ?? {};
      const limits = data.limits ?? {};
      const counts = data.counts ?? {};

      const stats = el(
        'div',
        { class: 'metrics' },
        metric({
          label: 'Active',
          value: number(MTPROTO_ACTIVE.reduce((sum, k) => sum + (counts[k] ?? 0), 0)),
          tone: 'busy',
        }),
        metric({ label: 'Completed', value: number(counts.COMPLETED ?? 0), tone: 'ok' }),
        metric({
          label: 'Failed',
          value: number(counts.FAILED ?? 0),
          tone: (counts.FAILED ?? 0) ? 'danger' : null,
        }),
        metric({
          label: 'Unavailable',
          value: number(counts.UNAVAILABLE ?? 0),
          sub: 'source no longer reachable',
        }),
      );

      const filters = toolbar(
        selectField('User', userOptions(users), mtprotoState.userId, (v) => {
          mtprotoState.userId = v;
          mtprotoState.offset = 0;
          draw();
        }),
        selectField('Status', statusOptions(MTPROTO_STATUSES), mtprotoState.status, (v) => {
          mtprotoState.status = v;
          mtprotoState.offset = 0;
          draw();
        }),
        searchField('Search', 'Filename', mtprotoState.q, (v) => {
          mtprotoState.q = v;
          mtprotoState.offset = 0;
          draw();
        }),
      );

      const rows = table(
        [
          {
            label: 'File',
            wrap: true,
            render: (j) =>
              titleCell(
                j.file_name,
                `${j.user_name} · ${j.origin_kind}${j.telegram_message_id ? ` · msg ${j.telegram_message_id}` : ''}`,
                j.origin_title ? `from ${j.origin_title}` : null,
                j.error_message ? j.error_message.slice(0, 120) : null,
              ),
          },
          { label: 'Size', numeric: true, render: (j) => bytes(j.file_size) },
          {
            label: 'Progress',
            wrap: true,
            render: (j) =>
              el(
                'div',
                { class: 'progress-cell' },
                el(
                  'div',
                  { class: 'progress-track' },
                  el('div', {
                    class: 'progress-fill',
                    style: `width:${Math.min(100, j.percent ?? 0).toFixed(1)}%`,
                  }),
                ),
                el(
                  'div',
                  { class: 'progress-meta' },
                  el('span', {}, `${(j.percent ?? 0).toFixed(0)}% · ${bytes(j.bytes_downloaded)}`),
                  j.speed_bps ? el('span', {}, `${bytes(j.speed_bps)}/s · ${etaText(j.eta_seconds)} left`) : null,
                ),
              ),
          },
          {
            label: 'Status',
            render: (j) =>
              el(
                'div',
                {},
                statusBadge(j.status),
                el(
                  'div',
                  { class: 'cell-sub' },
                  j.attempts ? `${j.attempts} attempt${j.attempts === 1 ? '' : 's'} · ` : '',
                  'started ',
                  when(j.created_at),
                ),
              ),
          },
          {
            label: 'Actions',
            render: (j) =>
              el(
                'div',
                { class: 'row-actions' },
                menu({
                  label: `Actions for ${j.file_name}`,
                  items: [
                    ['FAILED', 'UNAVAILABLE', 'CANCELLED'].includes(j.status)
                      ? {
                          label: 'Retry',
                          onClick: async () => {
                            try {
                              await Api.retryMtproto(j.id);
                              toast('Requeued', 'ok');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        }
                      : null,
                    MTPROTO_ACTIVE.includes(j.status)
                      ? {
                          label: 'Cancel',
                          danger: true,
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: 'Cancel this fetch?',
                              message: `“${j.file_name}” will stop downloading and any progress will be discarded.`,
                              confirmLabel: 'Cancel fetch',
                              danger: true,
                            });
                            if (!ok) return;
                            try {
                              await Api.cancelMtproto(j.id);
                              toast('Cancellation requested', 'ok');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        }
                      : null,
                  ],
                }),
              ),
          },
        ],
        data.jobs,
        emptyState({
          icon: '⇄',
          title: 'Nothing has needed the Telegram account yet',
          message: `Forwarded media larger than ${bytes(limits.botApiCeiling ?? 0)} is fetched this way instead of through the bot.`,
        }),
        'Files fetched through the linked Telegram account',
      );

      const transportCard = card({
        title: 'Telegram account link',
        children: [
          definitionList([
            ['Status', el('span', {}, dot(t.authorized, t.sessionPresent), t.message ?? 'unknown')],
            ['Enabled', t.enabled ? badge('Yes', 'ok') : badge('No', 'neutral')],
            ['Account', t.accountUsername ? `@${t.accountUsername}` : '—'],
            ['Session file', t.sessionPresent ? `present, mode ${t.sessionPathMode ?? '?'}` : 'not present'],
            ['Bot API ceiling', bytes(limits.botApiCeiling ?? 0)],
            ['MTProto ceiling', bytes(limits.maxFileBytes ?? 0)],
          ]),
          el(
            'p',
            { class: 'hint', style: 'margin-top:.75rem' },
            'Forwarded media larger than the Bot API ceiling is fetched through the linked Telegram account and then handed to the ordinary pipeline. The session itself is never shown here or returned by the API.',
          ),
        ],
      });

      mount(
        token,
        pageHead({
          title: 'Telegram fetch',
          description:
            'Files too large for the Bot API, pulled through the linked Telegram account instead.',
        }),
        stats,
        filters,
        rows,
        pager(data.total, mtprotoState, draw),
        transportCard,
      );
    };

    await draw();
    autoRefresh(draw, 4000);
  }

  // ------------------------------------------------------------------------
  // Media
  // ------------------------------------------------------------------------

  const mediaState = { userId: '', type: '', verified: '', q: '', offset: 0, limit: 25 };

  async function renderMedia() {
    const token = renderToken;
    const draw = async () => {
      const [{ users }, data] = await Promise.all([
        cachedUsers(),
        Api.media({
          userId: mediaState.userId || undefined,
          type: mediaState.type || undefined,
          q: mediaState.q || undefined,
          limit: mediaState.limit,
          offset: mediaState.offset,
        }),
      ]);

      // Verification is a property of the row, not a filter the endpoint
      // supports; narrowing here is honest as long as the pager still counts
      // what the server returned, so the filter is applied to the page only
      // and says so.
      const visible =
        mediaState.verified === ''
          ? data.media
          : data.media.filter((m) =>
              mediaState.verified === 'yes' ? m.jellyfin_verified : !m.jellyfin_verified,
            );

      const filtered = Boolean(mediaState.userId || mediaState.type || mediaState.q);

      const filters = toolbar(
        selectField('Owner', userOptions(users, 'All owners'), mediaState.userId, (v) => {
          mediaState.userId = v;
          mediaState.offset = 0;
          draw();
        }),
        selectField(
          'Type',
          [
            { value: '', label: 'All types' },
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'TV episodes' },
          ],
          mediaState.type,
          (v) => {
            mediaState.type = v;
            mediaState.offset = 0;
            draw();
          },
        ),
        selectField(
          'In Jellyfin',
          [
            { value: '', label: 'Any' },
            { value: 'yes', label: 'Verified' },
            { value: 'no', label: 'Not yet' },
          ],
          mediaState.verified,
          (v) => {
            mediaState.verified = v;
            draw();
          },
        ),
        searchField('Search', 'Title', mediaState.q, (v) => {
          mediaState.q = v;
          mediaState.offset = 0;
          draw();
        }),
      );

      const rows = table(
        [
          {
            label: 'Title',
            wrap: true,
            render: (m) =>
              titleCell(
                m.year ? `${m.title} (${m.year})` : m.title,
                m.user_name,
                m.type === 'tv'
                  ? `S${String(m.season ?? 0).padStart(2, '0')}E${String(m.episode ?? 0).padStart(2, '0')}${
                      m.episode_title ? ` — ${m.episode_title}` : ''
                    }`
                  : null,
              ),
          },
          { label: 'Type', render: (m) => (m.type === 'movie' ? 'Movie' : 'Episode') },
          { label: 'Size', numeric: true, render: (m) => bytes(m.file_size) },
          {
            label: 'In Jellyfin',
            render: (m) => (m.jellyfin_verified ? badge('Verified', 'ok') : badge('Pending', 'warn')),
          },
          { label: 'Added', render: (m) => when(m.created_at) },
          {
            label: 'Actions',
            render: (m) =>
              el(
                'div',
                { class: 'row-actions' },
                el('button', { class: 'btn btn-sm', onclick: () => showMedia(m) }, 'Details'),
                menu({
                  label: `Actions for ${m.title}`,
                  items: [
                    m.jellyfin_verified
                      ? null
                      : {
                          label: 'Retry Jellyfin',
                          onClick: async () => {
                            try {
                              const r = await Api.verifyMedia(m.id);
                              toast(r.message, r.outcome === 'verified' ? 'ok' : 'warn');
                              draw();
                            } catch (err) {
                              toast(err.message, 'error');
                            }
                          },
                        },
                    m.upload_id ? { label: 'Open the upload', onClick: () => { window.location.hash = `#/upload/${m.upload_id}`; } } : null,
                    { label: 'Delete', danger: true, onClick: () => removeMedia(m, draw) },
                  ],
                }),
              ),
          },
        ],
        visible,
        filtered || mediaState.verified
          ? emptyState({
              icon: '⊘',
              title: 'Nothing matches these filters',
              message: 'Try a different owner, type or search term.',
            })
          : emptyState({
              icon: '▷',
              title: 'The library is empty',
              message: 'Media appears here once an upload has been identified and filed into a library folder.',
              action: el('a', { class: 'btn', href: '#/uploads' }, 'See uploads'),
            }),
        'Media library',
      );

      mount(
        token,
        pageHead({
          title: 'Media',
          description: 'Everything filed into a library, and whether Jellyfin can actually see it.',
          actions: [
            actionButton({
              label: 'Scan Jellyfin',
              busyLabel: 'Requesting…',
              onClick: async () => {
                await Api.jellyfinScan();
                toast('Jellyfin library scan requested', 'ok');
              },
            }),
          ],
        }),
        filters,
        rows,
        mediaState.verified
          ? el(
              'p',
              { class: 'hint', style: 'margin-bottom:1rem' },
              `Showing ${visible.length} of the ${data.media.length} rows on this page that match “In Jellyfin”.`,
            )
          : null,
        pager(data.total, mediaState, draw),
      );
    };

    await draw();
  }

  function showMedia(m) {
    openModal({
      title: m.year ? `${m.title} (${m.year})` : m.title,
      submitLabel: 'Close',
      hideCancel: true,
      fields: [
        { type: 'static', label: 'Path', value: m.path, mono: true, copy: true },
        { type: 'static', label: 'Size', value: bytes(m.file_size) },
        { type: 'static', label: 'TMDB id', value: m.tmdb_id ?? '—' },
        { type: 'static', label: 'Checksum', value: m.checksum_sha256 ?? '—', mono: true },
        { type: 'static', label: 'Jellyfin item', value: m.jellyfin_item_id ?? 'not indexed yet', mono: true },
        { type: 'static', label: 'Overview', value: m.overview ?? '—' },
      ],
    });
  }

  async function removeMedia(m, redraw) {
    const result = await openModal({
      title: `Delete “${m.title}”?`,
      submitLabel: 'Delete',
      description:
        'The database record is always removed. Tick the box to delete the file from disk as well — that cannot be undone.',
      fields: [{ name: 'deleteFile', label: 'Also delete the file from disk', type: 'checkbox', value: false }],
      onSubmit: async (data) => ({ ...(await Api.deleteMedia(m.id, data.deleteFile)), deleteFile: data.deleteFile }),
    });
    if (result) {
      // Told by the server, not by the checkbox: the row is always removed,
      // but the file only when the unlink actually succeeded.
      if (!result.deleteFile) toast('Media record deleted', 'ok');
      else if (result.fileRemoved) toast('Media and file deleted', 'ok');
      else toast('Media record deleted, but the file could not be removed — check the API log.', 'warn');
      await redraw();
    }
  }

  // ------------------------------------------------------------------------
  // Storage
  // ------------------------------------------------------------------------

  async function renderStorage() {
    const token = renderToken;
    const data = await Api.storage();
    const usedPct = data.disk.totalBytes ? (data.disk.usedBytes / data.disk.totalBytes) * 100 : 0;
    const low = data.disk.freeBytes < data.thresholds.minFreeBytes;
    const tone = low ? 'danger' : usedPct > 85 ? 'warn' : 'ok';

    const overview = card({
      title: 'Disk',
      subtitle: low
        ? 'Below the minimum free space — new uploads are being refused.'
        : 'The filesystem the media library lives on.',
      tone: low ? 'danger' : null,
      children: [
        el(
          'div',
          { class: 'metrics' },
          metric({ label: 'Total', value: data.disk.totalHuman }),
          metric({ label: 'Used', value: data.disk.usedHuman, sub: `${usedPct.toFixed(1)}%` }),
          metric({
            label: 'Free',
            value: data.disk.freeHuman,
            tone: tone === 'ok' ? null : tone,
            sub: low ? 'below minimum' : 'healthy',
          }),
          metric({
            label: 'Media',
            value: bytes(data.media.bytes),
            sub: `${number(data.media.movies)} movies · ${number(data.media.episodes)} episodes`,
          }),
        ),
        meter({
          value: data.disk.usedBytes,
          max: data.disk.totalBytes,
          tone,
          label: 'Disk used',
          caption: `${bytes(data.disk.usedBytes)} used · ${bytes(data.disk.freeBytes)} free · minimum ${bytes(
            data.thresholds.minFreeBytes,
          )}`,
        }),
      ],
    });

    const perUser = card({
      title: 'Per-user usage',
      subtitle: 'How the library divides between accounts.',
      children: table(
        [
          {
            label: 'User',
            render: (u) => (u.id ? el('a', { href: `#/user/${u.id}` }, u.name) : u.name),
          },
          { label: 'Items', numeric: true, render: (u) => number(u.items) },
          { label: 'Used', numeric: true, render: (u) => bytes(u.bytes) },
          {
            label: 'Share',
            wrap: true,
            render: (u) => {
              const pct = data.media.bytes ? (u.bytes / data.media.bytes) * 100 : 0;
              return meter({
                value: u.bytes,
                max: data.media.bytes || 1,
                label: `Share of the library used by ${u.name}`,
                caption: `${pct.toFixed(1)}%`,
              });
            },
          },
          {
            label: 'Quota',
            numeric: true,
            render: (u) => (u.quota_bytes ? bytes(u.quota_bytes) : 'Unlimited'),
          },
        ],
        data.perUser,
        'No users yet.',
        'Storage used per user',
      ),
    });

    const thresholds = card({
      title: 'Limits and paths',
      actions: [
        actionButton({
          label: 'Scan disk usage',
          busyLabel: 'Scanning…',
          onClick: async () => {
            const scan = await Api.storageScan();
            toast(
              `On disk — movies ${bytes(scan.moviesBytes)}, TV ${bytes(scan.tvBytes)}, quarantine ${bytes(
                scan.quarantineBytes,
              )}`,
              'ok',
            );
          },
        }),
      ],
      children: [
        definitionList([
          ['Minimum free space', bytes(data.thresholds.minFreeBytes)],
          ['Maximum file size', bytes(data.thresholds.maxFileSizeBytes)],
          ['Safety margin', bytes(data.thresholds.safetyMarginBytes)],
          ['Media root', el('code', {}, data.paths.mediaRoot)],
          ['Movies', el('code', {}, data.paths.moviesRoot)],
          ['TV shows', el('code', {}, data.paths.tvRoot)],
          ['Quarantine', el('code', {}, data.paths.quarantine)],
        ]),
        el(
          'p',
          { class: 'hint', style: 'margin-top:.75rem' },
          'Quarantine holds files that could not be identified confidently. Nothing there is ever deleted automatically.',
        ),
      ],
    });

    mount(
      token,
      pageHead({
        title: 'Storage',
        description: 'What the disk holds, who is using it, and the limits that protect it.',
      }),
      overview,
      perUser,
      thresholds,
    );
  }

  // ------------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------------

  async function renderHealth() {
    const token = renderToken;
    const draw = async () => {
      const [health, status] = await Promise.all([Api.systemHealth(), Api.systemStatus()]);
      const bad = health.checks.filter((c) => c.state !== 'ok');

      const summary = card({
        tone: health.state === 'ok' ? 'ok' : health.state === 'warn' ? 'warn' : 'danger',
        title: 'Overall',
        actions: [
          actionButton({
            label: 'Re-check now',
            busyLabel: 'Checking…',
            onClick: async () => {
              await draw();
              toast('Health re-checked', 'ok');
            },
          }),
        ],
        children: [
          el(
            'div',
            { class: 'page-title-row' },
            el(
              'span',
              { class: 'progress-percent' },
              health.state === 'ok' ? 'Healthy' : health.state === 'warn' ? 'Warning' : health.state === 'down' ? 'Down' : 'Unknown',
            ),
            badge(
              `${health.checks.length - bad.length} of ${health.checks.length} checks passing`,
              health.state === 'ok' ? 'ok' : health.state === 'warn' ? 'warn' : 'danger',
            ),
          ),
          el('p', { class: 'hint', style: 'margin-top:.5rem' }, `Last checked ${relative(health.checkedAt)}.`),
        ],
      });

      const tiles = card({
        title: 'Checks',
        subtitle: 'Worst first. Each one says what it looked at and what to do about it.',
        children: el(
          'div',
          { class: 'health-grid' },
          health.checks.map((c) =>
            el(
              'div',
              { class: `health-tile is-${c.state}` },
              el(
                'div',
                { class: 'health-tile-head' },
                el('span', { class: 'health-label' }, c.label),
                badge(HEALTH_WORD[c.state] ?? c.state, toneForHealth(c.state)),
              ),
              el('p', { class: 'hint' }, c.detail),
              c.action ? el('p', { class: 'hint health-action' }, c.action) : null,
            ),
          ),
        ),
      });

      const runtime = card({
        title: 'Runtime',
        subtitle: 'The API process answering this page.',
        children: definitionList([
          ['Node', status.process.nodeVersion],
          ['Uptime', duration(status.process.uptimeSec * 1000)],
          ['Memory', `${bytes(status.process.memoryRssBytes)} resident`],
          [
            'Queue',
            el(
              'span',
              {},
              `${number(status.jobs.pending ?? 0)} waiting · ${number(status.jobs.active ?? 0)} running · ${number(
                status.jobs.failed ?? 0,
              )} failed`,
              status.jobs.deferred
                ? el(
                    'span',
                    { class: 'cell-sub' },
                    `${number(status.jobs.deferred)} deferred — backing off or paused, not waiting for a worker`,
                  )
                : null,
            ),
          ],
        ]),
      });

      mount(
        token,
        pageHead({
          title: 'System health',
          description:
            'Whether anything is wrong right now — not just whether each dependency answered. The same checks drive the Telegram alerts.',
          badge: badge(
            HEALTH_WORD[health.state] ?? health.state,
            toneForHealth(health.state),
          ),
        }),
        summary,
        tiles,
        runtime,
      );
    };

    await draw();
    autoRefresh(draw, 15000);
  }

  // ------------------------------------------------------------------------
  // Privacy
  // ------------------------------------------------------------------------

  async function renderPrivacy() {
    const token = renderToken;
    const draw = async () => {
      const report = await Api.privacy();
      const tone = report.checked ? (report.ok ? 'ok' : 'danger') : 'warn';

      const banner = card({
        tone,
        title: report.checked
          ? report.ok
            ? 'Isolation verified'
            : 'Isolation is broken'
          : 'Isolation could not be checked',
        subtitle: report.checked
          ? `Checked ${report.managedLibraries} managed libraries against every Jellyfin account at ${dateTime(
              report.checkedAt,
            )}.`
          : 'Configure the Jellyfin API key to enable verification.',
        actions: [
          actionButton({
            label: 'Re-apply isolation',
            busyLabel: 'Applying…',
            className: 'btn btn-primary',
            // Rewrites every managed account's Jellyfin library policy.
            confirm: {
              title: 'Re-apply isolation to all users?',
              message: 'Each managed account will be restricted to its own libraries.',
              detail: 'Libraries this system did not create are preserved.',
              confirmLabel: 'Re-apply isolation',
            },
            onClick: async () => {
              const result = await Api.enforcePrivacy();
              toast(`Re-applied isolation for ${result.repaired.length} users`, 'ok');
              for (const w of result.warnings) toast(w, 'warn');
              await draw();
            },
          }),
          actionButton({ label: 'Re-check', busyLabel: 'Checking…', onClick: draw }),
        ],
        children: el(
          'p',
          { class: 'hint' },
          report.ok
            ? 'Every managed account can see only its own libraries.'
            : 'Findings below list exactly which account can see what it should not.',
        ),
      });

      const findings = card({
        title: 'Findings',
        children: report.findings.length
          ? report.findings.map((f) =>
              el(
                'div',
                { class: `finding ${f.severity}` },
                el('strong', {}, f.severity === 'error' ? 'Error' : f.severity === 'warning' ? 'Warning' : 'Note'),
                ' · ',
                el('span', {}, f.message),
              ),
            )
          : emptyState({
              icon: '⊙',
              title: 'No findings',
              message: 'Every account sees only its own libraries.',
            }),
      });

      const explainer = card({
        title: 'How isolation works',
        children: el(
          'p',
          { class: 'hint' },
          'Jellyfin grants access per library, not per folder, so separate folders alone would give no privacy. Each user gets their own pair of libraries pointed at their own directories, and their Jellyfin account is set to “access to all libraries: off” with only those two libraries enabled. This page re-derives that state from Jellyfin itself, so a change made in the Jellyfin UI shows up here rather than silently exposing everyone.',
        ),
      });

      mount(
        token,
        pageHead({
          title: 'Privacy',
          description: 'Whether each account can see only its own media, checked against Jellyfin itself.',
        }),
        banner,
        findings,
        explainer,
      );
    };

    await draw();
  }

  // ------------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------------

  /**
   * A settings section.
   *
   * Every row names the environment variable that sets it. Values are read
   * from the environment once at startup and the dashboard cannot change them,
   * so the useful thing a settings page can do is say precisely where to go
   * and what to edit — not present controls that quietly do nothing.
   */
  function settingsSection(title, rows, sources) {
    const body = rows.filter(Boolean).flatMap(([label, value, key]) => [
      el('dt', {}, label, key ? el('code', { class: 'env-key' }, sources?.[key] ?? key) : null),
      el('dd', {}, value ?? '—'),
    ]);
    return card({ title, children: el('dl', { class: 'kv' }, body) });
  }

  async function renderSettings() {
    const token = renderToken;
    const [settings, status] = await Promise.all([Api.settings(), Api.systemStatus()]);
    const e = settings.environment;
    const src = settings.sources ?? {};

    const connections = card({
      title: 'Connections',
      subtitle: 'Where this system reaches out to, and whether it is currently answering.',
      actions: [
        actionButton({
          label: 'Trigger Jellyfin scan',
          busyLabel: 'Requesting…',
          onClick: async () => {
            await Api.jellyfinScan();
            toast('Jellyfin library scan requested', 'ok');
          },
        }),
      ],
      children: definitionList([
        ['Jellyfin URL', el('code', {}, e.jellyfinUrl)],
        [
          'Jellyfin API key',
          el('span', {}, dot(status.jellyfin.authenticated, status.jellyfin.reachable), status.jellyfin.message),
        ],
        ['TMDB', el('span', {}, dot(status.tmdb.ok), status.tmdb.message)],
        [
          'Telegram API',
          el('code', {}, `${e.telegramApiRoot}${e.telegramLocalMode ? ' (local mode)' : ''}`),
        ],
        ['Max download', bytes(status.telegram.maxDownloadBytes)],
      ]),
    });

    const uploadsCard = settingsSection(
      'Uploads',
      [
        ['Largest single file', bytes(e.maxFileSizeBytes), 'maxFileSizeBytes'],
        ['Effective ceiling', bytes(e.effectiveMaxFileBytes), null],
        ['Accepted extensions', (e.allowedExtensions ?? []).join(', ').toUpperCase(), 'allowedExtensions'],
        ['Treated as a large transfer', e.largeUploadBytes ? bytes(e.largeUploadBytes) : null, 'largeUploadBytes'],
      ],
      src,
    );

    const workersCard = settingsSection(
      'Workers and retries',
      [
        ['Long-transfer slots', e.workerLargeConcurrency, 'workerLargeConcurrency'],
        ['Short-work slots', e.workerSmallConcurrency, 'workerSmallConcurrency'],
        ['Attempts per job', e.jobMaxAttempts, 'jobMaxAttempts'],
        ['First retry after', e.retryBackoffMs ? duration(e.retryBackoffMs) : null, 'retryBackoffMs'],
        ['Retry delay ceiling', e.retryMaxBackoffMs ? duration(e.retryMaxBackoffMs) : null, 'retryMaxBackoffMs'],
      ],
      src,
    );

    const backupsCard = settingsSection(
      'Backups',
      [
        ['Backup directory', el('code', {}, e.backupDir ?? '—'), 'backupDir'],
        ['Retention', e.backupRetentionDays ? `${e.backupRetentionDays} days` : null, 'backupRetentionDays'],
      ],
      src,
    );

    const storageCard = settingsSection(
      'Storage',
      [
        ['Media root', el('code', {}, e.mediaRoot), 'mediaRoot'],
        ['Movies', el('code', {}, e.moviesRoot), 'moviesRoot'],
        ['TV shows', el('code', {}, e.tvRoot), 'tvRoot'],
        ['Downloads (temp)', el('code', {}, e.downloadTmpDir), 'downloadTmpDir'],
        ['Quarantine', el('code', {}, e.quarantineDir), 'quarantineDir'],
        ['Minimum free disk', bytes(e.minFreeDiskBytes), 'minFreeDiskBytes'],
        ['Media group', e.mediaGroup, 'mediaGroup'],
        ['Log directory', el('code', {}, e.logDir), 'logDir'],
      ],
      src,
    );

    const runtime = card({
      title: 'System information',
      subtitle: 'Read from the running process, not from configuration.',
      children: definitionList([
        ['Node', status.process.nodeVersion],
        ['API uptime', duration(status.process.uptimeSec * 1000)],
        ['Memory', `${bytes(status.process.memoryRssBytes)} resident`],
        [
          'Queue',
          `${number(status.jobs.pending ?? 0)} waiting · ${number(status.jobs.active ?? 0)} running · ${number(
            status.jobs.failed ?? 0,
          )} failed`,
        ],
      ]),
    });

    const account = card({
      title: 'Administrator account',
      subtitle: 'The credentials that open this dashboard.',
      children: el(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const result = await openModal({
              title: 'Change password',
              submitLabel: 'Change password',
              description: 'Changing your password signs out every session, including this one.',
              fields: [
                { name: 'currentPassword', label: 'Current password', type: 'password', required: true },
                {
                  name: 'newPassword',
                  label: 'New password',
                  type: 'password',
                  required: true,
                  hint: 'At least 12 characters.',
                },
              ],
              onSubmit: (data) => Api.changePassword(data.currentPassword, data.newPassword),
            });
            if (result) {
              toast('Password changed. Please sign in again.', 'ok');
              setTimeout(showLogin, 1200);
            }
          },
        },
        'Change password',
      ),
    });

    const howToChange = card({
      title: 'Changing these',
      children: [
        el(
          'p',
          { class: 'hint' },
          'Everything above is read from the environment when each service starts, so the dashboard deliberately cannot edit it — a control that silently does nothing is worse than none. Edit .env and restart:',
        ),
        el('pre', { class: 'log-detail' }, 'systemctl --user restart jellygram-api jellygram-bot jellygram-worker'),
        el('p', { class: 'hint' }, settings.note),
      ],
    });

    mount(
      token,
      pageHead({
        title: 'Settings',
        description:
          'Configured by the server environment. This page shows what is in effect and names the variable that sets it.',
      }),
      connections,
      el('div', { class: 'grid grid-2' }, uploadsCard, workersCard, backupsCard, storageCard),
      runtime,
      account,
      howToChange,
    );
  }

  // ------------------------------------------------------------------------
  // Logs and activity
  // ------------------------------------------------------------------------

  let logService = 'worker';

  const logState = { tab: 'activity', level: '', q: '', offset: 0, limit: 25 };
  const auditState = { actorType: '', action: '', q: '', offset: 0, limit: 25 };

  let auditActions = null;

  async function renderLogs() {
    const draw = logState.tab === 'activity' ? drawActivity : drawServiceLogs;
    await draw();
    autoRefresh(draw, 10000);
  }

  /** Tabs shared by both views, so switching keeps the page identity. */
  function logTabs() {
    const tab = (id, label) =>
      el(
        'button',
        {
          class: 'btn btn-sm',
          'aria-current': logState.tab === id ? 'true' : 'false',
          onclick: () => {
            if (logState.tab === id) return;
            logState.tab = id;
            renderLogs();
          },
        },
        label,
      );
    return el('div', { class: 'tabs' }, tab('activity', 'Activity'), tab('service', 'Service logs'));
  }

  /**
   * The audit trail.
   *
   * The endpoint has always existed and been paginated; nothing in the
   * dashboard reached it, so the record of who changed what was only visible
   * through psql.
   */
  async function drawActivity() {
    const token = renderToken;
    if (!auditActions) {
      auditActions = await Api.auditActions()
        .then((r) => r.actions)
        .catch(() => []);
    }

    const data = await Api.audit({
      actorType: auditState.actorType || undefined,
      action: auditState.action || undefined,
      q: auditState.q || undefined,
      limit: auditState.limit,
      offset: auditState.offset,
    });

    const filters = toolbar(
      selectField(
        'Actor',
        [
          { value: '', label: 'Anyone' },
          { value: 'admin', label: 'Administrator' },
          { value: 'system', label: 'System' },
          { value: 'telegram', label: 'Telegram' },
        ],
        auditState.actorType,
        (v) => {
          auditState.actorType = v;
          auditState.offset = 0;
          drawActivity();
        },
      ),
      selectField(
        'Action',
        [{ value: '', label: 'All actions' }, ...auditActions.map((a) => ({ value: a, label: a }))],
        auditState.action,
        (v) => {
          auditState.action = v;
          auditState.offset = 0;
          drawActivity();
        },
      ),
      searchField('Search', 'Action, actor or detail', auditState.q, (v) => {
        auditState.q = v;
        auditState.offset = 0;
        drawActivity();
      }),
      el(
        'div',
        { class: 'toolbar-end' },
        actionButton({ label: 'Refresh', busyLabel: 'Loading…', className: 'btn btn-sm', onClick: drawActivity }),
      ),
    );

    mount(
      token,
      pageHead({
        title: 'Activity & logs',
        description: 'Who changed what, when, and from where. Written by the server, never by the browser.',
      }),
      logTabs(),
      filters,
      table(
        [
          { label: 'When', render: (r) => when(r.created_at) },
          {
            label: 'Actor',
            render: (r) => titleCell(r.actor_id ?? r.actor_type, r.actor_id ? r.actor_type : null),
          },
          { label: 'Action', render: (r) => el('code', {}, r.action) },
          {
            label: 'Subject',
            secondary: true,
            render: (r) => {
              if (!r.entity_type) return '—';
              const label = `${r.entity_type} ${r.entity_id ?? ''}`.trim();
              if (r.entity_type === 'user' && r.entity_id) return el('a', { href: `#/user/${r.entity_id}` }, label);
              if (r.entity_type === 'upload' && r.entity_id) return el('a', { href: `#/upload/${r.entity_id}` }, label);
              return label;
            },
          },
          { label: 'From', secondary: true, render: (r) => r.ip_address ?? '—' },
          {
            label: 'Detail',
            wrap: true,
            render: (r) => {
              const detail = r.detail && Object.keys(r.detail).length ? r.detail : null;
              if (!detail) return '—';
              const text = JSON.stringify(detail, null, 2);
              return el(
                'details',
                { class: 'log-line' },
                el('summary', {}, JSON.stringify(detail).slice(0, 80)),
                el('pre', { class: 'log-detail' }, text),
              );
            },
          },
        ],
        data.entries,
        auditState.actorType || auditState.action || auditState.q
          ? 'No activity matches these filters.'
          : emptyState({
              icon: '≡',
              title: 'Nothing recorded yet',
              message: 'Administrative actions — user changes, retries, token operations — are written here as they happen.',
            }),
        'Audit trail',
      ),
      pager(data.total, auditState, drawActivity),
    );
  }

  async function drawServiceLogs() {
    const token = renderToken;
    const data = await Api.logs(logService, 300);

    // Filtering happens on the tail already fetched: the endpoint returns the
    // last N lines, and narrowing them client-side avoids a round trip per
    // keystroke for what is at most a few hundred rows.
    const matches = (parsed, raw) => {
      if (logState.level) {
        const order = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
        const at = order.indexOf(String(parsed?.level ?? 'info'));
        if (at >= 0 && at < order.indexOf(logState.level)) return false;
      }
      if (logState.q && !raw.toLowerCase().includes(logState.q.toLowerCase())) return false;
      return true;
    };

    const lines = data.lines
      .map((raw) => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* not JSON; show verbatim */
        }
        if (!matches(parsed, raw)) return null;
        if (!parsed) return el('div', { class: 'log-line' }, raw);

        const { time, level, msg, service, ...rest } = parsed;
        const extras = Object.entries(rest)
          .filter(([k]) => !['pid', 'hostname'].includes(k))
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' ');

        // The full record is available on demand rather than truncated away:
        // an error's stack is exactly what an operator came here for.
        return el(
          'details',
          { class: `log-line level-${level ?? 'info'}` },
          el(
            'summary',
            {},
            el('span', { class: 'log-time' }, `${time ? new Date(time).toLocaleTimeString() : ''} `),
            `[${(level ?? 'info').toUpperCase()}] ${msg ?? ''}${extras ? ` · ${extras}` : ''}`,
          ),
          el('pre', { class: 'log-detail' }, JSON.stringify(parsed, null, 2)),
        );
      })
      .filter(Boolean);

    const filters = toolbar(
      selectField(
        'Service',
        [
          { value: 'worker', label: 'Worker' },
          { value: 'bot', label: 'Bot' },
          { value: 'api', label: 'API' },
        ],
        logService,
        (v) => {
          logService = v;
          drawServiceLogs();
        },
      ),
      selectField(
        'Level',
        [
          { value: '', label: 'All levels' },
          { value: 'info', label: 'Info and above' },
          { value: 'warn', label: 'Warnings and above' },
          { value: 'error', label: 'Errors only' },
        ],
        logState.level,
        (v) => {
          logState.level = v;
          drawServiceLogs();
        },
      ),
      searchField('Search', 'Search these lines', logState.q, (v) => {
        logState.q = v;
        drawServiceLogs();
      }),
      el(
        'div',
        { class: 'toolbar-end' },
        actionButton({ label: 'Refresh', busyLabel: 'Loading…', className: 'btn btn-sm', onClick: drawServiceLogs }),
      ),
    );

    mount(
      token,
      pageHead({
        title: 'Activity & logs',
        description: 'The tail of each service’s log file. Expand a line for the full record, including any stack.',
      }),
      logTabs(),
      filters,
      card({
        subtitle: data.file ? `Showing the tail of ${data.file}` : null,
        children: el(
          'div',
          { class: 'log-view' },
          lines.length
            ? lines
            : el(
                'div',
                { class: 'empty' },
                logState.q || logState.level
                  ? 'No lines match this filter.'
                  : (data.note ?? 'No log entries yet.'),
              ),
        ),
      }),
    );
  }

  // ------------------------------------------------------------------------
  // Session
  // ------------------------------------------------------------------------

  function showLogin() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    renderToken += 1;
    appView.hidden = true;
    loginView.hidden = false;
    document.getElementById('login-username').focus();
  }

  function showApp(me) {
    loginView.hidden = true;
    appView.hidden = false;
    document.getElementById('whoami').textContent = me.username;
    navigate();
  }

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = document.getElementById('login-error');
    const submit = document.getElementById('login-submit');
    errorNode.hidden = true;

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const me = await Api.login(username, password);
      document.getElementById('login-password').value = '';
      showApp(me);
    } catch (err) {
      // Deliberately whatever the server said: it never distinguishes an
      // unknown username from a wrong password, and the client must not
      // invent a distinction either.
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      document.getElementById('login-password').select();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await Api.logout();
    } catch {
      /* the cookie is cleared either way */
    }
    forgetUsers();
    showLogin();
  });

  document.getElementById('nav-toggle').addEventListener('click', () => {
    const open = document.getElementById('sidebar').classList.contains('open');
    if (open) closeSidebar();
    else openSidebar();
  });
  document.getElementById('sidebar-scrim').addEventListener('click', closeSidebar);

  // Escape closes the navigation drawer, the same way it closes a dialog.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('sidebar').classList.contains('open')) {
      closeSidebar();
      document.getElementById('nav-toggle').focus();
    }
  });

  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------

  /**
   * Paint the operator's chosen name (APP_NAME) over the neutral default.
   *
   * Read from the unauthenticated health endpoint, so the sign-in page is
   * branded too. A failure here is not worth reporting: the markup already
   * carries a sensible generic name, which is exactly what should be shown
   * when the server cannot be reached.
   */
  async function applyBranding() {
    let name = '';
    try {
      const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      name = (await res.json())?.appName ?? '';
    } catch {
      return;
    }
    if (!name) return;
    document.title = name;
    const heading = document.querySelector('.login-brand h1');
    if (heading) heading.textContent = name;
    const brand = document.querySelector('.topbar .brand');
    if (brand) brand.textContent = `🎬 ${name}`;
  }

  (async function boot() {
    initTheme();
    void applyBranding();
    try {
      const me = await Api.me();
      showApp(me);
    } catch {
      showLogin();
    }
  })();
})();
