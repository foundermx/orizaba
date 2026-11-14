// Transporte municipal gratuito. Fuentes: carteles del H. Ayuntamiento de Orizaba («Paradas establecidas» de
// Gallo y Gallina; circuito y «Mapa de ruta» del Búho). scripts/bake.mjs lleva cada línea por las calles reales.
// Puntos con `name` = paradas o referencias; los demás solo guían el trazo. `approx` = ubicación tomada del
// cartel, por confirmar. `poi` enlaza la parada con la ficha del lugar.

// Búho: trazo calcado del «Mapa de ruta» (ida por Calle Real, retorno de Escamela, vuelta por Av. Crí-Crí)
const REAL = [[18.8454, -97.10519], [18.84757, -97.09954], [18.84747, -97.09478], [18.84825, -97.09294], [18.84917, -97.09019], [18.84949, -97.08898], [18.84996, -97.08618]];
const ESCAMELA = [[18.85633, -97.08165], [18.85693, -97.08148], [18.85812, -97.07986], [18.86204, -97.07657], [18.85971, -97.0739], [18.859, -97.07343]];
const CRI_CRI_NORTE = [[18.85614, -97.08591], [18.85634, -97.08626], [18.85822, -97.09009], [18.85879, -97.09173]];
const CRI_CRI_PONIENTE = [[18.85995, -97.11449], [18.8575, -97.11415], [18.8552, -97.11405], [18.85227, -97.11317], [18.84956, -97.1127], [18.84842, -97.11265], [18.84799, -97.11277], [18.84541, -97.11199], [18.84465, -97.11237], [18.84419, -97.11235], [18.84378, -97.11224]];
const guide = (list) => list.map(([lat, lon]) => ({ lat, lon }));
const pass = (lat, lon) => ({ lat, lon, pass: true });

export const LINES = [
  {
    id: 'gallo', name: 'Gallo y Gallina', color: '#D21F45', icon: 'bus', numbered: true, loop: true,
    tag: 'Servicio municipal gratuito', meta: '13 paradas · Gratis',
    note: 'La Gallina (rosa) es de uso exclusivo para mujeres, niñas y niños. El trazo entre paradas es aproximado.',
    buses: [{ livery: 'gallo', name: 'Gallo', color: '#D21F45' }, { livery: 'gallina', name: 'Gallina', color: '#D6257F' }],
    route: [
      { name: 'Alameda Francisco Gabilondo Soler', lat: 18.84522, lon: -97.1119, poi: 'alameda' }, // esquina surponiente, sobre la avenida
      { name: 'Reserva Animal Tyson', lat: 18.8593, lon: -97.115, approx: true },
      { name: 'Mercado Cerritos', lat: 18.863268, lon: -97.114573 },
      pass(18.86225, -97.10997), // regresa a la avenida y sube por Prolongación Norte 2
      { name: 'Aeroparque', lat: 18.867421, lon: -97.113075, poi: 'aeroparque' },
      { name: 'Los Censos', lat: 18.8651, lon: -97.1024, approx: true },
      { name: 'Plaza Valle', lat: 18.863276, lon: -97.097016 },
      { name: 'Tobogán de la Montaña', lat: 18.859223, lon: -97.084223, poi: 'tobogan' },
      { name: 'Casavegas', lat: 18.857452, lon: -97.085674, poi: 'casavegas' },
      { name: 'Hospital IMSS', lat: 18.849477, lon: -97.084831 },
      { name: 'Poliforum Mier y Pesado', lat: 18.848324, lon: -97.089172, poi: 'poliforum' },
      { name: 'Escuela Secundaria Margarita Maza', lat: 18.840468, lon: -97.092184 },
      { name: 'Jardín Botánico BIORI', lat: 18.837028, lon: -97.096784, poi: 'biori' },
      { name: 'La Placa', lat: 18.837, lon: -97.1005, approx: true },
    ],
  },
  {
    id: 'buho', name: 'Búho', color: '#6A2C91', icon: 'moon', loop: true, guided: true,
    tag: 'Transporte nocturno gratuito · 21:00 a 06:00', meta: 'Circuito nocturno · 21:00 a 06:00 · Gratis',
    note: 'Circuito Calle Real – Av. Crí-Crí, de lunes a domingo. Viaja gratis y seguro.',
    buses: [{ livery: 'buho', name: 'Búho', color: '#6A2C91' }, { livery: 'buho', name: 'Búho', color: '#6A2C91' }],
    route: [
      { name: 'Calle Real, extremo poniente', lat: 18.84233, lon: -97.11136 },
      ...guide(REAL.slice(0, 2)),
      { name: 'Calle Real, Centro', lat: 18.84757, lon: -97.09954 },
      ...guide(REAL.slice(3)),
      pass(18.85083, -97.08363),
      pass(18.8552, -97.08533),
      ...guide(ESCAMELA),
      { name: 'Retorno Escamela', lat: 18.85771, lon: -97.07216 },
      ...guide([...ESCAMELA].reverse()),
      pass(18.8552, -97.08533),
      ...guide(CRI_CRI_NORTE),
      { name: 'Av. Crí-Crí', lat: 18.86508, lon: -97.10245 },
      pass(18.86043, -97.11435),
      ...guide(CRI_CRI_PONIENTE),
    ],
  },
];
for (const line of LINES) line.stops = line.route.filter((p) => p.name); // what the map lists and pins
