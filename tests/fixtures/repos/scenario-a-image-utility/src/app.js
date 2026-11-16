import { resizeToBlob } from './resize.js';
const drop = document.getElementById('drop');
let file = null;
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', (e) => { e.preventDefault(); file = e.dataTransfer.files[0]; drop.textContent = file.name; });
document.getElementById('go').addEventListener('click', async () => {
  if (!file) return; // TODO: show an error when no file is selected
  const blob = await resizeToBlob(file, Number(document.getElementById('w').value) || undefined, document.getElementById('fmt').value, Number(document.getElementById('q').value) / 100);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'out.' + document.getElementById('fmt').value; a.click();
});
