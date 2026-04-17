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
const LED_CHAR = '8082caa8-41a6-4021-91c6-56f9b954cc34'
const BUTTON_SERVICE = '6d696368-616c-206f-6c65-737a637a796b'
const BUTTON_CHAR = '66696c69-7020-726f-6d61-6e6f77736b69'
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
  return JSON.parse(localStorage.getItem('BT Tracker_settings_' + uid) || '{"notifications":true,"distanceAlert":true,"distanceThreshold":15,"soundOnFind":true}')
}

function saveSettings(s) {
  const uid = state.currentUser?.id || 'anon'
  localStorage.setItem('BT Tracker_settings_' + uid, JSON.stringify(s))
}

function getUserDisplayName() {
  return state.currentUser?.user_metadata?.name || state.currentUser?.email || ''
}

async function getCurrentLocation() {
  if (!navigator.geolocation) return null
  try {
    const pos = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, enableHighAccuracy: true, maximumAge: 30000 })
    })
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, time: Date.now() }
  } catch (e) {
    return null
  }
}

async function loadDevices() {
  if (!state.currentUser) { state.devices = []; return }
  const { data, error } = await sb
    .from('BT Tracker_devices')
    .select('*')
    .eq('user_id', state.currentUser.id)
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
    rssi: null
  }))
}

async function syncDevice(d) {
  if (!state.currentUser) return
  const { error } = await sb.from('BT Tracker_devices').update({
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

function rssiToProximity(rssi) {
  if (!rssi) return { label: 'Bilinmiyor', m: '?', pct: 0, color: '#94a3b8' }
  if (rssi > -50) return { label: 'Çok yakın', m: '~1-2m', pct: 90, color: '#10b981' }
  if (rssi > -65) return { label: 'Yakın', m: '~3-5m', pct: 65, color: '#06b6d4' }
  if (rssi > -80) return { label: 'Orta', m: '~5-15m', pct: 40, color: '#f59e0b' }
  return { label: 'Uzak', m: '~15-30m', pct: 15, color: '#ef4444' }
}

function timeAgo(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + ' sn önce'
  if (s < 3600) return Math.floor(s / 60) + ' dk önce'
  if (s < 86400) return Math.floor(s / 3600) + ' sa önce'
  return Math.floor(s / 86400) + ' gün önce'
}

function playFindPhone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    for (let i = 0; i < 5; i++) {
      [880, 1100].forEach((f, j) => {
        const o = ctx.createOscillator(), g = ctx.createGain()
        o.connect(g); g.connect(ctx.destination)
        o.frequency.value = f; g.gain.value = 0.3
        o.start(ctx.currentTime + i * 0.4 + j * 0.2)
        o.stop(ctx.currentTime + i * 0.4 + j * 0.2 + 0.2)
      })
    }
    state.findPhoneActive = true; render()
    setTimeout(() => { state.findPhoneActive = false; render() }, 2500)
  } catch (e) {}
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
      optionalServices: [BATTERY_SERVICE, BUTTON_SERVICE]
    })
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'AbortError') return
    let msg = e.name + ': ' + e.message
    if (e.name === 'SecurityError') {
      msg = 'Güvenlik hatası. Sayfa HTTPS üzerinde açık olmalı ve Bluetooth izni verilmeli.'
    } else if (e.name === 'NotSupportedError') {
      msg = 'BLE Desteklenmiyor. Brave kullanıyorsanız Shields kapalı olmalı ve brave://flags/#brave-web-bluetooth-api etkin olmalı.'
    }
    state.connectError = msg
    render()
    return
  }

  state.connecting = true
  render()

  try {
    const server = await btDevice.gatt.connect()
    const service = await server.getPrimaryService(TRACKER_SERVICE)

    let charLed = null
    try { charLed = await service.getCharacteristic(LED_CHAR) } catch (e) {}

    let battery = null
    try {
      const bs = await server.getPrimaryService(BATTERY_SERVICE)
      const bc = await bs.getCharacteristic(BATTERY_CHAR)
      const bv = await bc.readValue()
      battery = bv.getUint8(0)
    } catch (e) {}

    try {
      const btnSvc = await server.getPrimaryService(BUTTON_SERVICE)
      const btnChar = await btnSvc.getCharacteristic(BUTTON_CHAR)
      await btnChar.startNotifications()
      btnChar.addEventListener('characteristicvaluechanged', () => {
        if (getSettings().soundOnFind) playFindPhone()
      })
    } catch (e) {}

    const loc = await getCurrentLocation()

    const id = btDevice.id || 'tag-' + Date.now()
    const existing = state.devices.find(d => d.id === id)

    bleData[id] = { charLed, server, btDevice }

    const dev = {
      id,
      name: existing ? existing.name : (btDevice.name || 'Smart Tag'),
      icon: existing ? existing.icon : '🔑',
      battery,
      connected: true,
      rssi: null,
      lastSeen: Date.now(),
      lastLocation: loc || existing?.lastLocation || null
    }

    btDevice.addEventListener('gattserverdisconnected', async () => {
      const d = state.devices.find(x => x.id === id)
      if (d) { d.connected = false; d.rssi = null; d.lastSeen = Date.now() }
      delete bleData[id]
      const discLoc = await getCurrentLocation()
      if (d && discLoc) d.lastLocation = discLoc
      if (d) await syncDevice(d)
      if (getSettings().notifications && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Smart BT Tracker', { body: dev.name + ' bağlantısı kesildi!' })
      }
      render()
    })

    const { error } = await sb.from('BT Tracker_devices').upsert({
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

    if (existing) {
      Object.assign(existing, dev)
    } else {
      state.devices.push(dev)
    }
  } catch (e) {
    state.connectError = 'Bağlantı hatası: ' + e.message
  }

  state.connecting = false
  render()
}

async function ringDevice(deviceId) {
  const ble = bleData[deviceId]
  if (!ble || !ble.charLed) {
    state.connectError = 'Cihaz bağlı değil veya uyarı karakteristiği bulunamadı.'
    render()
    return
  }
  if (!ble.server || !ble.server.connected) {
    state.connectError = 'GATT bağlantısı kopmuş. Yeniden bağlanın.'
    render()
    return
  }
  state.ringingDeviceId = deviceId
  render()
  try {
    await ble.charLed.writeValue(new Uint8Array([0x01]))
  } catch (e) {
    state.connectError = 'Ring komutu gönderilemedi: ' + e.message
  }
  setTimeout(() => {
    state.ringingDeviceId = null
    render()
  }, 3000)
}

function disconnectDevice(deviceId) {
  const ble = bleData[deviceId]
  if (ble && ble.server && ble.server.connected) ble.server.disconnect()
}

async function deleteDevice(deviceId) {
  disconnectDevice(deviceId)
  const { error } = await sb.from('BT Tracker_devices').delete()
    .eq('user_id', state.currentUser.id)
    .eq('device_id', deviceId)
  if (error) console.error(error)
  state.devices = state.devices.filter(d => d.id !== deviceId)
  delete bleData[deviceId]
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
      <input class="input" id="login-email" placeholder="E-posta" type="email">
      <input class="input" id="login-pass" placeholder="Şifre" type="password">
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

  const { data, error } = await sb.auth.signUp({
    email,
    password: pass,
    options: { data: { name } }
  })

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
      const prox = rssiToProximity(d.rssi)
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
                  <span style="font-size:12px;color:#6b7280">Mesafe</span>
                  <span style="font-size:12px;font-weight:600;color:${prox.color}">${prox.label} (${prox.m})</span>
                </div>
                <div class="prox-bar"><div class="prox-fill" style="width:${prox.pct}%;background:${prox.color}"></div></div>
              </div>` : ''}
            ${d.lastLocation ? `
              <div style="margin-top:12px;padding:10px 12px;background:#fafaf8;border-radius:10px;font-size:12px;color:#6b7280;display:flex;justify-content:space-between;align-items:center">
                <span>📍 ${d.lastLocation.lat.toFixed(4)}, ${d.lastLocation.lng.toFixed(4)} · ${timeAgo(d.lastLocation.time || d.lastSeen)}</span>
                <a href="https://www.google.com/maps?q=${d.lastLocation.lat},${d.lastLocation.lng}" target="_blank" onclick="event.stopPropagation()" style="color:#4f46e5;text-decoration:none;font-weight:600">Harita →</a>
              </div>` : ''}
          </div>
          ${isOn ? `
            <button class="btn" style="margin-top:14px;background:${ringing ? '#f59e0b' : 'linear-gradient(135deg,#4f46e5,#7c3aed)'};color:#fff;display:flex;align-items:center;justify-content:center;gap:8px" onclick="event.stopPropagation();window._kt.ringDevice('${d.id}')" ${ringing ? 'disabled' : ''}>
              ${ringing ? '<span class="spinner"></span> Cihaz Çalıyor...' : '🔔 Cihazı Çaldır'}
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

function renderDetail(app) {
  const d = state.devices.find(x => x.id === state.selectedDeviceId)
  if (!d) { state.page = 'home'; render(); return }
  const prox = rssiToProximity(d.rssi)
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
        <button class="btn" style="background:${ringing ? '#f59e0b' : 'linear-gradient(135deg,#4f46e5,#7c3aed)'};color:#fff;font-size:16px;padding:18px;display:flex;align-items:center;justify-content:center;gap:10px" onclick="window._kt.ringDevice('${d.id}')" ${ringing ? 'disabled' : ''}>
          ${ringing ? '<span class="spinner"></span> Cihaz Çalıyor...' : '🔔 Cihazı Çaldır'}
        </button>
        <div style="font-size:12px;color:#9ca3af;margin-top:8px">Fiziksel alarm / LED aktif olacak</div>
      </div>
      <div class="card fade-in">
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:12px">📶 Yakınlık</div>
        <div style="text-align:center;margin-bottom:12px">
          <div style="font-size:36px;font-weight:700;color:${prox.color}">${prox.m}</div>
          <div style="font-size:14px;color:${prox.color};font-weight:500">${prox.label}</div>
        </div>
        <div class="prox-bar"><div class="prox-fill" style="width:${prox.pct}%;background:${prox.color}"></div></div>
        ${d.rssi ? `<div style="font-size:11px;color:#9ca3af;margin-top:6px;text-align:right">RSSI: ${d.rssi} dBm</div>` : ''}
      </div>` : `
      <div class="card fade-in" style="text-align:center;padding:24px">
        <div style="font-size:14px;color:#6b7280;margin-bottom:12px">Cihaz bağlı değil</div>
        <button class="btn btn-primary" id="reconnect-btn">Yeniden Bağlan</button>
      </div>`}

    ${d.lastLocation ? `
      <div class="card fade-in">
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:8px">📍 Son Bilinen Konum</div>
        <div style="background:#fafaf8;border-radius:12px;padding:14px">
          <div style="font-size:13px;color:#6b7280">${d.lastLocation.lat.toFixed(6)}, ${d.lastLocation.lng.toFixed(6)}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">${timeAgo(d.lastLocation.time || d.lastSeen)}</div>
          <a href="https://www.google.com/maps?q=${d.lastLocation.lat},${d.lastLocation.lng}" target="_blank" style="display:inline-block;margin-top:10px;font-size:13px;color:#4f46e5;text-decoration:none;font-weight:500">Haritada Göster →</a>
        </div>
      </div>` : ''}

    <div class="card fade-in">
      <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:12px">Cihaz Ayarları</div>
      ${editSection}
      ${d.connected ? `<button class="btn btn-secondary" style="margin-top:10px" onclick="window._kt.disconnect('${d.id}')">Bağlantıyı Kes</button>` : ''}
      <button class="btn btn-danger" style="margin-top:8px" onclick="if(confirm('Bu cihazı silmek istediğinize emin misiniz?')) window._kt.deleteDevice('${d.id}')">Cihazı Kaldır</button>
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
  if (event === 'TOKEN_REFRESHED' && session) {
    state.currentUser = session.user
  }
  if (event === 'SIGNED_OUT') {
    state.currentUser = null
    state.devices = []
    state.page = 'login'
    render()
  }
})

window._kt = {
  addDevice,
  ringDevice,
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
