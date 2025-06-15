import fs from 'fs/promises'
import axios from 'axios'
import HttpsProxyAgent from 'https-proxy-agent'

const CONCURRENT_REQUESTS = 3
const MAX_ID = 999999
const START_ID = 28824
let proxies = []

// === CARGA Y VALIDACIÓN DE PROXIES ===

async function cargarProxies() {
  const contenido = await fs.readFile('proxies.txt', 'utf8')
  proxies = contenido
    .split('\n')
    .map(p => p.trim())
    .filter(p => p.length > 0 && !p.startsWith('#'))
  console.log(`🔌 ${proxies.length} proxies cargados.`)
}

async function validarProxies() {
  console.log(`🧪 Validando proxies...`)
  const validados = []
  for (let proxy of proxies) {
    try {
      const agent = new HttpsProxyAgent(proxy)
      const res = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent: agent,
        timeout: 5000
      })
      if (res.data?.ip) {
        validados.push(proxy)
        console.log(`✅ Proxy OK: ${proxy} (${res.data.ip})`)
      }
    } catch (err) {
      console.log(`❌ Proxy inválido o no responde: ${proxy}`)
    }
  }
  proxies = validados
  if (proxies.length === 0) throw new Error("🚫 No hay proxies válidos.")
}

async function validarProxiesFinal() {
  console.log("🔄 Verificando proxies activos antes de terminar...")
  const activos = []
  for (let proxy of proxies) {
    try {
      const agent = new HttpsProxyAgent(proxy)
      const res = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent: agent,
        timeout: 5000
      })
      if (res.data?.ip) {
        activos.push(proxy)
        console.log(`✅ Proxy sigue activo: ${proxy} (${res.data.ip})`)
      }
    } catch {
      console.log(`❌ Proxy ya no responde: ${proxy}`)
    }
  }
  proxies = activos
  if (proxies.length === 0) {
    console.log("⚠️ No quedan proxies activos al finalizar.")
  } else {
    console.log(`✅ ${proxies.length} proxies activos al finalizar.`)
  }
}

function getRandomProxy() {
  if (proxies.length === 0) throw new Error("No proxies disponibles")
  const index = Math.floor(Math.random() * proxies.length)
  return { agent: new HttpsProxyAgent(proxies[index]), url: proxies[index], index }
}

// === PROGRESO POR ID ===

let idActual = START_ID
const PROGRESO_FILE = 'progreso.json'

async function cargarProgreso() {
  try {
    const data = await fs.readFile(PROGRESO_FILE, 'utf8')
    const json = JSON.parse(data)
    idActual = json.idActual || START_ID
  } catch {
    idActual = START_ID
  }
}

async function guardarProgreso(id) {
  await fs.writeFile(PROGRESO_FILE, JSON.stringify({ idActual: id }), 'utf8')
}

// === SCRAPER ===

async function procesarID(id) {
  const archivo = `./personajes/${id}.json`

  try {
    await fs.access(archivo)
    console.log(`📄 ID ${id} ya existe. Saltando...`)
    return true
  } catch {}

  const query = `
    query ($id: Int!) {
      Character(id: $id) {
        id
        name { full native }
        image { large }
        description
        gender
        age
        dateOfBirth { year month day }
        bloodType
        siteUrl
        favourites
        media {
          edges {
            node {
              title { romaji english }
            }
          }
        }
      }
    }
  `
  const variables = { id }

  let intentos = 0
  const maxIntentos = 5

  while (intentos < maxIntentos) {
    if (proxies.length === 0) {
      console.log('❌ Se quedaron sin proxies válidos. Abortando.')
      process.exit(1)
    }

    const { agent, url, index } = getRandomProxy()
    try {
      const res = await axios.post('https://graphql.anilist.co', {
        query,
        variables
      }, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        httpsAgent: agent,
        timeout: 10000
      })

      if (typeof res.data !== 'object') {
        throw new Error('❌ Respuesta no es JSON válida.')
      }

      if (res.data.errors) {
        const msg = res.data.errors[0].message

        if (msg === "Not Found.") {
          console.log(`🛑 ID ${id} no existe`)
          return true
        }

        if (msg === "Too Many Requests.") {
          console.log(`🚫 Proxy bloqueado (429). Quitando ${url}`)
          proxies.splice(index, 1)
          intentos++
          continue
        }

        console.log(`❌ Error inesperado para ID ${id}: ${msg}`)
        return true
      }

      await fs.writeFile(archivo, JSON.stringify(res.data, null, 2), 'utf8')
      console.log(`✅ Guardado personaje ${id}`)
      return true
    } catch (err) {
      console.log(`⚠️ Proxy ${url} falló con ID ${id}: ${err.message}`)
      proxies.splice(index, 1)
      intentos++
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  console.log(`❗ No se pudo procesar ID ${id} tras ${maxIntentos} intentos.`)
  await fs.appendFile('fallos.txt', `${id}\n`)
  return false
}

// === PROCESAMIENTO CONCURRENTE ===

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function iniciarScraping() {
  try {
    await fs.access("./personajes")
  } catch {
    await fs.mkdir("personajes")
    console.log("📁 Carpeta 'personajes' creada automáticamente.")
  }

  await cargarProgreso()

  const enProceso = new Set()

  while (idActual <= MAX_ID) {
    while (enProceso.size >= CONCURRENT_REQUESTS) {
      await sleep(100)
    }

    const id = idActual++
    enProceso.add(id)

    procesarID(id)
      .then(() => guardarProgreso(id + 1))
      .catch(err => console.error(`⛔ Error en ID ${id}:`, err))
      .finally(() => enProceso.delete(id))

    await sleep(1000 + Math.random() * 500)
  }

  // Esperar a que terminen las tareas pendientes
  while (enProceso.size > 0) {
    await sleep(500)
  }
}

// === INICIO ===

try {
  await cargarProxies()
  await validarProxies()
  await iniciarScraping()
  await validarProxiesFinal()
  console.log("🎉 Scraping finalizado.")
} catch (err) {
  console.error('🚨 Error crítico:', err)
  process.exit(1)
}
