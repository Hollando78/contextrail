/**
 * Operator pairing helper. Mints a one-time pairing token on the host's loopback
 * port and prints a scannable QR + URL. Open it on a spare phone/tablet to pair
 * that device as a desklet bound to the given role.
 *
 *   node scripts/pair.mjs [Role] [loopbackPort]
 *   Role ∈ {Project, Actions, Status, Capture, Logs, AI}  (default Status)
 */
import { get as httpGet } from 'node:http';
import QRCode from 'qrcode';

const role = process.argv[2] ?? 'Status';
const loopback = Number(process.argv[3] ?? process.env.CONTEXTRAIL_LOOPBACK ?? 8788);

function httpJson(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          reject(new Error(`bad response (${res.statusCode})`));
        }
      });
    }).on('error', reject);
  });
}

try {
  const mint = await httpJson(`http://127.0.0.1:${loopback}/pair/new?role=${encodeURIComponent(role)}`);
  if (!mint.ott) throw new Error(mint.error || 'failed to mint pairing token');
  const qr = await QRCode.toString(mint.url, { type: 'terminal', small: true });
  console.log(`\nPair a device as role: ${mint.role}\n`);
  console.log(qr);
  console.log(`URL:  ${mint.url}`);
  console.log(`(token expires in 30s — scan or open on the device now)\n`);
} catch (err) {
  console.error(`\n  Could not reach the host on loopback:${loopback} — is it running? (npm run host)`);
  console.error(`  ${err.message}\n`);
  process.exitCode = 1;
}
