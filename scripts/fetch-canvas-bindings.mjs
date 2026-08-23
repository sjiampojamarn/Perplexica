import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');

const version = JSON.parse(
  readFileSync('node_modules/@napi-rs/canvas/package.json', 'utf8'),
).version;

const platforms = ['linux-arm64-gnu', 'linux-arm64-musl'];

for (const platform of platforms) {
  const pkg = `canvas-${platform}`;
  const dir = `node_modules/@napi-rs/${pkg}`;
  const url = `https://registry.npmjs.org/@napi-rs%2F${pkg}/-/${pkg}-${version}.tgz`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }

  writeFileSync('/tmp/canvas-binding.tgz', Buffer.from(await res.arrayBuffer()));
  mkdirSync(dir, { recursive: true });
  execSync(`tar xzf /tmp/canvas-binding.tgz -C ${dir} --strip-components=1`, {
    stdio: 'inherit',
  });

  console.log(`installed ${pkg}@${version}`);
}
