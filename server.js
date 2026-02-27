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

app.get("/api/inventario", async (req, res) => {
  const { categoria, proveedor, q } = req.query;

  let sql = `
    SELECT
      p.sku,
      p.descripcion,
      c.nombre AS categoria,
      pr.nombre AS proveedor,
      i.cantidad AS stock,
      p.costo,
      (i.cantidad * p.costo) AS valor
    FROM productos p
    LEFT JOIN categorias c ON p.categoria_id = c.id
    LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
    LEFT JOIN inventario i ON i.producto_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (categoria) { sql += " AND c.nombre = ?"; params.push(categoria); }
  if (proveedor) { sql += " AND pr.nombre = ?"; params.push(proveedor); }
  if (q) { sql += " AND (p.sku LIKE ? OR p.descripcion LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }

  sql += " ORDER BY valor DESC LIMIT 500";

  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

app.get("/api/filtros", async (_req, res) => {
  const [cats] = await pool.query("SELECT nombre FROM categorias ORDER BY nombre");
  const [provs] = await pool.query("SELECT nombre FROM proveedores ORDER BY nombre");
  res.json({
    categorias: cats.map(x => x.nombre),
    proveedores: provs.map(x => x.nombre),
  });
});

const port = Number(process.env.PORT || "3000");
app.listen(port, () => console.log("Listening on", port));
