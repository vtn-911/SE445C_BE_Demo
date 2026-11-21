const path = require('node:path');
const { JsonFileStore } = require('./json-file-store');

const DEMO_CUSTOMERS = [
  { customerId: 'CUST-0001', points: 100 },
  { customerId: 'CUST-0002', points: 250 }
];

class CustomersRepository {
  constructor(stateDir) {
    this.store = new JsonFileStore(
      path.join(stateDir, 'crm', 'customers.json'),
      { customers: DEMO_CUSTOMERS }
    );
  }

  async setPoints(customerId, points) {
    let updatedCustomer = null;
    await this.store.update((state) => {
      const customer = state.customers.find((item) => item.customerId === customerId);
      if (!customer) return;
      customer.points = points;
      updatedCustomer = { ...customer };
    });
    return updatedCustomer;
  }

}

module.exports = { CustomersRepository };
