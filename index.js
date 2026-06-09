const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN: Pool de conexiones para máxima estabilidad y soporte de transacciones
// Esta configuración permite manejar múltiples peticiones concurrentes sin saturar el servidor.
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

// Habilitamos el soporte de promesas para usar async/await de forma nativa
const db = pool.promise();

// Verificación inicial de la conexión a la base de datos
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error crítico al conectar a la base de datos MySQL:', err);
        return;
    }
    console.log('✅ Conexión establecida con éxito al Pool de Brinco Creativo (VERSIÓN MAESTRA RESTAURADA)');
    connection.release();
});

// =============================================================================
// 1. DASHBOARD Y ESTADÍSTICAS (KPIs EN TIEMPO REAL)
// =============================================================================

// Endpoint para el resumen principal del Dashboard
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM ordenes WHERE estado NOT IN ('Entregado', 'Cancelado')) as ordenes_activas,
                (SELECT COUNT(*) FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE) as stock_bajo,
                (SELECT COALESCE(SUM(total_quetzales), 0) FROM ordenes WHERE DATE(fecha_orden) = CURDATE() AND estado != 'Cancelado') as ventas_hoy
        `;
        const [results] = await db.query(sql);
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al cargar estadísticas: ' + err.message });
    }
});

// Endpoint para obtener los productos que necesitan reposición urgente
app.get('/api/dashboard/stock-bajo', async (req, res) => {
    try {
        const sql = "SELECT id, nombre, stock_actual, stock_minimo FROM productos WHERE stock_actual <= stock_minimo AND activo = TRUE ORDER BY stock_actual ASC";
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Error al cargar alertas de stock: ' + err.message });
    }
});

// =============================================================================
// 2. GESTIÓN DE CATEGORÍAS (ENRIQUECIDAS CON CONTEO)
// =============================================================================

// Categorías de Clientes con conteo dinámico de miembros
app.get('/api/clientes/categorias', async (req, res) => {
    try {
        const sql = `
            SELECT cc.*, 
            (SELECT COUNT(*) FROM clientes WHERE categoria_id = cc.id) as total_clientes
            FROM clientes_categorias cc 
            ORDER BY cc.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Categorías de Productos con conteo dinámico de items
app.get('/api/categorias', async (req, res) => {
    try {
        const sql = `
            SELECT c.*, 
            (SELECT COUNT(*) FROM productos WHERE categoria_id = c.id) as total_productos
            FROM categorias c 
            WHERE c.activo = TRUE 
            ORDER BY c.nombre ASC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// 3. INVENTARIO DE PRODUCTOS (CRUD COMPLETO)
// =============================================================================

// Listar todos los productos con el nombre de su categoría
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

// Crear un nuevo producto en el catálogo
app.post('/api/inventario', async (req, res) => {
    const { categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url } = req.body;
    try {
        const sql = "INSERT INTO productos (categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [categoria_id, nombre, descripcion, sku, stock_actual, stock_minimo, precio_compra_referencia, precio_venta_sugerido, imagen_url]);
        res.json({ message: 'Producto creado exitosamente', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar un producto existente o cambiar su estatus de visibilidad
app.put('/api/inventario/:id', async (req, res) => {
    const { id } = req.params;
    const { categoria_id, nombre, descripcion, stock_minimo, precio_compra_referencia, precio_venta_sugerido, activo } = req.body;
    
    try {
        if (activo !== undefined && Object.keys(req.body).length === 1) {
            const sql = "UPDATE productos SET activo=? WHERE id=?";
            await db.query(sql, [activo, id]);
            res.json({ message: 'Estatus de visibilidad actualizado' });
        } else {
            const sql = `
                UPDATE productos 
                SET categoria_id=?, nombre=?, descripcion=?, stock_minimo=?, precio_compra_referencia=?, precio_venta_sugerido=?, activo=? 
                WHERE id=?`;
            await db.query(sql, [categoria_id, nombre, descripcion, stock_minimo, precio_compra_referencia, precio_venta_sugerido, activo, id]);
            res.json({ message: 'Información del producto actualizada correctamente' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// 4. ÓRDENES DE TRABAJO (NÚCLEO DEL NEGOCIO Y TRANSACCIONES)
// =============================================================================

// Listar órdenes para el tablero de producción
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

// Obtener detalle extendido de una orden específica (incluyendo materiales)
app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sqlOrden = "SELECT o.*, c.nombre_completo FROM ordenes o JOIN clientes c ON o.cliente_id = c.id WHERE o.id = ?";
        const sqlDetalles = "SELECT d.*, p.nombre FROM orden_detalles_materiales d JOIN productos p ON d.producto_id = p.id WHERE d.orden_id = ?";
        const [orden] = await db.query(sqlOrden, [id]);
        const [detalles] = await db.query(sqlDetalles, [id]);
        
        if (orden.length === 0) return res.status(404).json({ error: 'Orden no encontrada' });
        res.json({ ...orden[0], materiales: detalles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Creación de Órdenes con Gestión Transaccional de Stock (ATOMICIDAD)
app.post('/api/ordenes', async (req, res) => {
    const { 
        cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas, materiales 
    } = req.body;
    const connection = await pool.promise().getConnection();
    try {
        await connection.beginTransaction();
        
        // 1. Insertar cabecera de la orden
        const sqlOrden = `
            INSERT INTO ordenes 
            (cliente_id, fecha_entrega_prometida, subtotal, total_costo_materiales, costo_mano_obra, costo_envio, cargo_administrativo, total_quetzales, porcentaje_utilidad_aplicado, notas_personalizacion) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [resultOrden] = await connection.query(sqlOrden, [cliente_id, fecha_entrega, subtotal, costo_materiales, mano_obra, envio, cargo_admin, total, utilidad_porcentaje, notas]);
        const ordenId = resultOrden.insertId;

        // 2. Procesar materiales y descontar inventario
        if (materiales && materiales.length > 0) {
            for (const mat of materiales) {
                // Validación estricta de existencia antes de cualquier descuento
                const [productos] = await connection.query("SELECT nombre, stock_actual FROM productos WHERE id = ?", [mat.producto_id]);
                const producto = productos[0];
                
                if (!producto || Number(producto.stock_actual) < Number(mat.cantidad)) {
                    throw new Error(`Stock insuficiente para "${producto ? producto.nombre : 'ID ' + mat.producto_id}". Disponible: ${producto ? producto.stock_actual : 0}`);
                }
                
                // Registro del detalle
                await connection.query(
                    "INSERT INTO orden_detalles_materiales (orden_id, producto_id, cantidad, precio_unitario_momento, precio_venta_momento) VALUES (?, ?, ?, ?, ?)",
                    [ordenId, mat.producto_id, mat.cantidad, mat.costo_unitario, mat.precio_venta]
                );
                
                // Descuento real de stock
                await connection.query("UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?", [mat.cantidad, mat.producto_id]);
            }
        }
        
        await connection.commit();
        res.json({ message: 'Orden confirmada y stock actualizado con éxito', id: ordenId });
    } catch (error) {
        await connection.rollback();
        res.status(400).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// Cambio de estado de la orden (Flujo Kanban)
app.patch('/api/ordenes/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    try {
        const sql = "UPDATE ordenes SET estado = ? WHERE id = ?";
        await db.query(sql, [estado, id]);
        res.json({ message: 'Estatus de la orden actualizado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// 5. CLIENTES (CARTERA Y SEGMENTACIÓN)
// =============================================================================

// Listado de clientes con su categoría visual
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

// Registrar un nuevo cliente
app.post('/api/clientes', async (req, res) => {
    const { nombre_completo, telefono, email, direccion_envio, nit, categoria_id } = req.body;
    try {
        const sql = "INSERT INTO clientes (nombre_completo, telefono, email, direccion_envio, nit, categoria_id) VALUES (?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [nombre_completo, telefono, email, direccion_envio, nit, categoria_id]);
        res.json({ message: 'Cliente registrado', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar datos de facturación o contacto del cliente
app.put('/api/clientes/:id', async (req, res) => {
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

// =============================================================================
// 6. PROVEEDORES Y ABASTECIMIENTO
// =============================================================================

// Directorio de proveedores registrados
app.get('/api/proveedores', async (req, res) => {
    try {
        const [results] = await db.query("SELECT * FROM proveedores ORDER BY nombre_empresa ASC");
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear nuevo contacto de proveedor
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

// Editar datos del proveedor
app.put('/api/proveedores/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre_empresa, contacto_nombre, telefono, email, direccion, nit } = req.body;
    try {
        const sql = "UPDATE proveedores SET nombre_empresa=?, contacto_nombre=?, telefono=?, email=?, direccion=?, nit=? WHERE id=?";
        await db.query(sql, [nombre_empresa, contacto_nombre, telefono, email, direccion, nit, id]);
        res.json({ message: 'Datos del proveedor actualizados' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Historial de facturas de compra/entradas por proveedor
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

// =============================================================================
// 7. ENTRADA DE MERCANCÍA (TRANSACCIONAL - INCREMENTO DE STOCK)
// =============================================================================

// Registro de ingreso masivo de insumos
app.post('/api/entradas', async (req, res) => {
    const { proveedor_id, documento, total, items } = req.body;
    const connection = await pool.promise().getConnection();
    try {
        await connection.beginTransaction();
        
        // Registro de la factura de compra
        const sqlEntrada = "INSERT INTO entradas_mercancia (proveedor_id, documento_referencia, total_compra) VALUES (?, ?, ?)";
        const [result] = await connection.query(sqlEntrada, [proveedor_id, documento, total]);
        const entradaId = result.insertId;

        // Procesamiento de cada item recibido
        for (const item of items) {
            // Detalle de la entrada
            await connection.query("INSERT INTO entrada_detalles (entrada_id, producto_id, cantidad, costo_unitario) VALUES (?, ?, ?, ?)", [entradaId, item.producto_id, item.cantidad, item.costo]);
            
            // Incremento real de stock y actualización automática del último precio de costo
            await connection.query("UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?", [item.cantidad, item.producto_id]);
            await connection.query("UPDATE productos SET precio_compra_referencia = ? WHERE id = ?", [item.costo, item.producto_id]);
        }
        
        await connection.commit();
        res.json({ message: 'Entrada procesada, stock incrementado y costos actualizados', id: entradaId });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: 'Fallo técnico en la transacción de entrada: ' + err.message });
    } finally {
        connection.release();
    }
});

// =============================================================================
// 8. FLUJO DE CAJA Y PAGOS
// =============================================================================

// Listado histórico de transacciones (Ingresos y Egresos)
app.get('/api/pagos', async (req, res) => {
    try {
        const sql = `
            SELECT p.*, o.id as orden_num, c.nombre_completo as cliente_nombre 
            FROM pagos p 
            LEFT JOIN ordenes o ON p.orden_id = o.id 
            LEFT JOIN clientes c ON o.cliente_id = c.id 
            ORDER BY p.fecha_pago DESC`;
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Registro de un nuevo movimiento financiero
app.post('/api/pagos', async (req, res) => {
    const { orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago } = req.body;
    try {
        const sql = "INSERT INTO pagos (orden_id, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago) VALUES (?, ?, ?, ?, ?, ?, ?)";
        const [result] = await db.query(sql, [orden_id || null, monto, tipo_movimiento, categoria_pago, metodo_pago, referencia_pago, nota_pago]);
        res.json({ message: 'Transacción financiera registrada', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Resumen de caja para el día actual
app.get('/api/caja/resumen', async (req, res) => {
    try {
        const sql = `
            SELECT 
                COALESCE(SUM(CASE WHEN tipo_movimiento = 'Ingreso' THEN monto ELSE 0 END), 0) as ingresos_hoy,
                COALESCE(SUM(CASE WHEN tipo_movimiento = 'Egreso' THEN monto ELSE 0 END), 0) as egresos_hoy,
                500.00 as fondo_inicial
            FROM pagos 
            WHERE DATE(fecha_pago) = CURDATE()`;
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
    console.log(`🚀 Servidor de Brinco Creativo operando en puerto ${PORT}`);
    console.log(`📡 Endpoints CRUD y transaccionales restaurados al 100%`);
});
