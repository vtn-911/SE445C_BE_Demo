const fs = require('node:fs/promises');

function parseRateLimitFromKongYml(content) {
  const lines = content.split(/\r?\n/);
  let inRateLimiting = false;
  let inConfig = false;
  const result = {};

  for (const line of lines) {
    if (/^\s*-\s*name:\s*rate-limiting\b/.test(line)) {
      inRateLimiting = true;
      inConfig = false;
      continue;
    }
    if (inRateLimiting && /^\s*-\s*name:\s*/.test(line)) {
      break;
    }
    if (inRateLimiting && /^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (inRateLimiting && inConfig) {
      const minuteMatch = /^\s*minute:\s*(\d+)/.exec(line);
      if (minuteMatch) result.minute = Number(minuteMatch[1]);

      const limitByMatch = /^\s*limit_by:\s*([A-Za-z0-9_-]+)/.exec(line);
      if (limitByMatch) result.limitBy = limitByMatch[1];

      const policyMatch = /^\s*policy:\s*([A-Za-z0-9_-]+)/.exec(line);
      if (policyMatch) result.policy = policyMatch[1];
    }
  }

  return result;
}

async function readKongRateLimitConfig(kongConfigPath) {
  const content = await fs.readFile(kongConfigPath, 'utf8');
  const parsed = parseRateLimitFromKongYml(content);
  if (typeof parsed.minute !== 'number') {
    throw new Error('rate-limiting plugin config not found in kong.yml');
  }
  return {
    verified: true,
    source: 'kong/kong.yml',
    minute: parsed.minute,
    limitBy: parsed.limitBy || 'unknown',
    policy: parsed.policy || 'unknown',
  };
}

module.exports = { parseRateLimitFromKongYml, readKongRateLimitConfig };
