/** LAN sessions exchange only host candidates on private/local addresses or mDNS. */
export function isLanCandidate(candidate: string): boolean {
  const match = candidate.trim().match(/^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host(?:\s|$)/i);
  if (!match) return false;
  const address = match[1].toLowerCase();
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/.test(address)) return true;
  if (address.includes(':')) return address === '::1' || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+$/.test(address);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const octets = address.split('.').map(Number);
  if (octets.some(n => n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
}

/** Filter embedded ICE too: candidates may already be present in the offer/answer. */
export function lanDescription(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  return { type: description.type, sdp: description.sdp?.split(/\r?\n/).filter(line => !/^a=candidate:/i.test(line) || isLanCandidate(line)).join('\r\n') };
}
