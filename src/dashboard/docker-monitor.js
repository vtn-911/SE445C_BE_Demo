const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const EXPECTED_SERVICES = [
  { name: 'kong', role: 'API Gateway (:8000)' },
  { name: 'backend', role: 'Integration Backend (:3000)' },
  { name: 'rabbitmq', role: 'Event Broker (:5672 / :15672)' },
  { name: 'mock-wms', role: 'Warehouse System API (:3100)' },
  { name: 'mock-tms', role: 'Transport System API (:3300)' },
  { name: 'mock-crm', role: 'Loyalty Points API (:3200)' },
  { name: 'python-mapping', role: 'AI Data Mapping (:3400)' },
  { name: 'batch-receiver', role: 'Catalog Batch Receiver (:3500)' },
];

function mapContainerToStatus(container) {
  if (!container) {
    return { status: 'OFFLINE', healthStatus: 'not found' };
  }
  const state = String(container.State || '').toLowerCase();
  const health = String(container.Health || '').toLowerCase();

  if (state === 'running') {
    if (health === 'unhealthy' || health === 'starting') {
      return { status: 'UNHEALTHY', healthStatus: health };
    }
    return { status: 'ONLINE', healthStatus: health || 'running' };
  }
  if (state === 'exited' || state === 'dead' || state === 'paused' || state === 'created') {
    return { status: 'OFFLINE', healthStatus: state };
  }
  return { status: 'UNKNOWN', healthStatus: state || 'unknown' };
}

function parseComposePsJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class DockerMonitor {
  constructor({ composeFile, cacheTtlMs = 3000, timeoutMs = 15000, execFn = execFileAsync, eventHub = null }) {
    this.composeFile = composeFile;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.execFn = execFn;
    this.eventHub = eventHub;
    this.cache = null;
    this.cacheExpiresAt = 0;
    this.lastStatuses = new Map();
  }

  async getHealth({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    const checkedAt = new Date().toISOString();
    let containers = [];
    let dockerError = null;

    try {
      const { stdout } = await this.execFn(
        'docker',
        ['compose', '-f', this.composeFile, 'ps', '-a', '--format', 'json'],
        { timeout: this.timeoutMs }
      );
      containers = parseComposePsJson(stdout);
    } catch (err) {
      dockerError = err.message || 'Docker Engine unavailable';
    }

    const byService = new Map();
    for (const c of containers) {
      if (c.Service) byService.set(c.Service, c);
    }

    const services = EXPECTED_SERVICES.map((svc) => {
      if (dockerError) {
        return {
          name: svc.name,
          role: svc.role,
          status: 'UNKNOWN',
          healthStatus: 'docker_unavailable',
          lastChecked: checkedAt,
          detail: dockerError,
        };
      }

      const container = byService.get(svc.name);
      const mapped = mapContainerToStatus(container);

      const prev = this.lastStatuses.get(svc.name);
      if (prev && prev !== mapped.status && this.eventHub) {
        this.eventHub.push({
          type: 'SERVICE_STATUS_CHANGED',
          service: svc.name,
          status: mapped.status === 'ONLINE' ? 'SUCCESS' : mapped.status === 'OFFLINE' ? 'ERROR' : 'WARNING',
          message: `Service ${svc.name} changed status from ${prev} to ${mapped.status}`,
          timestamp: checkedAt,
        });
      }
      this.lastStatuses.set(svc.name, mapped.status);

      return {
        name: svc.name,
        role: svc.role,
        status: mapped.status,
        healthStatus: mapped.healthStatus,
        lastChecked: checkedAt,
        detail: container?.Status || null,
      };
    });

    const result = {
      checkedAt,
      dockerAvailable: !dockerError,
      services,
    };

    this.cache = result;
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return result;
  }

  async controlMockTms(action) {
    if (action !== 'stop' && action !== 'start') {
      throw new Error('Invalid action for mock-tms');
    }

    // Strictly hardcoded to mock-tms service only
    await this.execFn(
      'docker',
      ['compose', '-f', this.composeFile, action, 'mock-tms'],
      { timeout: this.timeoutMs }
    );

    const health = await this.getHealth({ force: true });
    const tms = health.services.find((s) => s.name === 'mock-tms');
    return {
      success: true,
      service: 'mock-tms',
      action,
      status: tms?.status || 'UNKNOWN',
      healthStatus: tms?.healthStatus || 'unknown',
      checkedAt: health.checkedAt,
    };
  }
}

module.exports = { DockerMonitor, EXPECTED_SERVICES, mapContainerToStatus, parseComposePsJson };
