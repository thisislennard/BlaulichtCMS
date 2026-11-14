// Komprimiert die Build-Ausgabe vorab (Brotli + Gzip). Der Server liefert die passende Variante aus,
// ohne bei jeder Anfrage neu zu komprimieren.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const exts = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt']);
let count = 0;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.has(path.extname(e.name)) && fs.statSync(p).size > 1024) {
      const buf = fs.readFileSync(p);
      const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
      fs.writeFileSync(p + '.br', br);
      fs.writeFileSync(p + '.gz', zlib.gzipSync(buf, { level: 9 }));
      count++;
      before += buf.length;
      after += br.length;
    }
  }
};
walk(dist);
console.log(`vorkomprimiert: ${count} Dateien, ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (Brotli)`);
