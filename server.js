const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const pool = mysql.createPool({
  host: required("DB_HOST"),
  port: Number(required("DB_PORT")),
  user: required("DB_USER"),
  password: required("DB_PASS"),
  database: required("DB_NAME"),
  ssl: { ca: required("DB_CA_PEM") },
});

// Build shared WHERE clause (tolerant to extra spaces)
function buildFilters(query) {
  const { categoria, proveedor, q, minStock, maxStock, missingCategory, missingSupplier } = query;

  let where = " WHERE 1=1 ";
  const params = [];

  // categoria/proveedor exact match but trimmed on DB side
  if (categoria) {
    where += " AND TRIM(c.nombre) = ? ";
    params.push(String(categoria).trim());
  }
  if (proveedor) {
    where += " AND TRIM(pr.nombre) = ? ";
    params.push(String(proveedor).trim());
  }

  // missing category/supplier quick views
  if (String(missingCategory || "") === "1") {
    where += " AND p.categoria_id IS NULL ";
  }
  if (String(missingSupplier || "") === "1") {
    where += " AND p.proveedor_id IS NULL ";
  }

  // search
  if (q) {
    where += " AND (p.sku LIKE ? OR p.descripcion LIKE ?) ";
    const like = `%${String(q)}%`;
    params.push(like, like);
  }

  // stock range (i.cantidad can be NULL if no row; treat as 0)
  const minS = minStock !== undefined && minStock !== "" ? Number(minStock) : null;
  const maxS = maxStock !== undefined && maxStock !== "" ? Number(maxStock) : null;

  if (Number.isFinite(minS)) {
    where += " AND COALESCE(i.cantidad, 0) >= ? ";
    params.push(minS);
  }
  if (Number.isFinite(maxS)) {
    where += " AND COALESCE(i.cantidad, 0) <= ? ";
    params.push(maxS);
  }

  return { where, params };
}

function buildSort(sort) {
  // default: value desc
  switch (String(sort || "")) {
    case "stock_desc":
      return " ORDER BY COALESCE(i.cantidad,0) DESC, p.sku ASC ";
    case "sku_asc":
      return " ORDER BY p.sku ASC ";
    case "value_desc":
    default:
      return " ORDER BY (COALESCE(i.cantidad,0) * p.costo) DESC, p.sku ASC ";
  }
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const BASE_FROM = `
  FROM productos p
  LEFT JOIN categorias c ON p.categoria_id = c.id
  LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
  LEFT JOIN inventario i ON i.producto_id = p.id
`;

// Filters lists
app.get("/api/filtros", async (_req, res) => {
  try {
    const [cats] = await pool.query("SELECT DISTINCT TRIM(nombre) AS nombre FROM categorias ORDER BY TRIM(nombre)");
    const [provs] = await pool.query("SELECT DISTINCT TRIM(nombre) AS nombre FROM proveedores ORDER BY TRIM(nombre)");
    res.json({
      categorias: cats.map(x => x.nombre),
      proveedores: provs.map(x => x.nombre),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// KPIs
app.get("/api/kpis", async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);

    const sql = `
      SELECT
        COUNT(*) AS total_products,
        COALESCE(SUM(COALESCE(i.cantidad,0)),0) AS total_stock_units,
        COALESCE(SUM(COALESCE(i.cantidad,0) * p.costo),0) AS total_value_cost,
        COALESCE(SUM(CASE WHEN COALESCE(i.cantidad,0) <= 10 THEN 1 ELSE 0 END),0) AS low_stock_count
      ${BASE_FROM}
      ${where}
    `;

    const [rows] = await pool.query(sql, params);
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Inventory (paged)
app.get("/api/inventario", async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);
    const sort = buildSort(req.query.sort);

    const pageSize = clampInt(req.query.pageSize, 10, 5, 50); // default 10
    const page = clampInt(req.query.page, 1, 1, 100000);
    const offset = (page - 1) * pageSize;

    // total rows for pagination
    const countSql = `SELECT COUNT(*) AS total ${BASE_FROM} ${where}`;
    const [countRows] = await pool.query(countSql, params);
    const totalRows = Number(countRows?.[0]?.total || 0);

    // page data
    const dataSql = `
      SELECT
        p.id AS producto_id,
        p.sku,
        p.descripcion,
        TRIM(c.nombre) AS categoria,
        TRIM(pr.nombre) AS proveedor,
        COALESCE(i.cantidad,0) AS stock,
        p.costo,
        p.precio,
        (COALESCE(i.cantidad,0) * p.costo) AS valor
      ${BASE_FROM}
      ${where}
      ${sort}
      LIMIT ? OFFSET ?
    `;

    const dataParams = [...params, pageSize, offset];
    const [rows] = await pool.query(dataSql, dataParams);

    res.json({
      page,
      pageSize,
      totalRows,
      totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      rows
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const port = Number(process.env.PORT || "3000");
app.listen(port, () => console.log("Listening on", port));
