import type { ConnectionProfile } from "./types";

export function profileTarget(profile: ConnectionProfile) {
  if (profile.type === "serial") {
    return `${profile.portName}:${profile.baudRate}`;
  }

  const username = "username" in profile && profile.username ? `${profile.username}@` : "";
  return `${username}${profile.host}:${profile.port}`;
}

export function profileTitle(profile: ConnectionProfile) {
  return `[${profile.type.toUpperCase()}] ${profileTarget(profile)}`;
}
