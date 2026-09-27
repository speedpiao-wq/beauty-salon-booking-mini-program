function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('小天使素材读取失败，请重新打开后再试。'));
    image.src = src;
  });
}

module.exports = { loadCanvasImage };
