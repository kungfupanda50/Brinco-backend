const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN: Pool de conexiones para máxima estabilidad y soporte de transacciones
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
});

// Habilitamos promesas para manejar el pool de forma moderna (async/await)
const db = pool.promise();

// Verificar conexión al iniciar
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error conectando a la base de datos:', err);
        return;
    }
    console.log('✅ Conectado exitosamente al Pool de Brinco Creativo (VERSIÓN MAESTRA ABSOLUTA)');
    connection.release();
});

// ==========================================
// 1. DASHBOARD (KPIs, Alertas y Rentabilidad)
// ==========================================

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM ordenes WHERE estado NOT IN ('Entregado', 'Cancelado')) as ordenes_activas,
                (SELECT COUNT(*) FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE) as stock_bajo,
                (SELECT COALESCE(SUM(total_quetzales), 0) FROM ordenes WHERE DATE(fecha_orden) = CURDATE()) as ventas_hoy
        `;
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/stock-bajo', async (req, res) => {
    try {
        const sql = "SELECT id, nombre, stock_actual, stock_minimo FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. INVENTARIO (Catálogo Pro con Precios Duales)
// ==========================================

app.get('/api/inventario', async (req, res) => {
    try {
        const sql = `
            SELECT p.*, c.nombre as categoria_nombre 
            FROM productos p 
            LEFT JOIN categorias c ON p.categoria_id = c.id 
            ORDER BY p.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventario', async (req, res) => {
    const { categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url } = req.body;
    try {
        const sql = "INSERT INTO productos (categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url]);
        res.json({ message: 'Producto creado', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventario/:id', async (req, res) => {
    const { id } = req.params;
    const { categoria_id, nombre, descripcion, stock_minimo, precio_compra_referencia, precio_venta_sugerido, activo } = req.body;
    
    try {
        if (activo !== undefined && Object.keys(req.body).length === 1) {
            const sql = "UPDATE productos SET activo=? WHERE id=?";
            await db.query(sql, [activo, id]);
            res.json({ message: 'Estatus actualizado' });
        } else {
            const sql = `
                UPDATE productos 
                SET categoria_id=?, nombre=?, descripcion=?, stock_minimo=?, precio_compra_referencia=?, precio_venta_sugerido=?, activo=? 
                WHERE id=?`;
            await db.query(sql, [categoria_id, nombre, descripcion, stock_minimo, precio_compra_referencia, precio_venta_sugerido, activo, id]);
            res.json({ message: 'Producto actualizado con éxito' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. ÓRDENES DE TRABAJO (Lógica Comercial y de Stock)
// ==========================================

app.get('/api/ordenes', async (req, res) => {
    try {
        const sql = `
            SELECT o.*, c.nombre_completo as cliente_nombre 
            FROM ordenes o 
            JOIN clientes c ON o.cliente_id = c.id 
            ORDER BY o.fecha_orden DESC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sqlOrden = "SELECT o.*, c.nombre_completo FROM ordenes o JOIN clientes c ON o.cliente_id = c.id WHERE o.id = ?";
        const sqlDetalles = "SELECT d.*, p.nombre FROM orden_detalles_materiales d JOIN productos p ON d.producto_id = p.id WHERE d.orden_id = ?";
        const [orden] = await db.query(sqlOrden, [id]);
        const [detalles] = await db.query(sqlDetalles, [id]);
        res.json({ ...orden[0], materiales: detalles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ordenes', async (req, res) => {
    const { 
        cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas, materiales 
    } = req.body;
    const connection = await pool.promise().getConnection();
    try {
        await connection.beginTransaction();
        const sqlOrden = `
            INSERT INTO ordenes 
            (cliente_id, fecha_entrega_prometida, subtotal, total_costo_materiales, costo_mano_obra, costo_envio, cargo_administrativo, total_quetzales, porcentaje_utilidad_aplicado, notas_personalizacion) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [resultOrden] = await connection.query(sqlOrden, [cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas]);
        const ordenId = resultOrden.insertId;
        if (materiales && materiales.length > 0) {
            for (const mat of materiales) {
                const [productos] = await connection.query("SELECT nombre, stock_actual FROM productos WHERE id = ?", [mat.producto_id]);
                const producto = productos[0];
                if (!producto || Number(producto.stock_actual) < Number(mat.cantidad)) {
                    throw new Error(`Stock insuficiente para "${producto ? producto.nombre : 'ID ' + mat.producto_id}".`);
                }
                await connection.query(
                    "INSERT INTO orden_detalles_materiales (orden_id, producto_id, cantidad, precio_unitario_momento, precio_venta_momento) VALUES (?, ?, ?, ?, ?)",
                    [ordenId, mat.producto_id, mat.cantidad, mat.costo_unitario, mat.precio_venta]
                );
                await connection.query("UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?", [mat.cantidad, mat.producto_id]);
            }
        }
        await connection.commit();
        res.json({ message: 'Orden confirmada y stock descontado', id: ordenId });
    } catch (error) {
        await connection.rollback();
        res.status(400).json({ error: error.message });
    } finally {
        connection.release();
    }
});

app.patch('/api/ordenes/:id/estado', async (req, res) => {
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

// ==========================================
// 4. CLIENTES (Gestión Dinámica y Categorías)
// ==========================================

app.get('/api/clientes/categorias', async (req, res) => {
    try {
        const [results] = await db.query("SELECT * FROM clientes_categorias ORDER BY nombre ASC");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clientes', async (req, res) => {
    try {
        const sql = `
            SELECT c.*, cat.nombre as categoria_nombre, cat.color_clase 
            FROM clientes c 
            LEFT JOIN clientes_categorias cat ON c.categoria_id = cat.id 
            ORDER BY c.nombre_completo ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clientes', async (req, res) => {
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const sql = "INSERT INTO clientes (nombre_completo, telefono, email, direccion_envio, nit, categoria_id) VALUES (?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [nombre_completo, telefono, email, direccion_envio, nit, categoria_id]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/clientes/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const sql = "UPDATE clientes SET nombre_completo=?, telefono=?, email=?, direccion_envio=?, nit=?, categoria_id=? WHERE id=?";
        await db.query(sql, [nombre_completo, telefono, email, direccion_envio, nit, categoria_id, id]);
        res.json({ message: 'Cliente actualizado con éxito' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clientes/:id/historial', async (req, res) => {
    try {
        const { id } = req.params;
        const sql = "SELECT id, fecha_orden, estado, total_quetzales, notas_personalizacion FROM ordenes WHERE cliente_id = ? ORDER BY fecha_orden DESC";
        const [results] = await db.query(sql, [id]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. PROVEEDORES (CRUD Completo e Historial)
// ==========================================

app.get('/api/proveedores', async (req, res) => {
    try {
        const [results] = await db.query("SELECT * FROM proveedores ORDER BY nombre_empresa ASC");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proveedores', async (req, res) => {
    const { nombre_empresa, contacto_nombre, telefono, email, direccion, nit } = req.body;
    try {
        const sql = "INSERT INTO proveedores (nombre_empresa, contacto_nombre, telefono, email, direccion, nit) VALUES (?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [nombre_empresa, contacto_nombre, telefono, email, direccion, nit]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proveedores/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre_empresa, contacto_nombre, telefono, email, direccion, nit } = req.body;
    try {
        const sql = "UPDATE proveedores SET nombre_empresa=?, contacto_nombre=?, telefono=?, email=?, direccion=?, nit=? WHERE id=?";
        await db.query(sql, [nombre_empresa, contacto_nombre, telefono, email, direccion, nit, id]);
        res.json({ message: 'Proveedor actualizado con éxito' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ENDPOINT RECUPERADO: Historial de compras por cada proveedor
app.get('/api/proveedores/:id/compras', async (req, res) => {
    try {
        const { id } = req.params;
        const sql = "SELECT * FROM entradas_mercancia WHERE proveedor_id = ? ORDER BY fecha_entrada DESC";
        const [results] = await db.query(sql, [id]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 6. ENTRADA DE MERCANCÍA (Transaccional)
// ==========================================

app.post('/api/entradas', async (req, res) => {
    const { proveedor_id, documento, total, items } = req.body;
    const connection = await pool.promise().getConnection();
    try {
        await connection.beginTransaction();
        const sqlEntrada = "INSERT INTO entradas_mercancia (proveedor_id, documento_referencia, total_compra) VALUES (?, ?, ?)";
        const [result] = await connection.query(sqlEntrada, [proveedor_id, documento, total]);
        const entradaId = result.insertId;
        for (const item of items) {
            await connection.query("INSERT INTO entrada_detalles (entrada_id, producto_id, cantidad, costo_unitario) VALUES (?, ?, ?, ?)", [entradaId, item.producto_id, item.cantidad, item.costo]);
            await connection.query("UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?", [item.cantidad, item.producto_id]);
            await connection.query("UPDATE productos SET precio_compra_referencia = ? WHERE id = ?", [item.costo, item.producto_id]);
        }
        await connection.commit();
        res.json({ message: 'Entrada registrada y stock actualizado con éxito', id: entradaId });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: 'Error técnico al registrar la entrada: ' + err.message });
    } finally {
        connection.release();
    }
});

// ==========================================
// 7. OTROS (Caja, Categorías de Insumos, Usuarios)
// ==========================================

app.get('/api/pagos', async (req, res) => {
    try {
        const [results] = await db.query("SELECT p.*, o.id as orden_id FROM pagos p LEFT JOIN ordenes o ON p.orden_id = o.id ORDER BY p.fecha_pago DESC");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pagos', async (req, res) => {
    const { orden_id, monto, metodo, referencia } = req.body;
    try {
        const sql = "INSERT INTO pagos (orden_id, monto, metodo_pago, referencia_pago) VALUES (?, ?, ?, ?)";
        const [result] = await db.query(sql, [orden_id, monto, metodo, referencia]);
        res.json({ message: 'Pago registrado', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/categorias', async (req, res) => {
    try {
        const [results] = await db.query("SELECT * FROM categorias WHERE activo = TRUE ORDER BY nombre ASC");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Brinco Creativo MAESTRO ABSOLUTO en puerto ${PORT}`);
});
