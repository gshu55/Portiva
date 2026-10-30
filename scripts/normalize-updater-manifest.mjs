import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeUpdaterManifest(manifest, release, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository name");
  }
  if (!manifest.version || release.tag_name !== `v${manifest.version}` || release.draft || release.prerelease) {
    throw new Error("Updater version does not match the published release");
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("Updater manifest has no platforms");
  }
  for (const platform of ["windows-x86_64", "linux-x86_64", "darwin-aarch64"]) {
    if (!manifest.platforms[platform]) throw new Error(`Missing updater platform: ${platform}`);
  }

  const downloadPrefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  const assets = new Map();
  for (const asset of release.assets ?? []) {
    if (asset.state !== "uploaded" || !asset.browser_download_url?.startsWith(downloadPrefix)) continue;
    assets.set(asset.url, asset);
    assets.set(asset.browser_download_url, asset);
  }

  const platforms = {};
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const asset = assets.get(entry?.url);
    if (!asset || asset.name.endsWith(".sig") || !entry?.signature?.trim()) {
      throw new Error(`Invalid updater asset or signature for ${platform}`);
    }
    platforms[platform] = { ...entry, url: asset.browser_download_url };
  }

  return { ...manifest, notes: release.body || manifest.notes, platforms };
}

async function main() {
  const [manifestPath, releasePath, repository, outputPath] = process.argv.slice(2);
  if (!manifestPath || !releasePath || !repository || !outputPath) {
    throw new Error("Usage: normalize-updater-manifest <manifest> <release> <owner/repo> <output>");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  const normalized = normalizeUpdaterManifest(manifest, release, repository);
  await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
