import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { Worker } from '../acp/types.ts';
import { type Effort, ThrongError } from '../contract.ts';
import type { HarnessDefinition } from './types.ts';

// Model/effort selection after the handshake (DESIGN §4.1). Options are found by `category`, never by id.

/** Above this many models the rejection lists only the requested provider's ones. */
const FULL_LIST_MAX = 40;

export interface SelectOption {
  id: string;
  values: string[];
}

/** First `select` option of `category`, with grouped values flattened. */
export function optionByCategory(options: SessionConfigOption[] | undefined, category: string): SelectOption | undefined {
  const option = options?.find((o) => o.type === 'select' && o.category === category);
  if (!option || option.type !== 'select') return undefined;
  const values = option.options.flatMap((o) => ('value' in o ? [o.value] : o.options.map((g) => g.value)));
  return { id: option.id, values };
}

function currentOptions(worker: Worker): SessionConfigOption[] | undefined {
  return worker.session.configOptions;
}

async function setOption(worker: Worker, id: string, value: string): Promise<void> {
  await worker.setConfigOption(id, value);
}

/** `model_rejected` text: the full list when short, otherwise the requested provider's models and the total. */
export function modelRejectedMessage(model: string, values: string[]): string {
  const head = `model "${model}" is not available`;
  if (values.length <= FULL_LIST_MAX) return `${head}; valid models: ${values.join(', ')}`;
  const slash = model.indexOf('/');
  const tail = `… ${values.length} models in total; run list_harnesses for the full list`;
  if (slash === -1) return `${head}; ${tail}`;
  const prefix = model.slice(0, slash + 1);
  const same = values.filter((v) => v.startsWith(prefix));
  const listed = same.length ? `${prefix} models: ${same.join(', ')}` : `no ${prefix} models`;
  return `${head}; ${listed} ${tail}`;
}

/** Sets the `model` option strictly: a value the harness doesn't offer is `model_rejected`. */
export async function selectModel(worker: Worker, model: string): Promise<void> {
  const option = optionByCategory(currentOptions(worker), 'model');
  if (!option) throw new ThrongError('model_rejected', `cannot select model "${model}": harness exposes no model option`);
  if (!option.values.includes(model)) throw new ThrongError('model_rejected', modelRejectedMessage(model, option.values));
  await setOption(worker, option.id, model);
}

/** Sets the `thought_level` option through `def.mapEffort`; returns a warning instead of failing when it can't. */
export async function selectEffort(def: HarnessDefinition, worker: Worker, effort: Effort): Promise<string | undefined> {
  const option = optionByCategory(currentOptions(worker), 'thought_level');
  if (!option) return `effort "${effort}" ignored: ${def.id} exposes no effort option`;
  const mapped = def.mapEffort(effort, option.values);
  if (mapped === undefined) return `effort "${effort}" not available for ${def.id}; options: ${option.values.join(', ')}`;
  await setOption(worker, option.id, mapped);
  return mapped === effort ? undefined : `effort "${effort}" mapped to "${mapped}"`;
}
