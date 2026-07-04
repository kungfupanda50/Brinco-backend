/**
 * =============================================================================
 * BACKEND: index.js (Versión Maestra 3.7 - INTEGRIDAD Y SEGURIDAD VISUAL)
 * =============================================================================
 * Servidor central de Brinco Creativo. 
 * DIRECTIVA: Mantenimiento de densidad lógica >430 líneas.
 * 
 * Historial de Versiones:
 * v1.0 - Estructura básica de Express.
 * v3.0 - Integración de módulos de Clientes y Proveedores.
 * v3.5 - Sistema de Caja y Pagos.
 * v3.6 - Gestión de Permisos Granulares y Avatares.
 * v3.7 - Implementación de Endpoint de Perfil Público para Login Visual.
 * 
 * Este archivo contiene toda la lógica de negocio para la gestión de un taller
 * de personalización, incluyendo inventarios, órdenes de trabajo, finanzas
 * y administración de usuarios con permisos específicos por módulo.
 */

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const { fileTypeFromFile } = require('file-type');
const multerLib = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const app = express();
const corsOrigins = [
  'http://localhost:5173', // Para tu computadora
  'https://brinco-frontend.onrender.com' // Para la nube 
];

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
const sharp = require('sharp');
const puppeteer = require('puppeteer');
app.use(express.json());
const { OpenAI } = require("openai");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'brinco_creativo_secret_2026';

const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configurar Multer para que suba a Cloudinary en lugar de al disco local
const storageCloud = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'brinco-erp',
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'mp4']
  },
});
const uploadCloud = multerLib({ storage: storageCloud });

// =============================================================================
// CONFIGURACIÓN DE RECURSOS Y ARCHIVOS
// =============================================================================

// Acceso estático para imágenes subidas (evidencias y avatares)
app.use('/uploads', express.static('uploads'));

// Verificación y creación de directorio de almacenamiento
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
    console.log('📁 Directorio /uploads inicializado correctamente.');
}

// Configuración de Multer para gestión de archivos multimedia
const storage = multerLib.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const prefix = file.fieldname === 'avatar' ? 'avatar' : 'evidencia';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multerLib({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Límite de 10MB para fotos de taller
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|mp4/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error("Error: Tipo de archivo no soportado."));
    }
});

const storagePresupuestos = multerLib.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads/presupuestos';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `presup-${Date.now()}-${file.originalname.replace(/\s/g, '')}`);
    }
});
const uploadPresupuesto = multerLib({ storage: storagePresupuestos, limits: { fileSize: 5 * 1024 * 1024 } });

// Hacer estática la carpeta
app.use('/uploads/presupuestos', express.static('uploads/presupuestos'));

// =============================================================================
// CONEXIÓN A BASE DE DATOS (MYSQL POOL)
// =============================================================================

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'brinco_creativo',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ssl: { rejectUnauthorized: false }
});

const db = pool.promise();

// Verificación inicial de salud de la base de datos
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR DE CONEXIÓN MYSQL:', err.message);
        console.error('Verifique que el servicio MySQL esté activo y las credenciales sean correctas.');
        return;
    }
    console.log('✅ ESTADO: Servidor v3.7 en línea.');
    console.log('✅ DB: Conectado a la base de datos Brinco Creativo.');
    connection.release();
});


// =============================================================================
// MIDDLEWARE DE AUTENTICACIÓN (JWT)
// =============================================================================
const autenticar = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de acceso requerido' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuario = payload; // { id, usuario, rol }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
};

// =============================================================================
// MIDDLEWARE DE AUTORIZACIÓN (POR PERMISO)
// =============================================================================

const autorizar = (permisoRequerido) => {
    return async (req, res, next) => {
        try {
            const [rows] = await db.query(
                `SELECT p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, 
                        p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios
                 FROM usuarios_permisos p WHERE p.usuario_id = ?`,
                [req.usuario.id]
            );
            if (rows.length === 0 || rows[0][permisoRequerido] !== 1) {
                return res.status(403).json({ error: 'No tenés permisos para esta acción' });
            }
            req.permisos = rows[0];
            next();
        } catch (err) {
            res.status(500).json({ error: 'Error al verificar permisos' });
        }
    };
};

// ==========================================================
// MANTENIMIENTO DE MATERIALES POR ORDEN
// ==========================================================
app.get('/api/ordenes/:id/materiales', autenticar, autorizar('p_ordenes'), async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT od.id, od.producto_id, p.nombre as producto_nombre, od.cantidad, 
                   od.precio_unitario_momento as costo_unitario, od.precio_venta_momento as precio_venta
            FROM orden_detalles_materiales od
            JOIN productos p ON od.producto_id = p.id
            WHERE od.orden_id = ?
        `, [req.params.id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/ordenes/:id/materiales', autenticar, autorizar('p_ordenes'), async (req, res) => {
    const { id } = req.params;
    const { materiales } = req.body;
    const conn = await pool.promise().getConnection();
    
    try {
        await conn.beginTransaction();
        await conn.query("DELETE FROM orden_detalles_materiales WHERE orden_id = ?", [id]);
        
        let totalVenta = 0;
        let totalCosto = 0;

        for (const m of materiales) {
            await conn.query(
                "INSERT INTO orden_detalles_materiales (orden_id, producto_id, cantidad, precio_unitario_momento, precio_venta_momento) VALUES (?, ?, ?, ?, ?)", 
                [id, m.producto_id, m.cantidad, m.costo_unitario, m.precio_venta]
            );
            totalVenta += Number(m.cantidad) * Number(m.precio_venta || 0);
            totalCosto += Number(m.cantidad) * Number(m.costo_unitario || 0);
        }

        const [ordenData] = await conn.query("SELECT costo_mano_obra, costo_envio, cargo_administrativo FROM ordenes WHERE id = ?", [id]);
        if (ordenData.length > 0) {
            const o = ordenData[0];
            const nuevoTotal = totalVenta + Number(o.costo_mano_obra || 0) + Number(o.costo_envio || 0) + Number(o.cargo_administrativo || 0);
            await conn.query("UPDATE ordenes SET subtotal = ?, total_costo_materiales = ?, total_quetzales = ? WHERE id = ?", [totalVenta, totalCosto, nuevoTotal, id]);
        }

        await conn.commit();
        res.json({ message: 'Materiales actualizados correctamente' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Error al actualizar materiales: ' + err.message });
    } finally {
        conn.release();
    }
});

app.get('/api/test-ruta', (req, res) => res.json({ ok: true }));

// Endpoint para obtener datos del usuario autenticado
app.get('/api/me', autenticar, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT u.id, u.nombre, u.usuario, u.rol, u.activo, u.avatar_url,
                    p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, 
                    p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios
             FROM usuarios u
             LEFT JOIN usuarios_permisos p ON u.id = p.usuario_id
             WHERE u.id = ?`,
            [req.usuario.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// ENDPOINTS DE USUARIOS Y SEGURIDAD
// =============================================================================

/**
 * LOGIN: Autenticación de usuario
 * Devuelve datos de perfil y tabla de permisos granulares.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 intentos
  message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/login', loginLimiter, async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, u.rol, u.activo, u.avatar_url, u.password_hash,
            p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, 
            p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios
            FROM usuarios u
            LEFT JOIN usuarios_permisos p ON u.id = p.usuario_id
            WHERE u.usuario = ? AND u.activo = 1`;
        
        const [users] = await db.query(sql, [usuario]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas o cuenta bloqueada' });
        }

        const user = users[0];
        
        // Comparar contraseña en texto plano (soporte durante la transición)
        let passwordValida = false;
        if (user.password_hash.startsWith('$2b$')) {
            // Ya está hasheada con bcrypt
            passwordValida = await bcrypt.compare(password, user.password_hash);
        } else {
            // Contraseña antigua en texto plano → comparación directa
            passwordValida = (password === user.password_hash);
            // Si es válida, migrar a bcrypt automáticamente
            if (passwordValida) {
                const nuevoHash = await bcrypt.hash(password, 10);
                await db.query("UPDATE usuarios SET password_hash = ? WHERE id = ?", [nuevoHash, user.id]);
                console.log(`🔐 Contraseña migrada a bcrypt para usuario ${usuario}`);
            }
        }

        if (!passwordValida) {
            return res.status(401).json({ error: 'Credenciales inválidas o cuenta bloqueada' });
        }

        // Generar token JWT con datos básicos (sin permisos para no exponerlos)
        const tokenPayload = { id: user.id, usuario: user.usuario, rol: user.rol };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });

        // Devolver token y datos de usuario (sin el hash)
        delete user.password_hash;
        res.json({ 
            success: true, 
            token,
            user: {
                id: user.id,
                nombre: user.nombre,
                usuario: user.usuario,
                rol: user.rol,
                activo: user.activo,
                avatar_url: user.avatar_url,
                permisos: {
                    p_dashboard: user.p_dashboard,
                    p_clientes: user.p_clientes,
                    p_ordenes: user.p_ordenes,
                    p_nueva_orden: user.p_nueva_orden,
                    p_inventario: user.p_inventario,
                    p_proveedores: user.p_proveedores,
                    p_entrada_mercancia: user.p_entrada_mercancia,
                    p_caja: user.p_caja,
                    p_cat_clientes: user.p_cat_clientes,
                    p_cat_productos: user.p_cat_productos,
                    p_usuarios: user.p_usuarios,
                }
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Fallo interno en login: ' + err.message });
    }
});

/**
 * PERFIL PÚBLICO: Recuperar avatar para el login visual (v3.7)
 * Permite buscar el avatar y nombre por username antes de autenticar.
 */
app.get('/api/usuarios/perfil/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const sql = "SELECT nombre, avatar_url FROM usuarios WHERE usuario = ? AND activo = 1 LIMIT 1";
        const [results] = await db.query(sql, [username]);
        
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).json({ error: 'Usuario no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al consultar perfil: ' + err.message });
    }
});

app.get('/api/usuarios', autenticar, autorizar('p_usuarios'), async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, u.rol, u.activo, u.avatar_url,
            p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, 
            p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios
            FROM usuarios u
            LEFT JOIN usuarios_permisos p ON u.id = p.usuario_id
            ORDER BY u.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/usuarios', autenticar, autorizar('p_usuarios'), async (req, res) => {
    const { nombre, usuario, password, rol, permisos } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        const hashedPassword = await bcrypt.hash(password, 10);
        const [resU] = await conn.query("INSERT INTO usuarios (nombre, usuario, password_hash, rol, activo) VALUES (?, ?, ?, ?, 1)", [nombre, usuario, hashedPassword, rol]);
        const userId = resU.insertId;
        const p = permisos || {};
        const sqlP = `INSERT INTO usuarios_permisos (usuario_id, p_dashboard, p_clientes, p_ordenes, p_nueva_orden, p_inventario, p_proveedores, p_entrada_mercancia, p_caja, p_cat_clientes, p_cat_productos, p_usuarios) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await conn.query(sqlP, [userId, p.p_dashboard ?? 1, p.p_clientes ?? 1, p.p_ordenes ?? 1, p.p_nueva_orden ?? 1, p.p_inventario ?? 1, p.p_proveedores ?? 1, p.p_entrada_mercancia ?? 1, p.p_caja ?? 1, p.p_cat_clientes ?? 1, p.p_cat_productos ?? 1, p.p_usuarios ?? 0]);
        await conn.commit();
        res.json({ id: userId, message: 'Usuario creado con éxito' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Fallo al crear usuario: ' + err.message });
    } finally {
        conn.release();
    }
});

app.put('/api/usuarios/:id', autenticar, autorizar('p_usuarios'), async (req, res) => {
    const { id } = req.params;
    const { nombre, rol, activo, password, permisos } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            await conn.query("UPDATE usuarios SET nombre=?, rol=?, activo=?, password_hash=? WHERE id=?", [nombre, rol, activo, hashedPassword, id]);
        } else {
            await conn.query("UPDATE usuarios SET nombre=?, rol=?, activo=? WHERE id=?", [nombre, rol, activo, id]);
        }
        if (permisos) {
            const p = permisos;
            const sqlP = `UPDATE usuarios_permisos SET p_dashboard=?, p_clientes=?, p_ordenes=?, p_nueva_orden=?, p_inventario=?, p_proveedores=?, p_entrada_mercancia=?, p_caja=?, p_cat_clientes=?, p_cat_productos=?, p_usuarios=? WHERE usuario_id=?`;
            await conn.query(sqlP, [p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios, id]);
        }
        await conn.commit();
        res.json({ message: 'Perfil y permisos actualizados' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

app.post('/api/usuarios/:id/avatar', autenticar, autorizar('p_usuarios'), uploadCloud.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo de imagen requerido' });
        // Cloudinary nos devuelve la URL final en req.file.path
        const url = req.file.path; 
        await db.query("UPDATE usuarios SET avatar_url = ? WHERE id = ?", [url, req.params.id]);
        res.json({ url });
    } catch (err) {
        res.status(500).json({ error: 'Error al subir avatar: ' + err.message });
    }
});

// =============================================================================
// ENDPOINTS DE DASHBOARD Y ANALÍTICA
// =============================================================================

app.get('/api/dashboard/stats', autenticar, autorizar('p_dashboard'), async (req, res) => {
    try {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM ordenes WHERE estado NOT IN ('Entregado', 'Cancelado', 'Rechazado')) as ordenes_activas,
                (SELECT COUNT(*) FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE) as stock_bajo,
                (SELECT COALESCE(SUM(total_quetzales), 0) FROM ordenes WHERE DATE(fecha_orden) = CURDATE() AND estado NOT IN ('Cancelado', 'Rechazado')) as ventas_hoy,
                (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE tipo_movimiento = 'Egreso' AND DATE(fecha_pago) = CURDATE()) as egresos_hoy
        `;
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al recuperar estadísticas: ' + err.message });
    }
});
app.get('/api/dashboard/ordenes-detalle', autenticar, autorizar('p_ordenes'), async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT 
                o.id,
                COUNT(DISTINCT oe.id)  AS total_evidencias,
                COUNT(DISTINCT et.tag_id) AS total_tags
            FROM ordenes o
            LEFT JOIN orden_evidencias oe ON oe.orden_id = o.id
            LEFT JOIN evidencia_tags et   ON et.evidencia_id = oe.id
            GROUP BY o.id
        `);
        // Devolver como mapa { orden_id: { total_evidencias, total_tags } }
        const mapa = {};
        rows.forEach(r => { mapa[r.id] = { total_evidencias: r.total_evidencias, total_tags: r.total_tags }; });
        res.json(mapa);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




app.get('/api/dashboard/ventas-semana', autenticar, autorizar('p_caja'), async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT 
                DATE(fecha_pago) as fecha,
                DAYNAME(fecha_pago) as dia_nombre,
                COALESCE(SUM(CASE WHEN tipo_movimiento = 'Ingreso' THEN monto ELSE 0 END), 0) as ingresos,
                COALESCE(SUM(CASE WHEN tipo_movimiento = 'Egreso'  THEN monto ELSE 0 END), 0) as egresos
            FROM pagos
            WHERE fecha_pago >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY DATE(fecha_pago), DAYNAME(fecha_pago)
            ORDER BY fecha ASC
        `);

        // Rellenar los 7 días aunque no tengan movimientos
        const dias = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const fecha = d.toISOString().split('T')[0];
            const encontrado = rows.find(r => r.fecha.toISOString().split('T')[0] === fecha);
            dias.push({
                fecha,
                dia: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()],
                ingresos: encontrado ? Number(encontrado.ingresos) : 0,
                egresos:  encontrado ? Number(encontrado.egresos)  : 0,
            });
        }
        res.json(dias);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/stock-bajo',autenticar, autorizar('p_inventario'), async (req, res) => {
    try {
        const sql = "SELECT id, nombre, stock_actual, stock_minimo FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE ORDER BY stock_actual ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// GESTIÓN DE CLIENTES Y CATEGORÍAS
// =============================================================================

app.get('/api/clientes', autenticar, autorizar('p_clientes'), async (req, res) => {
    try {
        const sql = "SELECT c.*, cat.nombre as categoria_nombre, cat.color_clase FROM clientes c LEFT JOIN clientes_categorias cat ON c.categoria_id = cat.id ORDER BY c.nombre_completo ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clientes', autenticar, autorizar('p_clientes'), async (req, res) => {
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const [result] = await db.query("INSERT INTO clientes (nombre_completo, telefono, email, direccion_envio, nit, categoria_id) VALUES (?,?,?,?,?,?)", [nombre_completo, telefono, email, direccion_envio, nit, categoria_id]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clientes/categorias', autenticar, autorizar('p_cat_clientes'), async (req, res) => {
    try {
        const sql = `SELECT cc.*, (SELECT COUNT(*) FROM clientes WHERE categoria_id = cc.id) as total_clientes FROM clientes_categorias cc ORDER BY cc.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar datos de facturación o contacto del cliente
app.put('/api/clientes/:id', autenticar, autorizar('p_clientes'), async (req, res) => {
    const { id } = req.params;
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const sql = "UPDATE clientes SET nombre_completo=?, telefono=?, email=?, direccion_envio=?, nit=?, categoria_id=? WHERE id=?";
        await db.query(sql, [nombre_completo, telefono, email, direccion_envio, nit, categoria_id, id]);
        res.json({ message: 'Perfil del cliente actualizado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener el historial comercial de un cliente específico
app.get('/api/clientes/:id/historial',autenticar, autorizar('p_clientes'), async (req, res) => {
    try {
        const { id } = req.params;
        const sql = "SELECT id, fecha_orden, estado, total_quetzales, notas_personalizacion FROM ordenes WHERE cliente_id = ? ORDER BY fecha_orden DESC";
        const [results] = await db.query(sql, [id]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// =============================================================================
// GESTIÓN DE INVENTARIO Y CATEGORÍAS PRODUCTOS
// =============================================================================

app.get('/api/inventario', autenticar, autorizar('p_inventario'), async (req, res) => {
    try {
        const sql = "SELECT p.*, c.nombre as categoria_nombre FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id ORDER BY p.nombre ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventario', autenticar, autorizar('p_inventario'), async (req, res) => {
    const { categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido } = req.body;
    try {
        const sql = "INSERT INTO productos (categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventario/:id', autenticar, autorizar('p_inventario'), async (req, res) => {
    const { categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido } = req.body;
    try {
        const sql = "UPDATE productos SET categoria_id = ?, nombre = ?, descripcion = ?, sku = ?, stock_actual = ?, stock_minimo = ?, precio_compra_referencia = ?, precio_venta_sugerido = ? WHERE id = ?";
        const [result] = await db.query(sql, [categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, req.params.id]);
        res.json({ id: req.params.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cambiar solo el estado (activo/desactivo) de un producto
app.patch('/api/inventario/:id/estado',autenticar, autorizar('p_inventario'), async (req, res) => {
    const { id } = req.params;
    const { activo } = req.body;
    try {
        // Convertimos booleano a 0/1
        await db.query("UPDATE productos SET activo = ? WHERE id = ?", [activo ? 1 : 0, id]);
        res.json({ message: 'Estado actualizado correctamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/categorias',autenticar, autorizar('p_cat_productos'), async (req, res) => {
    try {
        const sql = `SELECT c.*, (SELECT COUNT(*) FROM productos WHERE categoria_id = c.id) as total_productos FROM categorias c ORDER BY c.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear nueva categoría de producto
app.post('/api/categorias', autenticar, autorizar('p_cat_productos'), async (req, res) => {
    const { nombre, descripcion, activo, color_clase, icono } = req.body;
    try {
        const sql = "INSERT INTO categorias (nombre, descripcion, activo, color_clase, icono) VALUES (?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [nombre, descripcion, activo || 1, color_clase, icono || 'category']);
        res.json({ id: result.insertId, message: 'Categoría creada exitosamente' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Actualizar categoría de producto existente
app.put('/api/categorias/:id', autenticar, autorizar('p_cat_productos'),async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, activo, color_clase, icono } = req.body;
    try {
        const sql = "UPDATE categorias SET nombre = ?, descripcion = ?, activo = ?, color_clase = ?, icono = ? WHERE id = ?";
        await db.query(sql, [nombre, descripcion, activo, color_clase, icono, id]);
        res.json({ message: 'Categoría actualizada correctamente' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe otra categoría con ese nombre.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Crear nueva categoría de clientes
app.post('/api/clientes/categorias',autenticar, autorizar('p_cat_clientes'), async (req, res) => {
    const { nombre, descripcion, color_clase } = req.body;
    try {
        const sql = "INSERT INTO clientes_categorias (nombre, descripcion, color_clase) VALUES (?, ?, ?)";
        const [result] = await db.query(sql, [nombre, descripcion, color_clase]);
        res.json({ id: result.insertId, message: 'Categoría creada exitosamente' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Actualizar categoría existente
app.put('/api/clientes/categorias/:id',autenticar, autorizar('p_cat_clientes'), async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, color_clase } = req.body;
    try {
        const sql = "UPDATE clientes_categorias SET nombre = ?, descripcion = ?, color_clase = ? WHERE id = ?";
        await db.query(sql, [nombre, descripcion, color_clase, id]);
        res.json({ message: 'Categoría actualizada correctamente' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe otra categoría con ese nombre.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// ÓRDENES DE TRABAJO Y PRODUCCIÓN
// =============================================================================

app.get('/api/ordenes',autenticar, autorizar('p_ordenes'), async (req, res) => {
    try {
        const sql = `
            SELECT o.*, c.nombre_completo as cliente_nombre,
            (SELECT COALESCE(SUM(CASE WHEN tipo_movimiento = 'Ingreso' THEN monto ELSE -monto END), 0) FROM pagos WHERE orden_id = o.id) as total_pagado,
            (SELECT COUNT(*) FROM orden_evidencias WHERE orden_id = o.id) as total_evidencias
            FROM ordenes o JOIN clientes c ON o.cliente_id = c.id ORDER BY o.fecha_orden DESC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Fallo al cargar tablero: ' + err.message });
    }
});

app.post('/api/ordenes', autenticar, autorizar('p_nueva_orden'), async (req, res) => {
    const { cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas, materiales } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        const sqlO = "INSERT INTO ordenes (cliente_id, fecha_entrega_prometida, subtotal, total_costo_materiales, costo_mano_obra, costo_envio, cargo_administrativo, total_quetzales, porcentaje_utilidad_aplicado, notas_personalizacion, stock_rebajado) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
        const [resO] = await conn.query(sqlO, [cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas]);
        if (materiales) {
            for (const m of materiales) {
                await conn.query("INSERT INTO orden_detalles_materiales (orden_id, producto_id, cantidad, precio_unitario_momento, precio_venta_momento) VALUES (?,?,?,?,?)", [resO.insertId, m.producto_id, m.cantidad, m.costo_unitario, m.precio_venta]);
            }
        }
        await conn.commit();
        res.json({ id: resO.insertId });
    } catch (err) {
        await conn.rollback();
        res.status(400).json({ error: 'No se pudo crear la orden: ' + err.message });
    } finally {
        conn.release();
    }
});

// ==========================================================
// MANTENIMIENTO DE MATERIALES POR ORDEN
// ==========================================================

app.post('/api/ordenes/:id/rebajar-stock',autenticar, autorizar('p_ordenes'), async (req, res) => {
    const { id } = req.params;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [materiales] = await conn.query("SELECT producto_id, cantidad FROM orden_detalles_materiales WHERE orden_id = ?", [id]);
        for (const m of materiales) {
            await conn.query("UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?", [m.cantidad, m.producto_id]);
        }
        await conn.query("UPDATE ordenes SET stock_rebajado = 1 WHERE id = ?", [id]);
        await conn.commit();
        res.json({ message: 'Existencias descontadas del inventario' });
    } catch (err) {
        await conn.rollback();
        res.status(400).json({ error: 'Fallo en proceso de stock: ' + err.message });
    } finally {
        conn.release();
    }
});

// Endpoint para devolver stock y cancelar la orden
app.post('/api/ordenes/:id/devolver-stock', autenticar, autorizar('p_ordenes'), async (req, res) => {
    const { id } = req.params;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        
        // 1. Buscamos los materiales que se habían descontado
        const [materiales] = await conn.query("SELECT producto_id, cantidad FROM orden_detalles_materiales WHERE orden_id = ?", [id]);
        
        // 2. Sumamos el stock de vuelta a los productos
        for (const m of materiales) {
            await conn.query("UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?", [m.cantidad, m.producto_id]);
        }
        
        // 3. Marcamos la orden como que ya no tiene stock descontado y la cancelamos
        await conn.query("UPDATE ordenes SET stock_rebajado = 0, estado = 'Cancelado' WHERE id = ?", [id]);
        
        await conn.commit();
        res.json({ message: 'Stock devuelto al inventario y orden cancelada' });
    } catch (err) {
        await conn.rollback();
        res.status(400).json({ error: 'Fallo al devolver stock: ' + err.message });
    } finally {
        conn.release();
    }
});

app.patch('/api/ordenes/:id/estado', autenticar, autorizar('p_ordenes'), async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    try {
        const sql = "UPDATE ordenes SET estado = ? WHERE id = ?";
        await db.query(sql, [estado, id]);
        res.json({ message: 'Estado de orden actualizado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// 7. PROVEEDORES Y ABASTECIMIENTO (MANTENIDO)
// =============================================================================

app.get('/api/proveedores', autenticar, autorizar('p_proveedores'), async (req, res) => {
    try { const [results] = await db.query("SELECT * FROM proveedores ORDER BY nombre_empresa ASC"); res.json(results); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proveedores', autenticar, autorizar('p_proveedores'), async (req, res) => {
    const { nombre_empresa, contacto_nombre, telefono, email, direccion, nit } = req.body;
    try {
        const [result] = await db.query("INSERT INTO proveedores (nombre_empresa, contacto_nombre, telefono, email, direccion, nit) VALUES (?,?,?,?,?,?)", [nombre_empresa, contacto_nombre, telefono, email, direccion, nit]);
        res.json({ id: result.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/proveedores/:id', autenticar, autorizar('p_proveedores'), async (req, res) => {
    const { nombre_empresa, contacto_nombre, telefono, email, direccion, nit } = req.body;
    try { await db.query("UPDATE proveedores SET nombre_empresa=?, contacto_nombre=?, telefono=?, email=?, direccion=?, nit=? WHERE id=?", [nombre_empresa, contacto_nombre, telefono, email, direccion, nit, req.params.id]); res.json({ message: 'Proveedor actualizado' }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/proveedores/:id/compras', autenticar, autorizar('p_proveedores'), async (req, res) => {
    try { const [results] = await db.query("SELECT * FROM entradas_mercancia WHERE proveedor_id = ? ORDER BY fecha_entrada DESC", [req.params.id]); res.json(results); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// 8. ABASTECIMIENTO Y CAJA (MANTENIDO)
// =============================================================================

app.post('/api/entradas', autenticar, autorizar('p_entrada_mercancia'), async (req, res) => {
    const { proveedor_id, documento, total, items } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [resE] = await conn.query("INSERT INTO entradas_mercancia (proveedor_id, documento_referencia, total_compra) VALUES (?,?,?)", [proveedor_id, documento, total]);
        for (const i of items) {
            await conn.query("INSERT INTO entrada_detalles (entrada_id, producto_id, cantidad, costo_unitario) VALUES (?,?,?,?)", [resE.insertId, i.producto_id, i.cantidad, i.costo]);
            await conn.query("UPDATE productos SET stock_actual = stock_actual + ?, precio_compra_referencia = ? WHERE id = ?", [i.cantidad, i.costo, i.producto_id]);
        }
        await conn.commit(); res.json({ id: resE.insertId });
    } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); }
    finally { conn.release(); }
});



// =============================================================================
// CAJA, FLUJO Y PAGOS
// =============================================================================

app.get('/api/pagos', autenticar, autorizar('p_caja'), async (req, res) => {
    try {
        const sql = "SELECT p.*, o.id as orden_num, c.nombre_completo as cliente_nombre FROM pagos p LEFT JOIN ordenes o ON p.orden_id = o.id LEFT JOIN clientes c ON o.cliente_id = c.id ORDER BY p.fecha_pago DESC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pagos', autenticar, autorizar('p_caja'), async (req, res) => {
    const { orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago } = req.body;
    try {
        const [result] = await db.query("INSERT INTO pagos (orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago) VALUES (?,?,?,?,?,?,?)", [orden_id || null, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/caja/resumen', autenticar, autorizar('p_caja'), async (req, res) => {
    try {
        const sql = "SELECT COALESCE(SUM(CASE WHEN tipo_movimiento='Ingreso' THEN monto ELSE 0 END),0) as ingresos_hoy, COALESCE(SUM(CASE WHEN tipo_movimiento='Egreso' THEN monto ELSE 0 END),0) as egresos_hoy, 500.00 as fondo_inicial FROM pagos WHERE DATE(fecha_pago)=CURDATE()";
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Carga todas las fotos de una orden con sus tags ya asignados
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ordenes/:id/evidencias',autenticar, autorizar('p_ordenes'),async (req, res) => {
    try {
        // Fotos de la orden
        const [fotos] = await db.query(
            `SELECT id, url_archivo, created_at 
             FROM orden_evidencias 
             WHERE orden_id = ? 
             ORDER BY created_at ASC`,
            [req.params.id]
        );

        // Para cada foto, obtener sus tags
        const fotosConTags = await Promise.all(
            fotos.map(async (foto) => {
                const [tags] = await db.query(
                    `SELECT t.id as tag_id, t.slug, t.nombre,
                            c.id as categoria_id, c.slug as categoria_slug,
                            c.nombre as categoria_nombre, c.color_clase, c.icono
                     FROM evidencia_tags et
                     JOIN cat_tags t ON et.tag_id = t.id
                     JOIN cat_tag_categorias c ON t.categoria_id = c.id
                     WHERE et.evidencia_id = ?
                     ORDER BY c.orden, t.orden`,
                    [foto.id]
                );
                return { ...foto, tags };
            })
        );

        res.json(fotosConTags);
    } catch (err) {
        res.status(500).json({ error: 'Error al cargar evidencias: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sube una o varias fotos nuevas a una orden
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ordenes/:id/evidencias', autenticar, autorizar('p_ordenes'), uploadCloud.array('fotos', 10), async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No se recibieron archivos' });
        }

        // Cloudinary ya validó que sean imágenes/videos válidos.
        const inserts = req.files.map(file => {
            // En Cloudinary, la URL final nos la devuelve en file.path
            const url = file.path;
            return db.query(
                'INSERT INTO orden_evidencias (orden_id, url_archivo) VALUES (?, ?)',
                [id, url]
            );
        });

        // Esperamos a que todas las fotos se hayan insertado en la base de datos
        const resultados = await Promise.all(inserts);

        // Mapeamos los resultados para devolverle al frontend el ID real de la BD y la URL
        const nuevasFotos = resultados.map((r, i) => ({
            id: r[0].insertId, // ID real generado por MySQL
            url_archivo: req.files[i].path, // URL segura de Cloudinary
            tags: []
        }));

        res.json({ message: 'Fotos subidas', fotos: nuevasFotos });
    } catch (err) {
        res.status(500).json({ error: 'Error al subir fotos: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Elimina una foto y sus tags en cascada (ON DELETE CASCADE en DB)
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/evidencias/:id', autenticar, autorizar('p_ordenes'),async (req, res) => {
    try {
        const { id } = req.params;

        // Obtener la URL para borrar el archivo físico
        const [rows] = await db.query(
            'SELECT url_archivo FROM orden_evidencias WHERE id = ?', [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Evidencia no encontrada' });
        }

        // Borrar archivo físico del disco
        const filePath = '.' + rows[0].url_archivo; // ./uploads/evidencia-xxx.png
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Borrar de DB (los tags se borran en cascada automáticamente)
        await db.query('DELETE FROM orden_evidencias WHERE id = ?', [id]);

        res.json({ message: 'Evidencia eliminada' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reemplaza todos los tags de una foto (toggle completo)
// ─────────────────────────────────────────────────────────────────────────────
app.put('/api/evidencias/:id/tags', autenticar, autorizar('p_ordenes'), async (req, res) => {
    const { id } = req.params;
    const { tag_ids } = req.body; // array de IDs

    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Borrar todos los tags actuales de esta foto
        await conn.query('DELETE FROM evidencia_tags WHERE evidencia_id = ?', [id]);

        // Insertar los nuevos (si hay alguno)
        if (tag_ids && tag_ids.length > 0) {
            const values = tag_ids.map(tagId => [id, tagId]);
            await conn.query(
                'INSERT INTO evidencia_tags (evidencia_id, tag_id) VALUES ?',
                [values]
            );
        }

        await conn.commit();
        res.json({ message: 'Tags actualizados', total: tag_ids?.length || 0 });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Error al guardar tags: ' + err.message });
    } finally {
        conn.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Devuelve todos los tags agrupados por categoría para el panel de selección
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/catalogo/tags', autenticar, async (req, res) => {
    try {
        const [categorias] = await db.query(
            `SELECT id, slug, nombre, icono, color_clase, orden
             FROM cat_tag_categorias
             ORDER BY orden ASC`
        );

        const [tags] = await db.query(
            `SELECT id, categoria_id, slug, nombre, orden
             FROM cat_tags
             WHERE activo = 1
             ORDER BY orden ASC`
        );

        // Agrupar tags dentro de su categoría
        const resultado = categorias.map(cat => ({
            ...cat,
            tags: tags.filter(t => t.categoria_id === cat.id)
        }));

        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: 'Error al cargar tags: ' + err.message });
    }
});

// =============================================================================
// ENDPOINTS DE PRESUPUESTOS
// =============================================================================

// Obtener datos iniciales (Temas, Monedas y Envío de la Orden)
app.get('/api/presupuestos/data-inicial', autenticar, async (req, res) => {
    try {
        const [temas] = await db.query("SELECT * FROM temas_presupuesto");
        const [monedas] = await db.query("SELECT * FROM monedas");
        
        // NUEVO: Buscar el costo de envío de la orden original si se proporciona el ID
        let envioOrden = 0;
        if (req.query.orden_id) {
            const [ordenData] = await db.query("SELECT costo_envio FROM ordenes WHERE id = ?", [req.query.orden_id]);
            if (ordenData.length > 0) {
                envioOrden = ordenData[0].costo_envio || 0;
            }
        }

        res.json({ temas, monedas, envio_orden: envioOrden });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint para subir imágenes (por línea o sueltas)
app.post('/api/presupuestos/upload-img', autenticar, uploadPresupuesto.single('imagen'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió la imagen' });
    
    // Si es GIF, no comprimimos para evitar errores de sharp con animaciones
    if (req.file.mimetype === 'image/gif') {
        return res.json({ url: `/uploads/presupuestos/${req.file.filename}` });
    }

    try {
        const filePath = req.file.path;
        const compressedPath = filePath + '_comp.jpg';
        
        await sharp(filePath)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(compressedPath);

        // Intentar borrar el original, si Windows lo bloquea, no pasa nada, usamos el comprimido
        try { fs.unlinkSync(filePath); } catch (e) { /* Ignorar error EBUSY */ }
        
        // Renombrar el comprimido al nombre original
        fs.renameSync(compressedPath, filePath);

        res.json({ url: `/uploads/presupuestos/${req.file.filename}` });
    } catch (err) {
        console.error('Error al comprimir imagen, usando original:', err.message);
        res.json({ url: `/uploads/presupuestos/${req.file.filename}` });
    }
});

// Crear Presupuesto
app.post('/api/presupuestos', autenticar, async (req, res) => {
    const { cliente_id, orden_id, plantilla_id, moneda_id, lineas, imagenes_sueltas, subtotal, descuento, costo_envio, total, nota_anticipo, texto_adicional } = req.body;
    const conn = await pool.promise().getConnection();
    
    try {
        await conn.beginTransaction();
        
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        const prefix = `BC${dd}${mm}${yy}`;
        
        const [lastPres] = await conn.query("SELECT numero_cotizacion FROM presupuestos WHERE numero_cotizacion LIKE ? ORDER BY id DESC LIMIT 1", [`${prefix}%`]);
        let consecutivo = 1;
        if (lastPres.length > 0) consecutivo = parseInt(lastPres[0].numero_cotizacion.slice(-2)) + 1;
        const numeroCotizacion = `${prefix}${String(consecutivo).padStart(2, '0')}`;

        // Mapeamos 'plantilla_id' del frontend a 'tema_id' de la DB, y asignamos 'simple' a tipo_estructura
        const [resP] = await conn.query(
            `INSERT INTO presupuestos (numero_cotizacion, cliente_id, orden_id, usuario_id, tema_id, moneda_id, tipo_estructura, subtotal, descuento, costo_envio, total, nota_anticipo, texto_adicional) 
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [numeroCotizacion, cliente_id, orden_id || null, req.usuario.id, plantilla_id, moneda_id, 'simple', subtotal, descuento, costo_envio, total, nota_anticipo, texto_adicional]
        );
        const presupuestoId = resP.insertId;

        for (let i = 0; i < lineas.length; i++) {
            const linea = lineas[i];
            const [resL] = await conn.query(
                `INSERT INTO presupuestos_detalles (presupuesto_id, orden_visual, descripcion, metadata, cantidad, precio_unitario, total_linea, color, medidas) VALUES (?,?,?,?,?,?,?,?,?)`,
                [presupuestoId, i, linea.descripcion, JSON.stringify(linea.metadata || {}), linea.cantidad, linea.precio_unitario, linea.total_linea, linea.color, linea.medidas]
            );
            if (linea.imagenes && linea.imagenes.length > 0) {
                for (const img of linea.imagenes) {
                    // CAMBIO: img ahora es un objeto { url, grande }, extraemos la url
                    const esGrande = img.grande ? 1 : 0;
                    await conn.query("INSERT INTO presupuestos_imagenes (presupuesto_id, detalle_id, ruta_archivo, es_grande) VALUES (?,?,?,?)", 
                        [presupuestoId, resL.insertId, img.url, esGrande]);
                }
            }
        }
        if (imagenes_sueltas && imagenes_sueltas.length > 0) {
            for (const img of imagenes_sueltas) {
                // CAMBIO: Extraer datos del objeto y guardar es_grande
                const imgUrl = typeof img === 'string' ? img : img.url;
                const esGrande = typeof img === 'string' ? false : (img.grande ? 1 : 0);
                await conn.query("INSERT INTO presupuestos_imagenes (presupuesto_id, detalle_id, ruta_archivo, es_grande) VALUES (?,?,?,?)", 
                    [presupuestoId, null, imgUrl, esGrande]);
            }
        }

        await conn.commit();
        res.json({ id: presupuestoId, numero: numeroCotizacion, message: 'Presupuesto creado' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: 'Error al crear presupuesto: ' + err.message });
    } finally {
        conn.release();
    }
});

// Obtener historial de presupuestos de un cliente
app.get('/api/presupuestos/historial/:clienteId', autenticar, async (req, res) => {
    try {
        const { clienteId } = req.params;
        const [rows] = await db.query(`
            SELECT p.id, p.numero_cotizacion, p.fecha_creacion, p.total, 
                   SUBSTRING(o.notas_personalizacion, 1, 30) as nota_corta,
                   m.simbolo as moneda_simbolo
            FROM presupuestos p
            LEFT JOIN ordenes o ON p.orden_id = o.id
            JOIN monedas m ON p.moneda_id = m.id
            WHERE p.cliente_id = ?
            ORDER BY p.fecha_creacion DESC
        `, [clienteId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar fecha de un presupuesto a hoy
app.put('/api/presupuestos/:id/fecha', autenticar, async (req, res) => {
    try {
        await db.query("UPDATE presupuestos SET fecha_creacion = NOW() WHERE id = ?", [req.params.id]);
        res.json({ message: 'Fecha actualizada a hoy' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Generar PDF (Puppeteer)
app.get('/api/presupuestos/:id/pdf', autenticar, async (req, res) => {
    try {
        const { id } = req.params;
        
        const [presRows] = await db.query(`
            SELECT p.*, c.nombre_completo, c.email, c.telefono, c.direccion_envio, 
                   t.color_primario, t.color_secundario, t.color_acento, 
                   m.simbolo as moneda_simbolo
            FROM presupuestos p
            JOIN clientes c ON p.cliente_id = c.id
            JOIN temas_presupuesto t ON p.tema_id = t.id
            JOIN monedas m ON p.moneda_id = m.id
            WHERE p.id = ?`, [id]);
        
        if (presRows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const pres = presRows[0];
        
        const [detalles] = await db.query("SELECT * FROM presupuestos_detalles WHERE presupuesto_id = ? ORDER BY orden_visual", [id]);
        const [imagenes] = await db.query("SELECT * FROM presupuestos_imagenes WHERE presupuesto_id = ?", [id]);
        
        const getImageBase64 = (rutaRelativa) => {
            try {
                const absolutePath = path.join(process.cwd(), rutaRelativa);
                if (fs.existsSync(absolutePath)) {
                    const buffer = fs.readFileSync(absolutePath);
                    const ext = path.extname(rutaRelativa).substring(1).toLowerCase() || 'jpeg';
                    return `data:image/${ext};base64,${buffer.toString('base64')}`;
                }
                return '';
            } catch (e) { return ''; }
        };

        const imagenesPorLinea = {};
        const imagenesSueltas = [];
        imagenes.forEach(img => {
            const base64Url = getImageBase64(img.ruta_archivo);
            if (!base64Url) return;
            if (img.detalle_id) {
                if (!imagenesPorLinea[img.detalle_id]) imagenesPorLinea[img.detalle_id] = [];
                imagenesPorLinea[img.detalle_id].push({ url: base64Url, grande: img.es_grande === 1 });
            } else {
                imagenesSueltas.push({ url: base64Url, grande: img.es_grande === 1 });
            }
        });

        const generateImageTags = (imgs) => {
            if (!imgs || imgs.length === 0) return '';
            return `<div class="img-container">${imgs.map(img => {
                const imgUrl = typeof img === 'string' ? img : img.url;
                const esGrande = typeof img === 'string' ? false : img.grande;
                if (!imgUrl) return '';
                const clase = esGrande ? 'img-grande' : 'img-chica';
                return `<img src="${imgUrl}" class="${clase}" />`;
            }).join('')}</div>`;
        };

        // LÓGICA CONDICIONAL PARA COLUMNAS DE COLOR Y MEDIDAS
        const tieneColor = detalles.some(d => d.color && d.color.trim() !== '');
        const tieneMedidas = detalles.some(d => d.medidas && d.medidas.trim() !== '');

        const filasTabla = detalles.map(d => {
            const imgs = generateImageTags(imagenesPorLinea[d.id]);
            return `<tr>
                <td>
                    <div class="desc-text">${d.descripcion}</div>
                    ${imgs}
                </td>
                ${tieneColor ? `<td style="word-wrap: break-word; font-size: 11px;">${d.color || ''}</td>` : ''}
                ${tieneMedidas ? `<td style="word-wrap: break-word; font-size: 11px;">${d.medidas || ''}</td>` : ''}
                <td>${d.cantidad || ''}</td>
                <td>${pres.moneda_simbolo} ${d.precio_unitario || ''}</td>
                <td>${pres.moneda_simbolo} ${d.total_linea}</td>
            </tr>`;
        }).join('');

        let filaEnvio = '';
        if (pres.costo_envio > 0) {
            filaEnvio = `
            <tr style="background-color: #f8f9fa;">
                <td><div class="desc-text" style="font-weight: bold;">Costo de Envío</div></td>
                ${tieneColor ? '<td></td>' : ''}
                ${tieneMedidas ? '<td></td>' : ''}
                <td>1</td>
                <td>${pres.moneda_simbolo} ${pres.costo_envio}</td>
                <td>${pres.moneda_simbolo} ${pres.costo_envio}</td>
            </tr>`;
        }

        const seccionSueltas = imagenesSueltas.length > 0 ? `
            <div class="sueltas-section">
                ${generateImageTags(imagenesSueltas)}
            </div>` : '';

        const textoAdicionalHTML = pres.texto_adicional && pres.texto_adicional.trim() !== '' ? `
            <div style="margin-top: 20px; padding: 15px; background-color: #f8f9fa; border-left: 4px solid ${pres.color_acento}; border-radius: 4px; font-size: 12px; color: #555;">
                ${pres.texto_adicional}
            </div>` : '';

        const match = pres.nota_anticipo.match(/(\d+)%/);
        const porcentaje = match ? match[1] : '100';
        const notaTexto = `El presente proyecto es 100% personalizado por lo que el trabajo se inicia con anticipación.<br>La reserva del ${porcentaje}% no es reembolsable depositado a cuenta banco.`;

        let logoBase64 = '';
        const logoPath = path.join(process.cwd(), 'uploads', 'assets', 'logo.png');
        if (fs.existsSync(logoPath)) {
            const logoBuffer = fs.readFileSync(logoPath);
            logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
        }

        let html = `
        <html><head><style>
            body { margin: 0; padding: 0; font-family: Arial, sans-serif; color: #333; }
            .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 100px; background-color: #1a3a5c; display: flex; align-items: flex-start; justify-content: center; padding-top: 40px; z-index: -1; }
            .sidebar-logo { max-width: 90px; max-height: 120px; object-fit: contain; }
            .content { margin-left: 100px; padding: 40px; }  
            .header-info { margin-bottom: 30px; border-bottom: 2px solid ${pres.color_secundario}; padding-bottom: 20px; }
            .header-title { font-size: 12px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; }
            .header-data { font-size: 14px; color: #333; margin: 0 0 8px 0; }
            .header-flex { display: flex; justify-content: space-between; }
            .tabla { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: fixed; }
            .tabla th { background-color: ${pres.color_secundario}; color: white; padding: 10px; text-align: left; font-size: 14px; }
            .tabla td { border-bottom: 1px solid #ddd; padding: 10px; vertical-align: top; word-wrap: break-word; }
            .desc-text { margin-bottom: 8px; }
            .img-container { display: flex; flex-wrap: wrap; gap: 8px; max-width: 100%; }
            .img-container img { object-fit: cover; border-radius: 6px; border: 1px solid #eee; }
            .img-grande { width: 100%; max-width: 300px; height: auto; max-height: 300px; }
            .img-chica { width: 90px; height: 90px; }
            .sueltas-section { margin-top: 30px; border-top: 2px solid #eee; padding-top: 20px; }
            .totales { text-align: right; margin-top: 30px; }
            .totales p { margin: 5px 0; }

            .totales { page-break-inside: avoid; break-inside: avoid; }
            .footer { page-break-inside: avoid; break-inside: avoid; }
            /* Evita que un huérfano del footer se quede solo arriba */
            .footer-nota, .footer-bancos, .footer-empresa { page-break-inside: avoid; }

            .footer { margin-top: 50px; border-top: 2px solid ${pres.color_primario}; padding-top: 20px; font-size: 10px; color: #555; display: block; text-align: left; }
            .footer-nota { line-height: 1.5; margin-bottom: 15px; text-align: left; }
            .footer-bancos { font-weight: bold; color: #333; margin-bottom: 25px; line-height: 1.4; text-align: left; }
            .footer-empresa { text-align: left; }
            .footer-empresa h4 { margin: 0 0 8px 0; color: ${pres.color_primario}; font-size: 16px; font-weight: 900; }
            .footer-empresa p { margin: 3px 0; display: flex; align-items: center; gap: 6px; justify-content: flex-start; }
        </style></head><body>
            <div class="sidebar">
                ${logoBase64 ? `<img src="${logoBase64}" class="sidebar-logo" alt="Logo" />` : `<div style="color: white; font-weight: 900; font-size: 20px; writing-mode: vertical-lr; transform: rotate(180deg);">BRINCO CREATIVO</div>`}
            </div>
            <div class="content">
                <div class="header-info">
                    <div class="header-flex">
                        <div>
                            <p class="header-title">Cotización No:</p>
                            <p class="header-data" style="font-size: 18px; font-weight: 900; color: ${pres.color_primario};">#${pres.numero_cotizacion}</p>
                        </div>
                        <div style="text-align: right;">
                            <p class="header-title">Fecha:</p>
                            <p class="header-data">${new Date(pres.fecha_creacion).toLocaleDateString('es-GT', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                        </div>
                    </div>
                    <div style="margin-top: 20px;">
                        <p class="header-title">Cliente:</p>
                        <p class="header-data">${pres.nombre_completo}</p>
                        <p class="header-title">Contacto:</p>
                        <p class="header-data">${pres.telefono || 'N/A'} | ${pres.email || 'N/A'}</p>
                    </div>
                </div>
                
                <table class="tabla">
                    <tr>
                        <th style="width: ${tieneColor || tieneMedidas ? '35%' : '50%'};">Descripción</th>
                        ${tieneColor ? '<th style="width: 10%;">Color</th>' : ''}
                        ${tieneMedidas ? '<th style="width: 15%;">Medidas</th>' : ''}
                        <th style="width: 10%;">Cant.</th>
                        <th style="width: 15%;">Precio</th>
                        <th style="width: 15%;">Total</th>
                    </tr>
                    ${filasTabla}
                    ${filaEnvio}
                </table>
                
                ${seccionSueltas}
                ${textoAdicionalHTML}
 
                <!-- BLOQUE 1: TOTALES (Independiente) -->
                <div style="page-break-inside: avoid; padding-top: 40px;">
                    <div class="totales">
                        ${parseFloat(pres.descuento) > 0 ? `
                            <p>Subtotal: ${pres.moneda_simbolo} ${(parseFloat(pres.subtotal) + parseFloat(pres.costo_envio || 0)).toFixed(2)}</p>
                            <p>Descuento: ${pres.moneda_simbolo} ${pres.descuento}</p>
                        ` : ''}
                        <h3 style="color: ${pres.color_primario};">Total: ${pres.moneda_simbolo} ${pres.total}</h3>
                    </div>
                </div>

                <!-- BLOQUE 2: FOOTER (Independiente) -->
                <div class="footer" style="page-break-inside: avoid;">
                    <div class="footer-nota">
                        <p style="margin:0;"><strong>Nota:</strong> ${notaTexto}</p>
                    </div>
                    <div class="footer-bancos">
                        BI Cuenta: 0000-0000-0000-0000<br>
                        Banrural Cuenta Ahorros: 04913600769182<br>
                        A nombre de: Vivian Roxana Villatoro Rodríguez
                    </div>
                    <div class="footer-empresa">
                        <h4>Brinco Creativo</h4>
                        <p><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> Ciudad Capital</p>
                        <p><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg> brinocreativo.info@gmail.com</p>
                        <p><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg> 56359748</p>
                    </div>
                </div>
            </div>
        </body></html>`;

        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        // NUEVO: Generar PDF con pie de página nativo de Puppeteer
        const pdfBuffer = await page.pdf({ 
            format: 'Letter', 
            printBackground: true, 
            displayHeaderFooter: true, // Activar cabeceras/pies
            headerTemplate: '<div></div>', // Dejamos la cabecera vacía
            footerTemplate: `
                <div style="width: 100%; font-size: 9px; color: #888; padding: 0 40px 0 140px; box-sizing: border-box; text-align: right;">
                    pág <span class="pageNumber"></span> de <span class="totalPages"></span>
                </div>
            `, // El padding-left de 140px evita que se meta en el cintillo azul
            margin: { top: '0px', bottom: '30px', left: '0px', right: '0px' } // Damos 30px abajo para el número
        });
        
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Cotizacion-${pres.numero_cotizacion}.pdf`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('ERROR GENERANDO PDF:', err); // Esto nos mostrará el error real en la consola de Node
        res.status(500).json({ error: 'Error generando PDF: ' + err.message });
    }
});

// Función de espera (para reintentar cuando Google nos bloquee por 1 minuto)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// Endpoint REAL con Inteligencia Artificial (GROQ - Llama 3)
// =============================================================================
app.post('/api/presupuestos/ia-descripcion', autenticar, async (req, res) => {
    const { palabraClave } = req.body;
    const palabraLimpia = palabraClave ? palabraClave.replace(/\n/g, ' ').trim() : '';

    console.log(`\n--- [CONSULTA IA GROQ] ---`);
    console.log(`1. Palabra clave recibida: "${palabraLimpia}"`);

    if (!palabraLimpia) {
        return res.status(400).json({ error: 'La palabra clave es requerida' });
    }

    try {
        // Configuramos Groq
        const groq = new OpenAI({
            apiKey: process.env.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1"
        });

        // Hacemos el prompt más estricto para que no salude ni dé opciones
        const prompt = `Eres un copywriter experto en marketing. Tu tarea es redactar una descripción comercial breve (máximo 2 frases) para un presupuesto formal sobre: "${palabraLimpia}".
        Enfócate en la calidad, el método de personalización y el impacto visual. 
        Varía la redacción siempre.
        Redacta el texto como personalizado para un cliente, no digas 
        -Diseñamos y grabamos trofeos- en su lugar di -Diseño y grabado de trofeo con estilo único-.
        Revisa que no se los estas vendiendo al público general, sino a un cliente que quiere un presupuesto formal.
        Recuerda que el cliente ya te solicitó algo, este servicio es algo ya pactado, no intentes venderle algo más, solo describe lo que ya se va a hacer.
        REGLAS: No uses comillas, ni simples ni dobles. No saludes. No ofrezcas opciones. Responde ÚNICAMENTE con el texto de la descripción.`;

        console.log(`2. Enviando petición a Groq (Llama 3.1)...`);
        
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.9,
            max_tokens: 150, // Aumentamos el límite para que no se corte la frase
        });

        const descripcionGenerada = completion.choices[0].message.content.trim();
        
        console.log(`✅ 3. RESPUESTA EXITOSA: ${descripcionGenerada}`);
        console.log(`--- [FIN CONSULTA IA] ---\n`);
        
        res.json({ descripcion: descripcionGenerada });
    } catch (err) {
        console.error(`❌ 3. ERROR AL CONSULTAR GROQ:`, err.message);
        
        let mensajeErrorFrontend = 'Error desconocido al conectar con la IA.';
        if (err.message.includes('429')) mensajeErrorFrontend = 'Límite de Groq agotado.';
        if (err.message.includes('401')) mensajeErrorFrontend = 'API Key de Groq inválida.';

        res.status(500).json({ 
            error: mensajeErrorFrontend,
            descripcion: `Diseño personalizado de ${palabraLimpia}, fabricado con materiales premium para destacar tu marca.` 
        });
    }
});

// =============================================================================
// INICIO DEL SERVIDOR
// =============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('---------------------------------------------------------');
    console.log(`🚀 SERVIDOR MAESTRO v3.7 - ACTIVO EN PUERTO ${PORT}`);
    console.log(`📡 URL API: http://localhost:${PORT}/api`);
    console.log('---------------------------------------------------------');
});