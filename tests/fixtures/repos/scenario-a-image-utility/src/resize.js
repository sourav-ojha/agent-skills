// Single-image resize via Canvas. Batch mode is not implemented yet.
export async function resizeToBlob(file, width, format = 'jpeg', quality = 0.8) {
  const bmp = await createImageBitmap(file);
  const w = width || bmp.width; const h = Math.round(bmp.height * (w / bmp.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, `image/${format}`, quality));
}
