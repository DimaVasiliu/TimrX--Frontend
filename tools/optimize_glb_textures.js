#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_JPEG_QUALITY = 60;
const DEFAULT_WEBP_QUALITY = 65;

function parseArgs(argv) {
  const args = {
    files: [],
    maxDimension: DEFAULT_MAX_DIMENSION,
    jpegQuality: DEFAULT_JPEG_QUALITY,
    webpQuality: DEFAULT_WEBP_QUALITY,
    rewriteOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-dimension') {
      args.maxDimension = Number(argv[++i] || DEFAULT_MAX_DIMENSION);
    } else if (arg === '--jpeg-quality') {
      args.jpegQuality = Number(argv[++i] || DEFAULT_JPEG_QUALITY);
    } else if (arg === '--webp-quality') {
      args.webpQuality = Number(argv[++i] || DEFAULT_WEBP_QUALITY);
    } else if (arg === '--rewrite-only') {
      args.rewriteOnly = true;
    } else {
      args.files.push(arg);
    }
  }

  if (!args.files.length) {
    throw new Error('Usage: node optimize_glb_textures.js [--max-dimension 2048] [--jpeg-quality 60] [--webp-quality 65] <file.glb> [...]');
  }

  return args;
}

function align4(value) {
  return (value + 3) & ~3;
}

function padBuffer(buffer) {
  const paddedLength = align4(buffer.length);
  if (paddedLength === buffer.length) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(paddedLength - buffer.length)]);
}

function padJsonBuffer(buffer) {
  const paddedLength = align4(buffer.length);
  if (paddedLength === buffer.length) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(paddedLength - buffer.length, 0x20)]);
}

function parseGlb(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.toString('utf8', 0, 4) !== 'glTF') {
    throw new Error(`Not a GLB file: ${filePath}`);
  }

  const version = data.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`Unsupported GLB version ${version}: ${filePath}`);
  }

  let offset = 12;
  const jsonLength = data.readUInt32LE(offset);
  const jsonType = data.readUInt32LE(offset + 4);
  offset += 8;
  if (jsonType !== 0x4E4F534A) {
    throw new Error(`Invalid JSON chunk in ${filePath}`);
  }

  const jsonChunk = data.slice(offset, offset + jsonLength);
  offset += align4(jsonLength);
  const json = JSON.parse(jsonChunk.toString('utf8').replace(/\0+$/g, '').trimEnd());

  if (offset > data.length) {
    throw new Error(`Missing BIN chunk in ${filePath}`);
  }

  const binLength = data.readUInt32LE(offset);
  const binType = data.readUInt32LE(offset + 4);
  offset += 8;
  if (binType !== 0x004E4942) {
    throw new Error(`Invalid BIN chunk in ${filePath}`);
  }

  const binChunk = data.slice(offset, offset + binLength);
  return { json, binChunk };
}

function getMimeExtension(mimeType = '') {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

function getImageDimensions(inputPath) {
  const probe = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', inputPath], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`sips probe failed: ${probe.stderr || probe.stdout}`);
  }
  const widthMatch = probe.stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = probe.stdout.match(/pixelHeight:\s*(\d+)/);
  const width = widthMatch ? Number(widthMatch[1]) : 0;
  const height = heightMatch ? Number(heightMatch[1]) : 0;
  if (!width || !height) {
    throw new Error(`Could not read image dimensions for ${inputPath}`);
  }
  return { width, height };
}

function getResizeDimensions(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function optimizeImageBytes(imageBytes, mimeType, options) {
  const ext = getMimeExtension(mimeType);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timrx-glb-opt-'));
  const inputPath = path.join(tempDir, `input${ext}`);
  fs.writeFileSync(inputPath, imageBytes);

  let outputPath = inputPath;
  let outputMimeType = mimeType;

  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    const convertedPath = path.join(
      tempDir,
      mimeType === 'image/png' ? 'output.png' : 'output.jpg',
    );
    const sipsArgs = ['-Z', String(options.maxDimension), inputPath];
    if (mimeType === 'image/jpeg') {
      sipsArgs.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(options.jpegQuality), '--out', convertedPath);
    } else {
      sipsArgs.push('--out', convertedPath);
    }
    const sipsRun = spawnSync('/usr/bin/sips', sipsArgs, { encoding: 'utf8' });
    if (sipsRun.status !== 0) {
      throw new Error(`sips failed: ${sipsRun.stderr || sipsRun.stdout}`);
    }
    outputPath = convertedPath;
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp') {
    const webpPath = path.join(tempDir, 'output.webp');
    const cwebpArgs = ['-quiet', '-q', String(options.webpQuality)];
    if (mimeType === 'image/webp') {
      const dims = getImageDimensions(inputPath);
      const resized = getResizeDimensions(dims.width, dims.height, options.maxDimension);
      if (resized.width !== dims.width || resized.height !== dims.height) {
        cwebpArgs.push('-resize', String(resized.width), String(resized.height));
      }
    }
    cwebpArgs.push(outputPath, '-o', webpPath);
    const cwebpRun = spawnSync('/opt/homebrew/bin/cwebp', cwebpArgs, { encoding: 'utf8' });
    if (cwebpRun.status === 0 && fs.existsSync(webpPath)) {
      outputPath = webpPath;
      outputMimeType = 'image/webp';
    }
  }

  const outputBytes = fs.readFileSync(outputPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { bytes: outputBytes, mimeType: outputMimeType };
}

function ensureWebPExtension(json) {
  json.extensionsUsed = json.extensionsUsed || [];
  if (!json.extensionsUsed.includes('EXT_texture_webp')) {
    json.extensionsUsed.push('EXT_texture_webp');
  }
  return json;
}

function rebuildGlb(originalJson, originalBin, replacements) {
  const json = JSON.parse(JSON.stringify(originalJson));
  let useWebP = false;

  const chunks = [];
  let cursor = 0;

  json.bufferViews.forEach((bufferView, index) => {
    const originalSlice = originalBin.slice(bufferView.byteOffset || 0, (bufferView.byteOffset || 0) + bufferView.byteLength);
    const replacement = replacements.get(index);
    const nextOffset = cursor;
    const content = replacement ? replacement.bytes : originalSlice;
    if (replacement && replacement.mimeType === 'image/webp') {
      useWebP = true;
    }
    chunks.push(content);
    cursor += content.length;
    const padded = align4(cursor) - cursor;
    if (padded) {
      chunks.push(Buffer.alloc(padded));
      cursor += padded;
    }
    bufferView.byteOffset = nextOffset;
    bufferView.byteLength = content.length;
  });

  json.buffers[0].byteLength = cursor;

  if (useWebP) {
    ensureWebPExtension(json);
  }

  for (const image of json.images || []) {
    if (typeof image.bufferView === 'number') {
      const replacement = replacements.get(image.bufferView);
      if (replacement) {
        image.mimeType = replacement.mimeType;
      }
    }
  }

  const jsonBuffer = padJsonBuffer(Buffer.from(JSON.stringify(json), 'utf8'));
  const binBuffer = Buffer.concat(chunks);
  const totalLength = 12 + 8 + jsonBuffer.length + 8 + binBuffer.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonHeader.writeUInt32LE(0x4E4F534A, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBuffer.length, 0);
  binHeader.writeUInt32LE(0x004E4942, 4);

  return Buffer.concat([header, jsonHeader, jsonBuffer, binHeader, binBuffer]);
}

function optimizeGlb(filePath, options) {
  const beforeSize = fs.statSync(filePath).size;
  const { json, binChunk } = parseGlb(filePath);
  const replacements = new Map();

  for (const image of json.images || []) {
    if (typeof image.bufferView !== 'number') continue;
    const bufferView = json.bufferViews[image.bufferView];
    if (!bufferView) continue;
    const start = bufferView.byteOffset || 0;
    const end = start + bufferView.byteLength;
    const imageBytes = binChunk.slice(start, end);
    const mimeType = image.mimeType || 'image/jpeg';
    const optimized = optimizeImageBytes(imageBytes, mimeType, options);

    if (optimized.bytes.length < imageBytes.length) {
      replacements.set(image.bufferView, optimized);
    }
  }

  if (!replacements.size) {
    return { filePath, beforeSize, afterSize: beforeSize, changed: false };
  }

  const rebuilt = rebuildGlb(json, binChunk, replacements);
  fs.writeFileSync(filePath, rebuilt);
  const afterSize = fs.statSync(filePath).size;
  return { filePath, beforeSize, afterSize, changed: afterSize !== beforeSize };
}

function rewriteGlb(filePath) {
  const beforeSize = fs.statSync(filePath).size;
  const { json, binChunk } = parseGlb(filePath);
  const rebuilt = rebuildGlb(json, binChunk, new Map());
  fs.writeFileSync(filePath, rebuilt);
  const afterSize = fs.statSync(filePath).size;
  return { filePath, beforeSize, afterSize, changed: afterSize !== beforeSize };
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];

  for (const filePath of args.files) {
    const result = args.rewriteOnly ? rewriteGlb(filePath) : optimizeGlb(filePath, args);
    results.push(result);
  }

  for (const result of results) {
    const delta = result.beforeSize - result.afterSize;
    console.log(
      `${path.basename(result.filePath)}: ${formatMb(result.beforeSize)} -> ${formatMb(result.afterSize)} ` +
      `(${delta > 0 ? '-' : ''}${formatMb(Math.abs(delta))})`
    );
  }
}

main();
