interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widget: string): void;
}
const scriptUrl = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const turnstile = () => (window as unknown as {turnstile?: Turnstile}).turnstile;
let loading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  const ready = turnstile();
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
    const script = existing ?? document.createElement('script');
    const fail = () => { clearTimeout(timer); if (!existing) script.remove(); reject(new Error('人机验证组件加载失败，请重试')); };
    const timer = setTimeout(fail, 20000);
    script.addEventListener('load', () => { const widget = turnstile(); if (!widget) { fail(); return; } clearTimeout(timer); resolve(widget); }, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existing) { script.src = scriptUrl; script.async = true; (document.head as unknown as HTMLHeadElement).appendChild(script); }
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

export async function messengerChallenge(siteKey: string | undefined, filename: string, signal: AbortSignal): Promise<string> {
  if (!siteKey) throw new Error('服务端已要求人机验证，尚缺验证组件的站点密钥');
  const widget = await loadTurnstile();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog'), title = document.createElement('p'), box = document.createElement('div'), cancel = document.createElement('button');
    title.textContent = `有人请求下载「${filename}」。请完成验证以建立传输。`;
    cancel.type = 'button'; cancel.textContent = '取消本次传输';
    dialog.setAttribute('aria-label', '文件传输验证'); dialog.appendChild(title); dialog.appendChild(box); dialog.appendChild(cancel);
    (document.body as unknown as HTMLBodyElement).appendChild(dialog);
    let widgetId: string | undefined;
    const clean = () => {
      signal.removeEventListener('abort', abort);
      if (widgetId !== undefined) widget.remove(widgetId);
      dialog.remove();
    };
    const abort = () => { clean(); reject(new Error('文件传输验证已取消')); };
    signal.addEventListener('abort', abort, { once: true }); cancel.onclick = abort; dialog.oncancel = abort;
    try {
      dialog.showModal();
      widgetId = widget.render(box, { sitekey: siteKey, action: 'create-share',
        callback: (value: string) => { clean(); resolve(value); },
        'error-callback': () => { clean(); reject(new Error('人机验证失败，请重新下载')); },
      });
    } catch (error) { clean(); reject(error); }
  });
}
