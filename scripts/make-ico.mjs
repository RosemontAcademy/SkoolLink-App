// Packs assets/ico/icon-{size}.png into assets/icon.ico (PNG-compressed
// entries — valid since Vista, required ≥256px by electron-builder).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => readFileSync(join(root, 'assets', 'ico', `icon-${s}.png`)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);

let offset = 6 + 16 * sizes.length;
const entries = [];
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 0); // width (0 = 256)
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 1); // height
  e.writeUInt8(0, 2);       // palette
  e.writeUInt8(0, 3);       // reserved
  e.writeUInt16LE(1, 4);    // planes
  e.writeUInt16LE(32, 6);   // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}

writeFileSync(join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
console.log('wrote assets/icon.ico');
