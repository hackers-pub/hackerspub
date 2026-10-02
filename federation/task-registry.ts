import type { Context, TaskDefinition, TaskRegistry } from "@fedify/fedify";
import type {
  ApplicationContext,
  ContextData,
} from "@hackerspub/models/context";
import type {
  ApplicationTask,
  ApplicationTaskHandler,
} from "@hackerspub/models/tasks";
import { enterApplicationTask } from "./task-execution.ts";

const handles = new WeakMap<object, TaskDefinition<ContextData, unknown>>();

/** Register once on the shared builder; all builds retain the exact handle. */
export function registerApplicationTask<T>(
  registry: TaskRegistry<ContextData>,
  task: ApplicationTask<T>,
  adapt: (context: Context<ContextData>) => ApplicationContext,
  handler: ApplicationTaskHandler<T>,
): void {
  if (handles.has(task))
    throw new TypeError(`Task ${task.name} is already registered.`);
  const handle = registry.defineTask(task.name, {
    schema: task.schema,
    handler: async (context, data) => {
      const execution = enterApplicationTask();
      execution.signal.throwIfAborted();
      await handler(adapt(context), data, execution);
      execution.signal.throwIfAborted();
    },
  });
  handles.set(task, handle);
}

export function getApplicationTaskHandle<T>(
  task: ApplicationTask<T>,
): TaskDefinition<ContextData, T> {
  const handle = handles.get(task);
  if (handle == null)
    throw new TypeError(`Task ${task.name} is not registered.`);
  return handle as TaskDefinition<ContextData, T>;
}
