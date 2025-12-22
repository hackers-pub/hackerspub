import child_process from "node:child_process";
export declare function execAsync(
  cmd: string,
  options: child_process.ExecOptions,
): Promise<{
  stderr: string;
  stdout: string;
}>;
