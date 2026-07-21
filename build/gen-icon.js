// One-off icon generator: draws the TradeForge rocket icon on a canvas at
// multiple sizes, writes PNGs, and packs them into build/icon.ico.
// Run with: npx electron build/gen-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUT_DIR = __dirname;

const PAGE = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
function draw(size) {
  var c = document.getElementById('c');
  c.width = size; c.height = size;
  var x = c.getContext('2d');
  var s = size / 256;
  x.setTransform(s, 0, 0, s, 0, 0);

  // --- rounded-square background ---
  var r = 56, inset = 6, w = 256 - inset * 2;
  function rr(px, py, pw, ph, pr) {
    x.beginPath();
    x.moveTo(px + pr, py);
    x.arcTo(px + pw, py, px + pw, py + ph, pr);
    x.arcTo(px + pw, py + ph, px, py + ph, pr);
    x.arcTo(px, py + ph, px, py, pr);
    x.arcTo(px, py, px + pw, py, pr);
    x.closePath();
  }
  var bg = x.createLinearGradient(0, 0, 256, 256);
  bg.addColorStop(0, '#191922');
  bg.addColorStop(1, '#08080d');
  rr(inset, inset, w, w, r);
  x.fillStyle = bg; x.fill();
  x.save(); rr(inset, inset, w, w, r); x.clip();

  // nebula glows
  var g1 = x.createRadialGradient(70, 60, 0, 70, 60, 190);
  g1.addColorStop(0, 'rgba(94,92,230,0.30)'); g1.addColorStop(1, 'rgba(94,92,230,0)');
  x.fillStyle = g1; x.fillRect(0, 0, 256, 256);
  var g2 = x.createRadialGradient(200, 210, 0, 200, 210, 170);
  g2.addColorStop(0, 'rgba(10,132,255,0.22)'); g2.addColorStop(1, 'rgba(10,132,255,0)');
  x.fillStyle = g2; x.fillRect(0, 0, 256, 256);

  // stars (fixed positions)
  var stars = [[38,48,1.6],[66,150,1.2],[48,205,1.8],[205,52,1.7],[178,34,1.2],
               [222,120,1.3],[95,38,1.1],[150,215,1.4],[215,190,1.1],[30,110,1.2]];
  for (var i = 0; i < stars.length; i++) {
    x.globalAlpha = 0.20 + (i % 4) * 0.11;
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(stars[i][0], stars[i][1], stars[i][2], 0, 7); x.fill();
  }
  x.globalAlpha = 1;

  // motion streaks trailing to the lower-left (flight path to top-right)
  x.lineCap = 'round';
  x.strokeStyle = 'rgba(255,255,255,0.10)';
  x.lineWidth = 11;
  x.beginPath(); x.moveTo(52, 226); x.lineTo(112, 166); x.stroke();
  x.strokeStyle = 'rgba(255,255,255,0.07)';
  x.lineWidth = 8;
  x.beginPath(); x.moveTo(34, 190); x.lineTo(78, 146); x.stroke();
  x.beginPath(); x.moveTo(96, 244); x.lineTo(132, 208); x.stroke();

  // --- rocket (drawn in local coords, nose to the top-right corner) ---
  x.translate(122, 138);
  x.rotate(Math.PI / 4);

  // flame
  var fg = x.createLinearGradient(0, 46, 0, 104);
  fg.addColorStop(0, 'rgba(120,200,255,0.95)');
  fg.addColorStop(0.5, 'rgba(10,132,255,0.75)');
  fg.addColorStop(1, 'rgba(94,92,230,0)');
  x.beginPath();
  x.moveTo(-9, 48);
  x.bezierCurveTo(-14, 74, -5, 88, 0, 102);
  x.bezierCurveTo(5, 88, 14, 74, 9, 48);
  x.closePath();
  x.fillStyle = fg; x.fill();
  var core = x.createLinearGradient(0, 48, 0, 80);
  core.addColorStop(0, 'rgba(255,255,255,0.95)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  x.beginPath();
  x.moveTo(-4, 48);
  x.bezierCurveTo(-6, 62, -2, 70, 0, 78);
  x.bezierCurveTo(2, 70, 6, 62, 4, 48);
  x.closePath();
  x.fillStyle = core; x.fill();

  // fins
  x.fillStyle = '#a9adbd';
  x.beginPath(); x.moveTo(-15, 12); x.lineTo(-32, 56); x.lineTo(-14, 44); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(15, 12); x.lineTo(32, 56); x.lineTo(14, 44); x.closePath(); x.fill();

  // body
  var bodyG = x.createLinearGradient(-18, 0, 18, 0);
  bodyG.addColorStop(0, '#ffffff');
  bodyG.addColorStop(0.55, '#f2f3f7');
  bodyG.addColorStop(1, '#c3c6d4');
  x.beginPath();
  x.moveTo(0, -94);
  x.bezierCurveTo(13, -78, 17, -52, 17, -26);
  x.lineTo(15, 40);
  x.lineTo(-15, 40);
  x.lineTo(-17, -26);
  x.bezierCurveTo(-17, -52, -13, -78, 0, -94);
  x.closePath();
  x.fillStyle = bodyG; x.fill();

  // nozzle
  x.fillStyle = '#8b8f9e';
  x.beginPath(); x.moveTo(-10, 40); x.lineTo(10, 40); x.lineTo(7, 50); x.lineTo(-7, 50);
  x.closePath(); x.fill();

  // window
  var wg = x.createRadialGradient(-3, -37, 2, 0, -34, 13);
  wg.addColorStop(0, '#7cc0ff');
  wg.addColorStop(1, '#0a5bd6');
  x.beginPath(); x.arc(0, -34, 11.5, 0, 7);
  x.fillStyle = wg; x.fill();
  x.lineWidth = 3.4; x.strokeStyle = 'rgba(255,255,255,0.9)'; x.stroke();

  x.restore();
  return c.toDataURL('image/png');
}
function renderAll(sizes) { return sizes.map(draw); }
</script></body></html>`;

function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const dataUrls = await win.webContents.executeJavaScript(`renderAll(${JSON.stringify(SIZES)})`, true);
  const pngs = SIZES.map((size, i) => ({
    size,
    buf: Buffer.from(dataUrls[i].split(',')[1], 'base64')
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngs[pngs.length - 1].buf);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), packIco(pngs));
  console.log('ICON_OK ' + pngs.map((p) => p.size).join(','));
  app.exit(0);
});
