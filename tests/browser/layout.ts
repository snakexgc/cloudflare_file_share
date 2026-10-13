const frame = document.querySelector('iframe')!;
(document.querySelector('#width') as unknown as HTMLSelectElement).onchange = event => { frame.style.width = `${(event.target as HTMLSelectElement).value}px`; };
document.querySelector<HTMLButtonElement>('#open')!.onclick = () => {
  const path = document.querySelector<HTMLInputElement>('#path')!.value;
  if (path.startsWith('/') && !path.startsWith('//')) frame.src = `http://127.0.0.1:5173${path}`;
};
