import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDirectory } from "@/lib/sqlite";

type LogDetails = Record<string, unknown>;

export type ScanLogger = {
  info(event: string, details?: LogDetails): void;
  warn(event: string, details?: LogDetails): void;
  error(event: string, details?: LogDetails): void;
};

function formatDetails(details: LogDetails) {
  return Object.entries(details).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
}

const silentLogger: ScanLogger = { info() {}, warn() {}, error() {} };

function logsDirectory() {
  return path.join(dataDirectory(), "logs");
}

export function createScanLogger(enabled: boolean, baseName = "shelfcheck"): ScanLogger {
  if (!enabled) return silentLogger;
  const logDirectory = logsDirectory();
  const currentLog = path.join(logDirectory, `${baseName}.log`);
  try {
    mkdirSync(logDirectory, { recursive: true });
    const oldest = path.join(logDirectory, `${baseName}-9.log`);
    if (existsSync(oldest)) rmSync(oldest);
    for (let index = 8; index >= 1; index -= 1) {
      const source = path.join(logDirectory, `${baseName}-${index}.log`);
      if (existsSync(source)) renameSync(source, path.join(logDirectory, `${baseName}-${index + 1}.log`));
    }
    if (existsSync(currentLog)) renameSync(currentLog, path.join(logDirectory, `${baseName}-1.log`));
    writeFileSync(currentLog, "", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("Shelfcheck could not initialize its scan log.", error);
  }

  const write = (level: "INFO" | "WARN" | "ERROR", event: string, details: LogDetails = {}) => {
    const suffix = formatDetails(details);
    const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${event}${suffix ? ` | ${suffix}` : ""}`;
    console.log(line);
    try { appendFileSync(currentLog, `${line}\n`, "utf8"); }
    catch (error) { console.error("Shelfcheck could not write to its scan log.", error); }
  };

  return {
    info: (event, details) => write("INFO", event, details),
    warn: (event, details) => write("WARN", event, details),
    error: (event, details) => write("ERROR", event, details),
  };
}

export function readCurrentScanLog(baseName = "shelfcheck") {
  const currentLog = path.join(logsDirectory(), `${baseName}.log`);
  return existsSync(currentLog) ? readFileSync(currentLog) : null;
}

export function deleteAllScanLogs(baseName = "shelfcheck") {
  const logDirectory = logsDirectory();
  let deleted = 0;
  for (let index = 0; index <= 9; index += 1) {
    const target = path.join(logDirectory, index === 0 ? `${baseName}.log` : `${baseName}-${index}.log`);
    if (existsSync(target)) {
      rmSync(target);
      deleted += 1;
    }
  }
  return deleted;
}
