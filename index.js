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
const multerLib = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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
    keepAliveInitialDelay: 10000
});

const db = pool.promise();

// Verificación inicial de salud de la base de datos
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR DE CONEXIÓN MYSQL:', err.message);
        console.error('Verifique que el servicio MySQL esté activo y las credenciales sean correctas.');
        return;
    }
    console.log('✅ ESTADO: Servidor v3.7 (Lógica Incremental) en línea.');
    console.log('✅ DB: Conectado a la base de datos Brinco Creativo.');
    connection.release();
});

// =============================================================================
// ENDPOINTS DE USUARIOS Y SEGURIDAD
// =============================================================================

/**
 * LOGIN: Autenticación de usuario
 * Devuelve datos de perfil y tabla de permisos granulares.
 */
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const sql = `
            SELECT u.id, u.nombre, u.usuario, u.rol, u.activo, u.avatar_url,
            p.p_dashboard, p.p_clientes, p.p_ordenes, p.p_nueva_orden, p.p_inventario, 
            p.p_proveedores, p.p_entrada_mercancia, p.p_caja, p.p_cat_clientes, p.p_cat_productos, p.p_usuarios
            FROM usuarios u
            LEFT JOIN usuarios_permisos p ON u.id = p.usuario_id
            WHERE u.usuario = ? AND u.password_hash = ? AND u.activo = 1`;
        
        const [users] = await db.query(sql, [usuario, password]);
        
        if (users.length > 0) {
            console.log(`🔑 Login exitoso: ${usuario}`);
            res.json({ success: true, user: users[0] });
        } else {
            res.status(401).json({ error: 'Credenciales inválidas o cuenta bloqueada' });
        }
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

app.get('/api/usuarios', async (req, res) => {
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

app.post('/api/usuarios', async (req, res) => {
    const { nombre, usuario, password, rol, permisos } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        const [resU] = await conn.query("INSERT INTO usuarios (nombre, usuario, password_hash, rol, activo) VALUES (?, ?, ?, ?, 1)", [nombre, usuario, password, rol]);
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

app.put('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, rol, activo, password, permisos } = req.body;
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();
        if (password) {
            await conn.query("UPDATE usuarios SET nombre=?, rol=?, activo=?, password_hash=? WHERE id=?", [nombre, rol, activo, password, id]);
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

app.post('/api/usuarios/:id/avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo de imagen requerido' });
        const url = `/uploads/${req.file.filename}`;
        await db.query("UPDATE usuarios SET avatar_url = ? WHERE id = ?", [url, req.params.id]);
        res.json({ url });
    } catch (err) {
        res.status(500).json({ error: 'Error al subir avatar: ' + err.message });
    }
});

// =============================================================================
// ENDPOINTS DE DASHBOARD Y ANALÍTICA
// =============================================================================

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM ordenes WHERE estado NOT IN ('Entregado', 'Cancelado', 'Rechazado')) as ordenes_activas,
                (SELECT COUNT(*) FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE) as stock_bajo,
                (SELECT COALESCE(SUM(total_quetzales), 0) FROM ordenes WHERE DATE(fecha_orden) = CURDATE() AND estado NOT IN ('Cancelado', 'Rechazado')) as ventas_hoy
        `;
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al recuperar estadísticas: ' + err.message });
    }
});

app.get('/api/dashboard/stock-bajo', async (req, res) => {
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

app.get('/api/clientes', async (req, res) => {
    try {
        const sql = "SELECT c.*, cat.nombre as categoria_nombre, cat.color_clase FROM clientes c LEFT JOIN clientes_categorias cat ON c.categoria_id = cat.id ORDER BY c.nombre_completo ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clientes', async (req, res) => {
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const [result] = await db.query("INSERT INTO clientes (nombre_completo, telefono, email, direccion_envio, nit, categoria_id) VALUES (?,?,?,?,?,?)", [nombre_completo, telefono, email, direccion_envio, nit, categoria_id]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clientes/categorias', async (req, res) => {
    try {
        const sql = `SELECT cc.*, (SELECT COUNT(*) FROM clientes WHERE categoria_id = cc.id) as total_clientes FROM clientes_categorias cc ORDER BY cc.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// GESTIÓN DE INVENTARIO Y CATEGORÍAS PRODUCTOS
// =============================================================================

app.get('/api/inventario', async (req, res) => {
    try {
        const sql = "SELECT p.*, c.nombre as categoria_nombre FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id ORDER BY p.nombre ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventario', async (req, res) => {
    const { categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido } = req.body;
    try {
        const sql = "INSERT INTO productos (categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/categorias', async (req, res) => {
    try {
        const sql = `SELECT c.*, (SELECT COUNT(*) FROM productos WHERE categoria_id = c.id) as total_productos FROM categorias c ORDER BY c.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// ÓRDENES DE TRABAJO Y PRODUCCIÓN
// =============================================================================

app.get('/api/ordenes', async (req, res) => {
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

app.post('/api/ordenes', async (req, res) => {
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

app.post('/api/ordenes/:id/rebajar-stock', async (req, res) => {
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

// =============================================================================
// CAJA, FLUJO Y PAGOS
// =============================================================================

app.get('/api/pagos', async (req, res) => {
    try {
        const sql = "SELECT p.*, o.id as orden_num, c.nombre_completo as cliente_nombre FROM pagos p LEFT JOIN ordenes o ON p.orden_id = o.id LEFT JOIN clientes c ON o.cliente_id = c.id ORDER BY p.fecha_pago DESC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pagos', async (req, res) => {
    const { orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago } = req.body;
    try {
        const [result] = await db.query("INSERT INTO pagos (orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago) VALUES (?,?,?,?,?,?,?)", [orden_id || null, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/caja/resumen', async (req, res) => {
    try {
        const sql = "SELECT COALESCE(SUM(CASE WHEN tipo_movimiento='Ingreso' THEN monto ELSE 0 END),0) as ingresos_hoy, COALESCE(SUM(CASE WHEN tipo_movimiento='Egreso' THEN monto ELSE 0 END),0) as egresos_hoy, 500.00 as fondo_inicial FROM pagos WHERE DATE(fecha_pago)=CURDATE()";
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
