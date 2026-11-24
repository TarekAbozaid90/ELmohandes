'use strict';

const MAX_STOCK = 999999;
const STOCK_DEFINITION = `INTEGER CHECK (stock_quantity IS NULL OR (stock_quantity BETWEEN 0 AND ${MAX_STOCK} AND stock_quantity = CAST(stock_quantity AS INTEGER)))`;
const message = 'كمية المخزون لازم تكون عدد صحيح من 0 إلى 999999. سيب الخانة فاضية لو الكمية مش محددة.';
function normalizeStock(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    value = value.trim().replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) % 16));
    if (!value) return null;
    if (!/^\d{1,6}$/.test(value)) throw new Error(message);
    value = Number(value);
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_STOCK) throw new Error(message);
  return value;
}
module.exports = { normalizeStock, STOCK_DEFINITION };
