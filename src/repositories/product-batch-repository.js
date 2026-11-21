const path = require('node:path');
const { JsonFileStore } = require('./json-file-store');

class ProductBatchRepository {
  constructor(stateDir) {
    this.store = new JsonFileStore(
      path.join(stateDir, 'batch-receiver', 'batches.json'),
      { batches: [] }
    );
  }

  async acceptBatch({ runId, batchNumber, products }) {
    let result;
    await this.store.update((state) => {
      const existing = state.batches.find((batch) =>
        batch.runId === runId && batch.batchNumber === batchNumber
      );
      if (existing) {
        result = JSON.stringify(existing.products) === JSON.stringify(products)
          ? { status: 'duplicate', batch: existing }
          : { status: 'conflict' };
        return;
      }

      const batch = {
        runId,
        batchNumber,
        receivedAt: new Date().toISOString(),
        products
      };
      state.batches.push(batch);
      result = { status: 'created', batch };
    });
    return result;
  }

  async listBatches() {
    return (await this.store.read()).batches;
  }
}

module.exports = { ProductBatchRepository };
