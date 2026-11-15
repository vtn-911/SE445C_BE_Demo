const path = require('node:path');
const { JsonFileStore } = require('./json-file-store');

class ConsumerEventsRepository {
  constructor(stateDir, consumerName) {
    this.store = new JsonFileStore(
      path.join(stateDir, 'consumers', `${consumerName}.json`),
      { processedEventIds: [] }
    );
  }

  async processOnce(eventId, operation) {
    return this.store.update(async (state) => {
      if (state.processedEventIds.includes(eventId)) return false;
      await operation();
      state.processedEventIds.push(eventId);
      return true;
    });
  }
}

module.exports = { ConsumerEventsRepository };
