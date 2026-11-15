const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonFileStore {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.initialValue = initialValue;
    this.pendingWrite = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not read JSON state at ${this.filePath}: ${error.message}`, { cause: error });
      }

      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(this.initialValue, null, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporaryPath, this.filePath);
      } catch (writeError) {
        await fs.rm(temporaryPath, { force: true });
        if (writeError.code !== 'EEXIST') throw writeError;
      }
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    }
  }

  update(mutator) {
    const operation = async () => {
      const state = await this.read();
      const result = await mutator(state);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      try {
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      return result;
    };

    this.pendingWrite = this.pendingWrite.then(operation, operation);
    return this.pendingWrite;
  }
}

module.exports = { JsonFileStore };
