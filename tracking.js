/* v6.0 — v5 bounded FTM/trolley UI + Supabase shared, role-protected configuration. */
/* Shared-workspace build: no automatic localStorage deletion or migration. */

/* ================= Theme ================= */
/* Fallback controller for older HTML builds. New tracking.html owns the primary theme handler. */
(function initThemeFallback(){
  if (window.__ALPS_THEME_BOUND__) return;
  const root = document.documentElement;
  const btn = document.getElementById('toggleTheme');
  if (!btn) return;

  const readTheme = () => {
    try {
      const saved = localStorage.getItem('alps-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (_) {}
    return root.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
  };

  const applyTheme = (theme) => {
    const next = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-bs-theme', next);
    root.style.colorScheme = next;
    try { localStorage.setItem('alps-theme', next); } catch (_) {}
    btn.innerHTML = next === 'dark'
      ? '<i class="bi bi-sun" aria-hidden="true"></i>'
      : '<i class="bi bi-moon-stars" aria-hidden="true"></i>';
    btn.title = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(next === 'dark'));
  };

  applyTheme(readTheme());
  btn.addEventListener('click', () => {
    const current = root.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
  window.applyTheme = applyTheme;
  window.__ALPS_THEME_BOUND__ = true;
})();

/* ================= Storage keys / presets ================= */
const PRESET_FAVORIOT = { apiKey:'', username:'', refreshMs:8000, authHeader:'apikey', proxy:'', liveSocket:true };
const PRESET_DEVICES = [];
const LS_KEYS = {
  favoriot:'favoriot-config-v4',
  devices:'favoriot-devices-v4',
  beacons:'beacons-v1',
  visible:'visible-devices-v1',
  triCache:'tri-cache-v1',
  rangeMode:'range-mode-v1',
  rangeDevice:'range-device-v1',
  recordDev:'record-device-v1'
};
const LEGACY_KEYS = [
  {from:'favoriot-config', to:'favoriot-config-v4'},
  {from:'favoriot-config-v3', to:'favoriot-config-v4'},
  {from:'devices', to:'favoriot-devices-v4'},
  {from:'favoriot-devices', to:'favoriot-devices-v4'},
  {from:'beacons', to:'beacons-v1'},
  {from:'visible-devices', to:'visible-devices-v1'},
];

function jget(k, d){ try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function jset(k, v){
  // Retain a synchronous local cache, but Supabase is authoritative once signed in.
  // Authentication and RLS enforce server-side viewer read-only permissions.
  if(window.WorkspaceSync?.isReady() && window.WorkspaceSync.isSharedKey(k)){
    if(!window.WorkspaceSync.requireAdmin()) return false;
    window.WorkspaceSync.put(k, v);
    return true;
  }
  localStorage.setItem(k, JSON.stringify(v));
  return true;
}

// Trilateration cache (persist last-known)
function loadTriCache(){ return jget(LS_KEYS.triCache, {}); }
function saveTriCache(obj){ jset(LS_KEYS.triCache, obj); }
function cacheTriResult(normId, res){
  if(!res || res.tlat==null || res.tlon==null) return;
  const c = loadTriCache();
  if(!res.boundaryVerified || !validBoundedCache({lat:res.tlat,lon:res.tlon,boundaryVerified:true,anchors:res.anchors})) return;
  c[normId] = { tlat:res.tlat,tlon:res.tlon,rms:res.rms??null,time:res.time??null,
    boundaryVerified:true,anchors:res.anchors,rangeConflict:!!res.rangeConflict,maxRangeMiss:res.maxRangeMiss??0 };
  saveTriCache(c);
}

(function bootstrapPresets(){
  // Defaults are loaded from workspace_config when Supabase authentication succeeds.
  // Never seed shared keys from an arbitrary visitor's localStorage.
  if(!localStorage.getItem(LS_KEYS.rangeMode)) localStorage.setItem(LS_KEYS.rangeMode,'all');
})();

const CONFIG = { trailPoints: 25, trilatMinBeacons: 3, staleMs: 20*60*1000 };
const SLEEP_GRACE_MS = 20000; // applied only to trackers with explicit Sleep_Time_Sec
const LIVE_OFFLINE_MS = 90000; // live 30 s cycle: offline after three missed updates
window.activeSecByDev = window.activeSecByDev || new Map();

/* ================= Map & panes ================= */
const MAP_MAX_ZOOM = 24;
const ESRI_DETAIL_NATIVE_ZOOM = 19;
const ESRI_STABLE_NATIVE_ZOOM = 18; // safer fallback in areas where the deepest imagery tiles are unavailable

let map;
try {
  map = L.map('map', {
    minZoom: 2,
    maxZoom: MAP_MAX_ZOOM,
    crs: L.CRS.EPSG3857,
    preferCanvas: true,
    zoomSnap: 0.5,       // finer pinch / fitBounds zoom steps
    zoomDelta: 0.5,      // finer +/- control steps
    wheelPxPerZoomLevel: 80,
    bounceAtZoomLimits: false
  }).setView([3.1390, 101.6869], 14);
} catch(e) { console.error('Leaflet init failed', e); }

const streetsOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: MAP_MAX_ZOOM,
  maxNativeZoom: 19,
  keepBuffer: 4,
  updateWhenZooming: false
}).addTo(map);

function makeEsriSatellite(maxNativeZoom){
  return L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri',
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom,
    keepBuffer: 4,
    updateWhenZooming: false
  });
}

// Detail mode requests Esri imagery through native level 19.
const esriA = makeEsriSatellite(ESRI_DETAIL_NATIVE_ZOOM);
// Stable mode deliberately stops at level 18, then Leaflet overzooms that image up to level 24.
// This avoids many "Map data not available" tiles that only appear at the deepest native level.
const esriStable = makeEsriSatellite(ESRI_STABLE_NATIVE_ZOOM);

// The old init-hook was registered after the map already existed, so create the pane directly.
if(!map.getPane('labelsPane')) map.createPane('labelsPane');
map.getPane('labelsPane').classList.add('leaflet-labels-pane');
function labels(){
  return L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
    attribution: 'Labels © CARTO',
    pane: 'labelsPane',
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: 20,
    keepBuffer: 4,
    updateWhenZooming: false
  });
}
function hybrid(img){ const g=L.layerGroup(); img.addTo(g); labels().addTo(g); return g; }
const esriStableHybrid = hybrid(makeEsriSatellite(ESRI_STABLE_NATIVE_ZOOM));

L.control.layers({
  'Streets (OSM)': streetsOSM,
  'Satellite (Esri — detail)': esriA,
  'Satellite (Esri — stable deep zoom)': esriStable,
  'Satellite + labels (stable)': esriStableHybrid
}, {}, { collapsed:true, position:'topright' }).addTo(map);

L.control.scale({ position:'bottomleft', metric:true, imperial:false, maxWidth:140 }).addTo(map);

// If the detailed Esri layer returns actual HTTP tile errors, fall back automatically.
// (Provider-generated placeholder images still load successfully, so the stable mode remains
// available in the layer menu for those cases.)
let esriTileErrorBurst = 0;
let esriTileErrorReset = null;
esriA.on('tileerror', ()=>{
  esriTileErrorBurst++;
  clearTimeout(esriTileErrorReset);
  esriTileErrorReset = setTimeout(()=>{ esriTileErrorBurst = 0; }, 1200);
  if(esriTileErrorBurst >= 3 && map.hasLayer(esriA)){
    esriTileErrorBurst = 0;
    map.removeLayer(esriA);
    esriStable.addTo(map);
    try { showErr('High-detail satellite tiles are unavailable here. Switched to stable satellite deep zoom.'); } catch(_) {}
  }
});

map.createPane('rangesPane'); map.getPane('rangesPane').style.zIndex = 350;

let devicesLayer=L.layerGroup().addTo(map);
let beaconLayer=L.layerGroup().addTo(map);
let triLayer=L.layerGroup().addTo(map);
const vectorRenderer = L.canvas({ padding: 0.2 });
let trilatTrack=L.polyline([], { weight:3, opacity:.9, color:'#c62828' }).addTo(map);
let testRangesLayer=L.layerGroup().addTo(map); // purple debug circles

const devMarkers=new Map();
const triMarkers=new Map();
const rangeByDev=new Map();
const lastScanByDev=new Map();
const triResByDev=new Map();

const healthByDev=new Map();
const batteryByDev=new Map();
const lastSeenByDev=new Map();
const lastServerTsByDev=new Map();
const stateByDev=new Map();
const tempByDev=new Map();
const offlineReasonByDev=new Map();
const sleepSecByDev=new Map();

let meMarker=null, meCircle=null;
setTimeout(()=>map.invalidateSize(),150); window.addEventListener('resize',()=>map.invalidateSize());

map.on('zoomend baselayerchange', ()=>{
  try{
    [beaconLayer, devicesLayer, triLayer, testRangesLayer].forEach(g=>{
      if(!g) return;
      g.eachLayer(l=>{ if (l && typeof l.redraw==='function') try{ l.redraw(); }catch(_){} });
    });
  }catch(_){}
});


/* ===== Place-mode (beacons) ===== */
let placeMode=false;
let placeMarker=null;
function setPlaceMode(on){
  placeMode = !!on;
  const btn = document.getElementById('btnPlaceMode');
  const hint = document.getElementById('placeHint');
  btn.classList.toggle('btn-primary', on);
  btn.classList.toggle('btn-outline-primary', !on);
  hint.classList.toggle('d-none', !on);
  if(!on){
    if(placeMarker){ map.removeLayer(placeMarker); placeMarker=null; }
    document.getElementById('bLat').value='';
    document.getElementById('bLon').value='';
  }
}
document.getElementById('btnPlaceMode').addEventListener('click', ()=> setPlaceMode(!placeMode));
map.on('click', (e)=>{
  if(!placeMode) return;
  const lat=e.latlng.lat, lon=e.latlng.lng;
  if(!placeMarker){
    placeMarker=L.marker([lat,lon],{draggable:true}).addTo(map);
    placeMarker.on('drag', (ev)=>{
      const ll=ev.target.getLatLng();
      document.getElementById('bLat').value=ll.lat.toFixed(8);
      document.getElementById('bLon').value=ll.lon.toFixed(8);
    });
  }
  placeMarker.setLatLng([lat,lon]);
  document.getElementById('bLat').value=lat.toFixed(8);
  document.getElementById('bLon').value=lon.toFixed(8);
});

/* ================= Utils ================= */
function showErr(msg){
  const d=document.getElementById('alert');
  d.textContent=msg;
  d.classList.remove('d-none');
  clearTimeout(window._errHide); window._errHide=setTimeout(()=>{ d.classList.add('d-none'); }, 6000);
}
function clearErr(){ const d=document.getElementById('alert'); d.classList.add('d-none'); d.textContent=''; }
function escapeHtml(s){ return (s??'').toString().replace(/[&<>\"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }
const R_EARTH=6371000; const toRad=d=>d*Math.PI/180, toDeg=r=>r*180/Math.PI;
function ll2xy(lat,lon,refLat,refLon){ const x=(lon-refLon)*Math.PI/180*R_EARTH*Math.cos(toRad(refLat)); const y=(lat-refLat)*Math.PI/180*R_EARTH; return [x,y]; }
function xy2ll(x,y,refLat,refLon){ const lat=refLat+toDeg(y/R_EARTH), lon=refLon+toDeg(x/(R_EARTH*Math.cos(toRad(refLat)))); return [lat,lon]; }
function solve2x2(M,v){ const [[a,b],[c,d]]=M; const det=a*d-b*c; if(Math.abs(det)<1e-9)return null; return [( d*v[0]-b*v[1])/det, (-c*v[0]+a*v[1])/det]; }
function colorForIndex(i){ const h=(i*137+120)%360; return `hsl(${h} 70% 45%)`; }
function normalizeBssid(s){ return (s||'').toUpperCase().replace(/[^0-9A-F]/g,''); }
function colonizeBssid(s){ const h=normalizeBssid(s); if (h.length!==12) return null; return h.match(/.{2}/g).join(':'); }
function sameBssid(a,b){ const A=normalizeBssid(a), B=normalizeBssid(b); return A && B && A===B; }
function prettyBssid(s){ return colonizeBssid(s)||s||''; }

function isStale(normId){ const ts = lastSeenByDev.get(normId); if(!ts) return true; return (Date.now() - ts) >= CONFIG.staleMs; }
function computeStatus(normId){
  const last=lastSeenByDev.get(normId);
  const delta=last?Math.max(0,Date.now()-last):Infinity;
  const sleepSec=sleepSecByDev.get(normId)??null;
  // Live firmware does not supply Sleep_Time_Sec. Do not report it as sleeping.
  if(sleepSec==null){
    const online=Number.isFinite(delta)&&delta<=LIVE_OFFLINE_MS;
    return {online,sleeping:false,offline:!online,delta,sleepSec:null};
  }
  const sleepMs=Math.max(sleepSec*1000,SLEEP_GRACE_MS);
  const sleeping=delta>SLEEP_GRACE_MS&&delta<=sleepMs;
  const offline=delta>sleepMs;
  return {online:!offline&&!sleeping,sleeping,offline,delta,sleepSec};
}
function statusDotColor(normId){ const st=computeStatus(normId); return st.offline ? '#c62828' : (st.sleeping ? '#f9a825' : '#2e7d32'); }

function isChargingState(state){ return /CHARGING/i.test(String(state||'') ) && !/FULLY/i.test(String(state||'')); }
function batteryBadgeHtml(p, state){
  if(p==null) return '';
  const charging = isChargingState(state);
  const cls = (p<20) ? 'bg-danger' : (p<40 ? 'bg-warning text-dark' : 'bg-success');
  let icon; if (charging) icon = 'bi-battery-charging';
  else icon = (p<33) ? 'bi-battery' : (p<66 ? 'bi-battery-half' : 'bi-battery-full');
  return ` <span class="badge ${cls}"><i class="bi ${icon}"></i> ${Math.round(p)}%</span>`;
}
function stateBadgeHtml(state){
  if(!state) return '';
  const s = String(state).toUpperCase();
  if (s === 'FULLYCHARGE' || /FULLY\s*CHARGE/.test(s)) return ` <span class="badge bg-success">FULLYCHARGE</span>`;
  if (/CHARG/.test(s)) return ` <span class="badge bg-info text-dark">CHARGING</span>`;
  if (/REMAIN/.test(s)) return ` <span class="badge bg-warning text-dark">REMAINING</span>`;
  let cls='bg-secondary';
  if (/(ALERT|CRITICAL|FAULT|PANIC|SOS|ERROR|DANGER)/.test(s)) cls='bg-danger';
  else if (/(WARN|WARNING|CAUTION|LOW|DEGRADED)/.test(s)) cls='bg-warning text-dark';
  else if (/(OK|READY|NORMAL|SAFE|ONLINE|GOOD)/.test(s)) cls='bg-success';
  return ` <span class="badge ${cls}">${escapeHtml(s)}</span>`;
}
function normalizeStateToken(s){ if(!s) return ''; const first = String(s).split(/[,;\]]/)[0].trim(); return first.toUpperCase(); }
function extractState(data, scanStr){
  const keys=['State','state','status','device_state','deviceStatus','device_status','STATE'];
  if (data && typeof data === 'object'){
    for (const k of keys){ if (Object.prototype.hasOwnProperty.call(data, k)){ const v = String(data[k] ?? '').trim(); if (v) return normalizeStateToken(v); } }
  }
  const segs = String(scanStr || '').match(/\[[^\]]+\]/g) || [];
  for (const seg of segs){ const m = seg.match(/\bState\s*[:=]\s*([^\]\s,;]+)/i); if (m && m[1]) return normalizeStateToken(m[1]); }
  return '';
}
function extractTemperature(data, scanStr){
  if (data && typeof data==='object'){
    const keys=['Temperature','temperature','temp','Temp','Temp_C','temperature_c','temp_c','tempC','temperatureC'];
    for (const k of keys){ if (k in data){ const v = parseFloat(String(data[k]).replace(/[^\d.-]/g,'')); if (Number.isFinite(v)) return v; } }
  }
  const s = String(scanStr||'');
  let m = s.match(/\b(?:Temperature|Temp|T)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*C\b/i);
  if (m) return parseFloat(m[1]);
  for (const seg of (s.match(/\[[^\]]+\]/g)||[])){
    const m2 = seg.match(/\b(?:Temperature|Temp|T)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*C?/i);
    if (m2) return parseFloat(m2[1]);
  }
  return null;
}

/* ---- FIXED: robust (case/punctuation-insensitive) sleep time parser ---- */
function extractSleepSec(data, scanStr){
  // 1) Look directly in JSON keys (case-insensitive, punctuation-insensitive)
  if (data && typeof data === 'object'){
    for (const [k,v] of Object.entries(data)){
      const lk = String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
      // Accept keys that mention "sleep" and either "sec" or "time"
      if (lk.includes('sleep') && (lk.includes('sec') || lk.includes('time'))) {
        const s = String(v).trim();
        const m = s.match(/([-+]?\d+(?:\.\d+)?)/);
        if (m){ const n = parseFloat(m[1]); if (Number.isFinite(n) && n>0) return Math.round(n); }
      }
      // Also accept compact forms like "sleeptimesec", "sleepsec"
      if (lk.endsWith('sleeptimesec') || lk.endsWith('sleepsec')){
        const s = String(v).trim();
        const m = s.match(/([-+]?\d+(?:\.\d+)?)/);
        if (m){ const n = parseFloat(m[1]); if (Number.isFinite(n) && n>0) return Math.round(n); }
      }
    }
  }
  // 2) Try to scrape from free-form scan string, if present
  const s = String(scanStr||'');
  let m = s.match(/sleep[_\s-]*time[_\s-]*sec\s*[:=]\s*(\d+)/i)
        || s.match(/\bsleep\s*[:=]\s*(\d+)\s*s\b/i)
        || s.match(/\bsleep[_\s-]*sec\s*[:=]\s*(\d+)/i);
  if (m){ const n = parseFloat(m[1]); if (Number.isFinite(n) && n>0) return Math.round(n); }
  return null;
}

function tempHtmlC(temp){ if (temp==null) return ''; const t = Math.round((+temp) * 100) / 100; return ` <span class="badge bg-secondary-subtle text-dark">${t.toFixed(2)}°C</span>`; }
function isDeviceVisible(normId){ const set=visibleSet(); return set.has(normId); }

/* ================= Favoriot helpers ================= */
function CFG(){ return jget(LS_KEYS.favoriot, PRESET_FAVORIOT); }
function saveCFG(c){ jset(LS_KEYS.favoriot, c); }
function loadDevices(){ return jget(LS_KEYS.devices, []); }
function saveDevices(list){ return jset(LS_KEYS.devices, list); }
function apiBase(){ return 'https://apiv2.favoriot.com/v2'; }
function ensureDevId(id){ const cfg = CFG(); if(!id) return ''; return String(id).includes('@') ? id : (cfg.username ? `${id}@${cfg.username}`:id); }
function defaultProxy(){ return 'https://cors.isomorphic-git.org/'; }
function withProxy(url, forceDefault=false){
  const user = (CFG().proxy||'').trim();
  const p = user || (forceDefault ? defaultProxy() : '');
  return p ? p.replace(/\/$/,'') + '/' + url : url;
}
function headersFor(){
  const cfg=CFG();
  const h={'Accept':'application/json','Content-Type':'application/json'};
  if ((cfg.authHeader||'apikey') === 'authorization') h['Authorization'] = 'Bearer ' + (cfg.apiKey||'').trim();
  else h['apikey'] = (cfg.apiKey||'').trim();
  return h;
}
function streamsUrl(dev){
  const enc = encodeURIComponent(ensureDevId(dev.id));
  return `${apiBase()}/devices/${enc}/streams`;
}

/* ================= Visibility & persistence ================= */
function visibleSet(){
  const arr=jget(LS_KEYS.visible, null);
  return new Set(Array.isArray(arr)? arr : loadDevices().map(d=>ensureDevId(d.id)));
}
function saveVisibleSet(set){ jset(LS_KEYS.visible, Array.from(set)); }

/* ================= UI builders ================= */
function rebuildRecordDeviceSelect(){
  const sel=document.getElementById('recordDevice'); sel.innerHTML='';
  const list=loadDevices();
  list.forEach((d)=>{ const opt=document.createElement('option'); const norm=ensureDevId(d.id); opt.value=norm; opt.textContent=(d.name? d.name+' • ' : '')+norm; sel.appendChild(opt); });
  const stored=localStorage.getItem('record-device-v1')||'';
  if(stored && [...sel.options].some(o=>o.value===stored)) sel.value=stored;
  else if(sel.options.length){ sel.selectedIndex=0; localStorage.setItem('record-device-v1', sel.value); }
  sel.onchange=()=> localStorage.setItem('record-device-v1', sel.value);
}
function renderVisibilityDropdown(){
  const menu=document.getElementById('visMenu'); menu.innerHTML='';
  const list=loadDevices(); const vis=visibleSet();
  list.forEach((d,i)=>{
    const norm=ensureDevId(d.id);
    const id=`vis-${i}`;
    const row=document.createElement('label'); row.className='menu-item';
    row.innerHTML=`
      <span id="vDot-${i}" class="badge-dot" style="background:${statusDotColor(norm)}"></span>
      <input type="checkbox" class="form-check-input m-0" id="${id}" data-vis-id="${escapeHtml(norm)}" ${vis.has(norm)?'checked':''}>
      <span class="small">${escapeHtml(d.name||norm)}</span>
    `;
    menu.appendChild(row);
  });
  menu.onchange=(e)=>{
    const cb=e.target.closest('input[type="checkbox"][data-vis-id]'); if(!cb) return;
    const set=visibleSet(); const id=cb.getAttribute('data-vis-id');
    if(cb.checked) set.add(id); else set.delete(id);
    saveVisibleSet(set);
    renderDeviceList();
    updateDevicesVisibility();
    renderTriInfoList(true);
  };
}
document.getElementById('btnSelectAll').addEventListener('click', ()=>{
  const set=new Set(loadDevices().map(d=>ensureDevId(d.id)));
  saveVisibleSet(set); renderVisibilityDropdown(); renderDeviceList(); updateDevicesVisibility(); renderTriInfoList(true);
});
document.getElementById('btnSelectNone').addEventListener('click', ()=>{
  saveVisibleSet(new Set()); renderVisibilityDropdown(); renderDeviceList(); updateDevicesVisibility(); renderTriInfoList(true);
});

function rowIdFor(normId){ return 'devrow-' + btoa(normId).replace(/=+$/,''); }

function focusDeviceByIndex(idx){
  const list=loadDevices(); const dev=list[idx]; if(!dev) return;
  const tri=triMarkers.get(dev.id);
  const posTri = tri?.getLatLng ? tri.getLatLng() : null;
  const devM = devMarkers.get(dev.id);
  const posDev = devM?.getLatLng ? devM.getLatLng() : null;
  const norm=ensureDevId(dev.id);
  const res = triResByDev.get(norm);
  const ll = posTri || posDev || (res && res.tlat!=null ? L.latLng(res.tlat,res.tlon) : null);
  if(ll){
    map.setView(ll, Math.max(map.getZoom(), 20), { animate:true });
    if(posTri){ tri.openPopup(); } else if(posDev){ devM.openPopup(); }
  }else{
    showErr('No position yet for '+norm);
  }
}

function renderDeviceList(){
  const ul=document.getElementById('deviceStatus'); ul.innerHTML='';
  const list=loadDevices();
  const vis=visibleSet();

  /* seed-on-empty removed to respect user data */
  if(vis.size===0){
    const li=document.createElement('li');
    li.className='list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML=`<div class="small text-secondary">No devices visible — open “Visible devices” or</div>
      <button id="btnShowAllNow" class="btn btn-sm btn-outline-primary">Show all now</button>`;
    ul.appendChild(li);
    li.querySelector('#btnShowAllNow').onclick=()=>{
      const set=new Set(loadDevices().map(d=>ensureDevId(d.id)));
      saveVisibleSet(set);
      renderVisibilityDropdown();
      renderDeviceList();
      updateDevicesVisibility();
      renderTriInfoList(true);
    };
    return;
  }

  list.forEach((d,i)=>{
    const norm=ensureDevId(d.id);
    if(!vis.has(norm)) return;
    const li=document.createElement('li');
    li.id = rowIdFor(norm);
    li.dataset.normId = norm;
    li.className='list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML=`<div class="me-2">
      <div class="fw-semibold">
        <span id="dot-${i}" class="badge-dot" style="background:${statusDotColor(norm)}"></span>
        ${escapeHtml(d.name||'Device')}
        <span id="ol-${i}" class="badge bg-secondary-subtle text-dark ms-2">—</span>
      </div>
      <div class="text-secondary small">${escapeHtml(norm)}</div>
      <div class="small" id="st-${i}">—</div>
      <div class="small text-danger" id="rs-${i}"></div>
    </div>
    <div class="btn-group btn-group-sm">
      <button class="btn btn-outline-secondary" data-find="${i}" title="Find on map"><i class="bi bi-search"></i></button>
      <button class="btn btn-outline-danger" data-del="${i}" title="Remove device"><i class="bi bi-trash"></i></button>
    </div>`;
    ul.appendChild(li);
  });

  ul.onclick=(e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    if(btn.hasAttribute('data-del') && !window.WorkspaceSync?.requireAdmin()) return;
    const find = btn.getAttribute('data-find');
    const d = btn.getAttribute('data-del');
    if(find!=null){ focusDeviceByIndex(parseInt(find,10)); }
    else if(d!=null){
      const idx=parseInt(d,10); const arr=loadDevices(); const removed=ensureDevId(arr[idx].id); arr.splice(idx,1); saveDevices(arr);
      const set=visibleSet(); set.delete(removed); saveVisibleSet(set);
      rebuildRecordDeviceSelect(); renderDeviceList(); renderVisibilityDropdown(); renderTrackerList();
      fetchAllDevices(); updateDevicesVisibility(); renderTriInfoList(true);
    }
  };
}

/* ================= Tracker list + export/import ================= */
document.getElementById('btnExportTrackers').addEventListener('click', ()=>{
  const data = JSON.stringify(loadDevices(), null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'trackers.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});
document.getElementById('btnImportTrackers').addEventListener('click', ()=>{
  const inp = document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange = () => {
    const file = inp.files && inp.files[0]; if(!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try{
        const list = JSON.parse(String(fr.result||'[]'));
        if(Array.isArray(list)){ saveDevices(list); renderTrackerList(); rebuildRecordDeviceSelect(); renderVisibilityDropdown(); renderDeviceList(); rebuildScanSourceSelect(); fetchAllDevices(); }
        else alert('Invalid JSON format.');
      }catch(e){ alert('Failed to parse JSON: '+e.message); }
    };
    fr.readAsText(file);
  };
  inp.click();
});
function renderTrackerList(){
  const ul=document.getElementById('deviceList'); ul.innerHTML='';
  const list=loadDevices();
  const q = (document.getElementById('trackerSearch').value||'').toLowerCase();
  const filtered = list.filter(d => ((d.name||'')+' '+ensureDevId(d.id)).toLowerCase().includes(q));

  /* seed-on-empty removed to respect user data */
  filtered.forEach((d,i)=>{
    const id=ensureDevId(d.id);
    const li=document.createElement('li'); li.className='list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML = `<div>
        <div class="fw-semibold">${escapeHtml(d.name||'Tracker')}</div>
        <div class="text-secondary small">${escapeHtml(id)}</div>
      </div>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-danger" data-del="${id}" title="Remove"><i class="bi bi-trash"></i></button>
      </div>`;
    ul.appendChild(li);
  });
  ul.onclick=(e)=>{
    const btn=e.target.closest('button'); if(!btn) return;
    if(!window.WorkspaceSync?.requireAdmin()) return;
    const delId=btn.getAttribute('data-del');
    if(delId){
      const arr=loadDevices(); const idx=arr.findIndex(x=> ensureDevId(x.id)===delId);
      if(idx>=0){
        const removed=ensureDevId(arr[idx].id);
        arr.splice(idx,1); saveDevices(arr);
        const set=visibleSet(); set.delete(removed); saveVisibleSet(set);
        rebuildRecordDeviceSelect(); renderDeviceList(); renderVisibilityDropdown(); renderTrackerList();
        fetchAllDevices(); updateDevicesVisibility(); renderTriInfoList(true);
      }
    }
  };
}
document.getElementById('trackerSearch').addEventListener('input', renderTrackerList);

/* ================= Beacons (export/import/CRUD) ================= */
function loadBeacons(){ return jget(LS_KEYS.beacons, []); }
function saveBeacons(list){
  jset(LS_KEYS.beacons,list);
  // Changing any anchor invalidates or recalculates positions using that anchor.
  // Do not let a cached trolley continue to float beyond updated beacon bounds.
  for(const [normId,res] of triResByDev){
    if(res?.boundaryVerified&&!validBoundedCache({...res,lat:res.tlat,lon:res.tlon})){
      const dev=loadDevices().find(d=>ensureDevId(d.id)===normId);
      if(dev)placeTriMarker(dev,0,null,null,0);
      triResByDev.delete(normId);
    }
  }
  if(document.getElementById('enableTri2')?.checked){
    loadDevices().forEach((dev,idx)=>{
      const normId=ensureDevId(dev.id),scans=lastScanByDev.get(normId);
      if(Array.isArray(scans)&&scans.length)computeTrilatForDevice(dev,idx,null,null,scans);
    });
  }
  updateDevicesVisibility();renderTriInfoList(false);
}
function findBeaconIndexByNameOrBssid(name, bssid){
  const list=loadBeacons();
  const nameLc = (name||'').trim().toLowerCase();
  const bnorm = normalizeBssid(bssid||'');
  for(let i=0;i<list.length;i++){
    const it=list[i];
    if (bnorm && sameBssid(it.bssid||'', bssid)) return i;
    if (nameLc && (String(it.name||'').toLowerCase()===nameLc)) return i;
  }
  return -1;
}
function drawBeacons(){
  beaconLayer.clearLayers();
  for(const b of loadBeacons()){
    if(!Number.isFinite(b.lat)||!Number.isFinite(b.lon)) continue;
    const m=L.circleMarker([b.lat,b.lon],{renderer: vectorRenderer, radius:6,color:'#fbc02d',weight:2,fillOpacity:.9}).addTo(beaconLayer);
    m.bindTooltip(`<span class="small">${escapeHtml(b.name||'Beacon')}</span>`,{direction:'top',offset:[0,-8],opacity:.95,sticky:true});
    m.bindPopup(`<div class="small"><strong>${escapeHtml(b.name||'Beacon')}</strong><br>Lat ${b.lat.toFixed(6)}, Lon ${b.lon.toFixed(6)}${b.bssid?`<br>BSSID ${escapeHtml(prettyBssid(b.bssid))}`:''}</div>`);
  }
}
function renderBeaconList(filter=''){
  const ul=document.getElementById('beaconList'); ul.innerHTML='';
  const list=loadBeacons().filter(b=>(((b.name||'')+' '+(b.bssid||'')).toLowerCase().includes(filter.toLowerCase())));
  /* seed-on-empty removed to respect user data */
  for(const b of list){
    const li=document.createElement('li'); li.className='list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML=`<div class="me-2">
      <div class="fw-semibold">${escapeHtml(b.name||'(unnamed)')}</div>
      <div class="text-secondary small">Lat ${(b.lat??'').toFixed?b.lat.toFixed(6):b.lat}, Lon ${(b.lon??'').toFixed?b.lon.toFixed(6):b.lon}${b.bssid?` · BSSID ${escapeHtml(prettyBssid(b.bssid))}`:''}</div>
    </div>
    <div class="btn-group btn-group-sm">
      <button class="btn btn-outline-primary" data-edit="${escapeHtml(b.name||'')}"><i class="bi bi-pencil-square"></i></button>
      <button class="btn btn-outline-danger" data-del="${escapeHtml(b.name||'')}"><i class="bi bi-trash"></i></button>
    </div>`;
    ul.appendChild(li);
  }
}
document.getElementById('beaconSearch').addEventListener('input', (e)=> renderBeaconList(e.target.value||''));

document.getElementById('btnAddBeacon').addEventListener('click', ()=>{
  const name = (document.getElementById('bName').value||'').trim();
  const bssidRaw = (document.getElementById('bBssid').value||'').trim();
  const bssid = colonizeBssid(bssidRaw) || (bssidRaw||'').trim();
  const lat = parseFloat(document.getElementById('bLat').value);
  const lon = parseFloat(document.getElementById('bLon').value);
  if(!name && !bssid){ alert('Enter a name or BSSID.'); return; }
  if(!Number.isFinite(lat) || !Number.isFinite(lon)){ alert('Enter valid latitude and longitude (or place on map).'); return; }
  const list=loadBeacons();
  const idx = findBeaconIndexByNameOrBssid(name, bssid);
  const entry = { name, bssid, lat, lon };
  if(idx>=0) list[idx] = entry;
  else list.push(entry);
  saveBeacons(list);
  // reset UI
  document.getElementById('bName').value='';
  document.getElementById('bBssid').value='';
  document.getElementById('bLat').value='';
  document.getElementById('bLon').value='';
  setPlaceMode(false);
  drawBeacons();
  renderBeaconList(document.getElementById('beaconSearch').value||'');
});
document.getElementById('btnExport').addEventListener('click', ()=>{
  const data = JSON.stringify(loadBeacons(), null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'beacons.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});
document.getElementById('btnImport').addEventListener('click', ()=>{
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{
    const f=inp.files && inp.files[0]; if(!f) return;
    const fr=new FileReader();
    fr.onload=()=>{
      try{
        const arr=JSON.parse(String(fr.result||'[]'));
        if(!Array.isArray(arr)) throw new Error('Invalid JSON array.');
        const list=loadBeacons();
        for(const n of arr){
          if(!n) continue;
          const name=String(n.name||'').trim();
          const bssid = colonizeBssid(String(n.bssid||'')) || String(n.bssid||'').trim();
          const lat = Number(n.lat), lon = Number(n.lon);
          if(!Number.isFinite(lat)||!Number.isFinite(lon)) continue;
          const idx=findBeaconIndexByNameOrBssid(name,bssid);
          const entry={name,bssid,lat,lon};
          if(idx>=0) list[idx]=entry; else list.push(entry);
        }
        saveBeacons(list); drawBeacons(); renderBeaconList(document.getElementById('beaconSearch').value||'');
      }catch(e){ alert('Import failed: '+e.message); }
    };
    fr.readAsText(f);
  };
  inp.click();
});
document.getElementById('btnClearAll').addEventListener('click', ()=>{
  if(confirm('Remove ALL saved beacons?')){
    saveBeacons([]); drawBeacons(); renderBeaconList('');
  }
});
document.getElementById('beaconList').addEventListener('click', (e)=>{
  const btn=e.target.closest('button'); if(!btn) return;
  if(!window.WorkspaceSync?.requireAdmin()) return;
  const name=btn.getAttribute('data-edit') || btn.getAttribute('data-del') || '';
  const list=loadBeacons();
  const idx = findBeaconIndexByNameOrBssid(name, '');
  if(idx<0){ alert('Beacon not found.'); return; }
  if(btn.hasAttribute('data-edit')){
    const b=list[idx];
    document.getElementById('bName').value=b.name||'';
    document.getElementById('bBssid').value=prettyBssid(b.bssid||'');
    document.getElementById('bLat').value=b.lat;
    document.getElementById('bLon').value=b.lon;
    setPlaceMode(true);
    if(!placeMarker){ placeMarker=L.marker([b.lat,b.lon],{draggable:true}).addTo(map);
      placeMarker.on('drag', (ev)=>{
        const ll=ev.target.getLatLng();
        document.getElementById('bLat').value=ll.lat.toFixed(8);
        document.getElementById('bLon').value=ll.lon.toFixed(8);
      });
    }
    placeMarker.setLatLng([b.lat,b.lon]);
    map.setView([b.lat,b.lon], Math.max(map.getZoom(),20));
  } else if(btn.hasAttribute('data-del')){
    if(confirm('Delete beacon "'+name+'"?')){
      list.splice(idx,1); saveBeacons(list); drawBeacons(); renderBeaconList(document.getElementById('beaconSearch').value||'');
    }
  }
});

/* ================= Bounded trilateration core ================= */
function ll2xy_wrap(lat,lon,refLat,refLon){ return ll2xy(lat,lon,refLat,refLon); }
function xy2ll_wrap(x,y,refLat,refLon){ return xy2ll(x,y,refLat,refLon); }

/* Monotone chain hull of *matched* beacon coordinates (metres). */
function beaconHullXY(beacons){
  const p=beacons.filter(b=>Number.isFinite(b.x)&&Number.isFinite(b.y))
    .map(b=>({x:b.x,y:b.y})).sort((a,b)=>a.x-b.x||a.y-b.y);
  const unique=p.filter((a,i)=>i===0 || Math.hypot(a.x-p[i-1].x,a.y-p[i-1].y)>1e-5);
  if(unique.length<3) return [];
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const lower=[],upper=[];
  for(const pt of unique){while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],pt)<=0)lower.pop();lower.push(pt);}
  for(let i=unique.length-1;i>=0;i--){const pt=unique[i];while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],pt)<=0)upper.pop();upper.push(pt);}
  lower.pop();upper.pop();
  const hull=lower.concat(upper);
  const area2=Math.abs(hull.reduce((sum,p,i)=>{const q=hull[(i+1)%hull.length];return sum+p.x*q.y-q.x*p.y;},0));
  const xs=unique.map(p=>p.x),ys=unique.map(p=>p.y);
  const span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  // Refuse nearly-collinear geometries rather than fabricating a precise point.
  if(area2<Math.max(0.2,0.002*span*span)) return [];
  return hull;
}
function insideBeaconHull(p,hull){
  if(!p||hull.length<3||!Number.isFinite(p.x)||!Number.isFinite(p.y))return false;
  for(let i=0;i<hull.length;i++){
    const a=hull[i],b=hull[(i+1)%hull.length];
    if((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)<-1e-7)return false;
  }
  return true;
}
function projectToBeaconHull(p,hull){
  if(insideBeaconHull(p,hull))return {x:p.x,y:p.y};
  let closest=null,best=Infinity;
  for(let i=0;i<hull.length;i++){
    const a=hull[i],b=hull[(i+1)%hull.length];
    const dx=b.x-a.x,dy=b.y-a.y,denom=dx*dx+dy*dy;
    const t=denom>0?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/denom)):0;
    const q={x:a.x+t*dx,y:a.y+t*dy};
    const d=(p.x-q.x)**2+(p.y-q.y)**2;
    if(d<best){best=d;closest=q;}
  }
  return closest;
}
function rangingCost(p,anchors){
  return anchors.reduce((v,b)=>v+(Math.hypot(p.x-b.x,p.y-b.y)-b.d)**2,0);
}
function maxRangeExcess(p,anchors){
  return Math.max(0,...anchors.map(b=>Math.hypot(p.x-b.x,p.y-b.y)-b.d));
}
function projectIntoRangeDisk(p,b){
  const dx=p.x-b.x,dy=p.y-b.y,r=Math.hypot(dx,dy);
  if(r<=b.d || r===0)return {x:p.x,y:p.y};
  return {x:b.x+dx*(b.d/r),y:b.y+dy*(b.d/r)};
}
/* Dykstra projection: nearest point in hull ∩ all measured range disks, if feasible. */
function projectToFeasibleRanges(seed,hull,beacons){
  const projections=[p=>projectToBeaconHull(p,hull),...beacons.map(b=>p=>projectIntoRangeDisk(p,b))];
  const corrections=projections.map(()=>({x:0,y:0}));
  let p={x:seed.x,y:seed.y};
  for(let iteration=0;iteration<350;iteration++){
    const before=p;
    for(let i=0;i<projections.length;i++){
      const z={x:p.x+corrections[i].x,y:p.y+corrections[i].y};
      const projected=projections[i](z);
      corrections[i]={x:z.x-projected.x,y:z.y-projected.y};
      p=projected;
    }
    if(insideBeaconHull(p,hull)&&maxRangeExcess(p,beacons)<=0.03 &&
       Math.hypot(p.x-before.x,p.y-before.y)<0.002)return p;
  }
  return insideBeaconHull(p,hull)&&maxRangeExcess(p,beacons)<=0.03?p:null;
}
function trilatLM(beacons, initXY){
  if(beacons.length<3 || beacons.some(b=>!Number.isFinite(b.d)||b.d<0))return null;
  const hull=beaconHullXY(beacons);
  if(hull.length<3)return null;
  const center={x:beacons.reduce((v,b)=>v+b.x,0)/beacons.length,
                y:beacons.reduce((v,b)=>v+b.y,0)/beacons.length};
  // Algebraic LS gives a seed; this is NOT the displayed solution.
  const ref=beacons[0];let aa=0,ab=0,bb=0,ax=0,bx=0;
  for(let i=1;i<beacons.length;i++){
    const b=beacons[i],u=2*(b.x-ref.x),v=2*(b.y-ref.y);
    const z=(b.x*b.x-ref.x*ref.x)+(b.y*b.y-ref.y*ref.y)-(b.d*b.d-ref.d*ref.d);
    aa+=u*u;ab+=u*v;bb+=v*v;ax+=u*z;bx+=v*z;
  }
  const determinant=aa*bb-ab*ab;
  const linear=Math.abs(determinant)>1e-10?
    {x:(bb*ax-ab*bx)/determinant,y:(aa*bx-ab*ax)/determinant}:center;
  const seeds=[linear,center,...hull];
  if(Array.isArray(initXY)&&initXY.length===2&&initXY.every(Number.isFinite))
    seeds.unshift({x:initXY[0],y:initXY[1]});
  let best=null;
  for(const seed of seeds){
    let p=projectToBeaconHull(seed,hull),lambda=0.01;
    for(let k=0;k<100;k++){
      let h11=0,h12=0,h22=0,g1=0,g2=0;
      for(const b of beacons){
        const dx=p.x-b.x,dy=p.y-b.y,r=Math.max(Math.hypot(dx,dy),1e-9);
        const residual=r-b.d,jx=dx/r,jy=dy/r;
        h11+=jx*jx;h12+=jx*jy;h22+=jy*jy;g1+=jx*residual;g2+=jy*residual;
      }
      const a=h11+lambda,c=h22+lambda,det=a*c-h12*h12;
      if(det<1e-14){lambda*=10;continue;}
      const step={x:(-c*g1+h12*g2)/det,y:(h12*g1-a*g2)/det};
      const proposal=projectToBeaconHull({x:p.x+step.x,y:p.y+step.y},hull);
      if(rangingCost(proposal,beacons)<rangingCost(p,beacons)-1e-10){
        const distance=Math.hypot(proposal.x-p.x,proposal.y-p.y);
        p=proposal;lambda=Math.max(lambda/3,1e-8);
        if(distance<1e-5)break;
      }else{lambda=Math.min(lambda*6,1e8);if(lambda>=1e8)break;}
    }
    const cost=rangingCost(p,beacons);
    if(!best||cost<best.cost)best={x:p.x,y:p.y,cost};
  }
  if(!best)return null;
  let solution={x:best.x,y:best.y};
  let rangeAdjusted=false;
  // When all disks have a common area, keep the estimate inside every one.
  // When data disagree, a physically impossible intersection is not invented.
  if(maxRangeExcess(solution,beacons)>0.03){
    const feasible=projectToFeasibleRanges(solution,hull,beacons);
    if(feasible){rangeAdjusted=Math.hypot(solution.x-feasible.x,solution.y-feasible.y)>0.01;solution=feasible;}
  }
  const cost=rangingCost(solution,beacons);
  const maxMiss=maxRangeExcess(solution,beacons);
  return {
    x:solution.x,y:solution.y,rms:Math.sqrt(cost/beacons.length),
    bounded:true,
    hullConstrained:!insideBeaconHull(linear,hull),
    rangeAdjusted,
    rangeConflict:maxMiss>0.05,
    maxRangeMiss:maxMiss,
    hull
  };
}
function validBoundedCache(cache){
  if(!cache||cache.boundaryVerified!==true||!Array.isArray(cache.anchors)||cache.anchors.length<3||
     !Number.isFinite(Number(cache.lat??cache.tlat))||!Number.isFinite(Number(cache.lon??cache.tlon)))return false;
  const anchors=[];
  for(const a of cache.anchors){
    const current=findBeaconByScan({bssid:a.bssid,ssid:a.ssid});
    if(!current||Math.abs(current.lat-a.lat)>1e-7||Math.abs(current.lon-a.lon)>1e-7)return false;
    anchors.push(current);
  }
  const refLat=anchors[0].lat,refLon=anchors[0].lon;
  const xy=anchors.map(a=>{const [x,y]=ll2xy(a.lat,a.lon,refLat,refLon);return {x,y};});
  const hull=beaconHullXY(xy);
  const [x,y]=ll2xy(Number(cache.lat??cache.tlat),Number(cache.lon??cache.tlon),refLat,refLon);
  return hull.length>=3 && insideBeaconHull({x,y},hull);
}
function findBeaconByScan(s){ const list=loadBeacons(); if(s.bssid){ const by=list.find(x=> sameBssid(x.bssid, s.bssid)); if(by) return by; } return list.find(x=> (x.name||'').toLowerCase()===(s.ssid||'').toLowerCase()); }
function drawRangesForDevice(devNormId, scans){
  const old=rangeByDev.get(devNormId); if(old){ old.remove(); rangeByDev.delete(devNormId); }
  lastScanByDev.set(devNormId, scans);
  const group=L.layerGroup();
  for(const s of scans){
    const b=findBeaconByScan(s); if(!b) continue;
    if(!Number.isFinite(s.d)||s.d<0)continue;
    L.circle([b.lat,b.lon],{renderer:vectorRenderer,radius:s.d,color:'#0277bd',weight:1,fillOpacity:0.05,interactive:false,pane:'rangesPane'}).addTo(group);
  }
  // Show the precise displayed-position boundary: convex hull of matched beacons.
  const distinct=[],seen=new Set();
  for(const scan of scans){
    const b=findBeaconByScan(scan);
    if(!b||!Number.isFinite(b.lat)||!Number.isFinite(b.lon))continue;
    const id=normalizeBssid(b.bssid)||String(b.name||'').toLowerCase();
    if(seen.has(id))continue;
    seen.add(id);distinct.push(b);
  }
  if(distinct.length>=3){
    const refLat=distinct[0].lat,refLon=distinct[0].lon;
    const coords=distinct.map(b=>{const [x,y]=ll2xy(b.lat,b.lon,refLat,refLon);return {x,y};});
    const hull=beaconHullXY(coords);
    if(hull.length>=3){
      L.polygon(hull.map(p=>xy2ll(p.x,p.y,refLat,refLon)),{
        renderer:vectorRenderer,color:'#2356a6',weight:2,dashArray:'5 5',fillOpacity:0.015,
        interactive:false,pane:'rangesPane'
      }).addTo(group);
    }
  }
  rangeByDev.set(devNormId, group);
  updateRangesVisibility();
}

/* ================= Parse Favoriot/scan data ================= */
function parseLatLonFromData(data){
  if(!data||typeof data!=='object') return null;
  const latKeys=['lat','latitude','raw_lat','rawLat']; const lonKeys=['lon','lng','long','longitude','raw_lon','rawLong','rawLon'];
  let lat,lon; for(const k of latKeys){ if(k in data){ lat=parseFloat(data[k]); if(Number.isFinite(lat)) break; } }
  for(const k of lonKeys){ if(k in data){ lon=parseFloat(data[k]); if(Number.isFinite(lon)) break; } }
  return (Number.isFinite(lat)&&Number.isFinite(lon))?[lat,lon]:null;
}
function extractScanStringFromData(data){
  if(!data||typeof data!=='object') return '';
  const keys=[
    'Beacon_Triangulation','beacon_triangulation',
    'scan','wifi','wifi_rtt','rtt','payload','status','field3','text','scan_string','scanPayload'
  ];
  for(const k of keys){ if(typeof data[k]==='string' && /SSID\s*:|BSSID\s*:|D\s*[:=]/i.test(data[k])) return data[k]; }
  let acc=''; for(const [k,v] of Object.entries(data)){ if(typeof v==='string') acc+=v; }
  return acc;
}
function parseScanPayload(str){
  if(!str||typeof str!=='string') return [];
  const s = String(str);
  let items=[];
  const segs = s.match(/\[[^\]]+\]/g) || [];
  for (let seg of segs){
    const inner = seg.slice(1,-1);
    const ssid = (inner.match(/SSID\s*:\s*([^\s\]]+)/i)||[])[1];
    const bssidRaw = (inner.match(/BSSID\s*:\s*([0-9A-Fa-f:\-]{12,23})/i)||[])[1];
    const dStr = (inner.match(/\b(?:D|Dist|Distance)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/i)||[])[1];
    const bssid = bssidRaw ? prettyBssid(bssidRaw) : undefined;
    const d = dStr? parseFloat(dStr) : NaN;
    if (ssid && Number.isFinite(d)) items.push({ssid,bssid,d});
  }
  if (items.length) return items;
  const re = /SSID\s*:\s*([^\s\]]+)[\s\S]*?BSSID\s*:\s*([0-9A-Fa-f:\-]{12,23})[\s\S]*?(?:D|Dist|Distance)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/gi;
  let m; while ((m = re.exec(s)) !== null){
    const ssid = m[1];
    const bssid = prettyBssid(m[2]);
    const d = parseFloat(m[3]);
    if (ssid && Number.isFinite(d)) items.push({ssid,bssid,d});
  }
  return items;
}
function extractBatteryPercent(data, scanStr){
  if(data && typeof data==='object'){
    const keys=['Battery_Percentage','battery_percentage','battery','Battery','batt','batt_percent','batteryPercent','batteryPct'];
    for(const k of keys){
      if(k in data){
        const v = parseFloat(String(data[k]).toString().replace(/[^\d.]/g,''));
        if(Number.isFinite(v)) return Math.max(0, Math.min(100, v));
      }
    }
  }
  const s = String(scanStr||'');
  let m = s.match(/Battery[_\s-]*Percentage\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i)
       || s.match(/\bBatt(?:ery)?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*%?/i);
  if(m){ const v=parseFloat(m[1]); if(Number.isFinite(v)) return Math.max(0, Math.min(100, v)); }
  for(const seg of (s.match(/\[[^\]]+\]/g)||[])){
    const m2 = seg.match(/Battery[_\s-]*Percentage\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if(m2){ const v=parseFloat(m2[1]); if(Number.isFinite(v)) return Math.max(0, Math.min(100, v)); }
  }
  return null;
}

/* ================= Markers, Trilateration, Fetching ... ================= */
/* Inline SVG trolley with a bottom-anchored location pin and live status dot. */
function trolleyState(normId){
  const st=computeStatus(normId);
  return st.offline?'offline':(st.sleeping?'sleeping':'online');
}
function trolleyIcon(normId,{cached=false,rangeConflict=false}={}){
  const status=trolleyState(normId);
  const svg=`<svg width="29" height="29" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <path d="M5 9h4l4.1 18.5h18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M11.2 12.5H35l-3.3 12.1H14.0" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/>
    <path d="M13 18.5h20" fill="none" stroke="currentColor" stroke-width="1.7" opacity=".65"/>
    <circle cx="17" cy="32" r="3" fill="currentColor"/><circle cx="30" cy="32" r="3" fill="currentColor"/>
  </svg>`;
  const cls=`trolley-pin trolley-${status}${cached?' trolley-cached':''}${rangeConflict?' trolley-conflict':''}`;
  return L.divIcon({className:'trolley-map-icon',iconSize:[48,60],iconAnchor:[24,58],popupAnchor:[0,-48],
    html:`<div class="${cls}" role="img" aria-label="Trolley ${status}${cached?' last known':''}">
      <div class="trolley-card">${svg}<span class="trolley-status-dot"></span></div>
      <div class="trolley-tip"></div>
    </div>`});
}
function refreshTrolleyIcon(marker,normId,opts={}){
  if(!marker || typeof marker.setIcon!=='function')return;
  const key=trolleyState(normId)+'|'+Boolean(opts.cached)+'|'+Boolean(opts.rangeConflict);
  if(marker._trolleyIconKey!==key){marker.setIcon(trolleyIcon(normId,opts));marker._trolleyIconKey=key;}
}
function placeDeviceMarker(dev,idx,lat,lon,time){
  const normId=ensureDevId(dev.id);
  let m=devMarkers.get(dev.id);
  if(lat!=null&&lon!=null){
    if(!m){m=L.marker([lat,lon],{icon:trolleyIcon(normId),keyboard:true});devMarkers.set(dev.id,m);}
    m.setLatLng([lat,lon]);refreshTrolleyIcon(m,normId);
    const when=time?new Date(time).toLocaleString():'—';const name=escapeHtml(dev.name||'Device');
    m.bindTooltip(`<span class="small"><strong>${name}</strong><br>${escapeHtml(normId)}<br>${escapeHtml(when)}<br>Reported coordinate</span>`,{sticky:true,opacity:.95,offset:[0,-25]});
    m.bindPopup(`<div class="small"><strong>${name}</strong><br>ID: ${escapeHtml(normId)}<br>Reported: ${lat.toFixed(6)}, ${lon.toFixed(6)}<br>${escapeHtml(when)}</div>`);
    // Do not overlay a second trolley if the same device has a trilaterated marker.
    if(isDeviceVisible(normId)&&(!document.getElementById('enableTri2').checked||!triMarkers.has(dev.id))){
      if(!devicesLayer.hasLayer(m))m.addTo(devicesLayer);
    }else if(devicesLayer.hasLayer(m))devicesLayer.removeLayer(m);
  }else if(m){devicesLayer.removeLayer(m);devMarkers.delete(dev.id);}
}
function placeTriMarker(dev,idx,lat,lon,rms,meta={}){
  const key=dev.id,normId=ensureDevId(dev.id);
  let m=triMarkers.get(key);
  if(lat!=null&&lon!=null){
    const quality=meta.rangeConflict?'Range measurements conflict':
      (meta.cached?'Last-known position':(meta.hullConstrained||meta.rangeAdjusted?'Bounded estimate':'Range-fit estimate'));
    if(!m){m=L.marker([lat,lon],{icon:trolleyIcon(normId,meta),keyboard:true,zIndexOffset:100});triMarkers.set(key,m);}
    m.setLatLng([lat,lon]);refreshTrolleyIcon(m,normId,meta);
    const idHtml=escapeHtml(normId),name=escapeHtml(dev.name||'Trolley');
    const rmsText=Number.isFinite(rms)?rms.toFixed(2):'—';
    const mismatch=meta.rangeConflict?`<br>Max range discrepancy: ${Number(meta.maxRangeMiss||0).toFixed(2)} m`:'';
    const msg=`<strong>${escapeHtml(quality)}</strong>${mismatch}`;
    m.bindTooltip(`<span class="small"><strong>${name}</strong><br>${idHtml}<br>${msg}<br>RMS ${rmsText} m</span>`,{sticky:true,opacity:.95,offset:[0,-25]});
    m.bindPopup(`<div class="small"><strong>${name}</strong><br>ID: ${idHtml}<br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br>${msg}<br>RMS ${rmsText} m<br><small>Estimated position; not a guaranteed physical location.</small></div>`);
    if(isDeviceVisible(normId)){if(!triLayer.hasLayer(m))m.addTo(triLayer);}else if(triLayer.hasLayer(m))triLayer.removeLayer(m);
    const raw=devMarkers.get(key);if(raw&&devicesLayer.hasLayer(raw))devicesLayer.removeLayer(raw);
  }else{
    if(m){triLayer.removeLayer(m);triMarkers.delete(key);}
  }
}
function appendTrilatTrack(normId, lat, lon){
  if(!document.getElementById('recordTrilat').checked) return;
  const recordId = localStorage.getItem('record-device-v1')||'';
  if(recordId !== normId) return;
  const pts = trilatTrack.getLatLngs();
  pts.push(L.latLng(lat,lon));
  if(pts.length > CONFIG.trailPoints) pts.shift();
  trilatTrack.setLatLngs(pts);
}
function updateDevicesVisibility(){
  const set=visibleSet();
  devMarkers.forEach((marker, rawId)=>{
    const id=ensureDevId(loadDevices().find(d=>d.id===rawId)?.id||rawId);
    const triAvailable=triMarkers.has(rawId) && document.getElementById('enableTri2').checked;
    if(set.has(id)&&!triAvailable){ if(!devicesLayer.hasLayer(marker)) marker.addTo(devicesLayer); }
    else { if(devicesLayer.hasLayer(marker)) devicesLayer.removeLayer(marker); }
  });
  triMarkers.forEach((marker, rawId)=>{
    const id=ensureDevId(loadDevices().find(d=>d.id===rawId)?.id||rawId);
    if(set.has(id)&&document.getElementById('enableTri2').checked){
      if(!triLayer.hasLayer(marker))marker.addTo(triLayer);
    }else if(triLayer.hasLayer(marker))triLayer.removeLayer(marker);
  });
  updateRangesVisibility();
}
function computeTrilatForDevice(dev,idx,lat,lon,scans){
  if(!Array.isArray(scans))scans=parseScanPayload(scans||'');
  const normId=ensureDevId(dev.id);
  const matches=[],seen=new Set();
  for(const scan of scans){
    if(!Number.isFinite(scan.d)||scan.d<0)continue;
    const b=findBeaconByScan(scan);
    if(!b||!Number.isFinite(b.lat)||!Number.isFinite(b.lon))continue;
    const id=normalizeBssid(b.bssid)||String(b.name||'').toLowerCase();
    if(seen.has(id))continue;
    seen.add(id);
    matches.push({scan,beacon:b});
  }
  const prev=triResByDev.get(normId);
  function keepVerifiedOrHide(reason){
    if(prev&&validBoundedCache({...prev,lat:prev.tlat,lon:prev.tlon})){
      const retained={...prev,used:matches.length,scans,cached:true,reason};
      triResByDev.set(normId,retained);
      placeTriMarker(dev,idx,prev.tlat,prev.tlon,prev.rms||0,retained);
      return retained;
    }
    placeTriMarker(dev,idx,null,null,0);
    const result={used:matches.length,scans,time:null,reason};
    triResByDev.set(normId,result);
    return result;
  }
  if(matches.length<CONFIG.trilatMinBeacons)
    return keepVerifiedOrHide('Not enough matched beacons');
  const refLat=matches.reduce((v,item)=>v+item.beacon.lat,0)/matches.length;
  const refLon=matches.reduce((v,item)=>v+item.beacon.lon,0)/matches.length;
  const anchors=matches.map(({scan,beacon})=>{
    const [x,y]=ll2xy(beacon.lat,beacon.lon,refLat,refLon);
    return {x,y,d:scan.d};
  });
  const init=(lat!=null&&lon!=null)?ll2xy(lat,lon,refLat,refLon):null;
  const sol=trilatLM(anchors,init);
  if(!sol)return keepVerifiedOrHide('Degenerate beacon geometry or invalid ranges');
  const [tlat,tlon]=xy2ll(sol.x,sol.y,refLat,refLon);
  const storedAnchors=matches.map(({scan,beacon})=>({bssid:beacon.bssid||'',ssid:beacon.name||scan.ssid||'',lat:beacon.lat,lon:beacon.lon}));
  const time=lastSeenByDev.get(normId)||null;
  const result={used:matches.length,tlat,tlon,rms:sol.rms,scans,time,
    boundaryVerified:true,anchors:storedAnchors,cached:false,
    hullConstrained:sol.hullConstrained,rangeAdjusted:sol.rangeAdjusted,
    rangeConflict:sol.rangeConflict,maxRangeMiss:sol.maxRangeMiss};
  placeTriMarker(dev,idx,tlat,tlon,sol.rms,result);
  appendTrilatTrack(normId,tlat,tlon);
  triResByDev.set(normId,result);
  cacheTriResult(normId,result);
  return result;
}
function renderTriInfoList(centerFit=false){
  const box=document.getElementById('triInfoList'); box.innerHTML='';
  const vis=visibleSet();
  const list=loadDevices();
  const bounds=L.latLngBounds([]);

  list.forEach((d,i)=>{
    const norm=ensureDevId(d.id);
    if(!vis.has(norm)) return;
    const tri=triResByDev.get(norm)||{};
    const name=escapeHtml(d.name||'Device');
    const idHtml=escapeHtml(norm);
    const html=`<div class="tri-row">
      <div class="tri-title">${name}</div>
      <div class="small text-secondary">${idHtml}</div>
      <div class="row row-cols-2 g-2 mt-1">
        <div class="col"><div class="small text-secondary">Beacons used</div><div class="stat">${tri.used??0}</div></div>
        <div class="col"><div class="small text-secondary">RMS</div><div class="stat">${(tri.rms!=null)? tri.rms.toFixed(2)+' m' : '—'}</div></div>
        <div class="col"><div class="small text-secondary">Tri Lat</div><div class="stat">${(tri.tlat!=null)? tri.tlat.toFixed(6) : '—'}</div></div>
        <div class="col"><div class="small text-secondary">Tri Lon</div><div class="stat">${(tri.tlon!=null)? tri.tlon.toFixed(6) : '—'}</div></div>
      </div>
      <div class="small mt-2 ${tri.rangeConflict?'text-warning':''}">${tri.rangeConflict
          ? `Range conflict: beacon circles have no common fit (max excess ${Number(tri.maxRangeMiss||0).toFixed(2)} m). Location remains inside the beacon area.`
          : (tri.boundaryVerified ? (tri.cached ? 'Last-known bounded position' : (tri.hullConstrained||tri.rangeAdjusted ? 'Bounded to matched beacon area' : 'Position inside matched beacon area')) : (tri.reason||'Awaiting valid beacon geometry'))}</div>
      <div class="d-flex gap-2 mt-2 link-mini">
        <a class="btn btn-outline-secondary btn-sm" target="_blank" rel="noopener" href="${(tri.tlat!=null)?`https://www.openstreetmap.org/?mlat=${tri.tlat}&mlon=${tri.tlon}#map=19/${tri.tlat}/${tri.tlon}`:'#'}"><i class="bi bi-map"></i> OSM</a>
        <a class="btn btn-outline-secondary btn-sm" target="_blank" rel="noopener" href="${(tri.tlat!=null)?`https://www.google.com/maps?q=${tri.tlat},${tri.tlon}`:'#'}"><i class="bi bi-geo"></i> Google</a>
      </div>
    </div>`;
    box.insertAdjacentHTML('beforeend', html);
    if(tri.tlat!=null && tri.tlon!=null){ bounds.extend([tri.tlat,tri.tlon]); }
  });

  if(centerFit && document.getElementById('centerOnUpdate').checked){
    if(bounds.isValid()){ map.fitBounds(bounds.pad(0.2), { animate:true, duration:.4, maxZoom:20 }); }
  }
}

/* ================= Favoriot fetching ================= */
async function fetchFavoriot(url, headers, {attempt=0, viaDefaultProxy=false}={}){
  const usedUrl = viaDefaultProxy ? withProxy(url, true) : url;
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), 12000);
  try{
    const r = await fetch(usedUrl, { headers, signal: controller.signal });
    clearTimeout(t); return r;
  }catch(e){
    clearTimeout(t);
    if(attempt===0 && !viaDefaultProxy){ return fetchFavoriot(url, headers, {attempt:1, viaDefaultProxy:true}); }
    throw e;
  }
}
function explainFetchError(e, rJson){
  if (e?.name === 'AbortError') return 'Request timed out.';
  const msg = String(e?.message || '');
  if (/Failed to fetch|NetworkError|TypeError: Failed to fetch/i.test(msg)) return 'Network/CORS error — set a CORS proxy in Settings (or try again).';
  if (rJson?.message) return rJson.message;
  return msg || 'Unknown error';
}
async function fetchOneDeviceLatest(dev, idx){
  if(!window.WorkspaceSync?.isReady()) return {ok:false};
  const url=streamsUrl(dev); const headers=headersFor();
  try{
    clearErr();
    let r = await fetchFavoriot(url, headers, {attempt:0, viaDefaultProxy:false});
    let text = await r.text(); let j=null; try{ j=JSON.parse(text); }catch{}
    if(!r.ok){
      if (r.status===429 || (r.status>=500 && r.status<600)) {
        await new Promise(res=>setTimeout(res, 800));
        r = await fetchFavoriot(url, headers, {attempt:0, viaDefaultProxy:false});
        text = await r.text(); j=null; try{ j=JSON.parse(text); }catch{}
        if(!r.ok) throw new Error(j?.message || `${r.status} ${r.statusText}`);
      } else { throw new Error(j?.message || `${r.status} ${r.statusText}`);
      }
    }
    if(!window.WorkspaceSync?.isReady()) return {ok:false};
    let last=null;
    if(Array.isArray(j.results) && j.results.length){
      last = j.results.reduce((a,b)=>{
        const ta = Date.parse(a.stream_created_at||a.created_at||a.timestamp||0);
        const tb = Date.parse(b.stream_created_at||b.created_at||b.timestamp||0);
        return (tb>ta)? b : a;
      }, j.results[0]);
    }
    let lat=null,lon=null,time=null,scan='';
    if(last){
      const pair=parseLatLonFromData(last.data); if(pair){ lat=pair[0]; lon=pair[1]; }
      time= last.stream_created_at || last.created_at || last.timestamp || null;
      scan= extractScanStringFromData(last.data);
    }
    const batt = extractBatteryPercent(last?.data||{}, scan);
    const state = extractState(last?.data||{}, scan);
    const tempC = extractTemperature(last?.data||{}, scan);
    const sleepSec = extractSleepSec(last?.data||{}, scan);

    const normId=ensureDevId(dev.id);
    const ts = time ? Date.parse(time) : NaN;
    if(Number.isFinite(ts)){
      const prevTs = lastServerTsByDev.get(normId);
      if(prevTs === undefined){
        lastSeenByDev.set(normId, ts);
      } else if(ts > prevTs){
        lastSeenByDev.set(normId, Date.now());
      }
      lastServerTsByDev.set(normId, ts);
    } else {
      lastSeenByDev.set(normId, undefined);
    }

    batteryByDev.set(normId, batt);
    stateByDev.set(normId, state);
    tempByDev.set(normId, tempC);
    if(sleepSec!=null) sleepSecByDev.set(normId, sleepSec); else sleepSecByDev.delete(normId);

    placeDeviceMarker(dev,idx,lat,lon,time);

    const scans=parseScanPayload(scan||'');
    lastScanByDev.set(normId, scans);
    drawRangesForDevice(normId, scans);

    let usedCount=0;
    if(document.getElementById('enableTri2').checked){
      const triRes = computeTrilatForDevice(dev, idx, lat, lon, scans);
      usedCount = triRes?.used||0;
    }else{
      placeTriMarker(dev, idx, null, null, 0);
      triResByDev.set(normId, {used:0, scans, time:null});
    }
    if(!usedCount){ usedCount = scans.reduce((n,s)=> n + (findBeaconByScan(s)?1:0), 0); }
    healthByDev.set(normId, usedCount >= CONFIG.trilatMinBeacons);

    // Offline reason population (Sleep-aware)
    (function(){
      const st = computeStatus(normId);
      if(st.offline){
        let reason='';
        if(healthByDev.get(normId)===false){
          reason = `Not enough beacons matched for trilateration (${usedCount}/${CONFIG.trilatMinBeacons}).`;
        } else {
          const ts2 = lastSeenByDev.get(normId);
          const when = ts2 ? new Date(ts2).toLocaleString() : '—';
          if(st.sleepSec){
            const since = ts2 ? Math.round((Date.now()-ts2)/1000) : null;
            reason = since!=null ? `Exceeded sleep (${st.sleepSec}s); no new data for ${since}s (last ${when}).` : `Exceeded sleep (${st.sleepSec}s) without new data.`;
          } else {
            const mins = ts2 ? Math.round((Date.now()-ts2)/60000) : null;
            reason = mins!=null ? `No new data for ${mins} min (last ${when}).` : 'No recent data received.';
          }
        }
        offlineReasonByDev.set(normId, reason);
      } else {
        offlineReasonByDev.delete(normId);
      }
    })();

    const sEl=document.getElementById(`st-${idx}`);
    if(sEl){
      const when=time? new Date(time).toLocaleString():'—';
      const battHtml = batteryBadgeHtml(batt, state);
      const stateHtml = stateBadgeHtml(state);
      const tempHtml = tempHtmlC(tempC);
      if(lat!=null&&lon!=null){
        sEl.innerHTML = `Lat ${lat.toFixed(6)} · Lon ${lon.toFixed(6)} · ${escapeHtml(when)}${stateHtml}${tempHtml}${battHtml}`;
      }else{
        sEl.innerHTML = `— ${escapeHtml(when)}${stateHtml}${tempHtml}${battHtml}`;
      }
    }

    // Auto-fill Scan Tester on refresh
    if (document.getElementById('toggleScanTester').checked) {
      const selId = document.getElementById('scanSource').value;
      const autoFill = document.getElementById('scanAutoFill').checked;
      const autoParse = document.getElementById('scanAutoParse').checked;
      if (autoFill && ensureDevId(dev.id) === selId) {
        document.getElementById('scanInput').value = scan || '';
        if (autoParse) { parseScanTester(); }
      }
    }

    refreshHealthDots();
    return { ok:true };
  }catch(e){
    console.error('Device fetch error',dev.id,e);
    let reason = '';
    try{
      const rp = await fetchFavoriot(url, headers, {attempt:1, viaDefaultProxy:true});
      const txt = await rp.text(); const j = JSON.parse(txt);
      reason = explainFetchError(e, j);
    }catch(_ignore){
      reason = explainFetchError(e, null);
    }
    showErr(`Fetch failed for ${ensureDevId(dev.id)} — ${reason}`);
    placeDeviceMarker(dev,idx,null,null,null);
    placeTriMarker(dev, idx, null, null, 0);
    const normId=ensureDevId(dev.id);
    healthByDev.set(normId, false);
    offlineReasonByDev.set(normId, reason || 'Fetch failed.');
    refreshHealthDots();
    return { ok:false, err:String(e) };
  }
}
async function fetchAllDevices(){
  const list=loadDevices();
  await Promise.all(list.map((d,i)=> fetchOneDeviceLatest(d,i)));
  updateDevicesVisibility();
  renderTriInfoList(true);
}

/* ================= Favoriot WebSocket live transport ================= */
const LIVE = {
  socket: null,
  connected: false,
  listening: false,
  manualStop: false,
  registerTimer: null,
  lastEventAt: 0,
  seenStreamIds: new Set()
};
window.__ALPS_LIVE_STATUS_ACTIVE__ = true;

function liveSocketEnabled(){
  const cfg=CFG();
  return cfg.liveSocket !== false;
}

function setTransportStatus(mode, detail=''){
  const box=document.getElementById('uiRefreshStatus');
  if(!box) return;
  const icon=box.querySelector('i');
  const text=box.querySelector('span');
  box.classList.remove('text-success','text-warning','text-danger');
  if(mode==='live'){
    if(icon) icon.className='bi bi-broadcast-pin';
    if(text) text.textContent='Live · WebSocket';
    box.classList.add('text-success');
    box.title=detail || 'Favoriot WebSocket live stream is active';
  }else if(mode==='connecting'){
    if(icon) icon.className='bi bi-arrow-repeat';
    if(text) text.textContent='Connecting live…';
    box.classList.add('text-warning');
    box.title=detail || 'Connecting to Favoriot WebSocket';
  }else if(mode==='fallback'){
    if(icon) icon.className='bi bi-arrow-repeat';
    const sec=Math.max(2,Math.round((CFG().refreshMs||8000)/1000));
    if(text) text.textContent=`REST fallback · ${sec}s`;
    box.classList.add('text-warning');
    box.title=detail || 'WebSocket is unavailable; using REST polling';
  }else if(mode==='paused'){
    if(icon) icon.className='bi bi-pause-circle';
    if(text) text.textContent='Live disconnected · fallback paused';
    box.classList.add('text-secondary');
    box.title=detail || 'REST fallback polling is disabled';
  }else{
    if(icon) icon.className='bi bi-arrow-repeat';
    if(text) text.textContent=detail || 'Connection idle';
    box.title=detail || 'Connection idle';
  }
  const hint=document.getElementById('liveConnectionHint');
  if(hint){
    if(mode==='live') hint.textContent='Connected to Favoriot WebSocket. New data streams are pushed to this dashboard immediately.';
    else if(mode==='connecting') hint.textContent='Connecting to Favoriot WebSocket. REST fallback remains available during connection setup.';
    else if(mode==='fallback') hint.textContent='WebSocket is not active. The dashboard is using the configured REST fallback interval.';
    else if(mode==='paused') hint.textContent='WebSocket is not active and REST fallback polling is disabled.';
  }
}

function parseStreamTimeMs(record){
  if(!record || typeof record!=='object') return NaN;
  let raw=record.stream_created_at ?? record.created_at ?? record.timestamp ?? record.time ?? null;
  if(raw==null) return NaN;
  if(typeof raw==='number'){
    if(raw>0 && raw<1e11) raw*=1000;
    return Number.isFinite(raw)?raw:NaN;
  }
  const numeric=Number(raw);
  if(Number.isFinite(numeric) && String(raw).trim()!==''){
    return (numeric>0 && numeric<1e11)?numeric*1000:numeric;
  }
  return Date.parse(raw);
}

function extractActiveSecLive(data, scanStr){
  try{
    if(data && typeof data==='object'){
      for(const [k,v] of Object.entries(data)){
        const lk=String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
        if((lk.includes('active') && (lk.includes('sec') || lk.includes('time'))) || lk.endsWith('activetimesec') || lk.endsWith('activesec')){
          const m=String(v).match(/([-+]?\d+(?:\.\d+)?)/);
          if(m){ const n=parseFloat(m[1]); if(Number.isFinite(n) && n>0) return Math.round(n); }
        }
      }
    }
    const str=String(scanStr||'');
    const m=str.match(/active[_\s-]*time[_\s-]*sec\s*[:=]\s*(\d+)/i)
      || str.match(/\bactive\s*[:=]\s*(\d+)\s*s\b/i)
      || str.match(/\bactive[_\s-]*sec\s*[:=]\s*(\d+)/i);
    if(m){ const n=parseFloat(m[1]); if(Number.isFinite(n) && n>0) return Math.round(n); }
  }catch(_){ }
  return null;
}

function streamRecordsFromSocketPayload(payload){
  if(typeof payload==='string'){
    try{ payload=JSON.parse(payload); }catch(_){ return []; }
  }
  const out=[];
  const visited=new Set();
  const visit=(v,depth=0)=>{
    if(v==null || depth>5) return;
    if(typeof v==='string'){
      const t=v.trim();
      if((t.startsWith('{')||t.startsWith('['))){ try{ visit(JSON.parse(t),depth+1); }catch(_){} }
      return;
    }
    if(Array.isArray(v)){ v.forEach(x=>visit(x,depth+1)); return; }
    if(typeof v!=='object' || visited.has(v)) return;
    visited.add(v);
    const devId=v.device_developer_id || v.deviceDeveloperId || v.device_id;
    if(devId && v.data && typeof v.data==='object' && !Array.isArray(v.data)) out.push(v);
    for(const k of ['results','result','streams','stream','payload','parameters','response']){
      if(k in v) visit(v[k],depth+1);
    }
    if(Array.isArray(v.data) || (v.data && typeof v.data==='object' && (v.data.device_developer_id || v.data.results || v.data.stream))) visit(v.data,depth+1);
  };
  visit(payload,0);
  return out;
}

function rememberLiveTrilat(normId){
  try{
    const r=triResByDev.get(normId);
    if(!r || !r.boundaryVerified || !validBoundedCache({...r,lat:r.tlat,lon:r.tlon}) || (Number(r.used)||0)<CONFIG.trilatMinBeacons) return;
    window.lastGoodPosByDev = window.lastGoodPosByDev || new Map();
    window.lastGoodPosByDev.set(normId,{lat:Number(r.tlat),lon:Number(r.tlon),used:Number(r.used)||CONFIG.trilatMinBeacons,ts:Date.now(),boundaryVerified:true,anchors:r.anchors,rangeConflict:!!r.rangeConflict,maxRangeMiss:r.maxRangeMiss||0});
    const o={}; window.lastGoodPosByDev.forEach((v,k)=>{o[k]=v;});
    localStorage.setItem('alps-last-good-pos',JSON.stringify(o));
  }catch(_){ }
}

let liveRenderTimer=null;
function scheduleLiveRender(){
  clearTimeout(liveRenderTimer);
  liveRenderTimer=setTimeout(()=>{
    try{
      updateDevicesVisibility();
      renderTriInfoList(!!document.getElementById('centerOnUpdate')?.checked);
    }catch(_){ }
  },90);
}

function processLiveStreamRecord(record){
  if(!window.WorkspaceSync?.isReady()) return false;
  if(!record || typeof record!=='object') return false;
  const incomingId=String(record.device_developer_id || record.deviceDeveloperId || record.device_id || '').trim();
  if(!incomingId) return false;
  const list=loadDevices();
  const idx=list.findIndex(d=>ensureDevId(d.id).toLowerCase()===incomingId.toLowerCase());
  if(idx<0) return false; // Ignore account streams that are not configured on this dashboard.
  const dev=list[idx];
  const normId=ensureDevId(dev.id);

  const streamId=String(record.stream_developer_id || record.stream_id || '');
  if(streamId){
    if(LIVE.seenStreamIds.has(streamId)) return false;
    LIVE.seenStreamIds.add(streamId);
    if(LIVE.seenStreamIds.size>400){
      const first=LIVE.seenStreamIds.values().next().value;
      LIVE.seenStreamIds.delete(first);
    }
  }

  const ts=parseStreamTimeMs(record);
  const prevTs=lastServerTsByDev.get(normId);
  if(Number.isFinite(ts) && Number.isFinite(prevTs) && ts<prevTs) return false;
  if(Number.isFinite(ts)) lastServerTsByDev.set(normId,ts);
  lastSeenByDev.set(normId,Date.now());

  const data=(record.data && typeof record.data==='object')?record.data:{};
  const pair=parseLatLonFromData(data);
  const lat=pair?pair[0]:null, lon=pair?pair[1]:null;
  const time=record.stream_created_at || record.created_at || record.timestamp || new Date().toISOString();
  const scan=extractScanStringFromData(data);
  const batt=extractBatteryPercent(data,scan);
  const state=extractState(data,scan);
  const tempC=extractTemperature(data,scan);
  const sleepSec=extractSleepSec(data,scan);
  const activeSec=extractActiveSecLive(data,scan);

  batteryByDev.set(normId,batt);
  stateByDev.set(normId,state);
  tempByDev.set(normId,tempC);
  if(sleepSec!=null) sleepSecByDev.set(normId,sleepSec); else sleepSecByDev.delete(normId);
  if(activeSec!=null) window.activeSecByDev.set(normId,activeSec);

  placeDeviceMarker(dev,idx,lat,lon,time);
  const scans=parseScanPayload(scan||'');
  lastScanByDev.set(normId,scans);
  drawRangesForDevice(normId,scans);

  let usedCount=0;
  if(document.getElementById('enableTri2').checked){
    const triRes=computeTrilatForDevice(dev,idx,lat,lon,scans);
    usedCount=triRes?.used||0;
    rememberLiveTrilat(normId);
  }else{
    placeTriMarker(dev,idx,null,null,0);
    triResByDev.set(normId,{used:0,scans,time:null});
  }
  if(!usedCount) usedCount=scans.reduce((n,x)=>n+(findBeaconByScan(x)?1:0),0);
  healthByDev.set(normId,usedCount>=CONFIG.trilatMinBeacons);
  offlineReasonByDev.delete(normId);

  const sEl=document.getElementById(`st-${idx}`);
  if(sEl){
    let when='—';
    try{ when=new Date(Number.isFinite(ts)?ts:time).toLocaleString(); }catch(_){ }
    const battHtml=batteryBadgeHtml(batt,state);
    const stateHtml=stateBadgeHtml(state);
    const tempHtml=tempHtmlC(tempC);
    sEl.innerHTML=(lat!=null&&lon!=null)
      ? `Lat ${lat.toFixed(6)} · Lon ${lon.toFixed(6)} · ${escapeHtml(when)}${stateHtml}${tempHtml}${battHtml}`
      : `— ${escapeHtml(when)}${stateHtml}${tempHtml}${battHtml}`;
  }

  if(document.getElementById('toggleScanTester').checked){
    const selected=document.getElementById('scanSource').value;
    if(document.getElementById('scanAutoFill').checked && normId===selected){
      document.getElementById('scanInput').value=scan||'';
      if(document.getElementById('scanAutoParse').checked) parseScanTester();
    }
  }

  LIVE.lastEventAt=Date.now();
  refreshHealthDots();
  scheduleLiveRender();
  return true;
}

function startRestFallback(reason=''){
  LIVE.listening=false;
  const fallbackOn=document.getElementById('autorefresh')?.checked!==false;
  if(fallbackOn){
    startTimer();
    setTransportStatus('fallback',reason);
  }else{
    stopTimer();
    setTransportStatus('paused',reason);
  }
}

function stopLiveSocket({silent=false}={}){
  clearTimeout(LIVE.registerTimer); LIVE.registerTimer=null;
  LIVE.manualStop=true;
  const s=LIVE.socket;
  LIVE.socket=null; LIVE.connected=false; LIVE.listening=false;
  if(s){
    try{ s.removeAllListeners(); }catch(_){}
    try{ s.disconnect(); }catch(_){}
  }
  LIVE.manualStop=false;
  if(!silent) startRestFallback('Live connection stopped');
}

function startLiveTransport(){
  stopLiveSocket({silent:true});
  LIVE.seenStreamIds.clear();
  setPeriod();
  const cfg=CFG();
  const apiKey=String(cfg.apiKey||'').trim();
  if(!liveSocketEnabled()){
    startRestFallback('Favoriot WebSocket disabled in Settings');
    return;
  }
  if(!apiKey){
    startRestFallback('No Favoriot API key configured');
    return;
  }
  if(typeof window.io!=='function'){
    startRestFallback('Socket.IO client could not be loaded');
    return;
  }

  // Keep REST fallback alive while the WebSocket handshake/register request completes.
  if(document.getElementById('autorefresh')?.checked!==false) startTimer();
  setTransportStatus('connecting');

  const socket=window.io('https://io.favoriot.com',{
    transports:['websocket','polling'],
    upgrade:true,
    reconnection:true,
    reconnectionAttempts:Infinity,
    reconnectionDelay:1000,
    reconnectionDelayMax:10000,
    randomizationFactor:0.35,
    timeout:10000
  });
  LIVE.socket=socket;

  socket.on('connect',()=>{
    LIVE.connected=true;
    LIVE.listening=false;
    setTransportStatus('connecting','Connected to Favoriot; registering stream listener');
    try{
      socket.emit('v2/streams',{request:'listen',apikey:apiKey});
    }catch(e){
      startRestFallback('Unable to register Favoriot live listener');
      return;
    }
    clearTimeout(LIVE.registerTimer);
    LIVE.registerTimer=setTimeout(()=>{
      if(!LIVE.listening){
        // Socket exists, but Favoriot has not confirmed the stream event yet. REST remains active.
        setTransportStatus('fallback','Favoriot live listener has not confirmed yet; REST fallback remains active');
      }
    },5000);
  });

  socket.on('v2/streams',(payload)=>{
    // Any non-error response to our listen request confirms registration according to Favoriot docs.
    const text=typeof payload==='string'?payload:JSON.stringify(payload||{});
    if(/unauthor|invalid\s*api|forbidden|\b401\b|\b403\b|"statusCode"\s*:\s*(?:4\d\d|5\d\d)|request\s*(?:failed|invalid)/i.test(text)){
      startRestFallback('Favoriot rejected or could not register the WebSocket listener');
      return;
    }
    LIVE.listening=true;
    LIVE.connected=true;
    clearTimeout(LIVE.registerTimer); LIVE.registerTimer=null;
    stopTimer();
    setTransportStatus('live');
    const records=streamRecordsFromSocketPayload(payload);
    let processed=0;
    records.forEach(r=>{ if(processLiveStreamRecord(r)) processed++; });
    if(processed) clearErr();
  });

  socket.on('disconnect',(reason)=>{
    LIVE.connected=false; LIVE.listening=false;
    if(!LIVE.manualStop) startRestFallback(`Favoriot WebSocket disconnected${reason?`: ${reason}`:''}`);
  });
  socket.on('connect_error',(err)=>{
    LIVE.connected=false; LIVE.listening=false;
    startRestFallback(`Favoriot WebSocket connection error${err?.message?`: ${err.message}`:''}`);
  });
  socket.io?.on?.('reconnect_attempt',()=>{
    if(!LIVE.listening) setTransportStatus('connecting','Reconnecting to Favoriot WebSocket; REST fallback remains available');
  });
}

window.addEventListener('online',()=>{ try{ startLiveTransport(); }catch(_){} });
window.addEventListener('offline',()=>{ try{ startRestFallback('Browser is offline'); }catch(_){} });

/* ================= Health dots & Online badges ================= */
function refreshHealthDots(){
  const list=loadDevices();
  list.forEach((d,i)=>{
    const norm=ensureDevId(d.id);
    const st=computeStatus(norm);
    const col=statusDotColor(norm);
    const a=document.getElementById(`dot-${i}`); if(a) a.style.background=col;
    const b=document.getElementById(`vDot-${i}`); if(b) b.style.background=col;
    const lbl=document.getElementById(`ol-${i}`);
    if(lbl){
      if(st.offline){
        lbl.textContent='Offline';
        lbl.className='badge ms-2 bg-danger-subtle text-danger-emphasis';
      } else if(st.sleeping){
        lbl.innerHTML='Sleep <span class="zzz">💤</span>';
        lbl.className='badge ms-2 bg-warning-subtle text-warning-emphasis';
      } else {
        lbl.textContent='Online';
        lbl.className='badge ms-2 bg-success-subtle text-success-emphasis';
      }
    }
    const rs=document.getElementById(`rs-${i}`);
    if(rs){ rs.textContent = st.offline ? (offlineReasonByDev.get(norm)||'') : ''; }
    const tm = triMarkers.get(d.id);
    if(tm){const meta=triResByDev.get(norm)||{};refreshTrolleyIcon(tm,norm,meta);}
    const raw=devMarkers.get(d.id);if(raw)refreshTrolleyIcon(raw,norm);
  });
}

/* ================= Controls & Settings ================= */
function setPeriod(){ document.getElementById('periodLabel').textContent=Math.round((CFG().refreshMs||8000)/1000)+'s'; }
function startTimer(){
  stopTimer(); setPeriod();
  if(typeof LIVE!=='undefined' && LIVE.listening) return;
  if(document.getElementById('autorefresh')?.checked===false) return;
  window._timer=setInterval(()=>{ fetchAllDevices(); }, Math.max(2000, (CFG().refreshMs||8000)));
}
function stopTimer(){ if(window._timer) clearInterval(window._timer); window._timer=null; }

document.getElementById('applyFavoriot').addEventListener('click', async ()=>{
  if(!window.WorkspaceSync?.requireAdmin()) return;
  const cfg=CFG();
  cfg.apiKey=(document.getElementById('favApiKey').value||'').trim();
  cfg.username=(document.getElementById('favUser').value||'').trim();
  cfg.refreshMs=Math.max(2000, parseInt(document.getElementById('refreshSec').value||'8',10)*1000);
  cfg.authHeader=(document.getElementById('authHeader').value||'apikey');
  cfg.proxy=(document.getElementById('corsProxy').value||'').trim();
  cfg.liveSocket=document.getElementById('enableLiveSocket')?.checked!==false;
  saveCFG(cfg);
  try {
    await window.WorkspaceSync.flush();
    fetchAllDevices();
    startLiveTransport();
    alert('Shared settings saved to Supabase. Other users will synchronize automatically.');
  } catch(e) { showErr('Shared settings were NOT saved: '+e.message); }
});

document.getElementById('btnAddDevice').addEventListener('click', ()=>{
  const id=(document.getElementById('devId').value||'').trim();
  const name=(document.getElementById('devName').value||'').trim();
  if(!id){ alert('Enter a Device ID'); return; }
  const list=loadDevices(); list.push({id,name}); saveDevices(list);
  document.getElementById('devId').value=''; document.getElementById('devName').value='';
  const set=visibleSet(); set.add(ensureDevId(id)); saveVisibleSet(set);
  rebuildRecordDeviceSelect(); renderDeviceList(); renderVisibilityDropdown(); renderTrackerList(); rebuildScanSourceSelect();
  fetchAllDevices(); updateDevicesVisibility(); renderTriInfoList(true);
});
document.getElementById('btnClearTrilatRoute').addEventListener('click', ()=>{ trilatTrack.setLatLngs([]); });
document.getElementById('enableTri2').addEventListener('change',()=>{
  const enabled=document.getElementById('enableTri2').checked;
  if(!enabled){
    // Hide computed markers but preserve last result in memory for re-enabling.
    for(const marker of triMarkers.values())if(triLayer.hasLayer(marker))triLayer.removeLayer(marker);
  }else{
    // Recompute with last received FTM scans (no extra network calls).
    loadDevices().forEach((dev,idx)=>{
      const scans=lastScanByDev.get(ensureDevId(dev.id));
      if(Array.isArray(scans)&&scans.length)computeTrilatForDevice(dev,idx,null,null,scans);
    });
  }
  updateDevicesVisibility();renderTriInfoList(false);
});
document.getElementById('btnRefresh').addEventListener('click', ()=>{ fetchAllDevices(); });
document.getElementById('autorefresh').addEventListener('change',(e)=>{ if(LIVE.listening){ stopTimer(); setTransportStatus('live'); } else if(e.target.checked){ startRestFallback('REST fallback enabled'); } else { stopTimer(); setTransportStatus('paused','REST fallback disabled'); } });
document.getElementById('showBeacons').addEventListener('change',(e)=>{
  if(e.target.checked){ if(!map.hasLayer(beaconLayer)) beaconLayer.addTo(map); }
  else { if(map.hasLayer(beaconLayer)) map.removeLayer(beaconLayer); }
});
document.getElementById('showRanges').addEventListener('change', (e)=>{
  if(!e.target.checked){ testRangesLayer.clearLayers(); }  // ensure purple debug rings are cleared
  updateRangesVisibility();
});

// Range scope UI
const rangeScopeSel=document.getElementById('rangeScope');
const rangeDeviceSel=document.getElementById('rangeDevice');
function getRangeScope(){ return localStorage.getItem('range-mode-v1') || 'all'; }
function setRangeScope(v){ localStorage.setItem('range-mode-v1', v); updateRangesVisibility(); applyRangeScopeUI(); }
function getRangeDevice(){ return localStorage.getItem('range-device-v1') || ''; }
function setRangeDevice(id){ localStorage.setItem('range-device-v1', id); updateRangesVisibility(); }
function applyRangeScopeUI(){ const scope=getRangeScope(); rangeScopeSel.value=scope; rangeDeviceSel.disabled = (scope!=='specific'); }
rangeScopeSel.addEventListener('change', ()=> setRangeScope(rangeScopeSel.value));
rangeDeviceSel.addEventListener('change', ()=> setRangeDevice(rangeDeviceSel.value));

/* ================= Locate Me ================= */
document.getElementById('btnLocate').addEventListener('click', (e)=> doLocate(e.currentTarget));
document.getElementById('btnLocateFab').addEventListener('click', (e)=> doLocate(e.currentTarget));
document.addEventListener('keydown', (e)=>{
  const t = e.target;
  const tag = (t && t.tagName || '').toLowerCase();
  const typing = tag==='input' || tag==='textarea' || tag==='select' || (t && t.isContentEditable);
  if(typing) return;
  if(e.key && e.key.toLowerCase()==='l'){ e.preventDefault(); doLocate(document.getElementById('btnLocateFab')); }
});
function doLocate(btn){
  if(!('geolocation' in navigator)){ alert('Geolocation not supported in this browser.'); return; }
  if(!window.isSecureContext){ alert('Geolocation requires HTTPS or localhost. Please host this file via https:// (or use a local server).'); return; }
  const restore=()=>{ if(btn){ btn.disabled=false; btn.innerHTML='<i class="bi bi-crosshair"></i>'; } };
  if(btn){ btn.disabled=true; btn.innerHTML='<i class="bi bi-hourglass-split"></i>'; }
  navigator.geolocation.getCurrentPosition((pos)=>{
    const {latitude,longitude,accuracy}=pos.coords; const lat=latitude, lon=longitude;
    if(!meMarker) meMarker=L.circleMarker([lat,lon],{renderer: vectorRenderer, radius:8,color:'#1e88e5',weight:3,fillOpacity:0.7}).addTo(map);
    meMarker.setLatLng([lat,lon]).bindPopup(`<div class="small"><strong>You are here</strong><br>Lat ${lat.toFixed(6)}, Lon ${lon.toFixed(6)}<br>±${Math.round(accuracy)} m</div>`);
    if(!meCircle) meCircle=L.circle([lat,lon],{renderer: vectorRenderer, radius:accuracy,color:'#1e88e5',weight:1,fillOpacity:0.08}).addTo(map);
    meCircle.setLatLng([lat,lon]); meCircle.setRadius(accuracy);
    map.setView([lat,lon], Math.max(map.getZoom(),19));
    if(window._locTimer) clearTimeout(window._locTimer);
    window._locTimer=setTimeout(()=>{ if(meMarker){ map.removeLayer(meMarker); meMarker=null; } if(meCircle){ map.removeLayer(meCircle); meCircle=null; } }, 6000);
    restore();
  }, (err)=>{ alert('Geolocation: '+(err&&err.message? err.message : 'permission denied')); restore(); }, { enableHighAccuracy:true, timeout:10000, maximumAge:30000 });
}

/* ================= Ranges visibility ================= */
function activeDeviceNormalizedId(){
  const sel=document.getElementById('recordDevice');
  const v = sel && sel.value;
  if(v) return v;
  const list=loadDevices();
  return list[0] ? ensureDevId(list[0].id) : '';
}
function isScanTesterOn(){ return document.getElementById('toggleScanTester').checked; }
function isScanDrawOn(){ return document.getElementById('scanDraw').checked; }
function isShowRangesOn(){ return document.getElementById('showRanges').checked; }

function updateRangesVisibility(){
  const enabled=isShowRangesOn();
  const scope=getRangeScope();
  const specificId=getRangeDevice();
  const vis=visibleSet();

  rangeByDev.forEach((group, id)=>{
    let show=false;
    if(enabled){
      if(scope==='all'){ show = vis.has(id); }
      else if(scope==='active'){ show = (id===activeDeviceNormalizedId()); }
      else if(scope==='specific'){ show = (id===specificId); }
    }
    if(show){ if(!map.hasLayer(group)) group.addTo(map); }
    else { if(map.hasLayer(group)) map.removeLayer(group); }
  });

  const shouldShowDebug = enabled && isScanTesterOn() && isScanDrawOn() && testRangesLayer.getLayers().length>0;
  if(shouldShowDebug){
    if(!map.hasLayer(testRangesLayer)) testRangesLayer.addTo(map);
  }else{
    if(map.hasLayer(testRangesLayer)) map.removeLayer(testRangesLayer);
    testRangesLayer.clearLayers(); // ensure purple rings are fully gone
  }
}

/* ================= Scan string tester helpers ================= */
function parseScanTester(){
  const s = String(document.getElementById('scanInput').value||'');
  const items = parseScanPayload(s);
  const decorated = items.map(it=>{
    const b = findBeaconByScan(it);
    return {...it, matched: !!b, beaconName: b? (b.name||'') : null, beaconLat: b? b.lat : null, beaconLon: b? b.lon : null};
  });
  const scanParsed = document.getElementById('scanParsed');
  const scanSummary = document.getElementById('scanSummary');
  scanParsed.textContent = decorated.length ? JSON.stringify(decorated, null, 2) : '—';
  scanSummary.textContent = decorated.length ? `Parsed ${decorated.length} beacons (${decorated.filter(d=>d.matched).length} matched to saved beacons)` : '—';

  // Draw only when all three toggles are ON
  const canDraw = isShowRangesOn() && isScanTesterOn() && isScanDrawOn();

  testRangesLayer.clearLayers();
  if(canDraw){
    const bounds = L.latLngBounds([]);
    decorated.forEach(it=>{
      if(it.matched && Number.isFinite(it.beaconLat) && Number.isFinite(it.beaconLon) && Number.isFinite(it.d)){
        L.circle([it.beaconLat, it.beaconLon], {renderer: vectorRenderer, radius: it.d, color:'#6a1b9a', weight:1, fillOpacity:0.05, pane:'rangesPane'}).addTo(testRangesLayer);
        bounds.extend([it.beaconLat, it.beaconLon]);
      }
    });
    if(document.getElementById('scanFit').checked && bounds.isValid()){
      map.fitBounds(bounds.pad(0.2), { animate:true, duration:.4, maxZoom:20 });
    }
  }
  updateRangesVisibility();
}

const scanToggle = document.getElementById('toggleScanTester');
const scanBox = document.getElementById('scanTester');
const scanInput = document.getElementById('scanInput');
const scanSourceSel = document.getElementById('scanSource');
function rebuildScanSourceSelect(){
  scanSourceSel.innerHTML='';
  const list=loadDevices();
  list.forEach((d)=>{
    const opt=document.createElement('option');
    opt.value=ensureDevId(d.id);
    opt.textContent=(d.name? d.name+' • ' : '')+opt.value;
    scanSourceSel.appendChild(opt);
  });
  const recSel=document.getElementById('recordDevice');
  if (scanSourceSel.options.length){
    if(recSel && recSel.value){
      const idx = [...scanSourceSel.options].findIndex(o=>o.value===recSel.value);
      scanSourceSel.selectedIndex = idx>=0 ? idx : 0;
    } else {
      scanSourceSel.selectedIndex = 0;
    }
  }
}
async function loadLatestScanToTester(){
  const id = scanSourceSel.value;
  if(!id){ alert('No device selected.'); return; }
  const dev = { id };
  const url = streamsUrl(dev);
  const headers = headersFor();
  try{
    const r = await fetchFavoriot(url, headers, {attempt:0, viaDefaultProxy:false});
    const txt = await r.text(); let j=null; try{ j=JSON.parse(txt); }catch{}
    if(!r.ok) throw new Error(j?.message || `${r.status} ${r.statusText}`);
    let last=null;
    if(Array.isArray(j.results) && j.results.length){
      last = j.results.reduce((a,b)=>{
        const ta = Date.parse(a.stream_created_at||a.created_at||a.timestamp||0);
        const tb = Date.parse(b.stream_created_at||b.created_at||b.timestamp||0);
        return (tb>ta)? b : a;
      }, j.results[0]);
    }
    const scan = last? extractScanStringFromData(last.data) : '';
    scanInput.value = scan || '';
    if(document.getElementById('scanAutoParse').checked){ parseScanTester(); }
    if(!scan) alert('No scan string found in latest record.');
  }catch(e){
    showErr('Scan tester: '+(e?.message||'failed to load latest.'));
  }
}

document.getElementById('btnScanParse').addEventListener('click', parseScanTester);
document.getElementById('btnScanClear').addEventListener('click', ()=>{
  testRangesLayer.clearLayers();
  document.getElementById('scanParsed').textContent='—';
  document.getElementById('scanSummary').textContent='—';
  updateRangesVisibility();
});
document.getElementById('btnScanLoad').addEventListener('click', loadLatestScanToTester);
scanToggle.addEventListener('change', ()=>{
  const on = scanToggle.checked;
  scanBox.classList.toggle('d-none', !on);
  if(on) rebuildScanSourceSelect();
  if(!on) testRangesLayer.clearLayers(); // immediate clear when disabling
  updateRangesVisibility();
});
document.getElementById('scanDraw').addEventListener('change', ()=>{
  if(!document.getElementById('scanDraw').checked){ testRangesLayer.clearLayers(); }
  updateRangesVisibility();
});

/* ================= Export All / Import All / Legacy ================= */
function collectAllData(){
  return {
    version: '4.20.0-live-ws',
    exported_at: new Date().toISOString(),
    origin: location.origin,
    storage: {
      ['favoriot-config-v4']: jget('favoriot-config-v4', null),
      ['favoriot-devices-v4']: jget('favoriot-devices-v4', []),
      ['beacons-v1']: jget('beacons-v1', []),
      ['visible-devices-v1']: Array.from(visibleSet()),
      ['range-mode-v1']: localStorage.getItem('range-mode-v1') || 'all',
      ['range-device-v1']: localStorage.getItem('range-device-v1') || '',
      ['record-device-v1']: localStorage.getItem('record-device-v1') || ''
    }
  };
}
function exportAll(){
  const pkg = collectAllData();
  const blob = new Blob([JSON.stringify(pkg,null,2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'alpsalpine_favoriot_backup.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function importAllFromObject(obj){
  if(!obj) throw new Error('Empty file.');
  const S = obj.storage || obj; // allow flat structure
  if (S['favoriot-config-v4'] && typeof S['favoriot-config-v4']==='object') jset('favoriot-config-v4', S['favoriot-config-v4']);
  if (Array.isArray(S['favoriot-devices-v4'])) jset('favoriot-devices-v4', S['favoriot-devices-v4']);
  if (Array.isArray(S['beacons-v1'])) jset('beacons-v1', S['beacons-v1']);
  if (Array.isArray(S['visible-devices-v1'])) jset('visible-devices-v1', S['visible-devices-v1']);
  if (S['range-mode-v1']) localStorage.setItem('range-mode-v1', S['range-mode-v1']);
  if (S['range-device-v1']) localStorage.setItem('range-device-v1', S['range-device-v1']);
  if (S['record-device-v1']) localStorage.setItem('record-device-v1', S['record-device-v1']);

  // Refresh UI
  const cfg=CFG();
  document.getElementById('favApiKey').value=(cfg.apiKey||'');
  document.getElementById('favUser').value=(cfg.username||'');
  document.getElementById('refreshSec').value=Math.max(2, Math.round((cfg.refreshMs||8000)/1000));
  document.getElementById('authHeader').value=(cfg.authHeader||'apikey');
  document.getElementById('corsProxy').value=(cfg.proxy||'');
  const liveToggle=document.getElementById('enableLiveSocket'); if(liveToggle) liveToggle.checked=(cfg.liveSocket!==false);

  drawBeacons(); renderBeaconList(); rebuildRecord(); renderVisibilityAndLists(); rebuildScanSourceSelect();
  applyRangeScopeUI();
  fetchAllDevices(); updateDevicesVisibility(); renderTriInfoList(true);
}
function importAll(){
  if(!window.WorkspaceSync?.requireAdmin()) return;
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{
    const f=inp.files && inp.files[0]; if(!f) return;
    const fr=new FileReader();
    fr.onload=async ()=>{
      try{
        const obj=JSON.parse(String(fr.result||'{}'));
        stopTimer();
        stopLiveSocket({silent:true});
        importAllFromObject(obj);
        await window.WorkspaceSync.flush();
        startLiveTransport();
        alert('Import saved to Supabase. Shared settings will update for other users.');
      }catch(e){ alert('Import failed: '+e.message); }
    };
    fr.readAsText(f);
  };
  inp.click();
}
function migrateLegacy(forceOverwrite=true){
  if(!window.WorkspaceSync?.requireAdmin()) return {moved:0,details:[]};
  let moved=0, details=[];
  for(const {from,to} of LEGACY_KEYS){
    try{
      const raw = localStorage.getItem(from);
      if(!raw) continue;
      if(forceOverwrite || !localStorage.getItem(to)){
        if(window.WorkspaceSync?.isSharedKey(to)) jset(to, JSON.parse(raw));
        else localStorage.setItem(to, raw);
        moved++; details.push(`${from} → ${to}`);
      }
    }catch{}
  }
  drawBeacons(); renderBeaconList(); rebuildRecord(); renderVisibilityAndLists(); rebuildScanSourceSelect();
  applyRangeScopeUI();
  fetchAllDevices(); updateDevicesVisibility(); renderTriInfoList(true);
  return { moved, details };
}
document.getElementById('btnExportAll').addEventListener('click', exportAll);
document.getElementById('btnImportAll').addEventListener('click', importAll);
document.getElementById('btnMigrateLegacy').addEventListener('click', ()=>{
  const res = migrateLegacy(true);
  if(res.moved>0) alert(`Recovered ${res.moved} item(s):\n`+res.details.join('\n'));
  else alert('No legacy data found for this origin.');
});

/* ================= Init helpers ================= */
function rebuildRangeDeviceSelect(){
  const rangeSel=document.getElementById('rangeDevice'); rangeSel.innerHTML='';
  loadDevices().forEach((d)=>{ const opt=document.createElement('option'); opt.value=ensureDevId(d.id); opt.textContent=(d.name? d.name+' • ' : '')+ensureDevId(d.id); rangeSel.appendChild(opt); });
  const stored=getRangeDevice(); if(stored) rangeSel.value=stored;
}
function renderVisibilityAndLists(){
  renderVisibilityDropdown();
  renderDeviceList();
  renderTrackerList();
}
function rebuildRecord(){
  rebuildRecordDeviceSelect();
  rebuildRangeDeviceSelect();
}
function tryMigrateLegacySameOrigin(){
  let moved=0;
  for(const {from,to} of LEGACY_KEYS){
    try{
      const raw = localStorage.getItem(from);
      if(raw && !localStorage.getItem(to)){
        localStorage.setItem(to, raw);
        moved++;
      }
    }catch{}
  }
  return moved;
}
function applyRangeScopeUI(){ const scope=getRangeScope(); rangeScopeSel.value=scope; rangeDeviceSel.disabled = (scope!=='specific'); }

function restoreTriMarkersFromCache(){
  const cache = loadTriCache();
  const list = loadDevices();
  if(!cache || !list || !list.length) return;
  list.forEach((d,i)=>{
    const norm = ensureDevId(d.id);
    const c = cache[norm];
    if(!c || c.tlat==null || c.tlon==null || !validBoundedCache({ ...c,lat:c.tlat,lon:c.tlon })) return;
    // revive lastSeen for stale coloring
    if(c.time){ const ts = Date.parse(c.time); if(Number.isFinite(ts)) lastSeenByDev.set(norm, ts); }
    // materialize triRes map so Tri Info shows something
    const res = { ...c, used:0, tlat:c.tlat,tlon:c.tlon,rms:c.rms??0,scans:[],time:c.time??null,cached:true };
    triResByDev.set(norm, res);
    // draw marker with proper color based on staleness
    placeTriMarker(d, i, c.tlat, c.tlon, c.rms ?? 0, res);
  });
  updateDevicesVisibility();
  renderTriInfoList(false);
}

function init(){
  if(!window.WorkspaceSync?.isReady() && !jget('favoriot-devices-v4', []).length && !jget('beacons-v1', []).length){
    const moved = tryMigrateLegacySameOrigin();
    if(moved>0) showErr(`Recovered ${moved} legacy entries from same-origin storage.`);
  }

  const cfg=CFG();
  document.getElementById('favApiKey').value=(cfg.apiKey||'');
  document.getElementById('favUser').value=(cfg.username||'');
  document.getElementById('refreshSec').value=Math.max(2, Math.round((cfg.refreshMs||8000)/1000));
  document.getElementById('authHeader').value=(cfg.authHeader||'apikey');
  document.getElementById('corsProxy').value=(cfg.proxy||'');
  const liveToggle=document.getElementById('enableLiveSocket'); if(liveToggle) liveToggle.checked=(cfg.liveSocket!==false);

  if(!(cfg.apiKey||'').trim()){
    showErr('No Favoriot Read API Key set — open Settings and paste your key, then click “Save settings”.');
  }

  drawBeacons(); renderBeaconList(); rebuildRecord(); renderVisibilityAndLists();
  applyRangeScopeUI();
  rebuildScanSourceSelect();
  restoreTriMarkersFromCache();

  if(!document.getElementById('showBeacons').checked && map.hasLayer(beaconLayer)) map.removeLayer(beaconLayer);
  fetchAllDevices(); startLiveTransport(); setPeriod();
  // Offline/sleeping state must update even when the server stops sending data.
  if(!window.__trolleyStatusTimer)window.__trolleyStatusTimer=setInterval(refreshHealthDots,5000);
}
/* Reconcile Supabase changes without rebuilding the Leaflet map or clearing local view options. */
let previousSharedDevices = new Set();
function refreshSharedWorkspaceUI(changedKeys){
  const changed = new Set(changedKeys || []);
  const devicesChanged = changed.has(LS_KEYS.devices);
  const beaconsChanged = changed.has(LS_KEYS.beacons);
  const favoriotChanged = changed.has(LS_KEYS.favoriot);

  if(devicesChanged){
    const all = loadDevices();
    const newSet = new Set(all.map(d=>ensureDevId(d.id)));
    // Add newly registered trackers to the per-browser visible list by default.
    if(previousSharedDevices.size){
      const vis=visibleSet(); let added=false;
      for(const id of newSet) if(!previousSharedDevices.has(id)){vis.add(id);added=true;}
      if(added) saveVisibleSet(vis);
    }
    previousSharedDevices = newSet;
    // Do not display deleted trackers from old local caches.
    for(const [rawId,marker] of devMarkers){
      if(!all.some(d=>d.id===rawId)){devicesLayer.removeLayer(marker);devMarkers.delete(rawId);}
    }
    for(const [rawId,marker] of triMarkers){
      if(!all.some(d=>d.id===rawId)){triLayer.removeLayer(marker);triMarkers.delete(rawId);}
    }
    rebuildRecord();rebuildScanSourceSelect();renderVisibilityAndLists();
  }
  if(beaconsChanged){
    drawBeacons();renderBeaconList(document.getElementById('beaconSearch')?.value||'');
    // On anchor edits, the next position is recalculated from the latest scans.
    for(const [id,result] of triResByDev){
      if(result?.boundaryVerified && !validBoundedCache({...result,lat:result.tlat,lon:result.tlon})){
        triResByDev.delete(id);
      }
    }
    const devs=loadDevices();
    devs.forEach((dev,idx)=>{
      const normId=ensureDevId(dev.id);
      const scans=lastScanByDev.get(normId);
      if(Array.isArray(scans)&&scans.length){
        drawRangesForDevice(normId,scans);
        if(document.getElementById('enableTri2')?.checked) computeTrilatForDevice(dev,idx,null,null,scans);
      }
    });
  }
  if(favoriotChanged){
    const cfg=CFG();
    document.getElementById('favApiKey').value=cfg.apiKey||'';
    document.getElementById('favUser').value=cfg.username||'';
    document.getElementById('refreshSec').value=Math.max(2,Math.round((cfg.refreshMs||8000)/1000));
    document.getElementById('authHeader').value=cfg.authHeader||'apikey';
    document.getElementById('corsProxy').value=cfg.proxy||'';
    document.getElementById('enableLiveSocket').checked=cfg.liveSocket!==false;
    stopTimer();stopLiveSocket({silent:true});startLiveTransport();fetchAllDevices();
  }
  if(devicesChanged||beaconsChanged){
    renderTriInfoList(false);updateDevicesVisibility();refreshHealthDots();
  }
}
function cleanUpOnSignOut(){
  try{stopTimer();stopLiveSocket({silent:true});}catch(_){}
  devMarkers.forEach(m=>devicesLayer.removeLayer(m));devMarkers.clear();
  triMarkers.forEach(m=>triLayer.removeLayer(m));triMarkers.clear();
  beaconLayer.clearLayers();rangeByDev.forEach(g=>g.remove());rangeByDev.clear();
  lastScanByDev.clear();triResByDev.clear();
  renderTriInfoList(false);
}
if(!window.WorkspaceSync){
  throw new Error('workspace-sync.js must load before tracking.js');
}
window.WorkspaceSync.start({
  onReady:()=>{
    init();
    previousSharedDevices=new Set(loadDevices().map(d=>ensureDevId(d.id)));
  },
  onChange:refreshSharedWorkspaceUI,
  onLogout:cleanUpOnSignOut
});

/* === BEGIN: Full Fix Patch (Active_Time_Sec timing, no-trilat label, persist last position) === */
(function(){
  // ------------------------------
  // 0) Helpers and shared caches
  // ------------------------------
  window.activeSecByDev = window.activeSecByDev || new Map();

  // Parse Active_Time_Sec from JSON or free-form string
  function extractActiveSec(data, scanStr){
    try{
      if (data && typeof data === 'object'){
        for (const [k,v] of Object.entries(data)){
          const lk = String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
          if (lk.includes('active') && (lk.includes('sec') || lk.includes('time'))
               || lk.endsWith('activetimesec') || lk.endsWith('activesec') || lk==='activetimesec'){
            const m = String(v).match(/([-+]?\d+(?:\.\d+)?)/);
            if (m){ const n = parseFloat(m[1]); if (Number.isFinite(n) && n>0) return Math.round(n); }
          }
        }
      }
      const s = String(scanStr||'');
      let m = s.match(/active[_\s-]*time[_\s-]*sec\s*[:=]\s*(\d+)/i)
            || s.match(/\bactive\s*[:=]\s*(\d+)\s*s\b/i)
            || s.match(/\bactive[_\s-]*sec\s*[:=]\s*(\d+)/i);
      if (m){ const n = parseFloat(m[1]); if (Number.isFinite(n) && n>0) return Math.round(n); }
    }catch(e){}
    return null;
  }

  // Last-known-good trilat cache (RAM + localStorage)
  const LS_KEY = 'alps-last-good-pos';
  try{
    window.lastGoodPosByDev = window.lastGoodPosByDev || new Map();
    const raw = localStorage.getItem(LS_KEY);
    if (raw && !lastGoodPosByDev.size){
      const o = JSON.parse(raw);
      Object.entries(o).forEach(([k,v])=>{
        if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) lastGoodPosByDev.set(k, v);
      });
    }
  }catch(_){}

  function saveLastGood(){
    try{
      const o = {};
      lastGoodPosByDev.forEach((v,k)=>{ o[k]=v; });
      localStorage.setItem(LS_KEY, JSON.stringify(o));
    }catch(_){}
  }

  function trilatIsValid(res, need){
    if (!res) return false;
    const used = Number.isFinite(res.used) ? res.used : 0;
    const tlat = Number(res.tlat), tlon = Number(res.tlon);
    return Number.isFinite(tlat) && Number.isFinite(tlon) && used >= need && validBoundedCache({...res,lat:tlat,lon:tlon});
  }

  function applyFallback(normId, need){
    const cache = window.lastGoodPosByDev && window.lastGoodPosByDev.get(normId);
    if (!cache || !validBoundedCache(cache)) return false;
    if (typeof triResByDev!=='undefined'){
      const prev = triResByDev.get(normId) || {};
      triResByDev.set(normId, { ...prev,tlat:cache.lat,tlon:cache.lon,used:Math.max(cache.used||need,need),cached:true,boundaryVerified:true,anchors:cache.anchors,rangeConflict:!!cache.rangeConflict,maxRangeMiss:cache.maxRangeMiss||0 });
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------
  // 1) Wrap fetchOneDeviceLatest ONCE to add all enhancements
  // ----------------------------------------------------------
  if (typeof window.fetchOneDeviceLatest === 'function' && !window.__wrappedFetchOneDeviceLatest){
    const __origFetch = window.fetchOneDeviceLatest;
    window.__wrappedFetchOneDeviceLatest = true;

    window.fetchOneDeviceLatest = async function(dev, idx){
      const need = (typeof CONFIG!=='undefined' && Number.isFinite(CONFIG.trilatMinBeacons)) ? CONFIG.trilatMinBeacons : 3;
      const normId = (typeof ensureDevId==='function') ? ensureDevId(dev.id) : (dev.id||'').trim();
      const before = (typeof triResByDev!=='undefined') ? triResByDev.get(normId) : null;

      try{
        const r = await __origFetch(dev, idx);

        // A1) Ensure last sync time exists (if server didn't provide time)
        try{
          if (typeof lastSeenByDev !== 'undefined'){
            const cur = lastSeenByDev.get(normId);
            if (!(Number.isFinite(cur))) lastSeenByDev.set(normId, Date.now());
          }
        }catch(_){}

        // A2) Extract Active_Time_Sec from the same endpoint (if helpers exist)
        try{
          if (typeof streamsUrl==='function' && typeof headersFor==='function' && typeof fetchFavoriot==='function'){
            const url = streamsUrl(dev);
            const headers = headersFor();
            let resp = await fetchFavoriot(url, headers, {attempt:0, viaDefaultProxy:false});
            let txt = await resp.text(); let j=null; try{ j=JSON.parse(txt); }catch{}
            if (!resp.ok){
              try{
                await new Promise(res=>setTimeout(res, 300));
                resp = await fetchFavoriot(url, headers, {attempt:0, viaDefaultProxy:false});
                txt = await resp.text(); j=null; try{ j=JSON.parse(txt); }catch{}
              }catch(_){}
            }
            // Favoriot-like "latest record"
            let last = null;
            if (j) {
              if (Array.isArray(j.data) && j.data.length) last = j.data[0];
              else if (Array.isArray(j.results) && j.results.length) last = j.results[0];
              else if (j.last) last = j.last;
            }
            const data = last?.data || {};
            const scan = data?.Beacon_Triangulation || data?.Beacon || null;

            const activeSec = extractActiveSec(data, scan);
            if (activeSec!=null) window.activeSecByDev.set(normId, activeSec);
          }
        }catch(_){}

        // A3) Persist last good trilat; if we lost it, revert to last-known-good
        try{
          const after = (typeof triResByDev!=='undefined') ? triResByDev.get(normId) : null;
          if (trilatIsValid(after, need)){
            window.lastGoodPosByDev.set(normId, {
              lat: Number(after.tlat), lon: Number(after.tlon),
              used: Number(after.used)||need, ts: Date.now(),boundaryVerified:true,anchors:after.anchors,rangeConflict:!!after.rangeConflict,maxRangeMiss:after.maxRangeMiss||0
            });
            saveLastGood();
          } else {
            const usedFallback = applyFallback(normId, need);
            if (!usedFallback && trilatIsValid(before, need)){
              if (typeof triResByDev!=='undefined') triResByDev.set(normId, before);
            }
          }
        }catch(_){}

        return r;
      }catch(e){
        // On fetch error: keep marker on map with last known position
        try{
          if (!applyFallback(normId, need) && trilatIsValid(before, need)){
            if (typeof triResByDev!=='undefined') triResByDev.set(normId, before);
          }
        }catch(_){}
        console.warn('Fetch error preserved marker for', normId, e);
        return; // don't rethrow, keep UI alive
      }
    };
  }

  // -----------------------------------------------------------------
  // 2) Override computeStatus to pure time-based state (as requested)
  // -----------------------------------------------------------------
  if (typeof window.computeStatus === 'function' && !window.__overrodeComputeStatus){
    window.__overrodeComputeStatus = true;
    window.computeStatus = function(normId){
      const last=lastSeenByDev.get(normId);
      const delta=last?Math.max(0,Date.now()-last):Infinity;
      const sleepSec=sleepSecByDev.get(normId)??null;
      // No Sleep_Time_Sec on live tracker: green until 90 s without a packet,
      // then red. This avoids an amber flicker between normal 30 s updates.
      if(sleepSec==null){
        const online=Number.isFinite(delta)&&delta<=LIVE_OFFLINE_MS;
        return {online,sleeping:false,offline:!online,delta,sleepSec:null};
      }
      const activeSec=activeSecByDev.get(normId)??null;
      const graceMs=activeSec?activeSec*1000:SLEEP_GRACE_MS;
      const sleepMs=Math.max(sleepSec*1000,graceMs);
      const sleeping=delta>graceMs&&delta<=sleepMs;
      const offline=delta>sleepMs;
      return {online:!offline&&!sleeping,sleeping,offline,delta,sleepSec};
    };
  }

  // -----------------------------------------------------------------------------------
  // 3) Badge tweak: Online + fewer than min beacons => "Online — no trilateration"
  // -----------------------------------------------------------------------------------
  if (typeof window.refreshHealthDots === 'function' && !window.__wrappedRefreshHealthDots){
    const _origRefresh = window.refreshHealthDots;
    window.__wrappedRefreshHealthDots = true;

    window.refreshHealthDots = function(){
      _origRefresh();
      try{
        const list = (typeof loadDevices==='function') ? loadDevices() : [];
        const need = (typeof CONFIG!=='undefined' && Number.isFinite(CONFIG.trilatMinBeacons)) ? CONFIG.trilatMinBeacons : 3;
        list.forEach((d,i)=>{
          const norm = (typeof ensureDevId==='function') ? ensureDevId(d.id) : (d.id||'').trim();
          const st = (typeof computeStatus==='function') ? computeStatus(norm) : {online:false};
          if(st && st.online){
            const tri = (typeof triResByDev!=='undefined') ? triResByDev.get(norm) : null;
            const used = tri && Number.isFinite(tri.used) ? tri.used : 0;
            if (used < need){
              const lbl = document.getElementById(`ol-${i}`);
              if (lbl){
                lbl.textContent = 'Online — no trilateration';
                // keep Online color
                lbl.className='badge ms-2 bg-success-subtle text-success-emphasis';
              }
            }
          }
        });
      }catch(_){}
    };
  }

  // -------------------------------------------------------------------
  // 4) On initial load, show last-known-good positions if none present
  // -------------------------------------------------------------------
  try{
    if (typeof loadDevices==='function' && typeof triResByDev!=='undefined'){
      const list = loadDevices() || [];
      const need = (typeof CONFIG!=='undefined' && Number.isFinite(CONFIG.trilatMinBeacons)) ? CONFIG.trilatMinBeacons : 3;
      list.forEach(d=>{
        const normId = (typeof ensureDevId==='function') ? ensureDevId(d.id) : (d.id||'').trim();
        const cur = triResByDev.get(normId);
        if (!trilatIsValid(cur, need)) applyFallback(normId, need);
      });
    }
  }catch(_){}
})();
/* === END: Full Fix Patch === */

/* --- Map Change Stabilizer & Dedupe --- */
(function(){
  function debounce(fn, ms){
    let t=null; return function(){ const ctx=this, args=arguments;
      clearTimeout(t); t=setTimeout(()=>fn.apply(ctx,args), ms);
    };
  }
  function ready(fn){
    if(document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function(){
    try{
      if(!window.map) return;
      function dedupeCircles(){
        try{
          const seen = new Set();
          map.eachLayer(l=>{
            const isCM = (typeof L.CircleMarker !== 'undefined' && l instanceof L.CircleMarker);
            const isC  = (typeof L.Circle !== 'undefined' && l instanceof L.Circle);
            if(!(isCM || isC)) return;
            const ll = l.getLatLng ? l.getLatLng() : null;
            if(!ll) return;
            const r  = (typeof l.getRadius === 'function') ? l.getRadius() : -1;
            const col = (l.options && l.options.color) ? l.options.color : '';
            const key = ll.lat.toFixed(7)+","+ll.lng.toFixed(7)+"|"+r+"|"+col+"|"+(isCM?'m':'c');
            if(seen.has(key)){
              try{ map.removeLayer(l); }catch(_){}
            }else{
              seen.add(key);
            }
          });
        }catch(_){}
      }
      const heal = debounce(function(){
        try{ map.invalidateSize(false); }catch(_){}
        setTimeout(dedupeCircles, 80);
      }, 30);
      map.on('baselayerchange', heal);
      map.on('layeradd', heal);
      setTimeout(()=>{ heal(); dedupeCircles(); }, 200);
    }catch(_){}
  });
  try {
    if (!window.__ALMA_MAP_GUARD__) window.__ALMA_MAP_GUARD__ = true;
    else console.warn('Map initialization was triggered again; consider guarding init.');
  } catch(_){}
})();
