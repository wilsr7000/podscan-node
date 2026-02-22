// ---------------------------------------------------------------------------
// Icon Generator — mathematical sacred geometry + LLM-powered custom icons
// ---------------------------------------------------------------------------

const PROXY_URL =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/journey-map-api';
const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 60000;
const LLM_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function r2(n) { return Math.round(n * 100) / 100; }

function polar(cx, cy, radius, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return [r2(cx + radius * Math.cos(rad)), r2(cy + radius * Math.sin(rad))];
}

function wrap(els, opts = {}) {
  const s = opts.size || 48;
  const sw = opts.strokeWidth || 1;
  const stroke = opts.stroke || '#fff';
  const fill = opts.fill || 'none';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">`,
    `  <g fill="${fill}" stroke="${stroke}" stroke-width="${sw}">`,
    ...els,
    '  </g>',
    '</svg>',
  ].join('\n');
}

function circ(cx, cy, r, extra) {
  return `    <circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}"${extra ? ' ' + extra : ''}/>`;
}

function ln(x1, y1, x2, y2, extra) {
  return `    <line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}"${extra ? ' ' + extra : ''}/>`;
}

function pth(d, extra) {
  return `    <path d="${d}"${extra ? ' ' + extra : ''}/>`;
}

function polyPoints(cx, cy, r, n, rotDeg = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(polar(cx, cy, r, rotDeg + (360 / n) * i));
  return pts;
}

function polygon(pts) {
  return `    <polygon points="${pts.map(p => p.join(',')).join(' ')}"/>`;
}

// ---------------------------------------------------------------------------
// Mathematical pattern generators
// ---------------------------------------------------------------------------

const PATTERNS = {};

// --- Circular family ---

PATTERNS['flower-of-life'] = function(opts = {}) {
  const { rings = 2, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = (size / 2 - 1) / (rings + 1);
  const sqrt3 = Math.sqrt(3);
  const els = [circ(cx, cy, size / 2 - 1)];
  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > rings) continue;
      const x = cx + R * (sqrt3 * q + sqrt3 / 2 * r);
      const y = cy + R * (3 / 2 * r);
      els.push(circ(x, y, R));
    }
  }
  return wrap(els, opts);
};

PATTERNS['seed-of-life'] = function(opts = {}) {
  return PATTERNS['flower-of-life']({ ...opts, rings: 1 });
};

PATTERNS['vesica-piscis'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const offset = R / 2;
  return wrap([
    circ(cx - offset, cy, R),
    circ(cx + offset, cy, R),
  ], opts);
};

PATTERNS['borromean-rings'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.28;
  const d = size * 0.12;
  return wrap([
    circ(cx, cy - d, R),
    circ(cx - d * Math.sqrt(3) / 2 * 2, cy + d, R),
    circ(cx + d * Math.sqrt(3) / 2 * 2, cy + d, R),
  ], opts);
};

// --- Polygonal family ---

PATTERNS['metatrons-cube'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R1 = size * 0.18, R2 = size * 0.42;
  const dotR = size * 0.03;
  const inner = polyPoints(cx, cy, R1, 6, 0);
  const outer = polyPoints(cx, cy, R2, 6, 30);
  const all = [[cx, cy], ...inner, ...outer];
  const els = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      els.push(ln(all[i][0], all[i][1], all[j][0], all[j][1], 'stroke-width="0.4"'));
    }
  }
  for (const p of all) els.push(circ(p[0], p[1], dotR, 'fill="#fff"'));
  els.push(circ(cx, cy, R2 + 2));
  return wrap(els, opts);
};

PATTERNS['star-polygon'] = function(opts = {}) {
  const { points = 5, skip = 2, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const verts = polyPoints(cx, cy, R, points, 0);
  const els = [circ(cx, cy, R)];
  for (let i = 0; i < points; i++) {
    const j = (i + skip) % points;
    els.push(ln(verts[i][0], verts[i][1], verts[j][0], verts[j][1]));
  }
  return wrap(els, opts);
};

PATTERNS['nested-polygons'] = function(opts = {}) {
  const { sides = 6, layers = 3, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 2;
  const els = [];
  for (let i = 0; i < layers; i++) {
    const R = maxR * (i + 1) / layers;
    const rot = (i * 180 / sides);
    els.push(polygon(polyPoints(cx, cy, R, sides, rot)));
  }
  return wrap(els, opts);
};

PATTERNS['hexagram'] = function(opts = {}) {
  return PATTERNS['star-polygon']({ ...opts, points: 6, skip: 2 });
};

// --- Spiral family ---

PATTERNS['golden-spiral'] = function(opts = {}) {
  const { turns = 3, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 2;
  const phi = (1 + Math.sqrt(5)) / 2;
  const steps = turns * 90;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / 90) * Math.PI / 2;
    const r = maxR * Math.pow(phi, -2 * angle / Math.PI) * 0.95;
    pts.push(`${r2(cx + r * Math.cos(angle))},${r2(cy + r * Math.sin(angle))}`);
  }
  return wrap([
    circ(cx, cy, maxR),
    pth(`M${pts.join(' L')}`, 'fill="none"'),
  ], opts);
};

PATTERNS['fibonacci'] = function(opts = {}) {
  const { size = 48 } = opts;
  const els = [];
  const fib = [1, 1, 2, 3, 5, 8, 13];
  const scale = (size - 4) / (fib[fib.length - 1] + fib[fib.length - 2]);
  let x = 2, y = 2;
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let i = 0; i < fib.length; i++) {
    const s = fib[i] * scale;
    const d = dirs[i % 4];
    const sx = d[0] >= 0 ? x : x - s;
    const sy = d[1] >= 0 ? y : y - s;
    els.push(pth(`M${r2(sx)},${r2(sy)} h${r2(s)} v${r2(s)} h${r2(-s)} Z`, 'stroke-width="0.5"'));
    const arcX = d[0] === 1 ? sx + s : d[0] === -1 ? sx : (d[1] === 1 ? sx : sx + s);
    const arcY = d[1] === 1 ? sy + s : d[1] === -1 ? sy : (d[0] === 1 ? sy : sy + s);
    els.push(pth(`M${r2(arcX)},${r2(arcY)} A${r2(s)},${r2(s)} 0 0 1 ${r2(arcX + d[1] * s)},${r2(arcY - d[0] * s)}`));
    x += d[0] * s;
    y += d[1] * s;
  }
  return wrap(els, opts);
};

PATTERNS['torus'] = function(opts = {}) {
  const { rings = 8, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.35, r = size * 0.12;
  const els = [circ(cx, cy, R + r), circ(cx, cy, Math.max(1, R - r))];
  for (let i = 0; i < rings; i++) {
    const angle = (i / rings) * Math.PI * 2;
    const ecx = cx + R * Math.cos(angle);
    const ecy = cy + R * Math.sin(angle);
    const rx = r;
    const ry = r * Math.abs(Math.sin(angle)) * 0.6 + r * 0.4;
    els.push(`    <ellipse cx="${r2(ecx)}" cy="${r2(ecy)}" rx="${r2(rx)}" ry="${r2(ry)}" transform="rotate(${r2(angle * 180 / Math.PI)} ${r2(ecx)} ${r2(ecy)})"/>`);
  }
  return wrap(els, opts);
};

// --- Triangular family ---

PATTERNS['sri-yantra'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [circ(cx, cy, R)];
  const upTriangles = [0.85, 0.62, 0.42, 0.2];
  const downTriangles = [0.78, 0.55, 0.35, 0.15, 0.05];
  for (const s of upTriangles) {
    const h = R * s;
    const base = h * 1.15;
    const tipY = cy - h * 0.7;
    const baseY = cy + h * 0.5;
    els.push(pth(`M${r2(cx)},${r2(tipY)} L${r2(cx + base / 2)},${r2(baseY)} L${r2(cx - base / 2)},${r2(baseY)} Z`));
  }
  for (const s of downTriangles) {
    const h = R * s;
    const base = h * 1.15;
    const tipY = cy + h * 0.7;
    const baseY = cy - h * 0.5;
    els.push(pth(`M${r2(cx)},${r2(tipY)} L${r2(cx + base / 2)},${r2(baseY)} L${r2(cx - base / 2)},${r2(baseY)} Z`));
  }
  els.push(circ(cx, cy, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['merkaba'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 1;
  const els = [circ(cx, cy, R)];
  els.push(pth(`M${cx},${cy - R * 0.95} L${cx + R * 0.82},${cy + R * 0.48} L${cx - R * 0.82},${cy + R * 0.48} Z`));
  els.push(pth(`M${cx},${cy + R * 0.95} L${cx - R * 0.82},${cy - R * 0.48} L${cx + R * 0.82},${cy - R * 0.48} Z`));
  const iR = R * 0.45;
  els.push(pth(`M${cx},${cy - iR * 0.95} L${cx + iR * 0.82},${cy + iR * 0.48} L${cx - iR * 0.82},${cy + iR * 0.48} Z`));
  els.push(pth(`M${cx},${cy + iR * 0.95} L${cx - iR * 0.82},${cy - iR * 0.48} L${cx + iR * 0.82},${cy - iR * 0.48} Z`));
  els.push(ln(cx, cy - R * 0.95, cx, cy + R * 0.95, 'stroke-width="0.5"'));
  els.push(ln(cx - R * 0.82, cy - R * 0.48, cx + R * 0.82, cy + R * 0.48, 'stroke-width="0.5"'));
  els.push(ln(cx + R * 0.82, cy - R * 0.48, cx - R * 0.82, cy + R * 0.48, 'stroke-width="0.5"'));
  els.push(circ(cx, cy, R * 0.2, 'stroke-width="0.7"'));
  els.push(circ(cx, cy, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['star-tetrahedron'] = function(opts = {}) {
  return PATTERNS['merkaba'](opts);
};

// --- Radial family ---

PATTERNS['mandala'] = function(opts = {}) {
  const { spokes = 12, rings = 3, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 1;
  const els = [];
  for (let r = 1; r <= rings; r++) {
    const rad = maxR * r / rings;
    els.push(circ(cx, cy, rad));
    const petalR = rad * 0.2;
    for (let s = 0; s < spokes; s++) {
      const angle = (360 / spokes) * s;
      const [px, py] = polar(cx, cy, rad, angle);
      els.push(circ(px, py, petalR));
    }
  }
  for (let s = 0; s < spokes; s++) {
    const angle = (360 / spokes) * s;
    const [x1, y1] = polar(cx, cy, maxR / rings, angle);
    const [x2, y2] = polar(cx, cy, maxR, angle);
    els.push(ln(x1, y1, x2, y2, 'stroke-width="0.5"'));
  }
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['sunburst'] = function(opts = {}) {
  const { rays = 16, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const innerR = size * 0.12, outerR = size / 2 - 1;
  const els = [circ(cx, cy, innerR, 'fill="#fff"')];
  for (let i = 0; i < rays; i++) {
    const angle = (360 / rays) * i;
    const [x1, y1] = polar(cx, cy, innerR, angle);
    const long = i % 2 === 0 ? outerR : outerR * 0.7;
    const [x2, y2] = polar(cx, cy, long, angle);
    els.push(ln(x1, y1, x2, y2));
  }
  els.push(circ(cx, cy, outerR));
  return wrap(els, opts);
};

PATTERNS['compass-rose'] = function(opts = {}) {
  const { points = 8, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 1;
  const els = [circ(cx, cy, R)];
  for (let i = 0; i < points; i++) {
    const angle = (360 / points) * i;
    const long = i % 2 === 0 ? R * 0.95 : R * 0.6;
    const [tip] = [polar(cx, cy, long, angle)];
    const [l] = [polar(cx, cy, R * 0.15, angle - 360 / points / 2)];
    const [r] = [polar(cx, cy, R * 0.15, angle + 360 / points / 2)];
    els.push(pth(`M${tip[0]},${tip[1]} L${l[0]},${l[1]} L${r[0]},${r[1]} Z`, 'fill="#fff" stroke-width="0.5"'));
  }
  els.push(circ(cx, cy, 3, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['eye-of-providence'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 1;
  const els = [];
  els.push(pth(`M${cx},${cy - R * 0.85} L${cx + R * 0.92},${cy + R * 0.55} L${cx - R * 0.92},${cy + R * 0.55} Z`));
  els.push(circ(cx, cy + R * 0.05, R * 0.3));
  els.push(circ(cx, cy + R * 0.05, R * 0.12, 'fill="#fff"'));
  const rayLen = R * 0.35;
  for (let i = 0; i < 12; i++) {
    const angle = 30 * i;
    const [x1, y1] = polar(cx, cy - R * 0.2, R * 0.55, angle);
    const [x2, y2] = polar(cx, cy - R * 0.2, R * 0.55 + rayLen, angle);
    els.push(ln(x1, y1, x2, y2, 'stroke-width="0.4"'));
  }
  return wrap(els, opts);
};

// --- Misc patterns ---

PATTERNS['atom'] = function(opts = {}) {
  const { orbits = 3, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [];
  for (let i = 0; i < orbits; i++) {
    const angle = (180 / orbits) * i;
    els.push(`    <ellipse cx="${cx}" cy="${cy}" rx="${r2(R)}" ry="${r2(R * 0.35)}" transform="rotate(${r2(angle)} ${cx} ${cy})"/>`);
  }
  els.push(circ(cx, cy, 3, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['infinity'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const rx = size * 0.22, ry = size * 0.16;
  const d = size * 0.15;
  return wrap([
    pth(`M${cx},${cy} C${cx - d},${cy - ry * 2} ${cx - d - rx * 2},${cy - ry * 2} ${cx - d - rx},${cy} S${cx - d},${cy + ry * 2} ${cx},${cy} S${cx + d + rx * 2},${cy - ry * 2} ${cx + d + rx},${cy} S${cx + d},${cy + ry * 2} ${cx},${cy}`),
    circ(cx, cy, size / 2 - 1),
  ], opts);
};

PATTERNS['circuit'] = function(opts = {}) {
  const { nodes = 5, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const els = [circ(cx, cy, R + 2)];
  const pts = polyPoints(cx, cy, R * 0.7, nodes * 2, 0);
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  for (const [px, py] of pts) {
    els.push(ln(cx, cy, px, py, 'stroke-width="0.5"'));
    els.push(circ(px, py, 1.5, 'fill="#fff"'));
  }
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    if (i % 2 === 0) els.push(ln(pts[i][0], pts[i][1], pts[j][0], pts[j][1], 'stroke-width="0.5"'));
  }
  return wrap(els, opts);
};

PATTERNS['dna'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const amp = size * 0.2;
  const els = [];
  const steps = 20;
  const lPts = [], rPts = [];
  for (let i = 0; i <= steps; i++) {
    const y = 2 + (size - 4) * i / steps;
    const phase = (i / steps) * Math.PI * 3;
    const x1 = cx + Math.sin(phase) * amp;
    const x2 = cx - Math.sin(phase) * amp;
    lPts.push(`${r2(x1)},${r2(y)}`);
    rPts.push(`${r2(x2)},${r2(y)}`);
    if (i % 4 === 0) els.push(ln(x1, y, x2, y, 'stroke-width="0.6"'));
  }
  els.unshift(pth(`M${lPts.join(' L')}`, 'fill="none"'));
  els.unshift(pth(`M${rPts.join(' L')}`, 'fill="none"'));
  return wrap(els, opts);
};

PATTERNS['wave'] = function(opts = {}) {
  const { cycles = 2, size = 48 } = opts;
  const cy = size / 2, amp = size * 0.25;
  const els = [];
  const steps = 60;
  for (let row = -1; row <= 1; row += 2) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const x = 1 + (size - 2) * i / steps;
      const y = cy + row * amp * Math.sin((i / steps) * Math.PI * 2 * cycles);
      pts.push(`${r2(x)},${r2(y)}`);
    }
    els.push(pth(`M${pts.join(' L')}`, 'fill="none"'));
  }
  els.push(circ(size / 2, size / 2, size / 2 - 1));
  return wrap(els, opts);
};

PATTERNS['tree-of-life'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const R = 3.5;
  const nodes = [
    [cx, 4],
    [cx - 8, 12], [cx + 8, 12],
    [cx, 16],
    [cx - 8, 24], [cx + 8, 24],
    [cx, 28],
    [cx - 8, 36], [cx + 8, 36],
    [cx, 44],
  ];
  const edges = [
    [0, 1], [0, 2], [1, 2], [1, 3], [2, 3],
    [1, 4], [2, 5], [3, 4], [3, 5], [4, 5],
    [4, 6], [5, 6], [4, 7], [5, 8], [6, 7], [6, 8],
    [7, 8], [7, 9], [8, 9], [6, 9],
  ];
  const els = [];
  for (const [a, b] of edges) {
    els.push(ln(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], 'stroke-width="0.5"'));
  }
  for (const [nx, ny] of nodes) els.push(circ(nx, ny, R));
  return wrap(els, opts);
};

PATTERNS['platonic-icosa'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [circ(cx, cy, R)];
  const outer = polyPoints(cx, cy, R * 0.9, 5, 0);
  const inner = polyPoints(cx, cy, R * 0.45, 5, 36);
  els.push(polygon(outer));
  els.push(polygon(inner));
  for (let i = 0; i < 5; i++) {
    els.push(ln(outer[i][0], outer[i][1], inner[i][0], inner[i][1]));
    els.push(ln(outer[i][0], outer[i][1], inner[(i + 4) % 5][0], inner[(i + 4) % 5][1]));
  }
  return wrap(els, opts);
};

// --- Geometric family (extended) ---

PATTERNS['pentagon'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const pts = polyPoints(cx, cy, R, 5, 0);
  const inner = polyPoints(cx, cy, R * 0.45, 5, 0);
  const els = [polygon(pts), polygon(inner)];
  for (let i = 0; i < 5; i++) els.push(ln(pts[i][0], pts[i][1], inner[i][0], inner[i][1], 'stroke-width="0.5"'));
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['octagon'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const outer = polyPoints(cx, cy, R, 8, 22.5);
  const inner = polyPoints(cx, cy, R * 0.5, 8, 22.5);
  const els = [polygon(outer), polygon(inner)];
  for (let i = 0; i < 8; i++) els.push(ln(outer[i][0], outer[i][1], inner[i][0], inner[i][1], 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['diamond'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const w = size * 0.35, h = size * 0.44;
  const els = [];
  els.push(pth(`M${r2(cx)},${r2(cy - h)} L${r2(cx + w)},${r2(cy)} L${r2(cx)},${r2(cy + h)} L${r2(cx - w)},${r2(cy)} Z`));
  els.push(ln(cx - w * 0.6, cy - h * 0.3, cx + w * 0.6, cy - h * 0.3, 'stroke-width="0.5"'));
  els.push(ln(cx, cy - h, cx - w * 0.6, cy - h * 0.3, 'stroke-width="0.5"'));
  els.push(ln(cx, cy - h, cx + w * 0.6, cy - h * 0.3, 'stroke-width="0.5"'));
  els.push(ln(cx - w * 0.6, cy - h * 0.3, cx, cy + h, 'stroke-width="0.5"'));
  els.push(ln(cx + w * 0.6, cy - h * 0.3, cx, cy + h, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['cross'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const arm = size * 0.38, w = size * 0.1;
  const els = [];
  els.push(pth(`M${r2(cx - w)},${r2(cy - arm)} h${r2(w * 2)} v${r2(arm - w)} h${r2(arm - w)} v${r2(w * 2)} h${r2(-(arm - w))} v${r2(arm - w)} h${r2(-w * 2)} v${r2(-(arm - w))} h${r2(-(arm - w))} v${r2(-w * 2)} h${r2(arm - w)} Z`));
  els.push(circ(cx, cy, w * 0.8, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['asterisk'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [];
  for (let i = 0; i < 6; i++) {
    const angle = 30 * i;
    const [x1, y1] = polar(cx, cy, R * 0.15, angle);
    const [x2, y2] = polar(cx, cy, R, angle);
    els.push(ln(x1, y1, x2, y2));
    const [mx, my] = polar(cx, cy, R * 0.65, angle);
    const [la, lb] = polar(mx, my, R * 0.12, angle + 90);
    const [ra, rb] = polar(mx, my, R * 0.12, angle - 90);
    els.push(ln(la, lb, ra, rb, 'stroke-width="0.5"'));
  }
  els.push(circ(cx, cy, R * 0.12, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['triangle'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const outer = polyPoints(cx, cy, R, 3, 0);
  const inner = polyPoints(cx, cy, R * 0.5, 3, 60);
  const els = [polygon(outer), polygon(inner)];
  for (let i = 0; i < 3; i++) {
    els.push(ln(outer[i][0], outer[i][1], inner[i][0], inner[i][1], 'stroke-width="0.5"'));
    els.push(ln(outer[i][0], outer[i][1], inner[(i + 2) % 3][0], inner[(i + 2) % 3][1], 'stroke-width="0.5"'));
  }
  return wrap(els, opts);
};

PATTERNS['chevron'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  for (let i = 0; i < 4; i++) {
    const y = 6 + i * 10;
    const spread = size * 0.35 - i * 2;
    els.push(pth(`M${r2(cx - spread)},${r2(y)} L${r2(cx)},${r2(y + 8)} L${r2(cx + spread)},${r2(y)}`));
  }
  return wrap(els, opts);
};

PATTERNS['hexagon-grid'] = function(opts = {}) {
  const { size = 48 } = opts;
  const hr = 5.5;
  const dx = hr * Math.sqrt(3), dy = hr * 1.5;
  const els = [];
  for (let row = 0; row < 5; row++) {
    const off = row % 2 === 0 ? 0 : dx / 2;
    for (let col = 0; col < 5; col++) {
      const hx = 5 + off + col * dx;
      const hy = 5 + row * dy;
      if (hx > size - 3 || hy > size - 3) continue;
      els.push(polygon(polyPoints(hx, hy, hr, 6, 30)));
    }
  }
  return wrap(els, opts);
};

PATTERNS['concentric-circles'] = function(opts = {}) {
  const { rings = 5, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 2;
  const els = [];
  for (let i = 1; i <= rings; i++) els.push(circ(cx, cy, maxR * i / rings));
  for (let a = 0; a < 360; a += 90) {
    const [x, y] = polar(cx, cy, maxR, a);
    els.push(circ(x, y, 1.5, 'fill="#fff"'));
  }
  els.push(circ(cx, cy, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['spiral'] = function(opts = {}) {
  const { turns = 4, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 2;
  const steps = turns * 36;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    const rr = maxR * t;
    pts.push(`${r2(cx + rr * Math.cos(a))},${r2(cy + rr * Math.sin(a))}`);
  }
  return wrap([pth(`M${pts.join(' L')}`)], opts);
};

PATTERNS['cube'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const s = size * 0.35;
  const dx = s * 0.866, dy = s * 0.5;
  const els = [];
  els.push(pth(`M${r2(cx)},${r2(cy - s)} L${r2(cx + dx)},${r2(cy - dy)} L${r2(cx)},${r2(cy)} L${r2(cx - dx)},${r2(cy - dy)} Z`));
  els.push(pth(`M${r2(cx - dx)},${r2(cy - dy)} L${r2(cx)},${r2(cy)} L${r2(cx)},${r2(cy + s)} L${r2(cx - dx)},${r2(cy + dy)} Z`));
  els.push(pth(`M${r2(cx + dx)},${r2(cy - dy)} L${r2(cx)},${r2(cy)} L${r2(cx)},${r2(cy + s)} L${r2(cx + dx)},${r2(cy + dy)} Z`));
  return wrap(els, opts);
};

PATTERNS['pyramid'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const apex = [cx, 4];
  const bl = [cx - size * 0.35, size * 0.7];
  const br = [cx + size * 0.35, size * 0.7];
  const back = [cx + size * 0.1, size * 0.55];
  const els = [];
  els.push(pth(`M${r2(bl[0])},${r2(bl[1])} L${r2(br[0])},${r2(br[1])} L${r2(back[0])},${r2(back[1])} Z`, 'stroke-width="0.5"'));
  els.push(ln(apex[0], apex[1], bl[0], bl[1]));
  els.push(ln(apex[0], apex[1], br[0], br[1]));
  els.push(ln(apex[0], apex[1], back[0], back[1], 'stroke-width="0.6"'));
  els.push(ln(bl[0], bl[1], back[0], back[1], 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['prism'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const off = 6;
  const els = [];
  els.push(pth(`M${r2(cx - off)},${5} L${r2(cx - 14 - off)},${r2(size - 5)} L${r2(cx + 14 - off)},${r2(size - 5)} Z`));
  els.push(pth(`M${r2(cx + off)},${8} L${r2(cx - 14 + off)},${r2(size - 2)} L${r2(cx + 14 + off)},${r2(size - 2)} Z`, 'stroke-width="0.6"'));
  els.push(ln(cx - off, 5, cx + off, 8, 'stroke-width="0.6"'));
  els.push(ln(cx - 14 - off, size - 5, cx - 14 + off, size - 2, 'stroke-width="0.6"'));
  els.push(ln(cx + 14 - off, size - 5, cx + 14 + off, size - 2, 'stroke-width="0.6"'));
  return wrap(els, opts);
};

PATTERNS['dodecagon'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const outer = polyPoints(cx, cy, R, 12, 0);
  const inner = polyPoints(cx, cy, R * 0.5, 12, 15);
  const els = [polygon(outer), polygon(inner)];
  for (let i = 0; i < 12; i++) els.push(ln(outer[i][0], outer[i][1], inner[i][0], inner[i][1], 'stroke-width="0.4"'));
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['tetrahedron'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const top = [cx, cy - R];
  const bl = [r2(cx - R * 0.87), r2(cy + R * 0.5)];
  const br = [r2(cx + R * 0.87), r2(cy + R * 0.5)];
  const inner = [r2(cx + R * 0.15), r2(cy - R * 0.1)];
  const els = [pth(`M${top[0]},${top[1]} L${bl[0]},${bl[1]} L${br[0]},${br[1]} Z`)];
  els.push(ln(top[0], top[1], inner[0], inner[1], 'stroke-width="0.7"'));
  els.push(ln(bl[0], bl[1], inner[0], inner[1], 'stroke-width="0.7"'));
  els.push(ln(br[0], br[1], inner[0], inner[1], 'stroke-width="0.7"'));
  els.push(circ(inner[0], inner[1], 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

// --- Sacred geometry (extended) ---

PATTERNS['enneagram'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const pts = polyPoints(cx, cy, R, 9, 0);
  const els = [circ(cx, cy, R)];
  els.push(pth(`M${pts[0].join(',')} L${pts[3].join(',')} L${pts[6].join(',')} Z`));
  const conn = [[1, 4], [4, 2], [2, 8], [8, 5], [5, 7], [7, 1]];
  for (const [a, b] of conn) els.push(ln(pts[a][0], pts[a][1], pts[b][0], pts[b][1]));
  for (const p of pts) els.push(circ(p[0], p[1], 1.2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['heptagram'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const pts = polyPoints(cx, cy, R, 7, 0);
  const els = [circ(cx, cy, R)];
  for (let i = 0; i < 7; i++) {
    const j = (i + 2) % 7;
    els.push(ln(pts[i][0], pts[i][1], pts[j][0], pts[j][1]));
  }
  for (let i = 0; i < 7; i++) {
    const j = (i + 3) % 7;
    els.push(ln(pts[i][0], pts[i][1], pts[j][0], pts[j][1], 'stroke-width="0.5"'));
  }
  return wrap(els, opts);
};

PATTERNS['celtic-knot'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.28;
  const els = [];
  for (let i = 0; i < 4; i++) {
    els.push(`    <ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(R)}" ry="${r2(R * 0.42)}" transform="rotate(${r2(i * 45)} ${r2(cx)} ${r2(cy)})"/>`);
  }
  els.push(circ(cx, cy, R * 0.18, 'fill="#fff"'));
  els.push(circ(cx, cy, size / 2 - 2));
  return wrap(els, opts);
};

PATTERNS['labyrinth'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const maxR = size / 2 - 2;
  const rings = 5;
  const els = [];
  for (let i = 1; i <= rings; i++) {
    const rr = maxR * i / rings;
    const gapA = i % 2 === 0 ? 0 : 180;
    const [sx, sy] = polar(cx, cy, rr, gapA + 20);
    const [ex, ey] = polar(cx, cy, rr, gapA + 340);
    els.push(pth(`M${r2(sx)},${r2(sy)} A${r2(rr)},${r2(rr)} 0 1 1 ${r2(ex)},${r2(ey)}`));
  }
  for (let i = 1; i < rings; i++) {
    const r1 = maxR * i / rings;
    const r2v = maxR * (i + 1) / rings;
    const a = i % 2 === 0 ? 0 : 180;
    const [x1, y1] = polar(cx, cy, r1, a);
    const [x2, y2] = polar(cx, cy, r2v, a);
    els.push(ln(x1, y1, x2, y2));
  }
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['yin-yang'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const h = R / 2;
  const els = [circ(cx, cy, R)];
  els.push(pth(`M${r2(cx)},${r2(cy - R)} A${r2(h)},${r2(h)} 0 0 1 ${r2(cx)},${r2(cy)} A${r2(h)},${r2(h)} 0 0 0 ${r2(cx)},${r2(cy + R)}`));
  els.push(circ(cx, cy - h, R * 0.1, 'fill="#fff"'));
  els.push(circ(cx, cy + h, R * 0.1, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['lotus'] = function(opts = {}) {
  const { petals = 8, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [];
  for (let i = 0; i < petals; i++) {
    const a = (360 / petals) * i;
    const [tx, ty] = polar(cx, cy, R, a);
    const [c1x, c1y] = polar(cx, cy, R * 0.55, a - 360 / petals * 0.35);
    const [c2x, c2y] = polar(cx, cy, R * 0.55, a + 360 / petals * 0.35);
    els.push(pth(`M${r2(cx)},${r2(cy)} Q${r2(c1x)},${r2(c1y)} ${r2(tx)},${r2(ty)} Q${r2(c2x)},${r2(c2y)} ${r2(cx)},${r2(cy)}`));
  }
  els.push(circ(cx, cy, R * 0.12, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['pentacle'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const pts = polyPoints(cx, cy, R, 5, 0);
  const els = [circ(cx, cy, R)];
  for (let i = 0; i < 5; i++) els.push(ln(pts[i][0], pts[i][1], pts[(i + 2) % 5][0], pts[(i + 2) % 5][1]));
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['triquetra'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size * 0.38;
  const els = [];
  for (let i = 0; i < 3; i++) {
    const a1 = i * 120;
    const a2 = (i + 1) * 120;
    const [x1, y1] = polar(cx, cy, R, a1);
    const [x2, y2] = polar(cx, cy, R, a2);
    const cpA = (a1 + a2) / 2;
    const [cpx, cpy] = polar(cx, cy, R * 1.15, cpA);
    els.push(pth(`M${r2(x1)},${r2(y1)} Q${r2(cpx)},${r2(cpy)} ${r2(x2)},${r2(y2)}`));
    const [ipx, ipy] = polar(cx, cy, R * 0.25, cpA);
    els.push(pth(`M${r2(x1)},${r2(y1)} Q${r2(ipx)},${r2(ipy)} ${r2(x2)},${r2(y2)}`));
  }
  els.push(circ(cx, cy, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['triskelion'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const els = [circ(cx, cy, R + 1)];
  for (let i = 0; i < 3; i++) {
    const startA = i * 120;
    const pts = [];
    for (let j = 0; j <= 30; j++) {
      const t = j / 30;
      const a = (startA + t * 270) * Math.PI / 180;
      const rr = R * (1 - t * 0.7);
      pts.push(`${r2(cx + rr * Math.cos(a))},${r2(cy + rr * Math.sin(a))}`);
    }
    els.push(pth(`M${pts.join(' L')}`));
  }
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['yantra'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [circ(cx, cy, R)];
  const scales = [0.9, 0.7, 0.5, 0.3];
  for (let i = 0; i < scales.length; i++) {
    els.push(polygon(polyPoints(cx, cy, R * scales[i], 3, i % 2 === 0 ? 0 : 60)));
  }
  for (let i = 0; i < 8; i++) {
    const [px, py] = polar(cx, cy, R * 0.92, i * 45);
    els.push(circ(px, py, 1.2, 'fill="#fff"'));
  }
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

// --- Tech / Science ---

PATTERNS['cpu'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const s = size * 0.28;
  const pins = 4, pinL = size * 0.1;
  const gap = s * 2 / (pins + 1);
  const els = [];
  els.push(pth(`M${r2(cx - s)},${r2(cy - s)} h${r2(s * 2)} v${r2(s * 2)} h${r2(-s * 2)} Z`));
  els.push(pth(`M${r2(cx - s * 0.5)},${r2(cy - s * 0.5)} h${r2(s)} v${r2(s)} h${r2(-s)} Z`, 'stroke-width="0.6"'));
  for (let i = 1; i <= pins; i++) {
    const off = -s + i * gap;
    els.push(ln(cx + off, cy - s, cx + off, cy - s - pinL, 'stroke-width="0.7"'));
    els.push(ln(cx + off, cy + s, cx + off, cy + s + pinL, 'stroke-width="0.7"'));
    els.push(ln(cx - s, cy + off, cx - s - pinL, cy + off, 'stroke-width="0.7"'));
    els.push(ln(cx + s, cy + off, cx + s + pinL, cy + off, 'stroke-width="0.7"'));
  }
  els.push(circ(cx - s * 0.3, cy - s * 0.3, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['wifi'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, by = size * 0.78;
  const els = [];
  for (let i = 1; i <= 3; i++) {
    const rr = i * size * 0.13;
    const x1 = cx - rr * 0.7, y1 = by - rr * 0.7;
    const x2 = cx + rr * 0.7, y2 = by - rr * 0.7;
    els.push(pth(`M${r2(x1)},${r2(y1)} Q${r2(cx)},${r2(by - rr * 1.3)} ${r2(x2)},${r2(y2)}`));
  }
  els.push(circ(cx, by, 2.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['bluetooth'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const h = size * 0.35, w = size * 0.16;
  const els = [];
  els.push(ln(cx, cy - h, cx, cy + h));
  els.push(pth(`M${r2(cx - w)},${r2(cy + h * 0.45)} L${r2(cx + w)},${r2(cy - h * 0.05)} L${r2(cx)},${r2(cy - h)}`));
  els.push(pth(`M${r2(cx - w)},${r2(cy - h * 0.45)} L${r2(cx + w)},${r2(cy + h * 0.05)} L${r2(cx)},${r2(cy + h)}`));
  els.push(circ(cx, cy, size / 2 - 2));
  return wrap(els, opts);
};

PATTERNS['shield'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const w = size * 0.38, top = 4;
  const els = [];
  els.push(pth(`M${r2(cx - w)},${r2(top)} H${r2(cx + w)} V${r2(size * 0.55)} L${r2(cx)},${r2(size - 4)} L${r2(cx - w)},${r2(size * 0.55)} Z`));
  els.push(ln(cx, top + 6, cx, size - 10, 'stroke-width="0.5"'));
  els.push(ln(cx - w * 0.6, size * 0.38, cx + w * 0.6, size * 0.38, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['lock'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const bw = size * 0.28, bh = size * 0.28;
  const by = size * 0.48;
  const sr = bw * 0.65;
  const els = [];
  els.push(pth(`M${r2(cx - bw)},${r2(by)} h${r2(bw * 2)} v${r2(bh)} h${r2(-bw * 2)} Z`));
  els.push(pth(`M${r2(cx - sr)},${r2(by)} V${r2(by - sr)} A${r2(sr)},${r2(sr)} 0 0 1 ${r2(cx + sr)},${r2(by - sr)} V${r2(by)}`));
  els.push(circ(cx, by + bh * 0.35, bh * 0.12, 'fill="#fff"'));
  els.push(ln(cx, by + bh * 0.42, cx, by + bh * 0.7));
  return wrap(els, opts);
};

PATTERNS['key'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cy = size / 2;
  const els = [];
  els.push(circ(14, cy, 7));
  els.push(circ(14, cy, 3));
  els.push(ln(21, cy, size - 6, cy));
  els.push(ln(size - 6, cy, size - 6, cy + 6));
  els.push(ln(size - 12, cy, size - 12, cy + 5));
  els.push(ln(size - 18, cy, size - 18, cy + 4));
  return wrap(els, opts);
};

PATTERNS['gear'] = function(opts = {}) {
  const { teeth = 8, size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const outerR = size / 2 - 3, innerR = outerR * 0.72;
  const tw = 360 / teeth / 4;
  const els = [];
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (360 / teeth) * i;
    pts.push(polar(cx, cy, innerR, a - tw * 1.5));
    pts.push(polar(cx, cy, outerR, a - tw));
    pts.push(polar(cx, cy, outerR, a + tw));
    pts.push(polar(cx, cy, innerR, a + tw * 1.5));
  }
  els.push(polygon(pts));
  els.push(circ(cx, cy, innerR * 0.4));
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['lightning'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx + 4)},${4} L${r2(cx - 8)},${r2(size * 0.42)} H${r2(cx + 2)} L${r2(cx - 5)},${size - 4} L${r2(cx + 10)},${r2(size * 0.52)} H${r2(cx)} Z`));
  return wrap(els, opts);
};

PATTERNS['cloud'] = function(opts = {}) {
  const { size = 48 } = opts;
  const by = size * 0.62;
  const els = [];
  els.push(pth(`M${r2(size * 0.15)},${r2(by)} Q${r2(size * 0.15)},${r2(by - 10)} ${r2(size * 0.3)},${r2(by - 10)} Q${r2(size * 0.35)},${r2(by - 18)} ${r2(size * 0.5)},${r2(by - 16)} Q${r2(size * 0.65)},${r2(by - 18)} ${r2(size * 0.72)},${r2(by - 8)} Q${r2(size * 0.88)},${r2(by - 8)} ${r2(size * 0.88)},${r2(by)} Z`));
  return wrap(els, opts);
};

PATTERNS['database'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const w = size * 0.35, h = size * 0.12;
  const top = size * 0.18, bot = size * 0.72;
  const mid = (top + bot) / 2;
  const els = [];
  els.push(`    <ellipse cx="${r2(cx)}" cy="${r2(top)}" rx="${r2(w)}" ry="${r2(h)}"/>`);
  els.push(ln(cx - w, top, cx - w, bot));
  els.push(ln(cx + w, top, cx + w, bot));
  els.push(pth(`M${r2(cx - w)},${r2(bot)} A${r2(w)},${r2(h)} 0 0 0 ${r2(cx + w)},${r2(bot)}`));
  els.push(pth(`M${r2(cx - w)},${r2(mid)} A${r2(w)},${r2(h)} 0 0 0 ${r2(cx + w)},${r2(mid)}`, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['server'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const w = size * 0.35, uh = size * 0.17;
  const els = [];
  for (let i = 0; i < 3; i++) {
    const y = 5 + i * (uh + 2);
    els.push(pth(`M${r2(cx - w)},${r2(y)} h${r2(w * 2)} v${r2(uh)} h${r2(-w * 2)} Z`));
    els.push(circ(cx - w + 5, y + uh / 2, 1.5, 'fill="#fff"'));
    els.push(ln(cx, y + uh / 2, cx + w - 3, y + uh / 2, 'stroke-width="0.5"'));
  }
  return wrap(els, opts);
};

PATTERNS['satellite'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const bs = 5, pw = 12, ph = 5;
  const els = [];
  els.push(pth(`M${r2(cx - bs)},${r2(cy - bs)} h${r2(bs * 2)} v${r2(bs * 2)} h${r2(-bs * 2)} Z`));
  els.push(pth(`M${r2(cx - bs - 1)},${r2(cy - ph)} h${r2(-pw)} v${r2(ph * 2)} h${r2(pw)} Z`));
  els.push(pth(`M${r2(cx + bs + 1)},${r2(cy - ph)} h${r2(pw)} v${r2(ph * 2)} h${r2(-pw)} Z`));
  for (let i = 1; i < 3; i++) {
    const lx = cx - bs - 1 - pw * i / 3;
    const rx = cx + bs + 1 + pw * i / 3;
    els.push(ln(lx, cy - ph, lx, cy + ph, 'stroke-width="0.4"'));
    els.push(ln(rx, cy - ph, rx, cy + ph, 'stroke-width="0.4"'));
  }
  els.push(ln(cx + 2, cy - bs, cx + 7, cy - bs - 7));
  els.push(circ(cx + 7, cy - bs - 8, 2));
  return wrap(els, opts);
};

PATTERNS['antenna'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(ln(cx, 12, cx, size - 4));
  els.push(ln(cx - 8, size - 4, cx + 8, size - 4));
  els.push(ln(cx - 5, size - 4, cx, size * 0.55, 'stroke-width="0.5"'));
  els.push(ln(cx + 5, size - 4, cx, size * 0.55, 'stroke-width="0.5"'));
  for (let i = 0; i < 3; i++) {
    const y = size * 0.4 + i * 5;
    const w = 2 + i * 2;
    els.push(ln(cx - w, y, cx + w, y, 'stroke-width="0.5"'));
  }
  for (let i = 1; i <= 2; i++) {
    const rr = i * 5;
    els.push(pth(`M${r2(cx - rr)},${14} Q${r2(cx)},${r2(14 - rr)} ${r2(cx + rr)},${14}`, 'stroke-width="0.5"'));
  }
  els.push(circ(cx, 12, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['magnet'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const R = size * 0.22, arcY = size * 0.65, topY = size * 0.18;
  const els = [];
  els.push(ln(cx - R, topY, cx - R, arcY));
  els.push(ln(cx + R, topY, cx + R, arcY));
  els.push(pth(`M${r2(cx - R)},${r2(arcY)} A${r2(R)},${r2(R)} 0 0 0 ${r2(cx + R)},${r2(arcY)}`));
  els.push(ln(cx - R - 4, topY, cx - R + 4, topY));
  els.push(ln(cx - R - 4, topY + 5, cx - R + 4, topY + 5));
  els.push(ln(cx + R - 4, topY, cx + R + 4, topY));
  els.push(ln(cx + R - 4, topY + 5, cx + R + 4, topY + 5));
  for (let i = 1; i <= 2; i++) {
    const w = R + i * 6;
    els.push(pth(`M${r2(cx - R)},${r2(topY - i * 2)} Q${r2(cx)},${r2(topY - w * 0.3)} ${r2(cx + R)},${r2(topY - i * 2)}`, 'stroke-width="0.4"'));
  }
  return wrap(els, opts);
};

PATTERNS['oscilloscope'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const w = size * 0.38, h = size * 0.3;
  const els = [];
  els.push(pth(`M${r2(cx - w)},${r2(cy - h)} h${r2(w * 2)} v${r2(h * 2)} h${r2(-w * 2)} Z`));
  for (let i = 1; i < 4; i++) {
    const gx = cx - w + w * 2 * i / 4;
    els.push(ln(gx, cy - h, gx, cy + h, 'stroke-width="0.2"'));
  }
  els.push(ln(cx - w, cy, cx + w, cy, 'stroke-width="0.2"'));
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    const x = cx - w + 2 + t * (w * 2 - 4);
    const y = cy - h * 0.6 * Math.sin(t * Math.PI * 3);
    pts.push(`${r2(x)},${r2(y)}`);
  }
  els.push(pth(`M${pts.join(' L')}`, 'stroke-width="1.2"'));
  return wrap(els, opts);
};

// --- Data / Analytics ---

PATTERNS['bar-chart'] = function(opts = {}) {
  const { size = 48 } = opts;
  const base = size - 6;
  const bars = [0.6, 0.9, 0.4, 0.75, 0.55];
  const bw = size * 0.1;
  const gap = (size - 10 - bars.length * bw) / (bars.length + 1);
  const els = [ln(6, 4, 6, base), ln(6, base, size - 2, base)];
  for (let i = 0; i < bars.length; i++) {
    const x = 8 + gap + i * (bw + gap);
    const h = bars[i] * (base - 8);
    els.push(pth(`M${r2(x)},${r2(base)} v${r2(-h)} h${r2(bw)} v${r2(h)} Z`));
  }
  return wrap(els, opts);
};

PATTERNS['pie-chart'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const els = [circ(cx, cy, R)];
  const slices = [0, 100, 200, 290];
  for (const a of slices) {
    const [x, y] = polar(cx, cy, R, a);
    els.push(ln(cx, cy, x, y));
  }
  const mid = (slices[0] + slices[1]) / 2;
  const [ax, ay] = polar(cx, cy, R * 0.55, mid);
  els.push(circ(ax, ay, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['line-graph'] = function(opts = {}) {
  const { size = 48 } = opts;
  const base = size - 6;
  const els = [ln(6, 4, 6, base), ln(6, base, size - 2, base)];
  const data = [[8, base - 8], [16, base - 18], [24, base - 12], [32, base - 28], [40, base - 22]];
  els.push(pth(`M${data.map(p => `${r2(p[0])},${r2(p[1])}`).join(' L')}`));
  for (const [x, y] of data) els.push(circ(x, y, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['scatter-plot'] = function(opts = {}) {
  const { size = 48 } = opts;
  const base = size - 6;
  const els = [ln(6, 4, 6, base), ln(6, base, size - 2, base)];
  const dots = [[12, 30], [15, 18], [20, 26], [25, 12], [28, 22], [33, 10], [36, 16], [40, 8], [18, 34], [30, 28]];
  for (const [x, y] of dots) els.push(circ(x, y, 1.8, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['funnel'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const widths = [size - 8, size * 0.65, size * 0.4, size * 0.2];
  const uh = (size - 10) / widths.length;
  const els = [];
  for (let i = 0; i < widths.length; i++) {
    const y = 4 + i * uh;
    const w = widths[i] / 2;
    els.push(pth(`M${r2(cx - w)},${r2(y)} h${r2(w * 2)} v${r2(uh - 1)} h${r2(-w * 2)} Z`));
  }
  return wrap(els, opts);
};

PATTERNS['flow-branch'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(circ(cx, 8, 3.5));
  els.push(ln(cx, 11.5, cx, 17));
  els.push(circ(cx, 17, 1.5, 'fill="#fff"'));
  els.push(ln(cx, 18.5, cx - 14, 28));
  els.push(ln(cx, 18.5, cx, 28));
  els.push(ln(cx, 18.5, cx + 14, 28));
  els.push(circ(cx - 14, 31, 3.5));
  els.push(circ(cx, 31, 3.5));
  els.push(circ(cx + 14, 31, 3.5));
  els.push(ln(cx - 14, 34.5, cx - 14, 40));
  els.push(ln(cx + 14, 34.5, cx + 14, 40));
  els.push(circ(cx - 14, 42.5, 2, 'fill="#fff"'));
  els.push(circ(cx + 14, 42.5, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['merge-arrows'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const els = [];
  els.push(ln(6, 8, cx, cy));
  els.push(ln(cx, 4, cx, cy));
  els.push(ln(size - 6, 8, cx, cy));
  els.push(circ(cx, cy, 3, 'fill="#fff"'));
  els.push(ln(cx, cy + 3, cx, size - 8));
  els.push(pth(`M${r2(cx - 4)},${r2(size - 12)} L${r2(cx)},${r2(size - 4)} L${r2(cx + 4)},${r2(size - 12)}`));
  return wrap(els, opts);
};

PATTERNS['filter'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${4},${8} H${size - 4} L${r2(cx + 3)},${r2(size * 0.55)} V${size - 4} H${r2(cx - 3)} V${r2(size * 0.55)} Z`));
  els.push(ln(cx - 3, size * 0.55, cx + 3, size * 0.55, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['sort-arrows'] = function(opts = {}) {
  const { size = 48 } = opts;
  const lx = size * 0.3, rx = size * 0.7;
  const els = [];
  els.push(ln(lx, size - 10, lx, 14));
  els.push(pth(`M${r2(lx - 5)},${18} L${r2(lx)},${10} L${r2(lx + 5)},${18}`));
  els.push(ln(rx, 10, rx, size - 14));
  els.push(pth(`M${r2(rx - 5)},${size - 18} L${r2(rx)},${size - 10} L${r2(rx + 5)},${size - 18}`));
  return wrap(els, opts);
};

PATTERNS['matrix-grid'] = function(opts = {}) {
  const { rows = 5, cols = 5, size = 48 } = opts;
  const gx = (size - 8) / (cols - 1), gy = (size - 8) / (rows - 1);
  const els = [];
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const filled = (ri + ci) % 3 === 0 || (ri * ci) % 5 === 0;
      els.push(circ(4 + ci * gx, 4 + ri * gy, 1.8, filled ? 'fill="#fff"' : ''));
    }
  }
  return wrap(els, opts);
};

// --- Communication ---

PATTERNS['chat-bubble'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const l = 6, r = size - 6, t = 6, b = size * 0.65;
  const rr = 4;
  const els = [];
  els.push(pth(`M${l + rr},${t} H${r - rr} Q${r},${t} ${r},${t + rr} V${b - rr} Q${r},${b} ${r - rr},${b} H${l + rr} Q${l},${b} ${l},${b - rr} V${t + rr} Q${l},${t} ${l + rr},${t} Z`));
  els.push(pth(`M${r2(cx - 4)},${r2(b)} L${r2(cx - 8)},${r2(size - 4)} L${r2(cx + 2)},${r2(b)}`));
  els.push(circ(cx - 7, (t + b) / 2, 1.5, 'fill="#fff"'));
  els.push(circ(cx, (t + b) / 2, 1.5, 'fill="#fff"'));
  els.push(circ(cx + 7, (t + b) / 2, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['envelope'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const l = 4, r = size - 4, t = 10, b = size - 10;
  const els = [];
  els.push(pth(`M${l},${t} H${r} V${b} H${l} Z`));
  els.push(pth(`M${l},${t} L${cx},${r2((t + b) / 2)} L${r},${t}`));
  els.push(pth(`M${l},${b} L${cx},${r2((t + b) / 2 + 3)} L${r},${b}`, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['bell'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const bel = size * 0.7;
  const els = [];
  els.push(pth(`M${r2(cx - 14)},${r2(bel)} Q${r2(cx - 14)},${12} ${r2(cx)},${8} Q${r2(cx + 14)},${12} ${r2(cx + 14)},${r2(bel)} Z`));
  els.push(ln(cx - 17, bel, cx + 17, bel));
  els.push(circ(cx, bel + 5, 2.5, 'fill="#fff"'));
  els.push(circ(cx, 6, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['phone'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const w = size * 0.2, h = size * 0.4;
  const els = [];
  els.push(pth(`M${r2(cx - w + 2)},${r2(cy - h)} Q${r2(cx - w)},${r2(cy - h)} ${r2(cx - w)},${r2(cy - h + 2)} V${r2(cy + h - 2)} Q${r2(cx - w)},${r2(cy + h)} ${r2(cx - w + 2)},${r2(cy + h)} H${r2(cx + w - 2)} Q${r2(cx + w)},${r2(cy + h)} ${r2(cx + w)},${r2(cy + h - 2)} V${r2(cy - h + 2)} Q${r2(cx + w)},${r2(cy - h)} ${r2(cx + w - 2)},${r2(cy - h)} Z`));
  els.push(pth(`M${r2(cx - w + 3)},${r2(cy - h + 6)} h${r2((w - 3) * 2)} v${r2((h - 5) * 2 - 10)} h${r2(-(w - 3) * 2)} Z`));
  els.push(circ(cx, cy + h - 3, 1.5));
  return wrap(els, opts);
};

PATTERNS['chain-link'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const els = [];
  els.push(`    <ellipse cx="${r2(cx - 6)}" cy="${r2(cy)}" rx="7" ry="12" transform="rotate(-30 ${r2(cx - 6)} ${r2(cy)})"/>`);
  els.push(`    <ellipse cx="${r2(cx + 6)}" cy="${r2(cy)}" rx="7" ry="12" transform="rotate(30 ${r2(cx + 6)} ${r2(cy)})"/>`);
  return wrap(els, opts);
};

PATTERNS['share-node'] = function(opts = {}) {
  const { size = 48 } = opts;
  const nodes = [[size * 0.75, size * 0.2], [size * 0.75, size * 0.8], [size * 0.2, size * 0.5]];
  const els = [];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      els.push(ln(nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1], 'stroke-width="0.7"'));
    }
  }
  for (const [x, y] of nodes) els.push(circ(x, y, 4));
  for (const [x, y] of nodes) els.push(circ(x, y, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['broadcast'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, ty = size * 0.5;
  const els = [];
  els.push(ln(cx, ty, cx, size - 4));
  els.push(ln(cx - 8, size - 4, cx + 8, size - 4));
  els.push(ln(cx - 5, size - 4, cx, ty + 8, 'stroke-width="0.5"'));
  els.push(ln(cx + 5, size - 4, cx, ty + 8, 'stroke-width="0.5"'));
  for (let i = 1; i <= 3; i++) {
    const rr = i * 5;
    els.push(pth(`M${r2(cx - rr * 1.2)},${r2(ty)} Q${r2(cx)},${r2(ty - rr * 1.4)} ${r2(cx + rr * 1.2)},${r2(ty)}`));
  }
  els.push(circ(cx, ty, 2.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['pulse'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cy = size / 2;
  const els = [];
  els.push(pth(`M${2},${r2(cy)} H${r2(size * 0.25)} L${r2(size * 0.33)},${r2(cy - 12)} L${r2(size * 0.42)},${r2(cy + 8)} L${r2(size * 0.5)},${r2(cy - 16)} L${r2(size * 0.58)},${r2(cy + 10)} L${r2(size * 0.66)},${r2(cy)} H${size - 2}`));
  els.push(circ(size / 2, cy, size / 2 - 2));
  return wrap(els, opts);
};

PATTERNS['signal-bars'] = function(opts = {}) {
  const { bars = 5, size = 48 } = opts;
  const base = size - 6;
  const bw = (size - 12) / bars - 2;
  const els = [];
  for (let i = 0; i < bars; i++) {
    const x = 6 + i * (bw + 2);
    const h = (base - 8) * (i + 1) / bars;
    els.push(pth(`M${r2(x)},${r2(base)} v${r2(-h)} h${r2(bw)} v${r2(h)} Z`));
  }
  return wrap(els, opts);
};

PATTERNS['megaphone'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cy = size / 2;
  const els = [];
  els.push(pth(`M${8},${r2(cy - 4)} L${r2(size * 0.55)},${r2(cy - size * 0.35)} V${r2(cy + size * 0.35)} L${8},${r2(cy + 4)} Z`));
  els.push(pth(`M${5},${r2(cy - 4)} V${r2(cy + 4)} H${8} V${r2(cy - 4)} Z`));
  for (let i = 1; i <= 3; i++) {
    const rr = i * 4;
    els.push(pth(`M${r2(size * 0.55)},${r2(cy - rr)} Q${r2(size * 0.55 + rr)},${r2(cy)} ${r2(size * 0.55)},${r2(cy + rr)}`, 'stroke-width="0.6"'));
  }
  return wrap(els, opts);
};

// --- Nature / Abstract ---

PATTERNS['snowflake'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 2;
  const els = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 60;
    const [ex, ey] = polar(cx, cy, R, a);
    els.push(ln(cx, cy, ex, ey));
    for (let j = 1; j <= 2; j++) {
      const br = R * j * 0.35;
      const [bx, by] = polar(cx, cy, br, a);
      for (const side of [-1, 1]) {
        const [tx, ty] = polar(bx, by, R * 0.2, a + side * 60);
        els.push(ln(bx, by, tx, ty, 'stroke-width="0.7"'));
      }
    }
  }
  els.push(circ(cx, cy, 2, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['sun-rays'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const innerR = size * 0.15, outerR = size / 2 - 2;
  const els = [circ(cx, cy, innerR, 'fill="#fff"')];
  for (let i = 0; i < 12; i++) {
    const a = i * 30;
    const [x1, y1] = polar(cx, cy, innerR + 2, a);
    const len = i % 2 === 0 ? outerR : outerR * 0.7;
    const [x2, y2] = polar(cx, cy, len, a);
    els.push(ln(x1, y1, x2, y2));
  }
  return wrap(els, opts);
};

PATTERNS['crescent-moon'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const els = [];
  els.push(pth(`M${r2(cx)},${r2(cy - R)} C${r2(cx + R * 1.4)},${r2(cy - R * 0.6)} ${r2(cx + R * 1.4)},${r2(cy + R * 0.6)} ${r2(cx)},${r2(cy + R)} C${r2(cx + R * 0.3)},${r2(cy + R * 0.5)} ${r2(cx + R * 0.3)},${r2(cy - R * 0.5)} ${r2(cx)},${r2(cy - R)} Z`));
  return wrap(els, opts);
};

PATTERNS['droplet'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx)},${6} Q${r2(cx + size * 0.35)},${r2(size * 0.5)} ${r2(cx)},${r2(size - 6)} Q${r2(cx - size * 0.35)},${r2(size * 0.5)} ${r2(cx)},${6} Z`));
  els.push(pth(`M${r2(cx - 3)},${r2(size * 0.4)} Q${r2(cx - 5)},${r2(size * 0.5)} ${r2(cx - 2)},${r2(size * 0.58)}`, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['leaf'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx)},${6} Q${r2(size - 4)},${r2(size * 0.3)} ${r2(cx)},${r2(size - 8)} Q${4},${r2(size * 0.3)} ${r2(cx)},${6} Z`));
  els.push(ln(cx, 10, cx, size - 10, 'stroke-width="0.6"'));
  for (let i = 1; i <= 4; i++) {
    const y = 10 + i * (size - 22) / 5;
    els.push(ln(cx, y, cx - 7 + i, y - 4, 'stroke-width="0.4"'));
    els.push(ln(cx, y, cx + 7 - i, y - 4, 'stroke-width="0.4"'));
  }
  els.push(pth(`M${r2(cx)},${r2(size - 8)} Q${r2(cx + 4)},${r2(size - 3)} ${r2(cx + 8)},${r2(size - 3)}`));
  return wrap(els, opts);
};

PATTERNS['mountain'] = function(opts = {}) {
  const { size = 48 } = opts;
  const base = size - 6;
  const els = [];
  els.push(pth(`M${4},${base} L${r2(size * 0.4)},${10} L${r2(size * 0.48)},${16} L${r2(size * 0.55)},${8} L${r2(size - 4)},${base} Z`));
  els.push(pth(`M${r2(size * 0.45)},${18} L${r2(size * 0.55)},${8} L${r2(size * 0.62)},${16}`, 'stroke-width="0.5"'));
  els.push(pth(`M${2},${base} L${r2(size * 0.25)},${r2(base - 18)} L${r2(size * 0.42)},${base}`, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['flame'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx)},${4} Q${r2(cx + 14)},${r2(size * 0.3)} ${r2(cx + 10)},${r2(size * 0.55)} Q${r2(cx + 8)},${r2(size * 0.78)} ${r2(cx)},${r2(size - 4)} Q${r2(cx - 8)},${r2(size * 0.78)} ${r2(cx - 10)},${r2(size * 0.55)} Q${r2(cx - 14)},${r2(size * 0.3)} ${r2(cx)},${4} Z`));
  els.push(pth(`M${r2(cx)},${r2(size * 0.32)} Q${r2(cx + 5)},${r2(size * 0.5)} ${r2(cx + 4)},${r2(size * 0.65)} Q${r2(cx + 2)},${r2(size * 0.8)} ${r2(cx)},${r2(size - 6)} Q${r2(cx - 2)},${r2(size * 0.8)} ${r2(cx - 4)},${r2(size * 0.65)} Q${r2(cx - 5)},${r2(size * 0.5)} ${r2(cx)},${r2(size * 0.32)} Z`, 'stroke-width="0.6"'));
  return wrap(els, opts);
};

PATTERNS['wind-swirl'] = function(opts = {}) {
  const { size = 48 } = opts;
  const els = [];
  for (let i = 0; i < 3; i++) {
    const y = 12 + i * 11;
    const len = size * (0.55 + i * 0.1);
    const curl = 5 + i * 2;
    els.push(pth(`M${4},${r2(y)} Q${r2(size * 0.5)},${r2(y - curl)} ${r2(len)},${r2(y)} Q${r2(len + 5)},${r2(y)} ${r2(len + 3)},${r2(y - 4)}`));
  }
  return wrap(els, opts);
};

PATTERNS['crystal-gem'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx - 12)},${r2(size * 0.35)} L${r2(cx)},${6} L${r2(cx + 12)},${r2(size * 0.35)} L${r2(cx)},${r2(size - 4)} Z`));
  els.push(ln(cx - 12, size * 0.35, cx + 12, size * 0.35, 'stroke-width="0.5"'));
  els.push(ln(cx - 5, size * 0.35, cx, size - 4, 'stroke-width="0.5"'));
  els.push(ln(cx + 5, size * 0.35, cx, size - 4, 'stroke-width="0.5"'));
  els.push(ln(cx, 6, cx - 5, size * 0.35, 'stroke-width="0.5"'));
  els.push(ln(cx, 6, cx + 5, size * 0.35, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

PATTERNS['crown'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${8},${r2(size * 0.7)} L${8},${r2(size * 0.35)} L${r2(cx - 8)},${r2(size * 0.5)} L${r2(cx)},${r2(size * 0.2)} L${r2(cx + 8)},${r2(size * 0.5)} L${r2(size - 8)},${r2(size * 0.35)} L${r2(size - 8)},${r2(size * 0.7)} Z`));
  els.push(ln(8, size * 0.7, size - 8, size * 0.7));
  els.push(circ(8, size * 0.35, 1.5, 'fill="#fff"'));
  els.push(circ(cx, size * 0.2, 1.5, 'fill="#fff"'));
  els.push(circ(size - 8, size * 0.35, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['crosshair'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 3;
  const g = 4;
  const els = [circ(cx, cy, R), circ(cx, cy, R * 0.5)];
  els.push(ln(cx, cy - R, cx, cy - g));
  els.push(ln(cx, cy + g, cx, cy + R));
  els.push(ln(cx - R, cy, cx - g, cy));
  els.push(ln(cx + g, cy, cx + R, cy));
  els.push(circ(cx, cy, 1.5, 'fill="#fff"'));
  return wrap(els, opts);
};

PATTERNS['eye-iris'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2, cy = size / 2;
  const w = size / 2 - 2;
  const els = [];
  els.push(pth(`M${2},${r2(cy)} Q${r2(cx)},${r2(cy - w * 0.75)} ${r2(size - 2)},${r2(cy)} Q${r2(cx)},${r2(cy + w * 0.75)} ${2},${r2(cy)} Z`));
  els.push(circ(cx, cy, w * 0.32));
  els.push(circ(cx, cy, w * 0.13, 'fill="#fff"'));
  for (let i = 0; i < 8; i++) {
    const [ix, iy] = polar(cx, cy, w * 0.16, i * 45);
    const [ox, oy] = polar(cx, cy, w * 0.3, i * 45);
    els.push(ln(ix, iy, ox, oy, 'stroke-width="0.4"'));
  }
  return wrap(els, opts);
};

PATTERNS['heart'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(pth(`M${r2(cx)},${r2(size * 0.38)} C${r2(cx - 2)},${r2(size * 0.22)} ${r2(cx - 16)},${r2(size * 0.12)} ${r2(cx - 16)},${r2(size * 0.35)} C${r2(cx - 16)},${r2(size * 0.55)} ${r2(cx)},${r2(size * 0.68)} ${r2(cx)},${r2(size - 6)} C${r2(cx)},${r2(size * 0.68)} ${r2(cx + 16)},${r2(size * 0.55)} ${r2(cx + 16)},${r2(size * 0.35)} C${r2(cx + 16)},${r2(size * 0.12)} ${r2(cx + 2)},${r2(size * 0.22)} ${r2(cx)},${r2(size * 0.38)} Z`));
  return wrap(els, opts);
};

PATTERNS['anchor'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const els = [];
  els.push(circ(cx, 10, 4));
  els.push(ln(cx, 14, cx, size - 10));
  els.push(ln(cx - 12, size * 0.45, cx + 12, size * 0.45));
  els.push(pth(`M${r2(cx - 14)},${r2(size - 6)} Q${r2(cx - 16)},${r2(size * 0.6)} ${r2(cx)},${r2(size - 10)}`));
  els.push(pth(`M${r2(cx + 14)},${r2(size - 6)} Q${r2(cx + 16)},${r2(size * 0.6)} ${r2(cx)},${r2(size - 10)}`));
  return wrap(els, opts);
};

PATTERNS['hourglass'] = function(opts = {}) {
  const { size = 48 } = opts;
  const cx = size / 2;
  const w = size * 0.3;
  const top = 6, bot = size - 6, mid = size / 2;
  const els = [];
  els.push(ln(cx - w - 2, top, cx + w + 2, top));
  els.push(ln(cx - w - 2, bot, cx + w + 2, bot));
  els.push(pth(`M${r2(cx - w)},${r2(top)} L${r2(cx - 2)},${r2(mid)} L${r2(cx - w)},${r2(bot)}`));
  els.push(pth(`M${r2(cx + w)},${r2(top)} L${r2(cx + 2)},${r2(mid)} L${r2(cx + w)},${r2(bot)}`));
  for (let i = 0; i < 3; i++) els.push(circ(cx, mid + 3 + i * 4, 0.8, 'fill="#fff"'));
  els.push(pth(`M${r2(cx - w * 0.6)},${r2(bot)} L${r2(cx)},${r2(bot - 8)} L${r2(cx + w * 0.6)},${r2(bot)}`, 'stroke-width="0.5"'));
  return wrap(els, opts);
};

// ---------------------------------------------------------------------------
// LLM-powered custom icon generation
// ---------------------------------------------------------------------------

const SVG_SYSTEM_PROMPT = `You generate minimal SVG icons for a flow builder UI. Return ONLY the raw SVG code, nothing else.

Constraints:
- viewBox="0 0 48 48"
- White strokes on transparent background: stroke="#fff" stroke-width="1" fill="none"
- Use only: <circle>, <path>, <line>, <polygon>, <ellipse>, <rect>, <g>
- No <text>, no gradients, no filters, no clipPath, no <use>, no <defs>
- No inline styles — use attributes only
- Keep it under 1500 characters total
- The icon should look good at 24px-48px display size
- Design should be geometric, clean, and recognizable as a step icon
- Small filled circles (fill="#fff") are fine for focal points
- Wrap all elements in a single <g> tag with the stroke defaults`;

async function generateWithLLM(description, opts = {}) {
  const userMsg = `${SVG_SYSTEM_PROMPT}\n\n---\n\nGenerate an SVG icon for: ${description}`;

  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || LLM_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Proxy error: ${resp.status}`);
  }

  const data = await resp.json();
  const jobId = data.job_id;

  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    const poll = await fetch(`${PROXY_URL}?jobid=${jobId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await poll.json();

    if (result.status === 'success') {
      const text = Array.isArray(result.value)
        ? result.value.filter(b => b.type === 'text').map(b => b.text).join('')
        : String(result.value);
      const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/);
      if (!svgMatch) throw new Error('LLM response did not contain valid SVG');
      return svgMatch[0];
    }

    if (result.status === 'no job found' || result.error) {
      throw new Error(result.error?.message || `Job ${jobId} failed`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error(`LLM icon generation timed out after ${POLL_TIMEOUT / 1000}s`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function listPatterns() {
  return Object.keys(PATTERNS).sort();
}

function generateIcon(pattern, opts = {}) {
  const gen = PATTERNS[pattern];
  if (!gen) {
    const available = listPatterns().join(', ');
    throw new Error(`Unknown pattern "${pattern}". Available: ${available}`);
  }
  return gen(opts);
}

async function generate(patternOrPrompt, opts = {}) {
  if (PATTERNS[patternOrPrompt]) {
    return generateIcon(patternOrPrompt, opts);
  }
  return generateWithLLM(patternOrPrompt, opts);
}

// ---------------------------------------------------------------------------
// CLI: node lib/iconGenerator.js <pattern> [--rings=N] [--points=N] ...
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--list') {
    console.log('Available patterns:\n  ' + listPatterns().join('\n  '));
    console.log('\nUsage:');
    console.log('  node lib/iconGenerator.js <pattern> [--key=value ...] [--out=file.svg]');
    console.log('  node lib/iconGenerator.js --prompt="description" [--out=file.svg]');
    console.log('\nExamples:');
    console.log('  node lib/iconGenerator.js flower-of-life --rings=3');
    console.log('  node lib/iconGenerator.js star-polygon --points=7 --skip=3');
    console.log('  node lib/iconGenerator.js mandala --spokes=8 --rings=4');
    console.log('  node lib/iconGenerator.js --prompt="neural network with nodes and connections"');
    process.exit(0);
  }

  const opts = {};
  let pattern = null;
  let outFile = null;
  let prompt = null;

  for (const arg of args) {
    if (arg.startsWith('--out=')) { outFile = arg.slice(6); continue; }
    if (arg.startsWith('--prompt=')) { prompt = arg.slice(9); continue; }
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      opts[k] = isNaN(Number(v)) ? v : Number(v);
      continue;
    }
    pattern = arg;
  }

  (async () => {
    try {
      let svg;
      if (prompt) {
        console.error('Generating icon via LLM...');
        svg = await generateWithLLM(prompt, opts);
      } else if (pattern) {
        svg = generateIcon(pattern, opts);
      } else {
        console.error('Provide a pattern name or --prompt="description"');
        process.exit(1);
      }

      if (outFile) {
        require('fs').writeFileSync(outFile, svg + '\n');
        console.error(`Wrote ${outFile} (${svg.length} chars)`);
      } else {
        process.stdout.write(svg + '\n');
      }
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { generateIcon, generateWithLLM, generate, listPatterns, PATTERNS };
