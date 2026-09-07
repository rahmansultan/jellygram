/* global window, document */
'use strict';

/**
 * The Telegram client, as far as this app is allowed to believe it.
 *
 * Two things come from here and they are not equally trustworthy. The theme,
 * the viewport and the haptics are cosmetics the client controls, and using
 * them is what makes the page feel native. `initData` is different: it is a
 * signed blob, and this module's job is only to *carry* it to the server. It
 * is deliberately never parsed here to decide anything — the copy of the user
 * that Telegram also exposes unsigned (`initDataUnsafe`) is used for nothing
 * at all, because a WebView can be made to say anything.
 */
window.TG = (() => {
  const webApp = window.Telegram?.WebApp ?? null;

  /** Held once read, because the fragment it came from is wiped immediately. */
  let cached = '';

  /**
   * The credential, from the SDK or from the URL.
   *
   * Telegram puts the same signed string in the fragment as `tgWebAppData`, so
   * the app still authenticates if telegram.org fails to load — on a slow
   * connection, or with the script blocked. The signature is verified server
   * side either way, so neither source is more trusted than the other.
   */
  function initData() {
    const fromSdk = webApp?.initData;
    if (typeof fromSdk === 'string' && fromSdk.length > 0) return fromSdk;

    try {
      const hash = window.location.hash.replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const raw = params.get('tgWebAppData');
      if (raw && raw.length > 0) {
        // Kept in memory, removed from the address. The fragment is a
        // credential, and leaving it in the URL means it survives in history,
        // in a screenshot, and in anything the reader might share.
        cached = raw;
        try {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        } catch {
          /* not always permitted; the credential is already in hand */
        }
        return raw;
      }
    } catch {
      /* no usable fragment */
    }
    return cached;
  }

  /** Only for greeting text, and only after the server has confirmed identity. */
  function displayName() {
    const user = webApp?.initDataUnsafe?.user;
    const name = typeof user?.first_name === 'string' ? user.first_name.trim() : '';
    return name.slice(0, 64);
  }

  function ready() {
    if (!webApp) return;
    try {
      webApp.ready();
      webApp.expand();
      // Telegram 7.7+; harmless where it is absent.
      webApp.disableVerticalSwipes?.();
    } catch {
      /* an older client without these methods */
    }
  }

  /** Open a link outside the WebView, where a plain http:// LAN URL still works. */
  function openExternal(url) {
    try {
      if (webApp?.openLink) {
        webApp.openLink(url, { try_instant_view: false });
        return true;
      }
    } catch {
      /* fall through to the browser's own handling */
    }
    try {
      window.open(url, '_blank', 'noopener');
      return true;
    } catch {
      return false;
    }
  }

  function haptic(type) {
    try {
      if (type === 'error' || type === 'success' || type === 'warning') {
        webApp?.HapticFeedback?.notificationOccurred?.(type);
      } else {
        webApp?.HapticFeedback?.impactOccurred?.(type ?? 'light');
      }
    } catch {
      /* haptics are a nicety */
    }
  }

  /**
   * Telegram's own confirmation sheet, with the browser's as a fallback.
   * Resolved rather than thrown so a caller can always await a decision.
   */
  function confirm(message) {
    return new Promise((resolve) => {
      try {
        if (webApp?.showConfirm) {
          webApp.showConfirm(message, (ok) => resolve(Boolean(ok)));
          return;
        }
      } catch {
        /* fall through */
      }
      resolve(window.confirm(message));
    });
  }

  function applyThemeClass() {
    const scheme = webApp?.colorScheme;
    if (scheme === 'dark' || scheme === 'light') {
      document.documentElement.dataset.tgTheme = scheme;
    }
  }

  if (webApp) {
    try {
      webApp.onEvent?.('themeChanged', applyThemeClass);
    } catch {
      /* older client */
    }
    applyThemeClass();
  }

  return {
    available: Boolean(webApp),
    initData,
    displayName,
    ready,
    openExternal,
    haptic,
    confirm,
    get platform() {
      return webApp?.platform ?? 'unknown';
    },
  };
})();
