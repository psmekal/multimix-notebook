// Self-signed certificate for HTTPS (needed so hall notebooks get a secure
// context for the camera). Generated once into certs/, valid for localhost and
// every local IPv4 so any LAN address works. Browsers still show a one-time
// "not trusted" warning for a self-signed cert — accept it once per device.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

export function localIPv4() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) ips.push(i.address);
  return ips;
}

export async function ensureCert() {
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(keyPath) && fs.existsSync(certPath))
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIPv4().map(ip => ({ type: 7, ip }))
  ];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'MultiMix' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
