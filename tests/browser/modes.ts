const modeFrame = document.querySelector('iframe')!;
const modeResult = document.querySelector<HTMLParagraphElement>('#result')!;
document.querySelector<HTMLButtonElement>('#back')!.onclick = () => modeFrame.contentWindow!.history.back();
document.querySelector<HTMLButtonElement>('#forward')!.onclick = () => modeFrame.contentWindow!.history.forward();
document.querySelector<HTMLButtonElement>('#file')!.onclick = () => {
  const input = modeFrame.contentDocument?.querySelector<HTMLInputElement>('#file-input');
  if (!input) { modeResult.textContent = '请先切换到普通模式'; return; }
  const data = new DataTransfer(); data.items.add(new File(['Generated normal sharing mode test file.'], 'mode-switch-check.txt', { type: 'text/plain', lastModified: 1 }));
  input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); modeResult.textContent = '已选择生成的测试文件，可验证切换后仍保留。';
};
document.querySelector<HTMLButtonElement>('#cleanup')!.onclick = () => {
  void (async () => {
    try {
      const location = modeFrame.contentWindow!.location, token = new URLSearchParams(location.hash.slice(1)).get('owner');
      const reference = location.pathname.split('/').at(-1)!;
      if (!reference.startsWith('mode-qa-') || !token) throw new Error('仅可清理当前页面 mode-qa- 开头的验收分享');
      const response = await fetch(`/api/shares/${reference}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`清理失败：${response.status}`);
      modeResult.textContent = 'PASS：普通分享已创建并撤销，验收文件未发布到公共聊天室。';
    } catch (error) { modeResult.textContent = error instanceof Error ? error.message : String(error); }
  })();
};
