// ---------------------------------------------------------------------------
// A minimal, dependency-free ZIP file writer.
//
// The BrixOS Orchestrator's "Export ZIP" feature (server/orchestrator.js)
// needs to hand the user a real, standard .zip of their generated website.
// Rather than adding a new npm dependency (archiver, jszip, ...) for
// something this small, this implements just enough of the ZIP file format
// by hand: local file headers, a central directory, and the end-of-central-
// directory record, with DEFLATE compression via Node's built-in `zlib`
// (falling back to STORE — no compression — for any entry deflate doesn't
// actually shrink, e.g. already-compressed or tiny files).
//
// This is the real, standard ZIP format (PKWARE APPNOTE.TXT) — the output
// opens in any real unzip tool (Windows Explorer, macOS Archive Utility,
// `unzip`), not a custom/lookalike format.
// ---------------------------------------------------------------------------

const zlib = require('zlib');

let crcTable = null;
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

// zlib.crc32() exists on newer Node builds (added in Node 22) but this app's
// package.json only requires Node >=18, and the exact Node version a given
// deploy target (Railway, etc.) runs can differ from what's used locally —
// so this always has a working, dependency-free fallback rather than
// assuming a specific Node feature is present.
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTime(date) {
  return ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
}

function toDosDate(date) {
  return (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
}

// files: [{ name: 'index.html', content: string | Buffer }]
// Returns a Buffer — the complete .zip file, ready to write to disk or send
// as an HTTP response body.
function createZip(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('createZip: no files given');

  const now = new Date();
  const dosTime = toDosTime(now);
  const dosDate = toDosDate(now);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = String(file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('createZip: entry with no name');
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content == null ? '' : file.content), 'utf8');
    const crc = crc32(rawBuf);

    let method = 0;
    let dataBuf = rawBuf;
    if (rawBuf.length > 0) {
      const deflated = zlib.deflateRawSync(rawBuf);
      if (deflated.length < rawBuf.length) {
        method = 8;
        dataBuf = deflated;
      }
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(rawBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0x81a40000, 38); // external file attributes (unix -rw-r--r--)
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirOffset = offset;
  const centralDirBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(files.length, 8); // number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10); // total number of central directory records
  eocd.writeUInt32LE(centralDirBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

module.exports = { createZip };
