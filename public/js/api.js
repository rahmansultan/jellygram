/* global window */
'use strict';

/**
 * Thin API client.
 *
 * The session lives in an HttpOnly cookie the page cannot read; the CSRF token
 * comes back in the login response and is held in memory only, so it is not
 * available to anything that manages to inject script into storage.
 */
window.Api = (() => {
  let csrfToken = null;

  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = details;
    }
  }

  /** A request that never returns would otherwise leave "Loading…" forever. */
  const TIMEOUT_MS = 30_000;

  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Distinguish "took too long" from "could not reach the server at all",
      // because the two call for different things from the reader.
      if (err && err.name === 'TimeoutError') {
        throw new ApiError('The server did not respond in time. It may still be working.', 0);
      }
      throw new ApiError('Could not reach the server. Check that it is running.', 0);
    }

    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 200) };
      }
    }

    if (!res.ok) {
      // A message written for a person, per status, rather than a bare code.
      const fallback =
        {
          401: 'Your session has expired. Please sign in again.',
          403: 'You are not allowed to do that.',
          404: 'That no longer exists. It may have been deleted.',
          409: 'That conflicts with the current state. Refresh and try again.',
          413: 'That is too large to accept.',
          429: 'Too many requests. Wait a moment and try again.',
          500: 'The server hit an unexpected problem. Check the logs.',
          502: 'The server is unreachable.',
          503: 'The server is temporarily unavailable.',
        }[res.status] ?? `Request failed (${res.status})`;
      throw new ApiError(payload?.error ?? fallback, res.status, payload?.details);
    }
    return payload;
  }

  function query(params) {
    const usable = Object.entries(params ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    );
    return usable.length ? `?${new URLSearchParams(usable).toString()}` : '';
  }

  return {
    ApiError,

    get csrfToken() {
      return csrfToken;
    },

    async login(username, password) {
      const data = await request('POST', '/auth/login', { username, password });
      csrfToken = data.csrfToken;
      return data;
    },

    async me() {
      const data = await request('GET', '/auth/me');
      csrfToken = data.csrfToken;
      return data;
    },

    logout: () => request('POST', '/auth/logout'),
    changePassword: (currentPassword, newPassword) =>
      request('POST', '/auth/password', { currentPassword, newPassword }),

    dashboard: () => request('GET', '/dashboard'),

    users: () => request('GET', '/users'),
    user: (id) => request('GET', `/users/${id}`),
    createUser: (payload) => request('POST', '/users', payload),
    updateUser: (id, payload) => request('PATCH', `/users/${id}`, payload),
    deleteUser: (id) => request('DELETE', `/users/${id}`),
    provisionUser: (id) => request('POST', `/users/${id}/provision`),
    issueToken: (id) => request('POST', `/users/${id}/token`),
    revokeToken: (id) => request('DELETE', `/users/${id}/token`),
    userUploads: (id, params) => request('GET', `/users/${id}/uploads${query(params)}`),

    uploads: (params) => request('GET', `/uploads${query(params)}`),
    retryUpload: (id) => request('POST', `/uploads/${id}/retry`),
    cancelUpload: (id) => request('POST', `/uploads/${id}/cancel`),

    sessions: (params) => request('GET', `/sessions${query(params)}`),
    session: (id) => request('GET', `/sessions/${id}`),
    retrySession: (id) => request('POST', `/sessions/${id}/retry`),
    cancelSession: (id) => request('POST', `/sessions/${id}/cancel`),

    mtproto: (params) => request('GET', `/mtproto${query(params)}`),
    retryMtproto: (id) => request('POST', `/mtproto/${id}/retry`),
    cancelMtproto: (id) => request('POST', `/mtproto/${id}/cancel`),

    media: (params) => request('GET', `/media${query(params)}`),
    deleteMedia: (id, deleteFile) => request('DELETE', `/media/${id}`, { deleteFile }),
    verifyMedia: (id) => request('POST', `/media/${id}/verify`),

    storage: () => request('GET', '/storage'),
    storageScan: () => request('GET', '/storage/scan'),

    systemStatus: () => request('GET', '/system/status'),
    systemHealth: () => request('GET', '/system/health'),
    privacy: () => request('GET', '/system/privacy'),
    enforcePrivacy: () => request('POST', '/system/privacy/enforce'),
    jellyfinScan: () => request('POST', '/system/jellyfin/scan'),

    settings: () => request('GET', '/settings'),
    upload: (id) => request('GET', `/uploads/${id}`),
    logs: (service, lines) => request('GET', `/logs/${service}${query({ lines })}`),
    audit: (params) => request('GET', `/audit${query(params)}`),
    auditActions: () => request('GET', '/audit/actions'),
  };
})();
