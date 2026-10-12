export type Mode = 'p2p' | 'turn' | 'ws' | 'https' | 'r2';
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
  forcedMode?: Mode;
  deleted?: boolean;
}
export interface ShareInfo {
  id: string;
  shortCode?: string;
  passwordProtected?: boolean;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'revoked';
  cleanupStatus: 'pending' | 'cleaning' | 'cleaned';
  ownerStatus: 'online' | 'offline' | 'file_unavailable';
  activeRequests: number;
  files: FileInfo[];
}
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export interface PeerLink { id: string; ownerId: string; receiverId: string; generation: number; ownerReady: boolean; receiverReady: boolean }
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
  forcedMode?: Mode;
  adminGrant?: string;
  peerId?: string;
  httpsChunkBytes?: number;
  httpsBytes?: number;
  httpsStartedAt?: number;
}
export interface ControlEvent {
  seq: number;
  eventId: string;
  type: string;
  request?: DownloadRequest;
  data?: unknown;
  createdAt: number;
}
export interface Capabilities { webrtc: boolean; ws: boolean; https?: boolean; readable: string[] }
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
  adminHash?: string;
}
export interface UploadAttempt {
  id: string;
  fileId: string;
  ownerSessionId: string;
  mode: 'put' | 'multipart';
  partSize: number;
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
