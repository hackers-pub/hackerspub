import { AsyncLocalStorage } from "node:async_hooks";
import type { ApplicationTaskExecution } from "@hackerspub/models/tasks";

export interface TaskExecutionState extends ApplicationTaskExecution {
  entered: boolean;
}

export const taskExecutionStorage = new AsyncLocalStorage<TaskExecutionState>();

export function enterApplicationTask(): ApplicationTaskExecution {
  const execution = taskExecutionStorage.getStore();
  if (execution == null)
    throw new Error("Application tasks require the durable task worker.");
  execution.entered = true;
  return execution;
}
