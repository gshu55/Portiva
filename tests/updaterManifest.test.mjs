import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUpdaterManifest } from "../scripts/normalize-updater-manifest.mjs";

const repository = "example/Portiva";
const tag = "v1.2.3";
const assets = ["windows.exe", "linux.AppImage", "mac.app.tar.gz"].map((name, index) => ({
  name,
  state: "uploaded",
  url: `https://api.github.com/repos/${repository}/releases/assets/${index + 1}`,
  browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
}));
const release = { tag_name: tag, draft: false, prerelease: false, body: "Release notes", assets };
const manifest = {
  version: "1.2.3",
  notes: "",
  platforms: Object.fromEntries(["windows-x86_64", "linux-x86_64", "darwin-aarch64"].map((platform, index) => [
    platform,
    { url: assets[index].url, signature: `signature-${index}` },
  ])),
};

test("release asset URLs are replaced without changing signatures", () => {
  const result = normalizeUpdaterManifest(manifest, release, repository);
  for (const [index, platform] of Object.keys(manifest.platforms).entries()) {
    assert.equal(result.platforms[platform].url, assets[index].browser_download_url);
    assert.equal(result.platforms[platform].signature, `signature-${index}`);
  }
  assert.equal(result.notes, "Release notes");
  assert.deepEqual(normalizeUpdaterManifest(result, release, repository), result);
});

test("rejects incomplete or unrelated update manifests", () => {
  assert.throws(() => normalizeUpdaterManifest({ ...manifest, version: "1.2.4" }, release, repository));
  assert.throws(() => normalizeUpdaterManifest({ ...manifest, platforms: {} }, release, repository));
  assert.throws(() => normalizeUpdaterManifest(manifest, { ...release, assets: assets.slice(1) }, repository));
  assert.throws(() => normalizeUpdaterManifest(manifest, { ...release, draft: true }, repository));
  assert.throws(() => normalizeUpdaterManifest(manifest, release, "other/repository"));
});
