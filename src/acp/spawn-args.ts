import type { AcpBackend, AcpModelApply } from "./types";

/** Resolve argv for spawning an ACP backend, applying spawn-arg model when configured. */
export function resolveBackendSpawnArgs(
  backend: Pick<AcpBackend, "args" | "modelApply">,
  pendingModel: string | null | undefined,
): string[] {
  const modelApply: AcpModelApply = backend.modelApply ?? "inject";
  if (modelApply === "spawn-arg" && pendingModel != null && pendingModel.length > 0) {
    return [...backend.args, "--model", pendingModel];
  }
  return [...backend.args];
}

export function shouldInjectPendingModelOnNew(modelApply: AcpModelApply | undefined): boolean {
  return (modelApply ?? "inject") !== "spawn-arg";
}
