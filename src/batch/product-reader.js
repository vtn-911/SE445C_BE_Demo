const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('csv-parse/sync');

async function readProducts(filePath) {
  const contents = await fs.readFile(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  let products;

  if (extension === '.json') {
    products = JSON.parse(contents);
  } else if (extension === '.csv') {
    products = parse(contents, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } else {
    throw new Error(`Unsupported product input file extension: ${extension || '(none)'}`);
  }

  if (!Array.isArray(products)) {
    throw new Error('Product input must contain an array of records');
  }

  return products.map((product, index) => {
    const sku = typeof product.sku === 'string' ? product.sku.trim() : '';
    const name = typeof product.name === 'string' ? product.name.trim() : '';
    const category = typeof product.category === 'string' ? product.category.trim() : '';
    const price = typeof product.price === 'number' ? product.price : Number(product.price);

    if (!sku || !name || !category || !Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid product record at row ${index + 1}`);
    }
    return { sku, name, category, price };
  });
}

module.exports = { readProducts };
