import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<div style="padding:40px;font-family:system-ui;color:#dc2626;text-align:center"><h2>Yapılandırma Hatası</h2><p>VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY .env dosyasında tanımlı olmalı.</p></div>'
  throw new Error('Missing Supabase env vars')
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const TRACKER_SERVICE = 0xFEF5
const BATTERY_SERVICE = 0x180F
const BATTERY_CHAR = 0x2A19
const IMMEDIATE_ALERT_SERVICE = 0x1802
const ALERT_LEVEL_CHAR = 0x2A06
const BUTTON_SERVICE_UUID = '6d696368-616c-206f-6c65-737a637a796b'
const BUTTON_CHAR_UUID = '8082caa8-41a6-4021-91c6-56f9b954cc34'
const LEGACY_BUTTON_CHAR_UUID = '66696c69-7020-726f-6d61-6e6f77736b69'

const ALERT_NONE = 0x00
const ALERT_MILD = 0x01
const ALERT_HIGH = 0x02

const MEASURED_POWER = -59
const N_PATH_LOSS = 2.0

const TABLE = 'tracker_devices'
const ICONS = ['🔑','🎒','👜','💼','🚗','🐱','🐶','📱','💳','🧸']

const state = {
  page: 'login',
  currentUser: null,
  devices: [],
  selectedDeviceId: null,
  connecting: false,
  connectError: null,
  findPhoneActive: false,
  ringingDeviceId: null,
  editingDevice: false,
  editName: '',
  editIcon: '',
  envSupport: { ble: true, brave: false, secure: true, message: '' }
}
const bleData = {}
const gattQueue = {}

function enqueueGatt(deviceId, op) {
  const prev = gattQueue[deviceId] || Promise.resolve()
  const next = prev.then(() => op()).catch(e => { console.error('[GATT]', e); throw e })
  gattQueue[deviceId] = next.catch(() => {})
  return next
}

async function detectEnvironment() {
  const env = { ble: true, brave: false, secure: true, message: '' }
  if (window.isSecureContext === false) {
    env.secure = false
    env.message = 'Sayfa HTTPS üzerinde açılmalı. Web Bluetooth yalnızca güvenli bağlamda çalışır.'
  }
  if (!('bluetooth' in navigator)) {
    env.ble = false
    if (!env.message) env.message = 'Web Bluetooth bu tarayıcıda desteklenmiyor. Android Chrome veya Edge kullanın.'
  }
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      const isBrave = await navigator.brave.isBrave()
      if (isBrave) {
        env.brave = true
        if (!env.ble) {
          env.message = 'Brave Shields Web Bluetooth\'u engelliyor olabilir. brave://flags/#brave-web-bluetooth-api ayarını etkinleştirin.'
        }
      }
    }
  } catch (e) {}
  return env
}

function getSettings() {
  const uid = state.currentUser?.id || 'anon'
  return JSON.parse(localStorage.getItem('tracker_settings_' + uid) || '{"notifications":true,"distanceAlert":true,"distanceThreshold":15,"soundOnFind":true}')
}

function saveSettings(s) {
  const uid = state.currentUser?.id || 'anon'
  localStorage.setItem('tracker_settings_' + uid, JSON.stringify(s))
}

function getUserDisplayName() {
  return state.currentUser?.user_metadata?.name || state.currentUser?.email || ''
}

async function getCurrentLocation() {
  if (!navigator.geolocation) return null
  try {
    const pos = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, enableHighAccuracy: true, maximumAge: 15000 })
    })
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, time: Date.now() }
  } catch (e) {
    return null
  }
}

async function loadDevices() {
  if (!state.currentUser) { state.devices = []; return }
  const { data, error } = await sb.from(TABLE).select('*').eq('user_id', state.currentUser.id)
  if (error) { console.error(error); return }
  state.devices = (data || []).map(d => ({
    id: d.device_id,
    name: d.device_name,
    icon: d.icon || '🔑',
    battery: d.battery_level,
    lastSeen: d.last_seen ? new Date(d.last_seen).getTime() : null,
    lastLocation: (d.last_known_lat != null && d.last_known_lng != null)
      ? { lat: d.last_known_lat, lng: d.last_known_lng, time: d.last_seen ? new Date(d.last_seen).getTime() : null }
      : null,
    connected: false,
    rssi: null,
    distance: null
  }))
}

async function syncDevice(d) {
  if (!state.currentUser) return
  const { error } = await sb.from(TABLE).update({
    device_name: d.name,
    icon: d.icon || '🔑',
    battery_level: d.battery,
    last_known_lat: d.lastLocation?.lat ?? null,
    last_known_lng: d.lastLocation?.lng ?? null,
    last_seen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null
  })
    .eq('user_id', state.currentUser.id)
    .eq('device_id', d.id)
  if (error) console.error(error)
}

async function logEvent(dev, reason) {
  if (!dev || !state.currentUser) return
  const loc = await getCurrentLocation()
  if (loc) dev.lastLocation = loc
  dev.lastSeen = Date.now()
  await syncDevice(dev)
  render()
}

function rssiToDistance(rssi) {
  if (rssi == null || !isFinite(rssi)) return null
  const d = Math.pow(10, (MEASURED_POWER - rssi) / (10 * N_PATH_LOSS))
  return Math.max(0.1, Math.min(100, d))
}

function distanceToProximity(distance, rssi) {
  if (distance == null) return { label: 'Bilinmiyor', m: '—', pct: 0, color: '#94a3b8', dist: null }
  const pct = Math.max(5, Math.min(100, 100 - Math.log10(distance + 1) * 50))
  let label, color
  if (distance < 1.5) { label = 'Çok yakın'; color = '#10b981' }
  else if (distance < 4) { label = 'Yakın'; color = '#06b6d4' }
  else if (distance < 10) { label = 'Orta'; color = '#f59e0b' }
  else { label = 'Uzak'; color = '#ef4444' }
  const m = distance < 10 ? distance.toFixed(1) + ' m' : Math.round(distance) + ' m'
  return { label, m, pct, color, dist: distance, rssi }
}

function playFindPhone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const freqs = [1760, 2093]
    for (let i = 0; i < 8; i++) {
      freqs.forEach((f, j) => {
        const o = ctx.createOscillator(), g = ctx.createGain()
        o.type = 'square'
        o.connect(g); g.connect(ctx.destination)
        o.frequency.value = f
        const t0 = ctx.currentTime + i * 0.3 + j * 0.12
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18)
        o.start(t0)
        o.stop(t0 + 0.2)
      })
    }
    state.findPhoneActive = true; render()
    setTimeout(() => { state.findPhoneActive = false; render() }, 3000)
  } catch (e) {}
}

async function startAdvertisementWatch(dev, btDevice) {
  if (typeof btDevice.watchAdvertisements !== 'function') return
  try {
    await btDevice.watchAdvertisements()
    btDevice.addEventListener('advertisementreceived', (e) => {
      if (typeof e.rssi !== 'number') return
      dev.rssi = e.rssi
      dev.distance = rssiToDistance(e.rssi)
      render()
    })
  } catch (e) {}
}

async function attachButtonListener(dev, service, charUuid) {
  try {
    const ch = await service.getCharacteristic(charUuid)
    await ch.startNotifications()
    ch.addEventListener('characteristicvaluechanged', async () => {
      if (getSettings().soundOnFind) playFindPhone()
      await logEvent(dev, 'button')
    })
    return ch
  } catch (e) {
    return null
  }
}

async function addDevice() {
  state.connectError = null

  if (!navigator.bluetooth) {
    const env = await detectEnvironment()
    state.envSupport = env
    state.connectError = env.message || 'Bluetooth bu tarayıcıda desteklenmiyor.'
    render()
    return
  }

  let btDevice
  try {
    btDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [TRACKER_SERVICE] }],
      optionalServices: [BATTERY_SERVICE, IMMEDIATE_ALERT_SERVICE, BUTTON_SERVICE_UUID]
    })
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'AbortError') return
    let msg = e.name + ': ' + e.message
    if (e.name === 'SecurityError') msg = 'Güvenlik hatası. Sayfa HTTPS üzerinde açık olmalı ve Bluetooth izni verilmeli.'
    else if (e.name === 'NotSupportedError') msg = 'BLE Desteklenmiyor. Brave kullanıyorsanız Shields kapalı olmalı ve brave://flags/#brave-web-bluetooth-api etkin olmalı.'
    state.connectError = msg
    render()
    return
  }

  state.connecting = true
  render()

  try {
    const server = await btDevice.gatt.connect()

    let alertChar = null
    try {
      const alertSvc = await server.getPrimaryService(IMMEDIATE_ALERT_SERVICE)
      alertChar = await alertSvc.getCharacteristic(ALERT_LEVEL_CHAR)
    } catch (e) {}

    let battery = null
    try {
      const bs = await server.getPrimaryService(BATTERY_SERVICE)
      const bc = await bs.getCharacteristic(BATTERY_CHAR)
      const bv = await bc.readValue()
      battery = bv.getUint8(0)
    } catch (e) {}

    const id = btDevice.id || 'tag-' + Date.now()
    const existing = state.devices.find(d => d.id === id)

    const loc = await getCurrentLocation()

    const dev = {
      id,
      name: existing ? existing.name : (btDevice.name || 'Smart Tag'),
      icon: existing ? existing.icon : '🔑',
      battery,
      connected: true,
      rssi: null,
      distance: null,
      lastSeen: Date.now(),
      lastLocation: loc || existing?.lastLocation || null
    }

    bleData[id] = { alertChar, server, btDevice, buttonChar: null }

    try {
      const btnSvc = await server.getPrimaryService(BUTTON_SERVICE_UUID)
      let btnChar = await attachButtonListener(dev, btnSvc, BUTTON_CHAR_UUID)
      if (!btnChar) btnChar = await attachButtonListener(dev, btnSvc, LEGACY_BUTTON_CHAR_UUID)
      bleData[id].buttonChar = btnChar
    } catch (e) {}

    btDevice.addEventListener('gattserverdisconnected', async () => {
      const d = state.devices.find(x => x.id === id)
      if (d) { d.connected = false; d.rssi = null; d.distance = null; d.lastSeen = Date.now() }
      delete bleData[id]
      delete gattQueue[id]
      const discLoc = await getCurrentLocation()
      if (d && discLoc) d.lastLocation = discLoc
      if (d) await syncDevice(d)
      if (getSettings().notifications && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Smart BT Tracker', { body: dev.name + ' bağlantısı kesildi!' })
      }
      render()
    })

    const { error } = await sb.from(TABLE).upsert({
      user_id: state.currentUser.id,
      device_id: id,
      device_name: dev.name,
      icon: dev.icon,
      battery_level: dev.battery,
      last_known_lat: dev.lastLocation?.lat ?? null,
      last_known_lng: dev.lastLocation?.lng ?? null,
      last_seen: new Date(dev.lastSeen).toISOString()
    }, { onConflict: 'user_id,device_id' })

    if (error) console.error(error)

    if (existing) Object.assign(existing, dev)
    else state.devices.push(dev)

    startAdvertisementWatch(existing || dev, btDevice)
  } catch (e) {
    state.connectError = 'Bağlantı hatası: ' + e.message
  }

  state.connecting = false
  render()
}

async function triggerAlert(deviceId, level = 'high') {
  const ble = bleData[deviceId]
  if (!ble) {
    state.connectError = 'Etiket bağlı değil.'
    render()
    return
  }
  if (!ble.server || !ble.server.connected) {
    state.connectError = 'GATT bağlantısı kopmuş. Yeniden bağlanın.'
    render()
    return
  }
  if (!ble.alertChar) {
    state.connectError = 'Immediate Alert karakteristiği bulunamadı.'
    render()
    return
  }

  const byte = level === 'mild' ? ALERT_MILD : level === 'none' ? ALERT_NONE : ALERT_HIGH
  state.ringingDeviceId = deviceId
  render()

  try {
    await enqueueGatt(deviceId, async () => {
      if (typeof ble.alertChar.writeValueWithoutResponse === 'function') {
        await ble.alertChar.writeValueWithoutResponse(new Uint8Array([byte]))
      } else {
        await ble.alertChar.writeValue(new Uint8Array([byte]))
      }
    })
    const dev = state.devices.find(x => x.id === deviceId)
    if (dev) await logEvent(dev, 'alert')
  } catch (e) {
    state.connectError = 'Alarm komutu gönderilemedi: ' + e.message
  }

  setTimeout(async () => {
    if (byte !== ALERT_NONE && ble.alertChar && ble.server && ble.server.connected) {
      try {
        await enqueueGatt(deviceId, async () => {
          if (typeof ble.alertChar.writeValueWithoutResponse === 'function') {
            await ble.alertChar.writeValueWithoutResponse(new Uint8Array([ALERT_NONE]))
          } else {
            await ble.alertChar.writeValue(new Uint8Array([ALERT_NONE]))
          }
        })
      } catch (e) {}
    }
    state.ringingDeviceId = null
    render()
  }, 3500)
}

function disconnectDevice(deviceId) {
  const ble = bleData[deviceId]
  if (ble && ble.server && ble.server.connected) ble.server.disconnect()
}

async function deleteDevice(deviceId) {
  disconnectDevice(deviceId)
  const { error } = await sb.from(TABLE).delete()
    .eq('user_id', state.currentUser.id)
    .eq('device_id', deviceId)
  if (error) console.error(error)
  state.devices = state.devices.filter(d => d.id !== deviceId)
  delete bleData[deviceId]
  delete gattQueue[deviceId]
  state.page = 'home'
  state.selectedDeviceId = null
  render()
}

function render() {
  const app = document.getElementById('app')
  if (state.findPhoneActive) {
    app.innerHTML = `
      <div class="overlay">
        <div style="font-size:72px;margin-bottom:16px;animation:shake 0.3s infinite">📱</div>
        <div style="font-size:22px;font-weight:700;color:#fff">Telefonunuz burada!</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:6px">Etiket butonuna basıldı</div>
        <button class="btn btn-primary" style="width:auto;padding:12px 32px;margin-top:24px" onclick="window._kt.findPhoneDismiss()">Tamam</button>
      </div>`
    return
  }

  if (!state.currentUser) {
    if (state.page === 'register') return renderRegister(app)
    return renderLogin(app)
  }
  if (state.page === 'settings') return renderSettings(app)
  if (state.page === 'detail' && state.selectedDeviceId) return renderDetail(app)
  renderHome(app)
}

function renderEnvWarning() {
  const env = state.envSupport
  if (env.ble && env.secure) return ''
  return `
    <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:12px 14px;margin:12px 16px;font-size:13px;color:#dc2626;display:flex;align-items:flex-start;gap:8px">
      <span style="font-size:16px;flex-shrink:0">⚠️</span>
      <span>${env.message}</span>
    </div>`
}

function renderLogin(app) {
  app.innerHTML = `
    <div style="background:#1a1a2e;color:#fff;padding:40px 24px 30px;text-align:center">
      <div style="width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 12px">📍</div>
      <div class="logo">Smart BT Tracker</div>
      <div class="logo-sub">Eşyalarınızı asla kaybetmeyin</div>
    </div>
    <div class="card fade-in" style="margin-top:24px">
      <div style="font-size:18px;font-weight:600;margin-bottom:20px;color:#1a1a2e">Giriş Yap</div>
      <input class="input" id="login-email" placeholder="E-posta" type="email" autocomplete="email">
      <input class="input" id="login-pass" placeholder="Şifre" type="password" autocomplete="current-password">
      <div id="login-err" style="color:#dc2626;font-size:13px;margin-bottom:12px;display:none"></div>
      <button class="btn btn-primary" id="login-btn" onclick="window._kt.doLogin()">Giriş Yap</button>
      <div class="divider"></div>
      <button class="btn btn-secondary" onclick="window._kt.goTo('register')">Hesabınız yok mu? Kayıt olun</button>
    </div>`
  setTimeout(() => {
    const p = document.getElementById('login-pass')
    if (p) p.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
  }, 50)
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim()
  const pass = document.getElementById('login-pass').value
  const err = document.getElementById('login-err')
  const btn = document.getElementById('login-btn')
  err.style.display = 'none'
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>'

  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass })

  if (error) {
    err.textContent = error.message === 'Invalid login credentials' ? 'E-posta veya şifre hatalı' : error.message
    err.style.display = 'block'
    btn.disabled = false
    btn.textContent = 'Giriş Yap'
    return
  }

  state.currentUser = data.user
  state.page = 'home'
  await loadDevices()
  render()
}

function renderRegister(app) {
  app.innerHTML = `
    <div style="background:#1a1a2e;color:#fff;padding:40px 24px 30px;text-align:center">
      <div style="width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 12px">📍</div>
      <div class="logo">Smart BT Tracker</div>
      <div class="logo-sub">Yeni hesap oluşturun</div>
    </div>
    <div class="card fade-in" style="margin-top:24px">
      <div style="font-size:18px;font-weight:600;margin-bottom:20px;color:#1a1a2e">Kayıt Ol</div>
      <input class="input" id="reg-name" placeholder="Adınız">
      <input class="input" id="reg-email" placeholder="E-posta" type="email">
      <input class="input" id="reg-pass" placeholder="Şifre" type="password">
      <input class="input" id="reg-pass2" placeholder="Şifre tekrar" type="password">
      <div id="reg-err" style="color:#dc2626;font-size:13px;margin-bottom:12px;display:none"></div>
      <button class="btn btn-primary" id="reg-btn" onclick="window._kt.doRegister()">Kayıt Ol</button>
      <div class="divider"></div>
      <button class="btn btn-secondary" onclick="window._kt.goTo('login')">Zaten hesabınız var mı? Giriş yapın</button>
    </div>`
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim()
  const email = document.getElementById('reg-email').value.trim()
  const pass = document.getElementById('reg-pass').value
  const pass2 = document.getElementById('reg-pass2').value
  const err = document.getElementById('reg-err')
  const btn = document.getElementById('reg-btn')

  err.style.display = 'none'
  if (!name) { err.textContent = 'İsim girin'; err.style.display = 'block'; return }
  if (!email.includes('@')) { err.textContent = 'Geçerli e-posta girin'; err.style.display = 'block'; return }
  if (pass.length < 6) { err.textContent = 'Şifre en az 6 karakter olmalı'; err.style.display = 'block'; return }
  if (pass !== pass2) { err.textContent = 'Şifreler eşleşmiyor'; err.style.display = 'block'; return }

  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>'

  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { name } } })

  if (error) {
    err.textContent = error.message
    err.style.display = 'block'
    btn.disabled = false
    btn.textContent = 'Kayıt Ol'
    return
  }

  state.currentUser = data.user
  state.page = 'home'
  await loadDevices()
  render()
}

function renderHome(app) {
  const onlineCount = state.devices.filter(d => d.connected).length
  const lowBat = state.devices.filter(d => d.battery != null && d.battery < 20).length

  let deviceCards = ''
  if (state.devices.length === 0) {
    deviceCards = `
      <div style="text-align:center;padding:40px 20px;color:#9ca3af">
        <div style="font-size:48px;margin-bottom:12px">📍</div>
        <div style="font-size:16px;font-weight:600;color:#6b7280">Henüz etiket eklenmedi</div>
        <div style="font-size:13px;margin-top:6px">Takip cihazınızı eklemek için aşağıdaki butona basın</div>
      </div>`
  } else {
    state.devices.forEach(d => {
      const prox = distanceToProximity(d.distance, d.rssi)
      const isOn = d.connected
      const ringing = state.ringingDeviceId === d.id
      deviceCards += `
        <div class="device-card fade-in">
          <div onclick="window._kt.openDetail('${d.id}')" style="cursor:pointer">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div style="display:flex;align-items:center;gap:12px">
                <div class="icon-box" style="background:${isOn ? '#ecfdf5' : '#f3f4f6'}">${d.icon || '🔑'}</div>
                <div>
                  <div style="font-size:16px;font-weight:600;color:#1a1a2e">${d.name}</div>
                  <div style="font-size:12px;color:${isOn ? '#10b981' : '#9ca3af'};margin-top:2px;display:flex;align-items:center;gap:4px">
                    <span class="status-dot" style="background:${isOn ? '#10b981' : '#d1d5db'}"></span>
                    ${isOn ? 'Bağlı' : 'Son: ' + timeAgo(d.lastSeen)}
                  </div>
                </div>
              </div>
              ${d.battery != null ? `
                <div style="display:flex;align-items:center;gap:4px;background:${d.battery < 20 ? '#fef2f2' : '#f0fdf4'};padding:4px 10px;border-radius:8px">
                  <span style="font-size:13px">${d.battery < 20 ? '🪫' : '🔋'}</span>
                  <span style="font-size:12px;font-weight:600;color:${d.battery < 20 ? '#dc2626' : '#16a34a'}">${d.battery}%</span>
                </div>` : ''}
            </div>
            ${isOn ? `
              <div style="margin-top:14px">
                <div style="display:flex;justify-content:space-between;margin-bottom:6px">
                  <span style="font-size:12px;color:#6b7280">Yakınlık</span>
                  <span style="font-size:12px;font-weight:600;color:${prox.color}" class="prox-text">${prox.label} · ${prox.m}</span>
                </div>
                <div class="prox-bar"><div class="prox-fill smooth" style="width:${prox.pct}%;background:${prox.color}"></div></div>
              </div>` : ''}
            ${d.lastLocation ? `
              <div style="margin-top:12px;padding:10px 12px;background:#fafaf8;border-radius:10px;font-size:12px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                <span>📍 ${d.lastLocation.lat.toFixed(4)}, ${d.lastLocation.lng.toFixed(4)} · ${timeAgo(d.lastLocation.time || d.lastSeen)}</span>
                <a href="https://www.google.com/maps?q=${d.lastLocation.lat},${d.lastLocation.lng}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#4f46e5;text-decoration:none;font-weight:600">Harita →</a>
              </div>` : ''}
          </div>
          ${isOn ? `
            <button class="btn ring-btn ${ringing ? 'ringing' : ''}" onclick="event.stopPropagation();window._kt.triggerAlert('${d.id}','high')" ${ringing ? 'disabled' : ''}>
              ${ringing ? '<span class="spinner"></span> Etiket Çalıyor...' : '🔔 Etiketi Çaldır'}
            </button>` : ''}
        </div>`
    })
  }

  app.innerHTML = `
    <div class="header">
      <div>
        <div class="logo">📍 Smart BT Tracker</div>
        <div class="logo-sub">Merhaba, ${getUserDisplayName()}</div>
      </div>
      <button class="settings-btn" onclick="window._kt.goTo('settings')">⚙️</button>
    </div>
    ${renderEnvWarning()}
    <div style="display:flex;gap:10px;margin:16px 16px 8px">
      <div class="stat-card"><div class="stat-label">Toplam</div><div class="stat-value" style="color:#1a1a2e">${state.devices.length}</div></div>
      <div class="stat-card"><div class="stat-label">Bağlı</div><div class="stat-value" style="color:#10b981">${onlineCount}</div></div>
      <div class="stat-card"><div class="stat-label">Düşük Pil</div><div class="stat-value" style="color:#f59e0b">${lowBat}</div></div>
    </div>
    ${deviceCards}
    <div style="padding:12px 16px 24px">
      ${state.connectError ? `<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#dc2626;display:flex;align-items:flex-start;gap:8px"><span style="font-size:16px;flex-shrink:0">⚠️</span><span>${state.connectError}</span></div>` : ''}
      <button class="btn btn-primary" id="add-device-btn" ${state.connecting ? 'disabled' : ''} style="display:flex;align-items:center;justify-content:center;gap:8px;${state.connecting ? 'opacity:0.7' : ''}">
        ${state.connecting ? '<span class="spinner"></span> Bağlanıyor...' : '➕ Yeni Etiket Ekle'}
      </button>
    </div>`

  const addBtn = document.getElementById('add-device-btn')
  if (addBtn) addBtn.addEventListener('click', addDevice, { passive: true })
}

function timeAgo(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + ' sn önce'
  if (s < 3600) return Math.floor(s / 60) + ' dk önce'
  if (s < 86400) return Math.floor(s / 3600) + ' sa önce'
  return Math.floor(s / 86400) + ' gün önce'
}

function renderDetail(app) {
  const d = state.devices.find(x => x.id === state.selectedDeviceId)
  if (!d) { state.page = 'home'; render(); return }
  const prox = distanceToProximity(d.distance, d.rssi)
  const ringing = state.ringingDeviceId === d.id

  let editSection = ''
  if (state.editingDevice) {
    let iconBtns = ICONS.map(ic => `<button class="icon-select" style="border:${state.editIcon === ic ? '2px solid #4f46e5' : '1.5px solid #e5e5e0'};background:${state.editIcon === ic ? '#eef2ff' : '#fff'}" onclick="window._kt.selectIcon('${ic}')">${ic}</button>`).join('')
    editSection = `
      <input class="input" id="edit-name" value="${d.name}">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${iconBtns}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="window._kt.saveDeviceEdit('${d.id}')">Kaydet</button>
        <button class="btn btn-secondary" style="flex:1" onclick="window._kt.cancelEdit()">İptal</button>
      </div>`
  } else {
    editSection = `<button class="btn btn-secondary" onclick="window._kt.startEdit('${d.id}')">İsim ve İkon Değiştir</button>`
  }

  app.innerHTML = `
    <div class="header-center">
      <button class="back-btn" onclick="window._kt.goHome()">←</button>
      <span style="font-weight:600">${d.name}</span>
      <div style="width:36px"></div>
    </div>

    <div class="card fade-in" style="text-align:center">
      <div style="font-size:48px;margin-bottom:8px">${d.icon || '🔑'}</div>
      <div style="font-size:20px;font-weight:700;color:#1a1a2e">${d.name}</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:6px">
        <span class="status-dot" style="background:${d.connected ? '#10b981' : '#d1d5db'}"></span>
        <span style="font-size:14px;color:${d.connected ? '#10b981' : '#9ca3af'}">${d.connected ? 'Bağlı' : 'Bağlı değil'}</span>
      </div>
      ${d.battery != null ? `
        <div style="margin-top:12px;display:inline-flex;align-items:center;gap:6px;background:${d.battery < 20 ? '#fef2f2' : '#f0fdf4'};padding:8px 16px;border-radius:10px">
          <span>${d.battery < 20 ? '🪫' : '🔋'}</span>
          <span style="font-weight:600;color:${d.battery < 20 ? '#dc2626' : '#16a34a'}">Pil: ${d.battery}%</span>
        </div>` : ''}
    </div>

    ${d.connected ? `
      <div class="card fade-in" style="text-align:center">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button class="btn ring-btn ${ringing ? 'ringing' : ''}" onclick="window._kt.triggerAlert('${d.id}','high')" ${ringing ? 'disabled' : ''}>
            ${ringing ? '<span class="spinner"></span> Çalıyor...' : '🔔 Yüksek Alarm'}
          </button>
          <button class="btn btn-secondary" onclick="window._kt.triggerAlert('${d.id}','mild')" ${ringing ? 'disabled' : ''}>
            🔕 Hafif Uyarı
          </button>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-top:8px">Immediate Alert Service (0x1802)</div>
      </div>
      <div class="card fade-in">
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:12px">📶 Yakınlık (RSSI)</div>
        <div style="text-align:center;margin-bottom:12px">
          <div class="prox-num" style="color:${prox.color}">${prox.m}</div>
          <div style="font-size:14px;color:${prox.color};font-weight:500" class="prox-text">${prox.label}</div>
        </div>
        <div class="prox-bar"><div class="prox-fill smooth" style="width:${prox.pct}%;background:${prox.color}"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#9ca3af;margin-top:8px">
          <span>RSSI: ${d.rssi != null ? d.rssi + ' dBm' : '—'}</span>
          <span>N=${N_PATH_LOSS} · P₀=${MEASURED_POWER} dBm</span>
        </div>
      </div>` : `
      <div class="card fade-in" style="text-align:center;padding:24px">
        <div style="font-size:14px;color:#6b7280;margin-bottom:12px">Etiket bağlı değil</div>
        <button class="btn btn-primary" id="reconnect-btn">Yeniden Bağlan</button>
      </div>`}

    ${d.lastLocation ? `
      <div class="card fade-in">
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:8px">📍 Son Bilinen Konum</div>
        <div style="background:#fafaf8;border-radius:12px;padding:14px">
          <div style="font-size:13px;color:#6b7280">${d.lastLocation.lat.toFixed(6)}, ${d.lastLocation.lng.toFixed(6)}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">${timeAgo(d.lastLocation.time || d.lastSeen)}${d.lastLocation.accuracy ? ' · ±' + Math.round(d.lastLocation.accuracy) + 'm' : ''}</div>
          <a href="https://www.google.com/maps?q=${d.lastLocation.lat},${d.lastLocation.lng}" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;font-size:13px;color:#4f46e5;text-decoration:none;font-weight:500">Haritada Göster →</a>
        </div>
      </div>` : ''}

    <div class="card fade-in">
      <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:12px">Etiket Ayarları</div>
      ${editSection}
      ${d.connected ? `<button class="btn btn-secondary" style="margin-top:10px" onclick="window._kt.disconnect('${d.id}')">Bağlantıyı Kes</button>` : ''}
      <button class="btn btn-danger" style="margin-top:8px" onclick="if(confirm('Bu etiketi silmek istediğinize emin misiniz?')) window._kt.deleteDevice('${d.id}')">Etiketi Kaldır</button>
    </div>
    <div style="height:30px"></div>`

  const reconnectBtn = document.getElementById('reconnect-btn')
  if (reconnectBtn) reconnectBtn.addEventListener('click', addDevice, { passive: true })
}

async function saveDeviceEdit(id) {
  const nameInput = document.getElementById('edit-name')
  const d = state.devices.find(x => x.id === id)
  if (d && nameInput) {
    d.name = nameInput.value || d.name
    d.icon = state.editIcon || d.icon
    await syncDevice(d)
  }
  state.editingDevice = false
  render()
}

function renderSettings(app) {
  const s = getSettings()
  app.innerHTML = `
    <div class="header-center">
      <button class="back-btn" onclick="window._kt.goTo('home')">←</button>
      <span style="font-weight:600">Ayarlar</span>
      <div style="width:36px"></div>
    </div>
    <div class="card fade-in">
      <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:4px">${getUserDisplayName()}</div>
      <div style="font-size:13px;color:#6b7280">${state.currentUser?.email || ''}</div>
    </div>
    <div class="card fade-in">
      <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:16px">Bildirim Ayarları</div>
      ${renderToggle('notifications', 'Bildirimler', 'Bağlantı kopunca bildirim al', s.notifications)}
      ${renderToggle('distanceAlert', 'Mesafe Uyarısı', 'Belirlenen mesafeden uzaklaşınca uyar', s.distanceAlert)}
      ${renderToggle('soundOnFind', 'Telefonu Buldur', 'Etiket butonuna basınca telefon ötsün', s.soundOnFind)}
      ${s.distanceAlert ? `
        <div style="margin-top:16px">
          <div style="font-size:13px;color:#6b7280;margin-bottom:8px">Uyarı mesafesi: ${s.distanceThreshold || 15}m</div>
          <input type="range" min="5" max="30" step="5" value="${s.distanceThreshold || 15}" style="width:100%" onchange="window._kt.updateThreshold(this.value)">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#9ca3af"><span>5m</span><span>15m</span><span>30m</span></div>
        </div>` : ''}
    </div>
    <div class="card fade-in">
      <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:8px">Teknik Bilgi</div>
      <div style="font-size:12px;color:#6b7280;line-height:1.6">
        Bluetooth Low Energy (BLE) tabanlı takip sistemi. Immediate Alert Service ile cihaz üzerindeki alarmı tetikler, RSSI ölçümlerinden Path Loss formülü ile mesafe kestirimi yapar.
      </div>
    </div>
    <div class="card fade-in">
      <button class="btn btn-danger" onclick="window._kt.doLogout()">Çıkış Yap</button>
    </div>`
}

function renderToggle(key, label, desc, val) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f3f4f6">
      <div>
        <div style="font-size:14px;color:#1a1a2e;font-weight:500">${label}</div>
        <div style="font-size:12px;color:#9ca3af">${desc}</div>
      </div>
      <button class="toggle" style="background:${val ? '#10b981' : '#d1d5db'}" onclick="window._kt.toggleSetting('${key}')">
        <div class="toggle-knob" style="left:${val ? '23px' : '3px'}"></div>
      </button>
    </div>`
}

function toggleSetting(key) {
  const s = getSettings()
  s[key] = !s[key]
  saveSettings(s)
  render()
}

function updateThreshold(val) {
  const s = getSettings()
  s.distanceThreshold = parseInt(val)
  saveSettings(s)
  render()
}

async function doLogout() {
  await sb.auth.signOut()
  state.currentUser = null
  state.devices = []
  state.page = 'login'
  render()
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' && session) state.currentUser = session.user
  if (event === 'SIGNED_OUT') {
    state.currentUser = null
    state.devices = []
    state.page = 'login'
    render()
  }
})

window._kt = {
  addDevice,
  triggerAlert,
  doLogin,
  doRegister,
  doLogout,
  toggleSetting,
  updateThreshold,
  saveDeviceEdit,
  deleteDevice,
  goTo: (page) => { state.page = page; render() },
  goHome: () => { state.page = 'home'; state.selectedDeviceId = null; state.editingDevice = false; render() },
  openDetail: (id) => { state.selectedDeviceId = id; state.page = 'detail'; render() },
  startEdit: (id) => { const d = state.devices.find(x => x.id === id); if (d) { state.editingDevice = true; state.editName = d.name; state.editIcon = d.icon || '🔑'; render() } },
  cancelEdit: () => { state.editingDevice = false; render() },
  selectIcon: (ic) => { state.editIcon = ic; render() },
  disconnect: (id) => { disconnectDevice(id); render() },
  findPhoneDismiss: () => { state.findPhoneActive = false; render() }
}

async function init() {
  state.envSupport = await detectEnvironment()
  const { data: { session } } = await sb.auth.getSession()
  if (session) {
    state.currentUser = session.user
    state.page = 'home'
    await loadDevices()
  }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  render()
}

init()
