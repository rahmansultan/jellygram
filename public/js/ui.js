/* global window, document */
'use strict';

/**
 * The shared component set.
 *
 * Every page is built from these. That is the point: a page that reaches for
 * its own markup is how eight subtly different button sizes and five spellings
 * of "no results" get into a product. Anything user- or Telegram-supplied is
 * inserted as *text*, never as HTML, so a filename containing markup cannot
 * become script in the dashboard.
 */
window.UI = (() => {
  // ------------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------------

  /** Create an element; children that are strings become text nodes. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'html') node.innerHTML = value; // only for literals we author
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /**
   * Replace a node's children, dropping the absent ones.
   *
   * `Node.append(null)` inserts the string "null" — which is exactly what the
   * user page showed beside a masked Telegram id. Everything built through
   * `el` already filters; this is for the places that append directly.
   */
  function fill(node, ...children) {
    clear(node);
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
    // A missing size is not a zero-byte file. Rendering it as "0 B" claims
    // knowledge the row does not have.
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let v = Math.abs(n);
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${(n < 0 ? '-' : '') + v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function number(value) {
    return Number(value ?? 0).toLocaleString();
  }

  function dateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function relative(value) {
    if (!value) return '—';
    const diff = Date.now() - new Date(value).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /**
   * A timestamp that reads well and stays precise.
   *
   * "3h ago" is what someone scanning a list wants; the exact time is what
   * they want the moment they stop scanning. Both, without spending a column.
   */
  function when(value) {
    if (!value) return '—';
    return el('span', { class: 'when', title: dateTime(value) }, relative(value));
  }

  function duration(ms) {
    if (!ms && ms !== 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  // ------------------------------------------------------------------------
  // Status vocabulary
  // ------------------------------------------------------------------------

  const STATUS_TONE = {
    COMPLETED: 'ok',
    FAILED: 'danger',
    DUPLICATE: 'neutral',
    CANCELLED: 'neutral',
    RECEIVED: 'busy',
    RECEIVING: 'busy',
    QUEUED: 'busy',
    DOWNLOADING: 'busy',
    PROCESSING: 'busy',
    ASSEMBLING: 'busy',
    ORGANIZING: 'busy',
    JELLYFIN_SCAN: 'busy',
    // Awaiting a person, not broken: warned rather than red, so a review queue
    // does not read as an outage.
    NEEDS_REVIEW: 'warn',
    EXPIRED: 'neutral',
    PENDING: 'busy',
    RUNNING: 'busy',
    DONE: 'ok',
    OPEN: 'busy',
  };

  /** Statuses read better as words than as the constant's own name. */
  const STATUS_LABEL = {
    NEEDS_REVIEW: 'Needs review',
    JELLYFIN_SCAN: 'Scanning',
    JELLYFIN_VERIFY: 'Verifying',
  };

  /**
   * Never colour alone.
   *
   * A glyph carries the same meaning as the colour does, so the state survives
   * a monochrome screen, a colour-blind reader, and a printout.
   */
  const TONE_GLYPH = { ok: '✓', warn: '!', danger: '✕', busy: '·', neutral: '–', info: 'i' };

  function statusLabel(status) {
    if (!status) return '—';
    return (
      STATUS_LABEL[status] ??
      status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')
    );
  }

  function badge(text, tone = 'neutral', { glyph = true } = {}) {
    return el(
      'span',
      { class: `badge is-${tone}` },
      glyph && TONE_GLYPH[tone]
        ? el('span', { class: 'badge-glyph', 'aria-hidden': 'true' }, TONE_GLYPH[tone])
        : null,
      text,
    );
  }

  function statusBadge(status) {
    return badge(statusLabel(status), STATUS_TONE[status] ?? 'neutral');
  }

  // ------------------------------------------------------------------------
  // Layout primitives
  // ------------------------------------------------------------------------

  /**
   * The head of every page: where am I, what is this, what can I do here.
   *
   * `back` renders a real link rather than a history step, so the page is
   * still navigable when it was opened directly from a bookmark.
   */
  function pageHead({ title, description, actions, back, badge: statusNode }) {
    return el(
      'header',
      { class: 'page-head' },
      back ? el('a', { class: 'back-link', href: back.href }, el('span', { 'aria-hidden': 'true' }, '←'), back.label) : null,
      el(
        'div',
        { class: 'page-head-main' },
        el('div', { class: 'page-title-row' }, el('h1', {}, title), statusNode ?? null),
        description ? el('p', { class: 'page-description' }, description) : null,
      ),
      actions?.filter(Boolean).length ? el('div', { class: 'page-actions' }, actions.filter(Boolean)) : null,
    );
  }

  function card({ title, subtitle, actions, tone, children, className }) {
    const head =
      title || actions
        ? el(
            'div',
            { class: 'card-head' },
            el(
              'div',
              {},
              title ? el('h2', {}, title) : null,
              subtitle ? el('p', { class: 'hint' }, subtitle) : null,
            ),
            actions?.filter(Boolean).length ? el('div', { class: 'card-actions' }, actions.filter(Boolean)) : null,
          )
        : null;

    return el(
      'section',
      { class: ['card', tone ? `card-${tone}` : null, className].filter(Boolean).join(' ') },
      head,
      ...[children].flat().filter(Boolean),
    );
  }

  /** A number worth reading at a glance, optionally a link to its detail. */
  function metric({ label, value, sub, tone, href, onclick }) {
    const body = el(
      'div',
      { class: ['metric', tone ? `is-${tone}` : null].filter(Boolean).join(' ') },
      el('span', { class: 'metric-label' }, label),
      el('span', { class: 'metric-value' }, value),
      sub ? el('span', { class: 'metric-sub' }, sub) : null,
    );
    if (href) return el('a', { class: 'metric-link', href }, body);
    if (onclick) return el('button', { class: 'metric-link', type: 'button', onclick }, body);
    return body;
  }

  /**
   * A proportion, stated in words as well as drawn.
   *
   * The bar is decorative; the caption underneath is the accessible fact. A
   * meter with only a bar tells a screen reader nothing at all.
   */
  function meter({ value, max, tone, caption, label }) {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    return el(
      'div',
      { class: 'meter-block' },
      el(
        'div',
        {
          class: `meter${tone ? ` is-${tone}` : ''}`,
          role: 'meter',
          'aria-valuenow': String(Math.round(pct)),
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-label': label ?? 'Usage',
        },
        el('span', { style: `width:${pct.toFixed(1)}%` }),
      ),
      caption ? el('p', { class: 'meter-caption' }, caption) : null,
    );
  }

  /**
   * What to show when there is nothing to show.
   *
   * Always says why it is empty, and offers the action that would fill it when
   * one exists — an empty frame leaves the reader unsure whether the page is
   * broken or simply new.
   */
  function emptyState({ icon = '◌', title, message, action }) {
    return el(
      'div',
      { class: 'empty-state' },
      el('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
      el('h3', {}, title),
      message ? el('p', {}, message) : null,
      action ?? null,
    );
  }

  /** Placeholder geometry while the first load is in flight. */
  function skeleton({ rows = 3, className } = {}) {
    return el(
      'div',
      { class: ['skeleton', className].filter(Boolean).join(' '), 'aria-hidden': 'true' },
      Array.from({ length: rows }, (_, i) =>
        el('span', { class: 'skeleton-line', style: `width:${[92, 74, 60, 84, 68][i % 5]}%` }),
      ),
    );
  }

  function loading(label = 'Loading…') {
    return el(
      'div',
      { class: 'loading', role: 'status' },
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', {}, label),
    );
  }

  function toolbar(...children) {
    return el('div', { class: 'toolbar' }, children.flat().filter(Boolean));
  }

  /** A labelled control. The label is real, not a placeholder pretending. */
  function field({ label, control, id, hint }) {
    if (id) control.setAttribute('id', id);
    return el(
      'div',
      { class: 'field' },
      el('label', id ? { for: id } : {}, label),
      control,
      hint ? el('p', { class: 'hint' }, hint) : null,
    );
  }

  function definitionList(rows) {
    const usable = rows.filter(Boolean);
    return el(
      'dl',
      { class: 'kv' },
      usable.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v ?? '—')]),
    );
  }

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------

  /**
   * A button that cannot be pressed twice.
   *
   * Every asynchronous action in the dashboard needs the same four states, and
   * hand-rolling them is how a button ends up spinning forever after a
   * rejected promise. The handler's own errors surface as a toast; the caller
   * only writes the request.
   */
  function actionButton({ label, busyLabel = 'Working…', onClick, className = 'btn', title, danger, confirm }) {
    const button = el(
      'button',
      {
        type: 'button',
        class: danger ? `${className} btn-danger` : className,
        title: title ?? null,
      },
      label,
    );

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      if (confirm) {
        const ok = await confirmDialog(confirm);
        if (!ok) return;
      }
      const original = button.textContent;
      button.disabled = true;
      button.classList.add('is-busy');
      button.textContent = busyLabel;
      try {
        await onClick();
      } catch (err) {
        toast(err?.message ?? 'Something went wrong', 'error');
      } finally {
        // The node may have been replaced by a redraw the handler triggered;
        // touching a detached button is harmless, leaving a live one disabled
        // is not.
        button.disabled = false;
        button.classList.remove('is-busy');
        button.textContent = original;
      }
    });
    return button;
  }

  /**
   * An overflow menu for row actions.
   *
   * Built on <details> deliberately: the disclosure behaviour, the focusable
   * trigger and Enter/Space are the browser's, so the only things left to add
   * are dismissal on Escape and on an outside click.
   */
  function menu({ label = 'Actions', items }) {
    const usable = items.filter(Boolean);
    if (!usable.length) return null;

    const list = el(
      'div',
      { class: 'menu-list', role: 'menu' },
      usable.map((item) =>
        el(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            class: `menu-item${item.danger ? ' is-danger' : ''}`,
            onclick: async () => {
              details.open = false;
              await item.onClick();
            },
          },
          item.label,
        ),
      ),
    );

    const details = el(
      'details',
      { class: 'menu' },
      el('summary', { class: 'btn btn-sm menu-trigger', 'aria-label': label, title: label }, el('span', { 'aria-hidden': 'true' }, '⋯')),
      list,
    );

    details.addEventListener('toggle', () => {
      if (!details.open) return;
      for (const other of document.querySelectorAll('details.menu[open]')) {
        if (other !== details) other.open = false;
      }
      const onDocClick = (event) => {
        if (!details.contains(event.target)) close();
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          close();
          details.querySelector('summary')?.focus();
        }
      };
      const close = () => {
        details.open = false;
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey, true);
      };
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    });

    return details;
  }

  /** Copy a value the server will not show twice, with honest feedback. */
  function copyButton(value, label = 'Copy') {
    return actionButton({
      label,
      busyLabel: 'Copied',
      className: 'btn btn-sm',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(String(value));
          toast('Copied to the clipboard', 'ok');
        } catch {
          // Clipboard access is refused outside a secure context, which this
          // dashboard often is. Say so rather than failing silently.
          toast('The browser refused clipboard access. Select the text and copy it manually.', 'warn');
        }
      },
    });
  }

  // ------------------------------------------------------------------------
  // Notifications
  // ------------------------------------------------------------------------

  const recentToasts = new Map();

  /**
   * One transient message.
   *
   * Repeats within a few seconds are suppressed: a five-second poll that fails
   * would otherwise stack an identical error until the screen is unusable.
   */
  function toast(message, kind = 'info') {
    const host = document.getElementById('toasts');
    if (!host) return;

    const key = `${kind}:${message}`;
    const now = Date.now();
    if (now - (recentToasts.get(key) ?? 0) < 4000) return;
    recentToasts.set(key, now);

    const node = el(
      'div',
      { class: `toast is-${kind}` },
      el('span', { class: 'toast-glyph', 'aria-hidden': 'true' }, TONE_GLYPH[kind === 'error' ? 'danger' : kind] ?? 'i'),
      el('span', {}, message),
      el('button', {
        type: 'button',
        class: 'toast-close',
        'aria-label': 'Dismiss',
        onclick: () => node.remove(),
        html: '&times;',
      }),
    );
    host.append(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 320);
    }, 5000);
  }

  // ------------------------------------------------------------------------
  // Dialogs
  // ------------------------------------------------------------------------

  /**
   * Open the shared modal. `fields` describes the form; the resolved value is
   * the collected values, or null when dismissed.
   */
  function openModal({ title, fields, submitLabel = 'Save', onSubmit, description, hideCancel }) {
    const dialog = document.getElementById('modal');
    const form = document.getElementById('modal-form');
    const body = clear(document.getElementById('modal-body'));
    const errorNode = document.getElementById('modal-error');
    const cancel = dialog.querySelector('[data-close]');

    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-submit').textContent = submitLabel;
    errorNode.hidden = true;
    cancel.hidden = Boolean(hideCancel);

    if (description) body.append(el('p', { class: 'modal-description' }, description));

    for (const field of fields ?? []) {
      if (field.type === 'checkbox') {
        body.append(
          el(
            'label',
            { class: 'checkbox' },
            el('input', {
              type: 'checkbox',
              name: field.name,
              id: `f-${field.name}`,
              ...(field.value ? { checked: true } : {}),
            }),
            field.label,
          ),
        );
      } else if (field.type === 'static') {
        // Not a <label>: there is no control for it to label, and an orphaned
        // label is announced as an unlabelled field by a screen reader.
        body.append(
          el('p', { class: 'field-label' }, field.label),
          el(
            'div',
            { class: field.mono ? 'static-value mono' : 'static-value' },
            String(field.value ?? '—'),
            field.copy ? copyButton(field.value) : null,
          ),
        );
      } else if (field.type === 'select') {
        body.append(el('label', { for: `f-${field.name}` }, field.label));
        body.append(
          el(
            'select',
            { name: field.name, id: `f-${field.name}` },
            (field.options ?? []).map((o) =>
              el('option', { value: o.value, ...(String(o.value) === String(field.value) ? { selected: true } : {}) }, o.label),
            ),
          ),
        );
        if (field.hint) body.append(el('p', { class: 'hint' }, field.hint));
      } else if (field.type === 'textarea') {
        body.append(el('label', { for: `f-${field.name}` }, field.label));
        body.append(el('textarea', { name: field.name, id: `f-${field.name}`, rows: '3' }, field.value ?? ''));
        if (field.hint) body.append(el('p', { class: 'hint' }, field.hint));
      } else {
        body.append(el('label', { for: `f-${field.name}` }, field.label));
        body.append(
          el('input', {
            type: field.type ?? 'text',
            name: field.name,
            id: `f-${field.name}`,
            value: field.value ?? '',
            placeholder: field.placeholder ?? '',
            ...(field.required ? { required: true } : {}),
            ...(field.min !== undefined ? { min: field.min } : {}),
          }),
        );
        if (field.hint) body.append(el('p', { class: 'hint' }, field.hint));
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const close = (result) => {
        if (settled) return;
        settled = true;
        form.onsubmit = null;
        dialog.oncancel = null;
        dialog.onclose = null;
        cancel.hidden = false;
        // Restore the default look: a previous danger dialog would otherwise
        // leave the next modal with a red submit button.
        document.getElementById('modal-submit').className = 'btn btn-primary';
        dialog.close();
        resolve(result);
      };

      // Escape and the backdrop close a native <dialog> without firing our
      // handlers. Without this the promise never settles, so everything the
      // caller does after `await openModal(...)` — the toast, the refresh —
      // silently never ran.
      dialog.oncancel = () => close(null);
      dialog.onclose = () => close(null);

      cancel.onclick = () => close(null);

      form.onsubmit = async (event) => {
        event.preventDefault();
        const data = {};
        for (const field of fields ?? []) {
          if (field.type === 'static') continue;
          const input = form.querySelector(`[name="${field.name}"]`);
          if (!input) continue;
          // Passwords are taken exactly as typed: trimming one here and not
          // at sign-in meant a password chosen with a leading or trailing
          // space could never be used.
          data[field.name] =
            field.type === 'checkbox' ? input.checked : field.type === 'password' ? input.value : input.value.trim();
        }

        const submit = document.getElementById('modal-submit');
        const label = submit.textContent;
        submit.disabled = true;
        submit.textContent = 'Saving…';
        try {
          // The handler's own result is what the caller gets, when it returns
          // one — the server's answer, not the form's — so a caller can act on
          // what actually happened rather than on what was asked for.
          const out = onSubmit ? await onSubmit(data) : undefined;
          close(out === undefined ? data : out);
        } catch (err) {
          errorNode.textContent = err.message ?? 'Something went wrong';
          errorNode.hidden = false;
        } finally {
          submit.disabled = false;
          submit.textContent = label;
        }
      };

      dialog.showModal();
      const first = body.querySelector('input, select, textarea');
      if (first) first.focus();
    });
  }

  async function confirmDialog({ title, message, detail, confirmLabel = 'Confirm', danger = false }) {
    const dialog = document.getElementById('modal');
    const form = document.getElementById('modal-form');
    const body = clear(document.getElementById('modal-body'));
    const cancel = dialog.querySelector('[data-close]');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-error').hidden = true;
    cancel.hidden = false;

    const submit = document.getElementById('modal-submit');
    submit.textContent = confirmLabel;
    submit.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    body.append(el('p', {}, message));
    if (detail) body.append(el('p', { class: 'hint' }, detail));

    return new Promise((resolve) => {
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        form.onsubmit = null;
        dialog.oncancel = null;
        dialog.onclose = null;
        submit.className = 'btn btn-primary';
        dialog.close();
        resolve(value);
      };
      // Escape means "no" for a confirmation, and must resolve as such.
      dialog.oncancel = () => close(false);
      dialog.onclose = () => close(false);
      cancel.onclick = () => close(false);
      form.onsubmit = (event) => {
        event.preventDefault();
        close(true);
      };
      dialog.showModal();
      cancel.focus();
    });
  }

  // ------------------------------------------------------------------------
  // Tables
  // ------------------------------------------------------------------------

  /**
   * Render a table; `columns` is [{ key, label, render?, wrap?, secondary? }].
   *
   * Below the card breakpoint the same markup becomes a stack of cards, driven
   * entirely by CSS reading `data-label` off each cell. One implementation
   * serves both, so a column added for the desktop view cannot go missing on a
   * phone. The explicit ARIA roles are what keep it a *table* to a screen
   * reader once `display` stops saying so.
   *
   * `secondary: true` marks a column that may be dropped from the card view —
   * detail that helps when scanning a wide table and only crowds a small one.
   */
  function table(columns, rows, emptyText = 'Nothing to show', caption) {
    if (!rows || rows.length === 0) {
      const empty =
        typeof emptyText === 'string' ? el('div', { class: 'empty' }, emptyText) : emptyText;
      return el('div', { class: 'table-wrap is-empty' }, empty);
    }

    const thead = el(
      'thead',
      { role: 'rowgroup' },
      el(
        'tr',
        { role: 'row' },
        columns.map((c) =>
          el(
            'th',
            {
              scope: 'col',
              role: 'columnheader',
              class: c.numeric ? 'is-numeric' : null,
            },
            c.label,
          ),
        ),
      ),
    );

    const tbody = el(
      'tbody',
      { role: 'rowgroup' },
      rows.map((row) =>
        el(
          'tr',
          { role: 'row' },
          columns.map((c, index) => {
            const content = c.render ? c.render(row) : (row[c.key] ?? '—');
            // A cell with nothing in it earns a labelled row of its own in the
            // card layout, where "PROGRESS —" is a line of noise on every
            // finished upload. Marked here, hidden by CSS on narrow screens
            // only: the column still has to exist on a wide one.
            const empty =
              index > 0 && (content === null || content === undefined || content === '' || content === '—');
            return el(
              'td',
              {
                role: 'cell',
                'data-label': c.label,
                class:
                  [
                    c.wrap ? 'wrap' : null,
                    c.numeric ? 'is-numeric' : null,
                    c.secondary ? 'is-secondary' : null,
                    empty ? 'is-empty' : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || null,
              },
              content === null || content === undefined || content === '' ? '—' : content,
            );
          }),
        ),
      ),
    );

    return el(
      'div',
      { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': caption ?? 'Data table' },
      el('table', { role: 'table' }, caption ? el('caption', { class: 'sr-only' }, caption) : null, thead, tbody),
    );
  }

  return {
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
  };
})();
