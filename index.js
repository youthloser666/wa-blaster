const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')
const express = require('express')
const fs = require('fs')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.json())
app.use(express.static('public'))

// Cegah aplikasi crash total jika ada error puppeteer/browser
process.on('uncaughtException', (err) => {
  console.error('[Critical Error] Uncaught Exception:', err)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Critical Error] Unhandled Rejection at:', promise, 'reason:', reason)
})

// ─── Device Manager ───────────────────────────────────────
const devices = {} // { id: { client, status, qr, info } }
let deviceCounter = 0

function createDevice() {
  const id = `device_${++deviceCounter}`
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    takeoverOnConflict: true,
    puppeteer: {
      headless: 'new',
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--allow-running-insecure-content'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/waping.js'
    }
  })

  devices[id] = { client, status: 'init', qr: null, name: id }
  console.log(`[${id}] creating client`)

  client.on('qr', async qr => {
    console.log(`[${id}] qr received`)
    const dataURL = await qrcode.toDataURL(qr)
    devices[id].qr = dataURL
    devices[id].status = 'scan_qr'
    io.emit('device_update', deviceSnapshot(id))
  })

  client.on('ready', async () => {
    console.log(`[${id}] ready`)
    
    // Beri jeda agar konteks eksekusi stabil sebelum melakukan injeksi/status
    await new Promise(r => setTimeout(r, 3000));
    
    // Set status 'Online' agar terlihat manusiawi
    try {
      if (devices[id] && devices[id].status !== 'disconnected') {
        await client.sendPresenceAvailable();
      }
    } catch (e) {
      console.warn(`[${id}] Gagal set status online:`, e.message)
    }

    const info = client.info
    devices[id].status = 'connected'
    devices[id].qr = null
    devices[id].name = info?.pushname || id
    io.emit('device_update', deviceSnapshot(id))
  })

  client.on('authenticated', () => {
    console.log(`[${id}] authenticated`)
    devices[id].status = 'authenticating'
    io.emit('device_update', deviceSnapshot(id))
  })

  client.on('auth_failure', msg => {
    console.error(`[${id}] auth failure:`, msg)
    const message = typeof msg === 'string' ? msg : JSON.stringify(msg)
    const notice = message.toLowerCase().includes('blocked') || message.toLowerCase().includes('limit')
      ? 'Akun WA mungkin diblokir atau terkena batasan. Gunakan akun lain atau tunggu beberapa saat.'
      : `Auth gagal: ${message}`
    
    io.emit('device_notice', { deviceId: id, message: notice, type: 'warning' })
    devices[id].status = 'auth_failed'
    io.emit('device_update', deviceSnapshot(id))
  })

  client.on('loading_screen', (percent, message) => {
    console.log(`[${id}] loading ${percent}%`, message)
  })

  client.on('change_state', state => {
    console.log(`[${id}] state changed:`, state)
  })

  client.on('disconnected', reason => {
    console.log(`[${id}] disconnected:`, reason)
    if (reason === 'LOGOUT') {
      const notice = 'Akun WA terkena batasan/limit dan logout. Gunakan akun lain atau tunggu beberapa saat sebelum mencoba lagi.'
      io.emit('device_notice', { deviceId: id, message: notice, type: 'error' })
    }
    devices[id].status = 'disconnected'
    io.emit('device_update', deviceSnapshot(id))
  })

  client.initialize().catch(err => {
    console.error(`[${id}] initialize error:`, err)
    devices[id].status = 'disconnected'
    io.emit('device_update', deviceSnapshot(id))
  })

  io.emit('device_added', deviceSnapshot(id))
  return id
}

async function removeDevice(id) {
  if (!devices[id]) return
  console.log(`[${id}] removing device`)
  
  try { 
    await devices[id].client.destroy() 
    // Beri waktu sistem operasi untuk menutup semua file handle
    await new Promise(r => setTimeout(r, 2000))
  } catch (e) {
    console.error(`[${id}] error destroying client:`, e.message)
  }
  
  // Hapus auth folder dengan mekanisme retry untuk menghindari EBUSY pada Windows
  const authPath = `.wwebjs_auth/session-${id}`
  if (fs.existsSync(authPath)) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(authPath, { recursive: true, force: true })
        console.log(`[${id}] folder sesi berhasil dihapus`)
        break
      } catch (e) {
        if (i === 4) console.error(`[${id}] Gagal menghapus folder sesi setelah 5 percobaan:`, e.message)
        else {
          console.warn(`[${id}] folder sibuk, mencoba lagi dalam 2 detik... (${i+1}/5)`)
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
  }
  
  delete devices[id]
  io.emit('device_removed', { id })
}

function deviceSnapshot(id) {
  const d = devices[id]
  return { id, status: d.status, qr: d.qr, name: d.name }
}

function getAllSnapshots() {
  return Object.keys(devices).map(deviceSnapshot)
}

// ─── CSV Parser ───────────────────────────────────────────
function loadCSV(content) {
  return content.trim().split('\n').map(line => {
    const [nomer, nama, pesanCustom] = line.split(',').map(s => s.trim())
    return { nomer, nama: nama || '', pesanCustom: pesanCustom || '' }
  }).filter(c => c.nomer)
}

// ─── Blast Logic ─────────────────────────────────────────
let isBlasting = false
let stopFlag = false

async function runBlast(contacts, pesanTemplates, options = {}) {
  isBlasting = true
  stopFlag = false

  // Ambil device yang connected
  const activeDevices = Object.keys(devices).filter(id => devices[id].status === 'connected')

  if (!activeDevices.length) {
    io.emit('blast_error', 'Tidak ada device yang connected')
    isBlasting = false
    return
  }

  // Round-robin: bagi kontak ke tiap device
  const chunks = activeDevices.map(() => [])
  contacts.forEach((c, i) => chunks[i % activeDevices.length].push(c))

  io.emit('blast_start', {
    total: contacts.length,
    devices: activeDevices.length,
    distribution: activeDevices.map((id, i) => ({
      id, name: devices[id].name, count: chunks[i].length
    }))
  })

  // Jalanin semua device paralel
  await Promise.all(activeDevices.map((id, idx) =>
    blastDevice(id, chunks[idx], pesanTemplates, contacts.length, options)
  ))

  isBlasting = false
  io.emit('blast_done')
}

async function blastDevice(deviceId, contacts, pesanTemplates, total, options = {}) {
  const client = devices[deviceId]?.client

  for (let i = 0; i < contacts.length; i++) {
    if (stopFlag) return

    const { nomer, nama, pesanCustom } = contacts[i]
    
    // Pilih template secara acak jika pesanCustom kosong
    let template = Array.isArray(pesanTemplates) 
      ? pesanTemplates[Math.floor(Math.random() * pesanTemplates.length)] 
      : pesanTemplates;
      
    const pesan = pesanCustom || template.replace(/{nama}/g, nama || 'Kak')

    try {
      // 1. Cek apakah nomor terdaftar di WA dan ambil ID yang benar
      const numberId = await client.getNumberId(nomer);
      
      if (!numberId) {
        throw new Error('Nomor tidak terdaftar di WhatsApp');
      }

      const chatId = numberId._serialized;
      
      // 2. Simulasi interaksi manusia
      try {
        const chat = await client.getChatById(chatId);
        
        // Tandai sudah dibaca (Centang Biru) agar natural
        await chat.sendSeen();
        
        // Simulasi 'Typing...'
        await chat.sendStateTyping();
        
        // Jeda mengetik acak antara 2 sampai 5 detik
        const typingDelay = Math.floor(Math.random() * 3000) + 2000;
        await new Promise(r => setTimeout(r, typingDelay));
      } catch (e) {
        // Jika gagal ambil chat objek (nomor baru), langsung kirim saja
        console.warn(`[${deviceId}] Warning: Gagal simulasi mengetik untuk ${nomer}, lanjut kirim.`);
      }

      await client.sendMessage(chatId, pesan)
      io.emit('blast_progress', { deviceId, nomer, status: 'success' })
    } catch (err) {
      const reason = err?.message || JSON.stringify(err) || 'unknown error'
      console.error(`[${deviceId}] send failed to ${nomer}:`, reason)
      io.emit('blast_progress', { deviceId, nomer, status: 'failed', error: reason })

      const normalized = reason.toLowerCase()
      if (normalized.includes('invalid account') || normalized.includes('not a whatsapp') || normalized.includes('number is invalid')) {
        io.emit('device_notice', { deviceId, message: `${nomer} bukan nomor WhatsApp yang valid.`, type: 'warning' })
      }
      if (normalized.includes('blocked') || normalized.includes('limit') || normalized.includes('rate limit') || normalized.includes('too many requests')) {
        io.emit('device_notice', { deviceId, message: `Akun rawan limit/banned karena mengirim terlalu cepat. Hentikan blast dan gunakan akun lain.`, type: 'error' })
      }
      if (normalized.includes('disconnect') || normalized.includes('logout') || normalized.includes('not connected')) {
        io.emit('device_notice', { deviceId, message: `Device kehilangan koneksi atau logout. Periksa kembali sesi WA.`, type: 'error' })
      }
    }

    if (i < contacts.length - 1 && !stopFlag) {
      const min = Math.max(1, parseInt(options.delayMin) || 30)
      const max = Math.max(min, parseInt(options.delayMax) || 70)
      const sec = Math.floor(Math.random() * (max - min + 1)) + min
      const delay = sec * 1000
      io.emit('blast_delay', { deviceId, seconds: sec })
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// ─── API Routes ───────────────────────────────────────────
app.get('/devices', (req, res) => res.json(getAllSnapshots()))

app.post('/devices/add', (req, res) => {
  const id = createDevice()
  res.json({ ok: true, id })
})

app.delete('/devices/:id', async (req, res) => {
  await removeDevice(req.params.id)
  res.json({ ok: true })
})

app.post('/blast', async (req, res) => {
  if (isBlasting) return res.json({ ok: false, msg: 'Blast sedang berjalan' })
  const { csvContent, pesans, delayMin, delayMax } = req.body
  if (!csvContent || !pesans || !pesans.length) return res.json({ ok: false, msg: 'CSV dan variasi pesan wajib diisi' })
  const contacts = loadCSV(csvContent)
  if (!contacts.length) return res.json({ ok: false, msg: 'Kontak kosong' })
  res.json({ ok: true, total: contacts.length })
  const dMin = parseInt(delayMin) || 30
  const dMax = parseInt(delayMax) || 70
  runBlast(contacts, pesans, { delayMin: dMin, delayMax: dMax })
})

app.post('/stop', (req, res) => {
  stopFlag = true
  isBlasting = false
  res.json({ ok: true })
})

app.post('/reset-auth', async (req, res) => {
  try {
    // 1. Hentikan semua client untuk melepas lock file
    for (const id in devices) {
      try {
        await devices[id].client.destroy()
      } catch (e) {}
      delete devices[id]
    }

    // 2. Tunggu sebentar agar browser benar-benar tertutup
    await new Promise(r => setTimeout(r, 3000))

    // 3. Hapus folder-folder sesi secara rekursif dengan paksa
    const targets = ['.wwebjs_auth', 'auth_info', '.wwebjs_cache', 'session']
    targets.forEach(target => {
      if (fs.existsSync(target)) {
        try {
          fs.rmSync(target, { recursive: true, force: true })
          console.log(`[System] Folder ${target} berhasil dihapus.`)
        } catch (e) {
          console.error(`[System] Gagal hapus ${target}:`, e.message)
        }
      }
    })

    res.json({ ok: true, msg: 'Semua sesi telah dibersihkan. Silakan refresh halaman dan tambah device baru.' })
  } catch (err) {
    console.error('[System] Gagal reset auth:', err)
    res.json({ ok: false, msg: 'Gagal menghapus sesi: ' + err.message })
  }
})

app.get('/status', (req, res) => {
  res.json({ isBlasting, devices: getAllSnapshots() })
})

// ─── Start ────────────────────────────────────────────────
server.listen(3000, () => {
  console.log('Server jalan di http://localhost:3000')
})