/* global window */
'use strict';

/**
 * The Mini App's API client.
 *
 * Every call carries the signed `initData` as `Authorization: tma …`. A header
 * rather than a cookie, deliberately: a cookie would ride along on cross-site
 * requests and need a CSRF token to defend, while a custom header cannot be
 * set by another origin without this server's permission, which it never
 * gives. That is the whole reason this surface has no CSRF machinery.
 *
 * The client also never sends a user id. There is no parameter for one; the
 * server decides who is asking from the signature alone.
 */
window.Api = (() => {
  const TIMEOUT_MS = 20_000;

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  function query(params) {
    const usable = Object.entries(params ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    );
    return usable.length ? `?${new URLSearchParams(usable).toString()}` : '';
  }

  async function request(method, path, { body, signal } = {}) {
    const headers = { Authorization: `tma ${window.TG.initData()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    // The timeout is built by hand rather than with `AbortSignal.timeout`,
    // which is absent from older WebViews — including ones Telegram opens Mini
    // Apps inside. Reaching for it there threw while the arguments were being
    // evaluated, so no request was ever made and the app reported "could not
    // connect": the one message guaranteed to send the reader looking at their
    // network instead of at this line.
    const controller = signal ? null : new AbortController();
    let timedOut = false;
    const timer = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, TIMEOUT_MS)
      : null;

    let res;
    try {
      res = await fetch(`/api/miniapp${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      // Distinguished because they call for different things from the reader:
      // one is worth retrying now, the other means check the connection.
      if (timedOut || err?.name === 'TimeoutError') {
        throw new ApiError('The server took too long to answer.', 0, 'TIMEOUT');
      }
      throw new ApiError('Could not reach the server.', 0, 'OFFLINE');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      const fallback =
        {
          401: 'Your session has expired. Close and reopen the app.',
          403: 'This Telegram account is not allowed here.',
          404: 'That no longer exists.',
          409: 'That cannot be done right now.',
          413: 'That file is too large.',
          429: 'Too many attempts. Wait a moment.',
          500: 'Something went wrong on the server.',
          503: 'The app is unavailable right now.',
        }[res.status] ?? `Request failed (${res.status})`;
      throw new ApiError(payload?.error ?? fallback, res.status, payload?.code ?? null);
    }
    return payload;
  }

  return {
    ApiError,
    config: () => request('GET', '/config'),
    me: () => request('GET', '/me'),
    library: (params) => request('GET', `/library${query(params)}`),
    uploads: (params) => request('GET', `/uploads${query(params)}`),
    active: () => request('GET', '/active'),
    cancelUpload: (id) => request('POST', `/uploads/${id}/cancel`),
    retryUpload: (id) => request('POST', `/uploads/${id}/retry`),
    posterUrl: (mediaId) => `/api/miniapp/poster/${mediaId}`,
  };
})();

/**
 * The ingest client.
 *
 * Talks to `/api/upload` — the same endpoints the command-line uploader uses,
 * with the same planning, resumable multi-part flow, quota and disk checks.
 * The only difference is which credential is presented, so a file sent from a
 * phone lands in exactly the same pipeline as one sent from a terminal.
 */
window.Ingest = (() => {
  const auth = () => ({ Authorization: `tma ${window.TG.initData()}` });

  async function readJson(res) {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  const CONTROL_TIMEOUT_MS = 30_000;

  /** A cancellation, as the caller recognises it. */
  const cancelled = () => Object.assign(new Error('Upload cancelled'), { cancelled: true });

  /**
   * A control call — begin, complete — bounded by the caller's signal and by
   * a timeout of its own, built by hand for the same reason `Api.request`
   * builds one. Neither used to be cancellable, so Cancel pressed while the
   * plan was being fetched did nothing until the plan arrived.
   */
  async function control(url, init, signal) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (err?.name === 'AbortError') throw new Error('The server took too long to answer.');
      throw new Error('Could not reach the server.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function begin(filename, size, signal) {
    const res = await control(
      '/api/upload/begin',
      {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, size }),
      },
      signal,
    );
    const body = await readJson(res);
    if (!res.ok) throw new Error(body?.error ?? `Upload could not start (${res.status})`);
    return body;
  }

  /**
   * A filename as a header value.
   *
   * Headers are bytes: the browser throws on any character above U+00FF, so an
   * Amharic or Cyrillic title could not be sent at all. Percent-encoded when
   * it has to be, exactly as the command-line uploader does; the server
   * decodes either form.
   */
  function headerFilename(name) {
    return /^[ -~]*$/.test(name) ? name : encodeURIComponent(name);
  }

  /**
   * Send one blob with real progress.
   *
   * XMLHttpRequest rather than fetch: it is the only way to observe *upload*
   * progress in a browser, and a progress bar that moves because of a timer
   * rather than because of bytes is a lie this app will not tell.
   */
  function put(url, blob, headers, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      for (const [k, v] of Object.entries({ ...auth(), ...headers })) xhr.setRequestHeader(k, v);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        let body = null;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          /* not json */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error ?? `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('The connection dropped during the upload.'));
      xhr.onabort = () => reject(cancelled());
      if (signal) {
        // `abort()` before `send()` fires no event at all, so the promise
        // would never settle and the card would hang with a dead Cancel.
        if (signal.aborted) return void reject(cancelled());
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(blob);
    });
  }

  async function complete(sessionId, signal) {
    const res = await control(`/api/upload/complete/${sessionId}`, { method: 'POST', headers: auth() }, signal);
    const body = await readJson(res);
    if (!res.ok) throw new Error(body?.error ?? `Could not finish the upload (${res.status})`);
    return body;
  }

  /**
   * Send a file, whole or in parts, as the server's own plan directs.
   *
   * The plan is asked for before a byte is read, so the decision is made on
   * the real file size rather than discovered half-way. A resumed session
   * skips the parts the server already holds.
   */
  async function send(file, { onStage, onProgress, signal } = {}) {
    onStage?.('planning');
    const plan = await begin(file.name, file.size, signal);

    if (plan.mode === 'single') {
      onStage?.('uploading');
      const result = await put(
        '/api/upload/single',
        file,
        { 'x-upload-filename': headerFilename(file.name), 'x-upload-size': String(file.size) },
        onProgress,
        signal,
      );
      onStage?.('queued');
      return result;
    }

    const partSize = plan.plan.partSize;
    const partCount = plan.plan.partCount;
    const already = new Set(plan.receivedParts ?? []);

    onStage?.('uploading');
    for (let number = 1; number <= partCount; number += 1) {
      if (signal?.aborted) throw Object.assign(new Error('Upload cancelled'), { cancelled: true });
      if (already.has(number)) continue;

      const start = (number - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));

      await put(
        `/api/upload/part/${plan.sessionId}/${number}`,
        blob,
        // The header the server reads for a part's declared length; it is what
        // lets a short body be refused instead of assembled.
        { 'x-upload-size': String(blob.size) },
        // `start` is the absolute offset of this part in the file, so it
        // already accounts for every earlier part — including the ones the
        // server already held and this run skipped. A resumed upload
        // therefore reports the position it has genuinely reached rather than
        // appearing to begin again.
        (loaded) => onProgress?.(Math.min(file.size, start + loaded), file.size),
        signal,
      );
    }

    onStage?.('assembling');
    const done = await complete(plan.sessionId, signal);
    onStage?.('queued');
    return done;
  }

  return { begin, send };
})();
