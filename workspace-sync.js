/*
 * AlpsAlpine shared workspace v6.0
 * Server-authoritative Supabase configuration + authentication + Realtime.
 * Uses existing localStorage JSON keys as a synchronous rendering cache only.
 * ALL edits are enforced by PostgreSQL Row Level Security; client controls are
 * merely a convenience. Do not store Supabase service-role keys in the browser.
 */
(function () {
  'use strict';

  const KEYS = Object.freeze({
    'beacons-v1': [],
    'favoriot-devices-v4': [],
    'favoriot-config-v4': {
      apiKey: '', username: '', refreshMs: 8000,
      authHeader: 'apikey', proxy: '', liveSocket: true
    }
  });
  const SHARED_KEYS = Object.keys(KEYS);
  const LEGACY_SNAPSHOT = {};
  for (const k of SHARED_KEYS) {
    try {
      const raw = localStorage.getItem(k);
      if (raw !== null) LEGACY_SNAPSHOT[k] = JSON.parse(raw);
    } catch (_) { /* optional old browser data */ }
  }

  const $ = id => document.getElementById(id);
  const config = window.ALPS_SUPABASE || {};
  let db = null;
  let role = '';
  let currentUser = null;
  let ready = false;
  let initialized = false;
  let activationId = 0;
  let channel = null;
  let pollTimer = null;
  let reloadTimer = null;
  let writeChain = Promise.resolve();
  let pendingWrites = 0;
  let lastSaveError = null;
  let snapshot = {};
  let callbacks = { onReady: null, onChange: null, onLogout: null };

  const isSharedKey = k => Object.prototype.hasOwnProperty.call(KEYS, k);
  const isAdmin = () => ready && role === 'admin';
  const isReady = () => ready;
  const setMessage = (message, error = false) => {
    const el = $('workspaceMessage');
    if (el) {
      el.textContent = message || '';
      el.classList.toggle('text-danger', error);
      el.classList.toggle('text-secondary', !error);
    }
  };
  function setGate(message = '', error = false) {
    const gate = $('workspaceGate');
    if (gate) gate.hidden = false;
    const msg = $('workspaceGateMessage');
    if (msg) {
      msg.textContent = message;
      msg.classList.toggle('text-danger', error);
    }
  }
  function hideGate() {
    const gate = $('workspaceGate');
    if (gate) gate.hidden = true;
  }
  function resetPrivateCache() {
    for (const k of SHARED_KEYS) {
      try { localStorage.removeItem(k); } catch (_) { }
    }
    snapshot = {};
  }
  function cleanupSubscriptions() {
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(reloadTimer); reloadTimer = null;
    if (channel && db) db.removeChannel(channel);
    channel = null;
  }
  function setRoleUI() {
    const admin = isAdmin();
    const badge = $('workspaceRole');
    if (badge) badge.textContent = ready ? `${role.toUpperCase()} · ${currentUser?.email || ''}` : 'Not signed in';
    const signOut = $('workspaceSignOut');
    if (signOut) signOut.hidden = !ready;
    const migrate = $('btnImportLocalToShared');
    if (migrate) migrate.hidden = !admin;
    // Only editing controls are locked; export, visibility, map and testing stay usable.
    for (const id of [
      'applyFavoriot', 'favApiKey', 'favUser', 'refreshSec', 'authHeader',
      'corsProxy', 'enableLiveSocket',
      'btnAddDevice', 'devId', 'devName', 'btnImportTrackers',
      'btnAddBeacon', 'btnPlaceMode', 'bName', 'bBssid', 'bLat', 'bLon',
      'btnImport', 'btnClearAll', 'btnImportAll', 'btnMigrateLegacy'
    ]) {
      const el = $(id);
      if (el) el.disabled = !admin;
    }
    // Device and beacon edit/delete actions are generated during list rendering.
    document.body.classList.toggle('workspace-readonly', !admin);
    const info = $('workspaceAccessHint');
    if (info) info.textContent = admin
      ? 'Administrator: edits are saved to Supabase and shared across browsers.'
      : 'Viewer: shared settings are read-only. Map and personal display options remain available.';
  }
  function cacheValues(values) {
    for (const k of SHARED_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : KEYS[k];
      snapshot[k] = structuredClone(value);
      localStorage.setItem(k, JSON.stringify(value));
    }
  }
  function existingChanges(next) {
    return SHARED_KEYS.filter(k => JSON.stringify(snapshot[k]) !== JSON.stringify(next[k]));
  }
  async function pull({initial = false} = {}) {
    if (!db || !currentUser) throw new Error('Sign in to load shared settings.');
    if (pendingWrites && !initial) return;
    const {data, error} = await db.from('workspace_config').select('key,value');
    if (error) throw error;
    const next = {...KEYS};
    for (const row of data || []) {
      if (isSharedKey(row.key)) next[row.key] = row.value;
    }
    // An empty or inaccessible table must never make one browser authoritative.
    const changed = existingChanges(next);
    cacheValues(next);
    if (!initial && changed.length && initialized && typeof callbacks.onChange === 'function') {
      callbacks.onChange(changed);
    }
    setMessage(`Shared settings synchronized · ${new Date().toLocaleTimeString()}`);
  }
  function requestPull() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!ready || pendingWrites) {
        if (ready) requestPull();
        return;
      }
      try { await pull(); }
      catch (e) { setMessage('Settings synchronization unavailable: ' + e.message, true); }
    }, 250);
  }
  function subscribeChanges() {
    cleanupSubscriptions();
    if (!ready || !db) return;
    channel = db.channel('alps-config-' + currentUser.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'workspace_config'
      }, requestPull)
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setMessage('Realtime interrupted; periodic synchronization is still active.', true);
        }
      });
    // Backup resync handles browser sleep and temporary websocket failures.
    pollTimer = setInterval(requestPull, 30000);
  }
  async function activate(user) {
    const seq = ++activationId;
    cleanupSubscriptions();
    ready = false;
    role = '';
    currentUser = user;
    setGate('Verifying account access and loading shared configuration…');
    try {
      const {data, error} = await db.from('workspace_members')
        .select('role').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      if (seq !== activationId) return;
      if (!data || !['admin', 'viewer'].includes(data.role)) {
        resetPrivateCache();
        setRoleUI();
        setGate('This account has not been granted dashboard access. Ask an administrator to add it to workspace_members.', true);
        return;
      }
      role = data.role;
      await pull({initial:true});
      if (seq !== activationId) return;
      ready = true;
      hideGate();
      setRoleUI();
      if (!initialized && typeof callbacks.onReady === 'function') {
        initialized = true;
        callbacks.onReady();
      } else if (typeof callbacks.onChange === 'function') {
        callbacks.onChange(SHARED_KEYS);
      }
      setRoleUI();
      subscribeChanges();
    } catch (e) {
      if (seq !== activationId) return;
      ready = false;
      setRoleUI();
      setGate('Cannot load Supabase workspace: ' + e.message + '. Check setup/SQL permissions and reload.', true);
    }
  }
  function signedOut() {
    activationId++;
    cleanupSubscriptions();
    role = '';
    ready = false;
    currentUser = null;
    resetPrivateCache();
    setRoleUI();
    if (initialized && callbacks.onLogout) callbacks.onLogout();
    setGate('Sign in to access the shared tracking workspace.');
  }
  function put(key, value) {
    if (!isSharedKey(key)) throw new Error('Unexpected shared settings key.');
    if (!isAdmin()) throw new Error('Only an administrator may edit shared settings.');
    // Optimistic local update preserves the current synchronous dashboard UI.
    localStorage.setItem(key, JSON.stringify(value));
    snapshot[key] = structuredClone(value);
    pendingWrites++;
    lastSaveError = null;
    writeChain = writeChain.catch(() => {}).then(async () => {
      const {error} = await db.from('workspace_config').upsert({
        key, value, updated_by: currentUser.id
      }, {onConflict: 'key'});
      if (error) throw error;
    }).catch(e => {
      lastSaveError = e;
      setMessage(`Cannot save ${key}: ${e.message}`, true);
      // RLS or network failure: re-download authoritative state, do not silently diverge.
      setTimeout(requestPull, 0);
    }).finally(() => {
      pendingWrites--;
      if (!pendingWrites) requestPull();
    });
    return writeChain;
  }
  async function flush() {
    await writeChain;
    if (lastSaveError) throw lastSaveError;
  }
  async function importOldBrowser() {
    if (!isAdmin()) return;
    const keys = SHARED_KEYS.filter(k => Object.prototype.hasOwnProperty.call(LEGACY_SNAPSHOT, k));
    if (!keys.length) { alert('No earlier browser settings were found on this origin. You can import a backup JSON using the existing Import All button.'); return; }
    if (!confirm('Overwrite shared configuration for ALL users with this browser’s original saved settings? This cannot be undone automatically. Export the current shared configuration first.')) return;
    for (const k of keys) await put(k, LEGACY_SNAPSHOT[k]);
    try {
      await flush();
      if (initialized && typeof callbacks.onChange === 'function') callbacks.onChange(keys);
      requestPull();
      setMessage('Original browser settings uploaded; synchronizing other users.');
    } catch (e) { setMessage('Migration failed: ' + e.message, true); }
  }
  async function start(opts = {}) {
    callbacks = {...callbacks, ...opts};
    const c = config;
    if (!c.url || c.url.includes('YOUR_PROJECT_REF') || !c.publishableKey || c.publishableKey.includes('YOUR_SUPABASE') || !window.supabase?.createClient) {
      setGate('Supabase is not configured. Edit supabase-config.js using your Supabase Project URL and publishable key. Ensure the Supabase JS library loaded.', true);
      return;
    }
    try {
      // Supabase normally saves logins in localStorage. The custom adapter below
      // makes Remember me meaningful: checked = persistent localStorage session;
      // unchecked = this browser tab's sessionStorage only (never store a password).
      // Keep Supabase's default storage key so existing v7 logins still work.
      const preferenceKey = 'alps-workspace-remember-me';
      const authStorageKey = `sb-${new URL(c.url).hostname.split('.')[0]}-auth-token`;
      const storedPreference = localStorage.getItem(preferenceKey);
      let rememberMe = storedPreference === '1' ||
        (storedPreference === null && !!localStorage.getItem(authStorageKey));
      const rememberCheckbox = $('workspaceRememberMe');
      if (rememberCheckbox) {
        rememberCheckbox.checked = rememberMe;
        rememberCheckbox.dispatchEvent(new Event('change'));
      }
      const authStorage = {
        getItem(key) {
          // A remembered session can also be restored from an old tab-only
          // session (where present); an unchecked login never reads localStorage.
          if (rememberMe) return localStorage.getItem(key) ?? sessionStorage.getItem(key);
          return sessionStorage.getItem(key);
        },
        setItem(key, value) {
          const chosen = rememberMe ? localStorage : sessionStorage;
          const unused = rememberMe ? sessionStorage : localStorage;
          chosen.setItem(key, value);
          unused.removeItem(key);
        },
        removeItem(key) {
          localStorage.removeItem(key);
          sessionStorage.removeItem(key);
        }
      };
      db = window.supabase.createClient(c.url, c.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage }
      });
      $('workspaceLoginForm')?.addEventListener('submit', async ev => {
        ev.preventDefault();
        const button = $('workspaceLoginButton');
        if (button) button.disabled = true;
        setGate('Signing in…');
        try {
          // Apply the checkbox *before* Supabase saves the new auth session.
          rememberMe = !!rememberCheckbox?.checked;
          const {data, error} = await db.auth.signInWithPassword({
            email: $('workspaceEmail').value.trim(), password: $('workspacePassword').value
          });
          if (error) throw error;
          localStorage.setItem(preferenceKey, rememberMe ? '1' : '0');
          $('workspacePassword').value = '';
          if (data.user) await activate(data.user);
        } catch (e) { setGate('Sign-in failed: ' + e.message, true); }
        finally { if (button) button.disabled = false; }
      });
      $('workspaceSignOut')?.addEventListener('click', async () => {
        try { await db.auth.signOut(); } finally { signedOut(); }
      });
      $('btnImportLocalToShared')?.addEventListener('click', importOldBrowser);
      db.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') { setTimeout(signedOut, 0); }
        if (event === 'SIGNED_IN' && session?.user) {
          // Do not call other Supabase APIs synchronously inside this callback.
          setTimeout(() => {
            if (!ready || currentUser?.id !== session.user.id) activate(session.user);
          }, 0);
        }
      });
      const {data, error} = await db.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await activate(data.session.user);
      else signedOut();
    } catch (e) { setGate('Supabase connection failed: ' + e.message, true); }
  }

  window.WorkspaceSync = Object.freeze({
    start, put, flush, isSharedKey, isReady, isAdmin,
    requireAdmin: () => {
      if (isAdmin()) return true;
      setMessage('Administrator permission required to change shared settings.', true);
      return false;
    }
  });
})();
