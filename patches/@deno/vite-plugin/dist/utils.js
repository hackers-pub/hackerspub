import child_process from "node:child_process";
export async function execAsync(cmd, options) {
  return await new Promise((resolve, reject) =>
    child_process.exec(cmd, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    })
  );
}
