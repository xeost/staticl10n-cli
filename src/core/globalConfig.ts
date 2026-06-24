import fs from 'fs-extra';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { logger } from '../utils/logger.js';

export interface GlobalConfig {
  model_priorities: string[];
}

const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'data', 'global-config.yaml');

const DEFAULT_GLOBAL_CONFIG = `# staticl10n global configuration

# Model priorities
# The models are ordered from highest priority / most powerful (top/first) to lowest priority (bottom/last).
# Higher models in this list are considered superior (more powerful) to lower ones.
#
# When translating a fragment, if a cache entry is found for a different model:
# - If the current model is superior (higher priority / more powerful) to the cached entry's model,
#   we re-translate and update the cache.
# - Otherwise (lower or equal priority), we reuse the cached translation to save tokens.
model_priorities:
  - gemma4
  - gemma3:12b
  - llama3.1
`;

let cachedGlobalConfig: GlobalConfig | null = null;

/** Reads the global configuration from data/global-config.yaml. */
export function readGlobalConfig(): GlobalConfig {
  if (cachedGlobalConfig) return cachedGlobalConfig;

  try {
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
      fs.ensureDirSync(path.dirname(GLOBAL_CONFIG_PATH));
      fs.writeFileSync(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, 'utf-8');
      logger.info(`Created default global config at ${GLOBAL_CONFIG_PATH}`);
    }

    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
    const parsed = yamlLoad(raw) as Partial<GlobalConfig>;
    
    cachedGlobalConfig = {
      model_priorities: parsed?.model_priorities ?? ['gemma4', 'gemma3:12b', 'llama3.1'],
    };
  } catch (err) {
    logger.warn(`Failed to read global config: ${(err as Error).message}. Using default priorities.`);
    cachedGlobalConfig = {
      model_priorities: ['gemma4', 'gemma3:12b', 'llama3.1'],
    };
  }

  return cachedGlobalConfig;
}

/**
 * Compares two models.
 * Returns:
 *   > 0 if modelA has higher priority (more powerful) than modelB
 *   < 0 if modelA has lower priority than modelB
 *   0 if they have equal priority
 */
export function compareModelPriority(modelA: string, modelB: string): number {
  if (modelA === modelB) return 0;
  
  const config = readGlobalConfig();
  const priorities = config.model_priorities;
  
  const idxA = priorities.indexOf(modelA);
  const idxB = priorities.indexOf(modelB);
  
  // Calculate priority values:
  // - If present, priority is (length - index) which is higher for lower indexes (top).
  // - If absent, priority is -1.
  const priorityA = idxA >= 0 ? priorities.length - idxA : -1;
  const priorityB = idxB >= 0 ? priorities.length - idxB : -1;
  
  return priorityA - priorityB;
}
