import os from "node:os";
import path from "node:path";

export type AcpPathLayout = {
  mode: "env" | "app" | "repo";
  home: string;
  resources: string;
  configPath: string;
};

function appSupportHome(): string {
  return path.join(os.homedir(), "Library", "Application Support", "ACP Bridge");
}

/** If execPath is …/Something.app/Contents/MacOS/<bin>, return Contents dir. */
export function contentsDirFromExecPath(execPath: string): string | null {
  const macOSDir = path.dirname(execPath);
  if (path.basename(macOSDir) !== "MacOS") return null;
  const contents = path.dirname(macOSDir);
  if (path.basename(contents) !== "Contents") return null;
  return contents;
}

export function resolveAcpPathLayout(opts?: {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  repoFallback?: string;
}): AcpPathLayout {
  const env = opts?.env ?? process.env;
  const repoFallback =
    opts?.repoFallback ?? path.resolve(import.meta.dir, "../..");

  const homeEnv = env.ACP_BRIDGE_HOME;
  const configEnv = env.ACP_BRIDGE_CONFIG;
  const resourcesEnv = env.ACP_BRIDGE_RESOURCES;
  if (homeEnv || configEnv || resourcesEnv) {
    const home = homeEnv ?? appSupportHome();
    return {
      mode: "env",
      home,
      resources: resourcesEnv ?? home,
      configPath: configEnv ?? path.join(home, "acp-bridge.config.json"),
    };
  }

  const execPath = opts?.execPath ?? process.execPath;
  const contents = contentsDirFromExecPath(execPath);
  if (contents) {
    const home = appSupportHome();
    return {
      mode: "app",
      home,
      resources: path.join(contents, "Resources"),
      configPath: path.join(home, "acp-bridge.config.json"),
    };
  }

  return {
    mode: "repo",
    home: repoFallback,
    resources: repoFallback,
    configPath: path.join(repoFallback, "acp-bridge.config.json"),
  };
}

export function publicDir(opts?: Parameters<typeof resolveAcpPathLayout>[0]): string {
  return path.resolve(path.join(resolveAcpPathLayout(opts).resources, "public"));
}
