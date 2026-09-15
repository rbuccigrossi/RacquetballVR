import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import selfsigned from 'selfsigned';

export const certificateDirectory = fileURLToPath(new URL('./certs/', import.meta.url));

export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(
    entry => entry && !entry.internal && (entry.family === 'IPv4' || entry.family === 4)
  ).map(entry => entry.address))];
}

export async function ensureCertificates({ directory = certificateDirectory, force = false, addresses = lanAddresses() } = {}) {
  const extra = (process.env.LAN_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
  const ips = [...new Set(['127.0.0.1', '::1', ...addresses, ...extra])];
  if (ips.some(ip => !isIP(ip))) throw new Error('LAN_IPS must contain comma-separated IP addresses.');
  if (!force) {
    try {
      const [key, cert] = await Promise.all([
        readFile(resolve(directory, 'key.pem')), readFile(resolve(directory, 'cert.pem'))
      ]);
      const x509 = new X509Certificate(cert);
      if (Date.parse(x509.validTo) > Date.now() + 86400000 && x509.checkHost('localhost') && ips.every(ip => x509.checkIP(ip))) {
        return { key, cert };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - 300000),
    notAfterDate: new Date(Date.now() + 90 * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map(ip => ({ type: 7, ip }))] }
    ]
  });
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'key.pem'), pems.private, { mode: 0o600 });
  await writeFile(resolve(directory, 'cert.pem'), pems.cert);
  return { key: pems.private, cert: pems.cert };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureCertificates({ force: process.argv.includes('--force') });
  console.log(`Certificate saved in ${certificateDirectory}`);
}
