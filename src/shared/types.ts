export type Mode = 'p2p' | 'turn' | 'ws' | 'r2';
export type RequestStatus = 'requested' | 'connecting' | 'transferring' | 'completed' | 'canceled' | 'failed';
export type UploadStatus = 'none' | 'uploading' | 'paused' | 'ready' | 'canceled' | 'failed' | 'aborted';
export interface FileInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
  sha256?: string;
  uploadStatus: UploadStatus;
}
export interface ShareInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'revoked';
  cleanupStatus: 'pending' | 'cleaning' | 'cleaned';
  ownerStatus: 'online' | 'offline' | 'file_unavailable';
  activeRequests: number;
  files: FileInfo[];
}
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export interface DownloadRequest {
  id: string;
  fileId: string;
  receiverId: string;
  ownerId?: string;
  epoch: number;
  mode: Mode;
  status: RequestStatus;
  offset: number;
  transferId: string;
  createdAt: number;
  iceServers?: IceServer[];
  error?: string;
  reservationId?: string;
  turnUsernames?: string[];
  turnExpiresAt?: number;
  sourceHash?: string;
}
export interface ControlEvent {
  seq: number;
  eventId: string;
  type: string;
  request?: DownloadRequest;
  data?: unknown;
  createdAt: number;
}
export interface Capabilities { webrtc: boolean; ws: boolean; readable: string[] }
export interface SessionInfo {
  id: string;
  tokenHash: string;
  role: 'owner' | 'receiver';
  lastSeen: number;
  lastPoll: number;
  capabilities: Capabilities;
  seq: number;
  events: ControlEvent[];
  seen: string[];
}
export interface UploadAttempt {
  id: string;
  fileId: string;
  ownerSessionId: string;
  mode: 'put' | 'multipart';
  key: string;
  uploadId?: string;
  createdAt: number;
  status: UploadStatus;
  signedUntil: number;
  recheckUntil: number;
  pausedUntil?: number;
  reservationId: string;
  verifiedSessionId?: string;
}
export interface UploadAuthorization {
  attemptId: string;
  mode: 'put' | 'multipart';
  url?: string;
  headers?: Record<string, string>;
  partSize: number;
  uploadedParts: { partNumber: number; etag: string; size: number }[];
  shared?: boolean;
  ready?: boolean;
}
