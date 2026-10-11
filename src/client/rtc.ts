export interface RtcSupport {
  available: boolean;
  constructorType: string;
  secureContext: boolean;
  message: string;
}
export function rtcSupport(): RtcSupport {
  const constructorType = typeof globalThis.RTCPeerConnection, secureContext = globalThis.isSecureContext === true;
  if (constructorType !== 'function') return { available: false, constructorType, secureContext, message: '当前页面的 WebRTC API 不可用（可能受浏览器设置、扩展或运行环境限制）' };
  let pc: RTCPeerConnection | undefined;
  try {
    pc = new globalThis.RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('capability');
    return { available: true, constructorType, secureContext, message: 'WebRTC DataChannel 可创建，直连结果需两端在线验证' };
  } catch (error) {
    return { available: false, constructorType, secureContext, message: `已检测到 WebRTC API，但连接创建失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` };
  } finally { pc?.close(); }
}
