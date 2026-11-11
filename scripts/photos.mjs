// Downloads free-licensed photos from Wikimedia Commons for the place cards, with credits.
// Run: `node scripts/photos.mjs` → public/photos/*.jpg + src/photos.json. Swap in the city's own photos when available.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FILES = {
  "palacio-de-hierro": "File:Palacio de hierro de Orizaba, Veracruz.jpg",
  "catedral": "File:Orizaba3.jpg",
  "teleferico": "File:Teleférico de Orizaba 1.jpg",
  "cerro-del-borrego": "File:Access to the Cerro del Borrego in Orizaba, Veracruz.jpg",
  "paseo-del-rio": "File:Paseo del Río Orizaba, Puente 5, Puente 3, Teleférico 18.jpg",
  "poliforum": "File:Poliforum Mier y Pesado en Orizaba.jpg",
  "maev": "File:Museo de Arte del Estado de Veracruz, patio..jpg",
  "palacio-municipal": "File:Palacio Municipal de Orizaba, 2025.jpg",
  "ex-convento": "File:Exterior del Exconvento de San José de Gracia en Orizaba 01.jpg",
  "teatro-llave": "File:Teatro Ignacio de la Llave, Orizaba, Ver..jpg",
  "la-concordia": "File:Santuario de la Concordia, Orizaba.jpg",
  "santa-gertrudis": "File:Iglesia de Santa Gertrudis, Orizaba, Ver.jpg",
  "el-carmen": "File:Iglesia del Carmen, Orizaba, Ver..jpg",
  "los-dolores": "File:Iglesia de los Dolores, Orizaba.jpg",
  "servitas": "File:Rectoría de Santa María de los Servitas. Orizaba.jpg",
  "el-calvario": "File:Iglesia del Calvario, Orizaba, Ver..jpg",
  "ojo-de-agua": "File:OJO DE AGUA ORIZABA VERACRUZ (BY LION) - panoramio - LEON23.jpg",
  "alameda": "File:Alameda \"Francisco Gabilondo Soler\" de Orizaba, Veracruz.jpg",
  "parque-castillo": "File:Parque Castillo en Orizaba visto desde el Teatro Llave 03.jpg",
  "panteon": "File:Panteón Orizaba.jpg",
  "casa-de-las-leyendas": "File:Casa de las Leyendas (House of Legends Museum in Orizaba).jpg",
  "san-juan-de-dios": "File:Parroquia de San Juan de Dios, Orizaba, Ver.jpg",
  "mercado-artesanias": "File:Mercado de Artesanías en Orizaba, Veracruz 01.jpg",
  "arte-popular": "File:Rosario a San José Obrero en Mercado de Artesanías, Orizaba 01.jpg",
  "500-escalones": "File:Bajada a cañón del Río Blanco en los 500 Escalones.jpg",
  "biori": "File:BIORI, Jardín Botánico de Orizaba 001.jpg",
  "san-antonio": "File:Rectoría de San Antonio de Padua, Orizaba 02.jpg",
};
const ROOT = path.resolve(import.meta.dirname, '..');
const UA = { 'User-Agent': 'orizaba-map-prototype/0.1 (tourism map demo)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, as) {
  for (let k = 0; k < 6; k++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) return as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
    await sleep(5000 * (k + 1));
  }
  throw new Error(`failed: ${url}`);
}
const strip = (h = '') => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
fs.mkdirSync(path.join(ROOT, 'public/photos/thumbs'), { recursive: true });
const out = {};
for (const [id, title] of Object.entries(FILES)) {
  const q = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=960&titles=${encodeURIComponent(title)}`, 'json');
  const info = Object.values(q.query.pages)[0].imageinfo[0], m = info.extmetadata;
  fs.writeFileSync(path.join(ROOT, 'public/photos', `${id}.jpg`), await get(info.thumburl));
  const file = path.join(ROOT, 'public/photos', `${id}.jpg`); // macOS sips: resize + recompress, plus a list thumbnail
  execFileSync('sips', ['-Z', '760', '-s', 'formatOptions', '68', file, '--out', file]);
  execFileSync('sips', ['-Z', '128', '-s', 'formatOptions', '72', file, '--out', path.join(ROOT, 'public/photos/thumbs', `${id}.jpg`)]);
  out[id] = { src: `/photos/${id}.jpg`, thumb: `/photos/thumbs/${id}.jpg`, credit: `Foto: ${strip(m.Artist?.value) || 'Wikimedia Commons'} · ${m.LicenseShortName?.value || ''} · Wikimedia Commons`, page: info.descriptionurl };
  console.log(id, '←', title);
  await sleep(1200);
}
fs.writeFileSync(path.join(ROOT, 'src/photos.json'), JSON.stringify(out, null, 1));
