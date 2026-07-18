import { isAbsolute, resolve } from "node:path";

import * as frida from "frida";

import type { Runtime, TargetConfig } from "./config.js";

const SYSTEM_SESSION_PID = 0;

export function resolveLocalSpawn(program: string, root: string): string {
  if (isAbsolute(program)) return program;
  if (!/[\\/]/.test(program)) return program;
  return resolve(root, program);
}

export async function getDevice(target: TargetConfig): Promise<frida.Device> {
  const { device } = target;
  if (device === "local") return frida.getLocalDevice();
  if (device === "usb") return frida.getUsbDevice();
  if (typeof device === "object" && device.id) return frida.getDevice(device.id);
  throw new Error(`invalid "device" in target config: ${JSON.stringify(device)}`);
}

export interface OpenedSession {
  session: frida.Session;
  /** Resume a gated spawn (idempotent); no-op for the system session. */
  resume(): Promise<void>;
  /** Kill the process if we spawned it, else detach. */
  close(): Promise<void>;
}

export async function openSession(
  device: frida.Device,
  target: TargetConfig,
): Promise<OpenedSession> {
  const { session } = target;

  if (session === "system") {
    const s = await device.attach(SYSTEM_SESSION_PID);
    return { session: s, resume: async () => {}, close: () => s.detach() };
  }
  if ("spawn" in session) {
    // spawn gating: the process starts suspended so the agent can hook before any of its code runs
    const program =
      target.device === "local" ? resolveLocalSpawn(session.spawn, process.cwd()) : session.spawn;
    const argv = session.args ? [program, ...session.args] : undefined;
    const pid = await device.spawn(program, argv ? { argv } : undefined);
    const s = await device.attach(pid);
    let resumed = false;
    return {
      session: s,
      resume: async () => {
        if (resumed) return;
        resumed = true;
        await device.resume(pid);
      },
      close: async () => {
        try {
          await device.kill(pid);
        } catch {
          // already gone (crashed / exited)
        }
      },
    };
  }
  throw new Error('invalid "session" in target config');
}

export function runtimeOption(runtime?: Runtime): frida.ScriptRuntime {
  switch (runtime) {
    case "qjs":
      return frida.ScriptRuntime.QJS;
    case "v8":
      return frida.ScriptRuntime.V8;
    default:
      return frida.ScriptRuntime.Default;
  }
}
