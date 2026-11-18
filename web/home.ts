type Icon = (name: 'arrows' | 'upload' | 'shield' | 'clock' | 'network' | 'link' | 'download') => string;

export function homeContent(hours: number, inactivity: string, icon: Icon, mode: 'auto' | 'lan'): string {
  return `<div class="workspace"><section class="card upload-card"><div class="card-heading"><div><h1>创建分享链接</h1></div></div>
      <fieldset class="mode-picker"><legend>传输方式</legend><div class="mode-options">
        <label class="mode-option"><input type="radio" name="transfer-mode" value="auto" ${mode === 'auto' ? 'checked' : ''}/><span class="mode-option-icon">${icon('arrows')}</span><span><strong>自动传输 <small>推荐</small></strong><span>跨网络分享，P2P 直连优先</span></span><span class="mode-check" aria-hidden="true"></span></label>
        <label class="mode-option"><input type="radio" name="transfer-mode" value="lan" ${mode === 'lan' ? 'checked' : ''}/><span class="mode-option-icon">${icon('network')}</span><span><strong>内网直传</strong><span>同一 Wi-Fi / 局域网内传输</span></span><span class="mode-check" aria-hidden="true"></span></label>
      </div></fieldset>
      <p id="mode-help" class="mode-help" role="status">${mode === 'lan' ? '两端需在同一局域网。文件直接传输，不使用公网中继；打开页面和建立连接仍需联网。' : '优先连接双方设备；直连不可用时，自动尝试中继。'}</p>
      <label class="dropzone" id="dropzone" for="file-input"><span class="upload-orbit">${icon('upload')}</span><strong>拖拽文件到这里</strong><span>或 <b>点击选择文件</b></span><small id="file-limit">正在读取服务配置…</small><input id="file-input" type="file" multiple aria-label="选择分享文件"/></label>
      <div id="selected-files" class="selected-files"></div>
      <form id="create-form">
        <div class="expiry-field"><label for="hours">链接有效期<small>从创建分享时开始计时</small></label><div class="number-input"><input id="hours" name="expiresInHours" type="number" min="1" max="24" step="1" value="${hours}" required inputmode="numeric"/><span>小时</span></div></div>
        <details class="advanced-options"><summary>链接与密码设置 <span>可选</span></summary><div class="share-options">
          <label for="short-code">自定义短链接</label><div class="short-link-input"><span>/s/</span><input id="short-code" type="text" minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9_-]{2,31}" placeholder="例如 summer-files" autocomplete="off"/></div><small>3–32 位小写字母、数字、下划线或连字符，创建后不可修改。</small>
          <label for="share-password">提取密码</label><input id="share-password" type="password" minlength="4" maxlength="64" autocomplete="new-password" placeholder="4–64 个字符"/><small>接收者需要先验证密码，创建后不可修改。</small>
        </div></details>
        <div id="challenge"></div><p id="error" class="error-message" role="alert" hidden></p><button id="create" class="button primary wide" type="submit" disabled>生成分享链接 ${icon('arrows')}</button>
      </form>
      <div class="waiting-note">${icon('shield')} 点击下载后才传输文件，请保持此页面打开。</div>
      <p class="expiry-note">${icon('clock')} 默认 ${hours} 小时，最长 24 小时。${inactivity}</p>
    </section>

  </div>`;
}
