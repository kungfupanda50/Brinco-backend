/* ============================================================================
   Brinco Creativo - Script de migracion inicial de proveedores  (v2)
   ----------------------------------------------------------------------------
   Detecta los proveedores escritos en la DESCRIPCION de cada producto y crea
   las relaciones en la tabla producto_proveedores.

   FORMATO QUE RECONOCE (el que usan tus datos reales):

        Proveedor: (NOVOCOLOR)                       <- nombre entre parentesis
        Proveedores: (YAXA, AMZON, TEMU)             <- varios separados por coma
        Proveedores: (RSA,COM,GT, DISTRIZA)          <- nombre con comas dentro
        Proveedores: (IMAGINA, DISEÑA Y REALIZA)     <- nombre largo con "y"
        ...texto... Proveedores: (X) ...mas texto... <- el parentesis delimita
        Proveedor: Papeleria ABC tel 5555-5555       <- sin parentesis (fallback)

   COMO DECIDE CADA NOMBRE:
     1. Compara el texto contra los proveedores YA EXISTENTES en la tabla
        `proveedores` y contra LISTA_PROVEEDORES (mas abajo), ignorando
        mayusculas, acentos y puntuacion. Esto resuelve los casos ambiguos:
        "IMAGINA, DISEÑA Y REALIZA" queda como UN solo proveedor si esta en la
        lista, y "RSA,COM,GT" coincide con un proveedor "RSA.COM.GT".
     2. Lo que no coincida con nada se reporta como "nuevo a crear", y en el
        reporte se marca con [!] si se parece mucho a un nombre existente
        (posible duplicado / error de dedo, ej. QUATEBAGPRINT vs GUATEBAGPRINT).

   Por cada relacion creada guarda:
        fecha_ultima_compra = fecha de alta del producto (created_at)
        documento           = 'Carga inicial'
        cantidad            = NULL (la llenas a mano si la conoces)

   - Es SEGURO ejecutarlo varias veces: no duplica nada.
   - Corre SIEMPRE primero con --dry-run y revisa el reporte.
   - Si el reporte parte mal un nombre, agregalo a LISTA_PROVEEDORES y
     vuelve a correr el --dry-run: es la forma de "enseñarle" el nombre real.
     Ademas, la lista CORRIGE ORTOGRAFIA: si en la lista escribes el nombre
     bien (ej. GUATEBAGPRINT) y en la descripcion esta con error de dedo
     (ej. QUATEBAGPRINT), el script lo empareja igual.

   DIAGNOSTICO DE CONEXION: al inicio imprime host, base de datos, usuario y
   el listado completo de productos que leyo. Comparalo con MySQL Workbench:
   si no ves los mismos productos, el script leyo OTRA base (corrige el .env,
   usa --host=... --database=... o llena CONFIG a mano).

   USO (desde la carpeta del backend, donde esta node):
       node migrar_proveedores_iniciales.js --dry-run   -> SOLO simula, no escribe
       node migrar_proveedores_iniciales.js             -> aplica los cambios
   Opciones: --host=HOST --port=PUERTO --database=BASE --user=USUARIO --password=CLAVE

   IMPORTANTE - COMO CORRERLO CONTRA PRODUCCION (Aiven) DESDE TU CONSOLA LOCAL:
   las opciones de linea de comandos tienen PRIORIDAD sobre el .env. Aunque tu
   .env local apunte a localhost, puedes correr contra Aiven pasando los datos
   de tu conexion de MySQL Workbench (esa conexion ya apunta a produccion):

       node migrar_proveedores_iniciales.js --dry-run --host=brincocreativo-1-neryvilla-ef6f.a.aivencloud.com --port=TU_PUERTO --database=brinco_creativo --user=TU_USUARIO --password="TU_CLAVE"

   No hace falta correrlo en Render: el script se conecta DIRECTO a la base
   Aiven, igual que tu Workbench. Si la clave tiene caracteres especiales,
   enciérrala entre comillas.

   CREDENCIALES (orden de prioridad):
     1. Opciones de linea de comandos: --user=... --password=... (etc.)
     2. Archivo .env del backend (DB_USER, DB_PASSWORD, DB_HOST, DB_PORT,
        DB_NAME o variantes MYSQL_*), leido automaticamente
     3. Valores por defecto del CONFIG dentro de main()
   Si no se encuentran user/password en ningun lado, el script avisa y corta.
   REQUISITO: mysql2 instalado (el backend ya lo usa).
   ============================================================================ */

const fs = require('fs')
const path = require('path')

// ----------------------------------------------------------------------------
// LISTA_PROVEEDORES: nombres reales de proveedores tomados de tus productos.
// Sirven para que el script no parta nombres largos ni se confunda con las
// comas. EDITALA libremente: agrega o quita nombres y vuelve a correr el
// --dry-run. Los de esta lista que no existan en la tabla `proveedores` se
// crearan (solo si aparecieron en alguna descripcion).
// ----------------------------------------------------------------------------
const LISTA_PROVEEDORES = [
  'NOVOCOLOR',
  'TEMU',
  'AMAZON', // en algunas descripciones aparece escrito "AMZON"; el
  // emparejamiento difuso lo reconoce igual
  'YAXA',
  'VICTOR INTERNACIONAL',
  'IMAGINA, DISEÑA Y REALIZA',
  'CREATIVO 3D',
  'RSA.COM.GT',
  'DISTRIZA',
  'GUATEBAGPRINT', // en algunas descripciones aparece "QUATEBAGPRINT"; el
  // emparejamiento difuso lo reconoce igual
  'LA CASA DE LAS MANUALIDADES',
]

// ----------------------------------------------------------------------------
// Argumentos de linea de comandos
// ----------------------------------------------------------------------------
const ARGS = {}
for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') {
    ARGS.dryRun = true
    continue
  }
  const m = /^--([a-zA-Z]+)=(.*)$/.exec(a)
  if (m) ARGS[m[1].toLowerCase()] = m[2]
}
const DRY_RUN = !!ARGS.dryRun

// DDL identico al archivo 01_crear_tabla_producto_proveedores.sql
const DDL_PRODUCTO_PROVEEDORES = `
CREATE TABLE IF NOT EXISTS producto_proveedores (
  id int NOT NULL AUTO_INCREMENT,
  producto_id int NOT NULL,
  proveedor_id int NOT NULL,
  fecha_ultima_compra date DEFAULT NULL,
  documento varchar(100) DEFAULT NULL,
  cantidad decimal(10,2) DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_producto_proveedor (producto_id, proveedor_id),
  KEY idx_pp_proveedor (proveedor_id),
  CONSTRAINT fk_pp_producto FOREIGN KEY (producto_id) REFERENCES productos (id) ON DELETE CASCADE,
  CONSTRAINT fk_pp_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedores (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`

// ============================================================================
// UTILIDADES DE TEXTO
// ============================================================================

// Normaliza para comparar sin pelear con mayusculas, acentos ni puntuacion:
// "DISEÑA Y REALIZA" -> "disena y realiza" ; "RSA.COM.GT" -> "rsa com gt"
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokensDe(texto) {
  const n = normalizar(texto)
  return n ? n.split(' ') : []
}

// Quita sufijos legales de razon social al final de un nombre:
// "Distribuidora X S.A." -> "distribuidora x"
const SUFIJOS_LEGALES = new Set([
  'sa', 'sas', 'cia', 'ltda', 'limitada', 'inc', 'llc', 'cv',
  'sociedad', 'anonima', 'de',
])
function sinSufijosLegales(tokens) {
  const t = tokens.slice()
  let cambio = true
  while (cambio) {
    cambio = false
    const n = t.length
    if (n > 2 && t[n - 1] === 'a' && t[n - 2] === 's') {
      t.pop()
      t.pop()
      cambio = true
      continue
    }
    if (n > 1 && SUFIJOS_LEGALES.has(t[n - 1])) {
      t.pop()
      cambio = true
    }
  }
  return t
}

// Todas las "formas" de un nombre contra las que se puede comparar
function variantesTokens(nombre) {
  const tokens = tokensDe(nombre)
  const variantes = [tokens]
  const recortada = sinSufijosLegales(tokens)
  if (recortada.length && recortada.length !== tokens.length) variantes.push(recortada)
  return variantes
}

// ¿La secuencia de tokens "aguja" aparece CONSECUTIVA dentro de "pajar"?
// (comparacion por palabras completas, nunca a mitad de una palabra)
function contieneSecuencia(aguja, pajar) {
  if (!aguja.length || aguja.length > pajar.length) return false
  for (let i = 0; i + aguja.length <= pajar.length; i++) {
    let ok = true
    for (let j = 0; j < aguja.length; j++) {
      if (pajar[i + j] !== aguja[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

// Distancia de edicion (solo para advertir sobre nombres parecidos)
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + costo)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function recortar(texto, n) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ============================================================================
// EXTRACCION DE FRAGMENTOS DESDE LA DESCRIPCION
// ============================================================================

// Por cada vez que aparece "proveedor/proveedores" en la descripcion:
//   - si le sigue un parentesis dentro de los primeros 40 caracteres,
//     captura SOLO lo que esta dentro del parentesis (tu formato real);
//   - si no hay parentesis, captura el resto de la linea (fallback).
function extraerFragmentos(descripcion) {
  const fragmentos = []
  if (!descripcion) return fragmentos
  const texto = String(descripcion)
  const RX = /proveedor(?:a|es|as)?\b/gi
  let m
  while ((m = RX.exec(texto)) !== null) {
    const despues = texto.slice(m.index + m[0].length)
    const corte = despues.search(/[\n\r]/)
    const linea = corte === -1 ? despues : despues.slice(0, corte)
    const apertura = linea.indexOf('(')
    if (apertura !== -1 && apertura <= 40) {
      const resto = linea.slice(apertura + 1)
      const cierre = resto.indexOf(')')
      const contenido = (cierre === -1 ? resto : resto.slice(0, cierre)).trim()
      if (contenido) fragmentos.push(contenido)
    } else {
      const limpio = linea.replace(/^[\s:\-–¿?¡!]+/, '').trim()
      if (limpio) fragmentos.push(limpio)
    }
  }
  return fragmentos
}

// Corta datos de contacto que suelen escribirse despues del nombre
function cortarContacto(texto) {
  return String(texto || '').split(
    /\b(tel[eé]fonos?|tel|celular|whatsapp|correo|email|contacto|nit|direcci[oó]n|direccion|nota|observaci[oó]n|observacion)\b\s*[:\-]?/i
  )[0]
}

// Palabras de "relleno": si una pieza SOLO contiene estas palabras, no es un
// nombre (ej. "pendiente de confirmar", "por definir", "sin asignar").
const RELLENOS = new Set([
  'por', 'de', 'del', 'la', 'el', 'las', 'los', 'y', 'sin', 'con', 'un', 'una',
  'pendiente', 'pendientes', 'confirmar', 'confirmarse', 'definir', 'definirse',
  'asignar', 'asignarse', 'varios', 'revisar', 'actualizar', 'x', 'na', 'no', 'si', 'sa',
])
function esRelleno(pieza) {
  const t = tokensDe(pieza)
  return t.length > 0 && t.every((x) => RELLENOS.has(x))
}

// Limpia una pieza candidata; devuelve null si no parece un nombre
function limpiarPieza(p) {
  const s = String(p || '')
    .replace(/^[\s:\-–(.¡!¿?"'[]+/, '')
    .replace(/[\s:\-–.).,;"'!?\]]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length < 3 || s.length > 150) return null
  if (
    /^(s\.?\s?a\.?|s\.?\s?r\.?\s?l\.?|n\/?a|none|null|varios|pendiente|por definir|sin proveedor|x+|no|si)$/i.test(s)
  ) {
    return null
  }
  if (esRelleno(s)) return null
  return s
}

// Separadores entre nombres DENTRO de un parentesis: ";" o "," seguida de espacio.
// OJO: una coma SIN espacio se considera parte del nombre (ej. "RSA,COM,GT").
const SEPARADORES_PIEZAS = /\s*;\s*|,\s+/

// ============================================================================
// REGISTRO DE PROVEEDORES CONOCIDOS (tabla + lista manual)
// ============================================================================

function construirConocidos(proveedoresTabla, listaExtra) {
  const conocidos = []
  const vistos = new Set()
  const agregar = (nombre, id, origen) => {
    const clave = normalizar(nombre)
    if (!clave || vistos.has(clave)) return
    vistos.add(clave)
    conocidos.push({ id: id || null, nombre: String(nombre).trim(), origen, variantes: variantesTokens(nombre) })
  }
  for (const p of proveedoresTabla) agregar(p.nombre_empresa, p.id, 'tabla')
  for (const n of listaExtra || []) agregar(n, null, 'lista')
  return conocidos
}

// ¿Que proveedores conocidos aparecen mencionados en este texto?
function conocidosEnTexto(texto, conocidos) {
  const tokens = tokensDe(texto)
  const hallados = []
  for (const c of conocidos) {
    for (const v of c.variantes) {
      const largo = v.join(' ').length
      if (largo < 4) continue // evita coincidencias triviales
      if (contieneSecuencia(v, tokens)) {
        hallados.push(c)
        break
      }
    }
  }
  return hallados
}

// ¿La pieza quedo cubierta por un nombre ya encontrado? (ej. la pieza
// "IMAGINA" esta dentro del nombre completo "IMAGINA, DISEÑA Y REALIZA")
function piezaCubierta(pieza, hallados) {
  const tp = tokensDe(pieza)
  if (!tp.length) return true
  for (const h of hallados) {
    for (const v of h.variantes) {
      if (tp.every((t) => v.includes(t))) return true
    }
  }
  return false
}

// Coincidencia "difusa": corrige errores de dedo entre lo escrito en la
// descripcion y el nombre real de la lista/tabla (ej. descripcion "AMZON"
// vs "AMAZON", o "QUATEBAGPRINT" vs "GUATEBAGPRINT"). Nombres largos (8+
// caracteres) toleran hasta 2 letras de diferencia; nombres de 5 a 7 letras
// solo 1, para no crear falsos positivos. Nombres de menos de 5 letras no se
// emparejan difusamente.
function buscarDifusa(pieza, conocidos) {
  const np = normalizar(pieza).replace(/ /g, '')
  if (np.length < 5) return null
  for (const c of conocidos) {
    for (const v of c.variantes) {
      const nv = v.join('')
      if (!nv) continue
      if (Math.abs(np.length - nv.length) > 2) continue
      const tolerancia = nv.length >= 8 ? 2 : 1
      const d = levenshtein(np, nv)
      if (d <= tolerancia) return c
    }
  }
  return null
}

// Advertencia de nombre parecido (posible duplicado o error de dedo)
function parecidoA(nombre, conocidos) {
  const na = normalizar(nombre).replace(/ /g, '')
  if (!na) return null
  for (const c of conocidos) {
    const nb = normalizar(c.nombre).replace(/ /g, '')
    if (!nb || nb === na) continue
    const d = levenshtein(na, nb)
    const max = Math.max(na.length, nb.length)
    if (max >= 6 && d <= 2) return c.nombre
    if (max >= 10 && d <= 3) return c.nombre
  }
  return null
}

// ============================================================================
// ANALISIS PRINCIPAL
// ============================================================================

function analizarProductos(productos, proveedoresTabla, listaExtra, relacionesExistentes) {
  const conocidos = construirConocidos(proveedoresTabla, listaExtra)
  const clavesConocidas = new Set(conocidos.map((c) => normalizar(c.nombre)))
  const existentesSet = new Set(
    (relacionesExistentes || []).map((r) => `${r.producto_id}-${r.proveedor_id}`)
  )

  const porProducto = []
  const relaciones = [] // { producto_id, producto, nombre, id, origen, clave }
  const nuevosDeLista = new Map() // clave -> { nombre, productos: [] }
  const nuevosDetectados = new Map() // clave -> { nombre, productos: [], parecidoA }
  const sinDeteccion = []
  const pendientes = []

  for (const prod of productos) {
  const descripcion = prod.descripcion || ''
    const fragmentos = extraerFragmentos(descripcion)

    if (fragmentos.length === 0) {
      if (/proveedor/i.test(descripcion)) pendientes.push(prod)
      else sinDeteccion.push(prod)
      continue
    }

    // 1) Proveedores conocidos mencionados en los fragmentos completos
    const halladosMap = new Map() // clave -> conocido
    for (const frag of fragmentos) {
      for (const h of conocidosEnTexto(frag, conocidos)) {
        halladosMap.set(normalizar(h.nombre), h)
      }
    }

    // 2) Piezas no cubiertas -> coincidencia difusa o proveedores nuevos
    const candMap = new Map() // clave -> nombre
    for (const frag of fragmentos) {
      const halladosFrag = conocidosEnTexto(frag, conocidos)
      for (const cruda of frag.split(SEPARADORES_PIEZAS)) {
        const pieza = limpiarPieza(cortarContacto(cruda))
        if (!pieza) continue
        if (piezaCubierta(pieza, halladosFrag)) continue
        // La pieza coincide con un nombre conocido aunque este mal escrito
        // en la descripcion (la lista "corrige" la ortografia)
        const difusa = buscarDifusa(pieza, conocidos)
        if (difusa) {
          halladosMap.set(normalizar(difusa.nombre), difusa)
          continue
        }
        const clave = normalizar(pieza)
        if (!clave || halladosMap.has(clave) || clavesConocidas.has(clave)) continue
        candMap.set(clave, pieza)
      }
    }

    const hallados = [...halladosMap.values()]
    const candidatos = [...candMap.values()]
    if (hallados.length === 0 && candidatos.length === 0) {
      pendientes.push(prod)
      continue
    }

    // Registrar relaciones y proveedores nuevos
    const yaEnProducto = new Set()
    for (const h of hallados) {
      const clave = normalizar(h.nombre)
      if (yaEnProducto.has(clave)) continue
      yaEnProducto.add(clave)
      relaciones.push({ producto_id: prod.id, producto: prod, nombre: h.nombre, id: h.id, origen: h.origen, clave })
      if (h.id === null && h.origen === 'lista') {
        if (!nuevosDeLista.has(clave)) nuevosDeLista.set(clave, { nombre: h.nombre, productos: [] })
        nuevosDeLista.get(clave).productos.push(prod.id)
      }
    }
    for (const nombre of candidatos) {
      const clave = normalizar(nombre)
      if (yaEnProducto.has(clave)) continue
      yaEnProducto.add(clave)
      relaciones.push({ producto_id: prod.id, producto: prod, nombre, id: null, origen: 'detectado', clave })
      if (!nuevosDetectados.has(clave)) {
        nuevosDetectados.set(clave, { nombre, productos: [], parecidoA: null })
      }
      nuevosDetectados.get(clave).productos.push(prod.id)
    }

    porProducto.push({ prod, hallados, candidatos })
  }

  // Advertencias de parecido (posible duplicado o error de dedo):
  //  - los detectados automaticamente se comparan contra TODO lo conocido
  //  - los de la lista se comparan solo contra los de la TABLA (ej. alguien
  //    pone QUATEBAGPRINT en la lista pero en la tabla existe GUATEBAGPRINT)
  const conocidosTabla = conocidos.filter((c) => c.origen === 'tabla')
  for (const det of nuevosDetectados.values()) {
    det.parecidoA = parecidoA(det.nombre, conocidos)
  }
  for (const deLista of nuevosDeLista.values()) {
    deLista.parecidoA = parecidoA(deLista.nombre, conocidosTabla)
  }

  let relacionesNuevas = 0
  let relacionesYaExistian = 0
  for (const r of relaciones) {
    if (r.id !== null && existentesSet.has(`${r.producto_id}-${r.id}`)) relacionesYaExistian++
    else relacionesNuevas++
  }

  return {
    conocidos,
    porProducto,
    relaciones,
    nuevosDeLista: [...nuevosDeLista.values()],
    nuevosDetectados: [...nuevosDetectados.values()],
    sinDeteccion,
    pendientes,
    relacionesNuevas,
    relacionesYaExistian,
  }
}

// ============================================================================
// LECTURA DEL .env DEL BACKEND (credenciales automaticas)
// ============================================================================

function leerEnv() {
  const rutas = [path.join(process.cwd(), '.env'), path.join(__dirname, '.env')]
  const vars = {}
  for (const ruta of rutas) {
    try {
      if (!fs.existsSync(ruta)) continue
      for (const lineaRaw of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
        const linea = lineaRaw.trim()
        if (!linea || linea.startsWith('#')) continue
        const eq = linea.indexOf('=')
        if (eq === -1) continue
        const clave = linea.slice(0, eq).replace(/^export\s+/, '').trim()
        let valor = linea.slice(eq + 1).trim()
        if (
          (valor.startsWith('"') && valor.endsWith('"')) ||
          (valor.startsWith("'") && valor.endsWith("'"))
        ) {
          valor = valor.slice(1, -1)
        }
        if (!(clave in vars)) vars[clave] = valor
      }
      console.log(`Archivo .env detectado: ${ruta} -> credenciales leidas de ahi.\n`)
      break
    } catch (_) {
      /* si no se puede leer, se sigue con CONFIG */
    }
  }
  return vars
}

const ENV_KEYS = {
  host: ['DB_HOST', 'MYSQL_HOST'],
  port: ['DB_PORT', 'MYSQL_PORT'],
  user: ['DB_USER', 'DB_USERNAME', 'MYSQL_USER', 'MYSQL_USERNAME'],
  password: ['DB_PASSWORD', 'MYSQL_PASSWORD', 'DB_PASS', 'MYSQL_PASS'],
  database: ['DB_NAME', 'DB_DATABASE', 'MYSQL_DATABASE'],
}

function deEnv(env, clave) {
  for (const k of ENV_KEYS[clave]) {
    if (env[k] !== undefined && env[k] !== '') return env[k]
  }
  return undefined
}

// ============================================================================
// PROGRAMA PRINCIPAL
// ============================================================================

async function main() {
  const mysql = require('mysql2/promise') // lazy: permite probar el analisis sin mysql2

  const env = leerEnv()
  const CONFIG = {
    host: ARGS.host || deEnv(env, 'host') || 'brincocreativo-1-neryvilla-ef6f.a.aivencloud.com',
    port: Number(ARGS.port || deEnv(env, 'port') || 3306),
    user: ARGS.user || deEnv(env, 'user') || 'USUARIO_AQUI',
    password: ARGS.password || deEnv(env, 'password') || 'CONTRASENA_AQUI',
    database: ARGS.database || deEnv(env, 'database') || 'brinco_creativo',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false },
  }

  if (CONFIG.user === 'USUARIO_AQUI' || CONFIG.password === 'CONTRASENA_AQUI') {
    console.error('FALTAN CREDENCIALES:')
    console.error(' - No se encontraron DB_USER/DB_PASSWORD en el .env del backend,')
    console.error('   y CONFIG (dentro de main) sigue con los valores de ejemplo.')
    console.error('')
    console.error('Solucion (elige una):')
    console.error('  a) Guarda este script en la MISMA carpeta donde esta el .env de tu backend.')
    console.error('  b) O abre este archivo y llena user y password en CONFIG (dentro de main).')
    process.exit(1)
  }

  let conn
  try {
    conn = await mysql.createConnection(CONFIG)
    console.log('Conexion establecida.')

    // 1) Asegurar que la tabla exista
    await conn.query(DDL_PRODUCTO_PROVEEDORES)
    console.log('Tabla producto_proveedores verificada/creada.\n')

    // 2) Cargar datos
    const [[info]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usuario')
    const [productos] = await conn.query(
      `SELECT id, nombre, sku, descripcion,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS fecha_alta
         FROM productos`
    )
    const [proveedores] = await conn.query('SELECT id, nombre_empresa FROM proveedores')
    const [relExistentes] = await conn.query('SELECT producto_id, proveedor_id FROM producto_proveedores')

    // ------------------------------------------------------------------
    // 3) DIAGNOSTICO DE CONEXION (verifica que sea la base correcta)
    // ------------------------------------------------------------------
    const linea = '='.repeat(72)
    console.log(linea)
    console.log('DIAGNOSTICO DE CONEXION')
    console.log(linea)
    console.log(`Host.......: ${CONFIG.host}:${CONFIG.port}`)
    console.log(`Base datos.: ${info && info.db}   <- segun SELECT DATABASE()`)
    console.log(`Usuario....: ${info && info.usuario}`)
    console.log(`Productos..: ${productos.length}`)
    console.log(`Proveedores: ${proveedores.length}`)
    console.log('')
    console.log('PRODUCTOS QUE LEE ESTE SCRIPT EN ESTA BASE:')
    for (const p of productos) {
      console.log(`   #${p.id} ${p.sku ? `[${p.sku}] ` : ''}${recortar(p.nombre, 45)} | ${recortar(p.descripcion, 60)}`)
    }
    console.log('')
    console.log('>>> Compara el Host y la Base datos con la conexion que usas en MySQL')
    console.log('>>> Workbench y con la que usa tu backend. Si no ves los mismos')
    console.log('>>> productos arriba, este script leyo OTRA base: corrige el .env,')
    console.log('>>> usa --host=... --database=... o llena CONFIG a mano.')
    const conMencion = productos.filter((p) => /proveedor/i.test(p.descripcion || '')).length
    if (/^(localhost|127\.0\.0\.1)$/i.test(CONFIG.host)) {
      console.log('>>>')
      console.log('>>> OJO: estas conectando a LOCALHOST (tu base local de pruebas).')
      console.log('>>> Para correr contra PRODUCCION (Aiven) agrega:')
      console.log('>>>   --host=brincocreativo-1-neryvilla-ef6f.a.aivencloud.com --port=TU_PUERTO --database=brinco_creativo --user=TU_USUARIO --password="TU_CLAVE"')
    }
    if (productos.length > 0 && conMencion === 0) {
      console.log('>>>')
      console.log('>>> ADVERTENCIA: NINGUN producto contiene la palabra "proveedor"')
      console.log('>>> en su descripcion. Con el formato de datos que usas, esto es')
      console.log('>>> muy raro y casi seguro confirma que es OTRA base de datos.')
    }
    console.log(linea + '\n')

    // ------------------------------------------------------------------
    // 4) Analizar
    // ------------------------------------------------------------------
    const analisis = analizarProductos(productos, proveedores, LISTA_PROVEEDORES, relExistentes)

    // ------------------------------------------------------------------
    // 5) Reporte
    // ------------------------------------------------------------------
    console.log(linea)
    console.log(DRY_RUN ? 'REPORTE (SIMULACION - no se escribio nada)' : 'REPORTE DE MIGRACION')
    console.log(linea)

    console.log('\nDETECCION POR PRODUCTO:')
    if (analisis.porProducto.length === 0) {
      console.log('   (nada detectado)')
    }
    for (const r of analisis.porProducto) {
      const partes = []
      for (const h of r.hallados) {
        partes.push(`${h.nombre} (${h.id !== null ? 'existente' : 'NUEVO, de la lista'})`)
      }
      for (const c of r.candidatos) {
        partes.push(`${c} (NUEVO, detectado)`)
      }
      console.log(`   #${r.prod.id} ${r.prod.sku ? `[${r.prod.sku}] ` : ''}"${recortar(r.prod.nombre, 50)}" -> ${partes.join(' | ')}`)
    }

    console.log(`\nProveedores nuevos a crear (de LISTA_PROVEEDORES): ${analisis.nuevosDeLista.length}`)
    for (const n of analisis.nuevosDeLista) {
      const aviso = n.parecidoA ? `  [!] PARECIDO A "${n.parecidoA}" - posible duplicado, revisar` : ''
      console.log(`   + "${n.nombre}"  (productos: ${n.productos.join(', ')})${aviso}`)
    }

    console.log(`\nProveedores nuevos a crear (detectados, NO estan en la lista): ${analisis.nuevosDetectados.length}`)
    for (const n of analisis.nuevosDetectados) {
      const aviso = n.parecidoA ? `  [!] PARECIDO A "${n.parecidoA}" - posible duplicado, revisar` : ''
      console.log(`   + "${n.nombre}"  (productos: ${n.productos.join(', ')})${aviso}`)
    }

    console.log(`\nRelaciones producto-proveedor a crear: ${analisis.relacionesNuevas}`)
    console.log(`Relaciones que ya existian (se omiten): ${analisis.relacionesYaExistian}`)

    if (analisis.pendientes.length > 0) {
      console.log(`\nMencionan "proveedor" pero no se detecto un nombre claro (revisar):`)
      for (const p of analisis.pendientes) {
        console.log(`   ? #${p.id} [${p.sku || 'sin SKU'}] "${recortar(p.nombre, 50)}" -> "${recortar(p.descripcion, 90)}"`)
      }
    }

    if (analisis.sinDeteccion.length > 0) {
      console.log(`\nSin mencion de proveedor en la descripcion (asignar a mano despues):`)
      for (const p of analisis.sinDeteccion) {
        console.log(`   - #${p.id} [${p.sku || 'sin SKU'}] "${recortar(p.nombre, 50)}"`)
      }
    }
    console.log(linea)

    if (DRY_RUN) {
      console.log('\nEra una SIMULACION (--dry-run): no se modifico nada.')
      console.log('Si algun nombre quedo mal partido o falta, agregalo a')
      console.log('LISTA_PROVEEDORES (al inicio de este script) y repite el --dry-run.')
      console.log('Para aplicar los cambios ejecuta:  node migrar_proveedores_iniciales.js')
      return
    }

    // ------------------------------------------------------------------
    // 6) Aplicar cambios en una transaccion
    // ------------------------------------------------------------------
    await conn.beginTransaction()
    try {
      const idsPorClave = new Map() // clave normalizada -> id del proveedor

      // proveedores existentes
      for (const p of proveedores) idsPorClave.set(normalizar(p.nombre_empresa), p.id)

      // crear los nuevos (de la lista + detectados)
      let creados = 0
      const aCrear = [
        ...analisis.nuevosDeLista.map((n) => ({ nombre: n.nombre, aviso: !!n.parecidoA })),
        ...analisis.nuevosDetectados.map((n) => ({ nombre: n.nombre, aviso: !!n.parecidoA })),
      ]
      for (const n of aCrear) {
        const clave = normalizar(n.nombre)
        if (idsPorClave.has(clave)) continue
        const [res] = await conn.query('INSERT INTO proveedores (nombre_empresa) VALUES (?)', [n.nombre])
        idsPorClave.set(clave, res.insertId)
        creados++
        console.log(`Proveedor creado: "${n.nombre}" (id ${res.insertId})${n.aviso ? '  [!] nombre parecido a otro, revisar' : ''}`)
      }

      // crear relaciones
      let insertadas = 0
      let omitidas = 0
      for (const rel of analisis.relaciones) {
        const proveedorId = rel.id !== null ? rel.id : idsPorClave.get(rel.clave)
        if (!proveedorId) continue
        const [res] = await conn.query(
          `INSERT IGNORE INTO producto_proveedores
             (producto_id, proveedor_id, fecha_ultima_compra, documento, cantidad)
           VALUES (?, ?, ?, 'Carga inicial', NULL)`,
          [rel.producto_id, proveedorId, rel.producto.fecha_alta || null]
        )
        if (res.affectedRows > 0) {
          insertadas++
          console.log(`Relacion: #${rel.producto_id} "${recortar(rel.producto.nombre, 40)}" <-> "${rel.nombre}" (fecha ${rel.producto.fecha_alta || 'n/d'})`)
        } else {
          omitidas++
        }
      }

      await conn.commit()
      console.log('\n' + linea)
      console.log('MIGRACION COMPLETADA')
      console.log(linea)
      console.log(`Proveedores creados: ${creados}`)
      console.log(`Relaciones creadas: ${insertadas}`)
      console.log(`Relaciones omitidas (ya existian): ${omitidas}`)
      console.log(`Productos sin proveedor detectado (asignar a mano): ${analisis.sinDeteccion.length + analisis.pendientes.length}`)
    } catch (errEscritura) {
      await conn.rollback()
      throw errEscritura
    }
  } catch (err) {
    console.error('\nERROR en la migracion:', err.message)
    if (err.code) console.error('Codigo:', err.code)
    console.error('\nRevisa la CONFIG de conexion dentro de main() (host, puerto, user, password, ssl)')
    console.error('o usa --host=... --port=... --database=... en la linea de comandos.')
    process.exitCode = 1
  } finally {
    if (conn) await conn.end()
  }
}

// ============================================================================
// Exportado para pruebas; se ejecuta solo si lo llamas directo con node
// ============================================================================
module.exports = {
  LISTA_PROVEEDORES,
  normalizar,
  tokensDe,
  sinSufijosLegales,
  variantesTokens,
  contieneSecuencia,
  extraerFragmentos,
  cortarContacto,
  limpiarPieza,
  construirConocidos,
  conocidosEnTexto,
  buscarDifusa,
  piezaCubierta,
  parecidoA,
  analizarProductos,
}

if (require.main === module) {
  main()
}
