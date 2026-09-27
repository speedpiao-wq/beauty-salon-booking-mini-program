const fs = require('fs');
const { spawn } = require('child_process');
const { once } = require('events');
const { PNG } = require('pngjs');
const { parseGIF, decompressFrames } = require('gifuct-js');

const WIDTH = 540;
const HEIGHT = 800;
const FPS = 24;
const FRAMES = 125;

function motionAt(frame, kind, dayCount = 1) {
  const seconds = frame / FPS;
  const progress = Math.max(0, Math.min(1, (seconds - 0.3) / 2.9));
  const eased = progress * progress * (3 - 2 * progress);
  const wing = Math.floor(seconds * 11) % 4;
  if (kind === 'empty') {
    const safeDayCount = Math.max(1, Math.min(3, Math.trunc(dayCount) || 1));
    const bodyBottom = safeDayCount === 1 ? 1098 : 554 + safeDayCount * 204 + 24 * (safeDayCount - 1);
    const availableHeight = Math.max(120, 1460 - bodyBottom - 52);
    const angelWidth = Math.max(100, Math.min(250, availableHeight / 1.2));
    const targetLeft = (1080 - angelWidth) / 4;
    const targetTop = (bodyBottom + 12) / 2;
    const targetWidth = angelWidth / 2;
    return {
      width: Math.round(40 + (targetWidth - 40) * eased),
      left: Math.round((1 - eased) ** 3 * 22
        + 3 * (1 - eased) ** 2 * eased * 0
        + 3 * (1 - eased) * eased ** 2 * -20
        + eased ** 3 * targetLeft),
      top: Math.round((1 - eased) ** 3 * 24
        + 3 * (1 - eased) ** 2 * eased * 160
        + 3 * (1 - eased) * eased ** 2 * (targetTop + 65)
        + eased ** 3 * targetTop),
      wing,
      knock: 0,
      finalOpacity: Math.max(0, Math.min(1, (seconds - 3.55) / 0.4)),
    };
  }
  const bezier = (a, b, c, d) => (1 - eased) ** 3 * a
    + 3 * (1 - eased) ** 2 * eased * b + 3 * (1 - eased) * eased ** 2 * c + eased ** 3 * d;
  const multiDay = dayCount > 1;
  const tap = center => Math.max(0, 1 - Math.abs(seconds - center) / 0.19);
  const knock = Math.max(tap(3.63), tap(4.16));
  return {
    width: Math.round(29 + (multiDay ? 41 : 78) * eased),
    left: Math.round(bezier(22, 9, multiDay ? 42 : 56, multiDay ? 46 : 67) + 5 * knock),
    top: Math.round(bezier(24, 66, multiDay ? 220 : 250, multiDay ? 300 : 343) - 4 * knock),
    wing,
    knock,
    finalOpacity: 0,
  };
}

function downscalePoster(filePath) {
  const image = PNG.sync.read(fs.readFileSync(filePath));
  if (image.width !== 1080 || image.height !== 1600) throw new Error('INVALID_VIDEO_INPUT');
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const target = (y * WIDTH + x) * 4;
      const source = ((y * 2) * image.width + x * 2) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[target + channel] = Math.round((image.data[source + channel]
          + image.data[source + 4 + channel]
          + image.data[source + image.width * 4 + channel]
          + image.data[source + image.width * 4 + 4 + channel]) / 4);
      }
    }
  }
  return pixels;
}

function decodeAngel(filePath) {
  const file = fs.readFileSync(filePath);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  const canvas = Buffer.alloc(width * height * 4);
  const images = [];
  let previous = null;
  for (const frame of frames) {
    if (previous && previous.disposalType === 2) {
      const { left, top, width: areaWidth, height: areaHeight } = previous.dims;
      for (let y = top; y < top + areaHeight; y += 1) {
        canvas.fill(0, (y * width + left) * 4, (y * width + left + areaWidth) * 4);
      }
    }
    const { left, top, width: areaWidth, height: areaHeight } = frame.dims;
    for (let y = 0; y < areaHeight; y += 1) {
      for (let x = 0; x < areaWidth; x += 1) {
        const source = (y * areaWidth + x) * 4;
        if (!frame.patch[source + 3]) continue;
        const target = ((top + y) * width + left + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) canvas[target + channel] = frame.patch[source + channel];
      }
    }
    images.push(Buffer.from(canvas));
    previous = frame;
  }
  if (!images.length) throw new Error('INVALID_ANGEL_ASSET');
  return { width, height, images };
}

function composeFrame(base, angel, finalImage, frame, kind, dayCount = 1) {
  const pixels = Buffer.from(base);
  const motion = motionAt(frame, kind, dayCount);
  const width = motion.width;
  const height = Math.round(angel.height * width / angel.width);
  const source = angel.images[motion.wing % angel.images.length];
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(angel.height - 1, Math.floor(y * angel.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(angel.width - 1, Math.floor(x * angel.width / width));
      const sourceIndex = (sourceY * angel.width + sourceX) * 4;
      const alpha = source[sourceIndex + 3] / 255;
      if (!alpha) continue;
      const targetIndex = ((motion.top + y) * WIDTH + motion.left + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[targetIndex + channel] = Math.round(source[sourceIndex + channel] * alpha + pixels[targetIndex + channel] * (1 - alpha));
      }
    }
  }
  if (kind === 'booked' && motion.knock > 0) {
    const tipX = Math.round(motion.left + width * 0.96);
    const tipY = Math.round(motion.top + height * 0.46);
    for (let dy = -18; dy <= 18; dy += 1) {
      for (let dx = -18; dx <= 18; dx += 1) {
        const x = tipX + dx;
        const y = tipY + dy;
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
        const radius = Math.hypot(dx, dy);
        const ring = Math.max(0, 1 - Math.abs(radius - 11) / 2.5);
        const rays = (Math.abs(dx) <= 1 || Math.abs(dy) <= 1) && radius < 18 ? 0.7 : 0;
        const alpha = Math.min(0.85, (ring + rays) * motion.knock * 0.7);
        if (!alpha) continue;
        const index = (y * WIDTH + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[index + channel] = Math.round([237, 168, 72][channel] * alpha + pixels[index + channel] * (1 - alpha));
        }
      }
    }
  }
  if (finalImage && motion.finalOpacity > 0) {
    const alpha = motion.finalOpacity;
    for (let index = 0; index < pixels.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[index + channel] = Math.round(finalImage[index + channel] * alpha + pixels[index + channel] * (1 - alpha));
      }
    }
  }
  return pixels;
}

async function renderVideo(ffmpegPath, { basePath, finalPath, angelPath, outputPath, kind, dayCount = 1 }) {
  if (!['empty', 'booked'].includes(kind) || (kind === 'empty' && !finalPath)) throw new Error('INVALID_VIDEO_INPUT');
  const base = downscalePoster(basePath);
  const finalImage = kind === 'empty' ? downscalePoster(finalPath) : null;
  const angel = decodeAngel(angelPath);
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', String(FPS), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath,
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`VIDEO_RENDER_FAILED: ${stderr}`)));
  });
  try {
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const pixels = composeFrame(base, angel, finalImage, frame, kind, dayCount);
      if (!child.stdin.write(pixels)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    await finished;
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await finished.catch(() => {});
    throw error;
  }
}

module.exports = { motionAt, downscalePoster, decodeAngel, composeFrame, renderVideo };
